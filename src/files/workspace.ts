import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {DialogueFile,GeneratedFile} from '../contracts.ts';
import {RESPONSE_FILE_LIMITS,ResponseFileError} from '../contracts.ts';
import {startEgress} from './egress.ts';

const unavailable='Изолированная среда документов недоступна. Попросите владельца проверить Docker и образ verfix-files:1.';
const exporter=String.raw`
import os,stat,sys
parts=sys.argv[1].split('/')
if parts[:2]!=['','work'] or len(parts)<3 or any(p in ('','.','..') for p in parts[2:]): raise RuntimeError('Path denied')
fd=os.open('/work',os.O_RDONLY|os.O_DIRECTORY)
try:
 for part in parts[2:-1]:
  next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=next_fd
 file=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
 try:
  info=os.fstat(file)
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>50000000: raise RuntimeError('File denied or exceeds 50 MB')
  size=0
  while True:
   data=os.read(file,65536)
   if not data: break
   size+=len(data)
   if size>50000000: raise RuntimeError('File exceeds 50 MB')
   sys.stdout.buffer.write(data)
 finally: os.close(file)
finally: os.close(fd)
`;

/** Host arguments and mounts are application-owned; commands run only in Docker. */
export class IsolatedWorkspace {
  private readonly name='verfix-files-'+randomUUID();
  private directory?:string;
  private socketDirectory?:string;
  private egressClose?:()=>Promise<void>;
  private ready?:Promise<void>;
  private closed=false;
  readonly materials:Array<DialogueFile & {path:string}>;
  private readonly readFile:(id:string)=>Uint8Array;
  private readonly stagingRoot:string;
  constructor(files:DialogueFile[],readFile:(id:string)=>Uint8Array,stagingRoot=tmpdir()) {
    this.materials=files.map(file=>({...file,path:'/work/materials/'+file.id+(/\.[a-z0-9]{1,12}$/i.exec(file.name)?.[0].toLowerCase()??'')}));
    this.readFile=readFile;this.stagingRoot=stagingRoot;
  }
  private async docker(args:string[],signal:AbortSignal|undefined,maxBytes=131072,input?:Uint8Array):Promise<{code:number;bytes:Buffer}> {
    if(signal?.aborted)throw new Error('Cancelled');
    return new Promise((accept,reject)=>{
      const child=spawn('docker',args,{env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
      const chunks:Buffer[]=[];let size=0,overflow=false,timedOut=false;
      const stop=()=>child.kill('SIGKILL');
      const timer=setTimeout(()=>{timedOut=true;stop();},130000);signal?.addEventListener('abort',stop,{once:true});
      child.stdin.on('error',()=>{});child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){overflow=true;stop();}else chunks.push(chunk);});
      child.stderr.on('data',()=>{});
      child.on('error',()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(new ResponseFileError(unavailable));});
      child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);if(signal?.aborted)reject(new Error('Cancelled'));else if(timedOut)reject(new ResponseFileError('Время выполнения инструмента истекло. Готовые файлы сохранены.'));else if(overflow)reject(new ResponseFileError('Превышен размер вывода инструмента или файла (50 МБ).'));else accept({code:code??1,bytes:Buffer.concat(chunks)});});
      child.stdin.end(input);
      if(signal?.aborted)stop();
    });
  }
  private async start(signal:AbortSignal) {
    if(this.closed)throw new Error('Workspace closed');
    await mkdir(this.stagingRoot,{recursive:true,mode:0o700});
    this.directory=await mkdtemp(join(this.stagingRoot,'verfix-workspace-'));
    const materials=join(this.directory,'materials');await mkdir(materials,{mode:0o755});await chmod(materials,0o755);
    for(const file of this.materials){
      if(!/^[a-f0-9-]{36}$/.test(file.id))throw new Error('Invalid material');
      const name=file.path.split('/').at(-1)!;
      await writeFile(join(materials,name),this.readFile(file.id),{mode:0o444});await chmod(join(materials,name),0o444);
    }
    // AF_UNIX paths are limited to 107 bytes, independent of runtime path.
    // Only the socket lives here; document bytes stay under the dialogue root.
    this.socketDirectory=await mkdtemp(join(tmpdir(),'vfx-'));
    const socket=join(this.socketDirectory,'egress.sock');this.egressClose=await startEgress(socket);
    const result=await this.docker(['run','--detach','--pull=never','--name',this.name,'--label','verfix.workspace=true','--rm','--network','none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user','65534:65534','--memory=1g','--memory-swap=1g','--cpus=1','--pids-limit=128','--ulimit','nofile=256:256','--tmpfs','/work:rw,nosuid,nodev,size=640m,mode=1777','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777','--mount',`type=bind,src=${materials},dst=/materials,readonly`,'--mount',`type=bind,src=${socket},dst=/run/egress.sock,readonly`,'verfix-files:1'],signal);
    if(result.code)throw new ResponseFileError(unavailable);
    const setup=await this.docker(['exec',this.name,'/bin/sh','-c','mkdir -p /work/materials; for file in /materials/*; do [ -e "$file" ] || continue; cp "$file" /work/materials/ || exit 1; done'],signal);
    if(setup.code)throw new ResponseFileError(unavailable);
  }
  private async ensure(signal:AbortSignal){this.ready??=this.start(signal);await this.ready;if(this.closed||signal.aborted)throw new Error('Workspace closed');}
  async run(command:string,signal:AbortSignal):Promise<{code:number;output:string}> {
    if(typeof command!=='string'||Buffer.byteLength(command)>65536)throw new ResponseFileError('Команда слишком большая.');
    await this.ensure(signal);
    const result=await this.docker(['exec','-i',this.name,'timeout','--signal=KILL','120','/bin/bash','-c','exec 2>&1\n'+command+'\n'],signal,131072);
    return {code:result.code,output:result.bytes.toString('utf8')};
  }
  async export(path:string,name:string,mime:string,signal:AbortSignal):Promise<GeneratedFile> {
    if(typeof path!=='string'||path.length>4096||!path.startsWith('/work/')||path.split('/').some(part=>part==='.'||part==='..'))throw new ResponseFileError('Выдавать можно только файлы из /work текущего задания.');
    await this.ensure(signal);
    const result=await this.docker(['exec',this.name,'/usr/local/bin/python','-I','-c',exporter,path],signal,RESPONSE_FILE_LIMITS.fileBytes);
    if(result.code)throw new ResponseFileError('Не удалось получить файл: проверьте путь, ссылки и размер (до 50 МБ).');
    return {bytes:result.bytes,name,mime};
  }
  async addImage(file:GeneratedFile,signal:AbortSignal):Promise<string>{
    await this.ensure(signal);
    const path='/work/materials/'+randomUUID()+'.png';
    const result=await this.docker(['exec','-i',this.name,'/usr/local/bin/python','-I','-c','import sys; open(sys.argv[1],"wb").write(sys.stdin.buffer.read())',path],signal,file.bytes.length,file.bytes);
    if(result.code)throw new ResponseFileError(unavailable);
    return path;
  }
  async close():Promise<void> {
    this.closed=true;
    await this.ready?.catch(()=>{});
    if(this.directory){await this.egressClose?.();await this.docker(['rm','--force',this.name],undefined).catch(()=>{});await rm(this.directory,{recursive:true,force:true});}
    if(this.socketDirectory)await rm(this.socketDirectory,{recursive:true,force:true});
  }
}
