import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

type Frame = {id?:number|string;method?:string;params?:any;result?:any;error?:unknown};
/** A bounded, newline-framed app-server connection. Error details never cross this boundary. */
export class Rpc {
  private child:ChildProcessWithoutNullStreams;
  private pending=new Map<number,{resolve:(x:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  private next=1;
  private stopped=false;
  onFrame:(frame:Frame)=>void=()=>{};
  onClose:()=>void=()=>{};
  constructor(command:string,cwd:string,env:NodeJS.ProcessEnv) {
    this.child=spawn(command,['app-server','--listen','stdio://','--strict-config'],{cwd,env,stdio:'pipe'});
    let buffer='';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',(chunk:string)=>{
      buffer+=chunk;
      if(Buffer.byteLength(buffer)>12*1024*1024){this.stop();return;}
      let index:number;
      while((index=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
        if(!line.trim())continue;
        try{
          const frame=JSON.parse(line) as Frame;
          if(frame.method){this.onFrame(frame);continue;}
          if(typeof frame.id!=='number')continue;
          const wait=this.pending.get(frame.id);if(!wait)continue;
          this.pending.delete(frame.id);clearTimeout(wait.timer);
          if(frame.error)wait.reject(new Error('Codex request failed'));else wait.resolve(frame.result);
        }catch{this.stop();}
      }
    });
    // Drain and discard: diagnostics can include credentials, prompts or local paths.
    this.child.stderr.on('data',()=>{});
    this.child.on('error',()=>this.stop());
    this.child.on('exit',()=>this.stop());
    this.child.stdin.on('error',()=>this.stop());
  }
  async initialize(){await this.request('initialize',{clientInfo:{name:'verfix_telegram_agent',version:'0.1.0'},capabilities:{experimentalApi:true,requestAttestation:false}});this.send({method:'initialized'});}
  send(frame:Frame){if(this.stopped)throw new Error('Codex unavailable');this.child.stdin.write(JSON.stringify(frame)+'\n');}
  request(method:string,params:any,timeout=30000):Promise<any>{
    if(this.stopped)return Promise.reject(new Error('Codex unavailable'));
    const id=this.next++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Codex deadline exceeded'));this.stop();},timeout);
      this.pending.set(id,{resolve,reject,timer});this.send({id,method,params});
    });
  }
  get alive(){return !this.stopped;}
  stop(){
    if(this.stopped)return;this.stopped=true;this.child.kill('SIGKILL');
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Codex unavailable'));}
    this.pending.clear();this.onClose();
  }
}
