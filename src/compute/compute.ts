import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { GeneratedImage } from '../contracts.ts';

/** OS boundary: generated Python is data until the trusted launcher enters bwrap. */
export async function compute(code:string,pythonPath:string,signal:AbortSignal):Promise<{success:boolean;stdout:string;stderr:string;images:GeneratedImage[]}>{
  if(Buffer.byteLength(code)>65536||signal.aborted)throw new Error('Calculation rejected');
  // tsc does not copy Python. Source distribution remains alongside dist/.
  const runner=fileURLToPath(new URL('../../src/compute/runner.py',import.meta.url));
  return new Promise((resolveResult,reject)=>{
    const child=spawn(resolve(pythonPath),[runner,String(process.pid)],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:'pipe'});
    const chunks:Buffer[]=[];let size=0,failed=false;
    const stop=()=>{failed=true;child.kill('SIGTERM');};
    const timer=setTimeout(stop,60000);
    signal.addEventListener('abort',stop,{once:true});
    child.stdin.on('error',()=>{});
    child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>9*1024*1024)stop();else chunks.push(chunk);});
    child.stderr.on('data',()=>{});
    child.on('error',()=>{failed=true;});
    child.on('close',()=>{
      clearTimeout(timer);signal.removeEventListener('abort',stop);
      try{
        if(failed||signal.aborted)throw new Error();
        const data=JSON.parse(Buffer.concat(chunks).toString());
        if(typeof data.success!=='boolean'||typeof data.stdout!=='string'||typeof data.stderr!=='string'||!Array.isArray(data.images)||data.images.length>4||data.stdout.length+data.stderr.length>131072)throw new Error();
        let total=0;
        const images:GeneratedImage[]=data.images.map((image:any,index:number)=>{
          if(typeof image.base64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(image.base64))throw new Error();
          const bytes=Buffer.from(image.base64,'base64');total+=bytes.length;
          if(bytes.length<33||bytes.length>2*1024*1024||total>6*1024*1024||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.subarray(12,16).toString()!=='IHDR')throw new Error();
          const w=bytes.readUInt32BE(16),h=bytes.readUInt32BE(20);
          if(!w||!h||w>4096||h>4096||w*h>16000000)throw new Error();
          return {bytes,name:`calculation-${index+1}.png`,mime:'image/png'};
        });
        resolveResult({success:data.success,stdout:data.stdout,stderr:data.stderr,images});
      }catch{reject(new Error('Calculation unavailable or resource limit exceeded'));}
    });
    child.stdin.end(JSON.stringify({code}));
  });
}
