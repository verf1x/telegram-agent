import {spawn} from 'node:child_process';
import {mkdtemp,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ATTACHMENT_LIMITS,AttachmentError} from '../contracts.ts';
import type {AttachmentReader,DownloadedAttachment,InputImage,PreparedAttachment} from '../contracts.ts';

const unavailable='Не удалось прочитать файл. Проверьте формат или разделите материалы.';
const split='Материалы превышают лимит. Разделите их на несколько заданий.';
const cancelled='Чтение вложений отменено.';

/** Uploaded bytes cross an inherited FD; user filenames are display metadata. */
export class SandboxedAttachmentReader implements AttachmentReader {
  private readonly pythonPath:string;
  constructor(options:{pythonPath?:string}={}) { this.pythonPath=resolve(options.pythonPath??'.venv/bin/python'); }

  async prepare(files:DownloadedAttachment[],signal:AbortSignal):Promise<PreparedAttachment[]> {
    try {return await this.prepareBatch(files,signal);}
    catch(error) {if(error instanceof AttachmentError)throw error;throw new AttachmentError(unavailable);}
  }

  private async prepareBatch(files:DownloadedAttachment[],signal:AbortSignal):Promise<PreparedAttachment[]> {
    if(signal.aborted)throw new AttachmentError(cancelled);
    if(files.length>ATTACHMENT_LIMITS.files||files.some(file=>file.bytes.byteLength>ATTACHMENT_LIMITS.fileBytes)||files.reduce((sum,file)=>sum+file.bytes.byteLength,0)>ATTACHMENT_LIMITS.batchBytes)throw new AttachmentError(split);
    if(files.some(file=>file.name.length>4096||file.mime.length>256))throw new AttachmentError(unavailable);
    const prepared:PreparedAttachment[]=[];
    let imageCount=0,imageBytes=0,textBytes=0;
    for(const file of files) {
      const result=await this.read(file,signal);
      textBytes+=Buffer.byteLength(result.text); imageCount+=result.images.length;
      for(const image of result.images)imageBytes+=Buffer.from(image.base64,'base64').length;
      if(textBytes>ATTACHMENT_LIMITS.textBytes||imageCount>ATTACHMENT_LIMITS.images||imageBytes>ATTACHMENT_LIMITS.imageBytes)throw new AttachmentError(split);
      prepared.push(result);
    }
    return prepared;
  }

  private async read(file:DownloadedAttachment,signal:AbortSignal):Promise<PreparedAttachment> {
    const directory=await mkdtemp(join(tmpdir(),'verfix-attachment-'));
    const path=join(directory,'input');
    let input:Awaited<ReturnType<typeof open>>|undefined;
    try {
      const output=await open(path,'wx',0o600);
      try {await output.writeFile(file.bytes);} finally {await output.close();}
      input=await open(path,'r');
      if(signal.aborted)throw new AttachmentError(cancelled);
      const runner=fileURLToPath(new URL('../../src/compute/runner.py',import.meta.url));
      const result=await new Promise<unknown>((accept,reject)=>{
        const child=spawn(this.pythonPath,[runner,String(process.pid),'--attachment'],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe',input!.fd]});
        let size=0,failed=false;const chunks:Buffer[]=[];
        const stop=()=>{failed=true;child.kill('SIGTERM');};
        const timer=setTimeout(stop,60_000);
        signal.addEventListener('abort',stop,{once:true});
        child.stdin!.on('error',()=>{});
        child.stdout!.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>10*1024*1024)stop();else chunks.push(chunk);});
        child.stderr!.on('data',()=>{});
        child.on('error',()=>{failed=true;});
        child.on('close',(code)=>{
          clearTimeout(timer);signal.removeEventListener('abort',stop);
          if(signal.aborted)return reject(new AttachmentError(cancelled));
          try {if(failed||code!==0)throw new Error();accept(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
          catch {reject(new AttachmentError(unavailable));}
        });
        child.stdin!.end(JSON.stringify({name:file.name,mime:file.mime}));
        if(signal.aborted)stop();
      });
      return this.validate(result,file.name);
    } finally {await input?.close();await rm(directory,{recursive:true,force:true});}
  }

  private validate(value:unknown,name:string):PreparedAttachment {
    const data=value as {text?:unknown;images?:unknown;error?:unknown};
    if(!data||typeof data!=='object')throw new AttachmentError(unavailable);
    if(typeof data.error==='string')throw new AttachmentError(data.error===split?split:unavailable);
    if(typeof data.text!=='string'||Buffer.byteLength(data.text)>ATTACHMENT_LIMITS.textBytes||!Array.isArray(data.images)||data.images.length>ATTACHMENT_LIMITS.images)throw new AttachmentError(unavailable);
    let total=0;
    const images:InputImage[]=data.images.map((value:unknown,index:number)=>{
      const image=value as {mime?:unknown;base64?:unknown};
      if(!image||typeof image.base64!=='string'||!['image/png','image/jpeg'].includes(String(image.mime))||image.base64.length>8_000_000||image.base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(image.base64))throw new AttachmentError(unavailable);
      const bytes=Buffer.from(image.base64,'base64'); total+=bytes.length;
      if(total>ATTACHMENT_LIMITS.imageBytes||bytes.length<16||bytes.toString('base64')!==image.base64)throw new AttachmentError(unavailable);
      if(image.mime==='image/png'){
        if(bytes.length<33||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.subarray(12,16).toString()!=='IHDR')throw new AttachmentError(unavailable);
        const w=bytes.readUInt32BE(16),h=bytes.readUInt32BE(20);
        if(!w||!h||w>2048||h>2048)throw new AttachmentError(unavailable);
      }else {
        if(bytes[0]!==255||bytes[1]!==216||bytes[2]!==255||bytes.at(-2)!==255||bytes.at(-1)!==217)throw new AttachmentError(unavailable);
        // Inspect bounded JPEG marker metadata without decoding pixels on the
        // host. Our guest emits only baseline JPEG (SOF0), never raw uploads.
        let offset=2,dimensions=false;
        while(offset+4<=bytes.length){
          if(bytes[offset++]!==255)throw new AttachmentError(unavailable);
          const marker=bytes[offset++];
          if(marker===0xda||marker===0xd9)break;
          const length=bytes.readUInt16BE(offset);
          if(length<2||offset+length>bytes.length)throw new AttachmentError(unavailable);
          if(marker===0xc0){
            if(length<8)throw new AttachmentError(unavailable);
            const h=bytes.readUInt16BE(offset+3),w=bytes.readUInt16BE(offset+5);
            if(!w||!h||w>2048||h>2048)throw new AttachmentError(unavailable);
            dimensions=true;break;
          }
          offset+=length;
        }
        if(!dimensions)throw new AttachmentError(unavailable);
      }
      const mime=image.mime as InputImage['mime'];
      return {name:`${name} — ${index+1}.${mime==='image/png'?'png':'jpg'}`,mime,base64:image.base64};
    });
    return {name,text:data.text,images};
  }
}
