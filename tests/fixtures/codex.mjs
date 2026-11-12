#!/usr/bin/env node
import readline from 'node:readline';
import {crc32} from 'node:zlib';
import {readFileSync,writeFileSync} from 'node:fs';
const memory=process.env.CODEX_HOME+'/fake-memory';
let toolTurn,threadParams,threadMethod;
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const chunk=(kind,data)=>{const bytes=Buffer.alloc(data.length+12);bytes.writeUInt32BE(data.length);bytes.write(kind,4);data.copy(bytes,8);bytes.writeUInt32BE(crc32(bytes.subarray(4,-4)),bytes.length-4);return bytes;};
const paddedPng=size=>{const png=readFileSync(new URL('./attachments/tiny.png',import.meta.url));return Buffer.concat([png.subarray(0,-12),chunk('vpAg',Buffer.alloc(size-png.length-12)),png.subarray(-12)]);};
const dimensions=(width,height)=>{const png=readFileSync(new URL('./attachments/tiny.png',import.meta.url));png.writeUInt32BE(width,16);png.writeUInt32BE(height,20);png.writeUInt32BE(crc32(png.subarray(12,29)),29);return png;};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line); if(x.id===999&&(x.result||x.error)){send({method:'turn/completed',params:{threadId:toolTurn,turn:{id:'turn-1',status:'completed',items:[{id:'a',type:'agentMessage',phase:'final_answer',text:x.result?.contentItems[0].text??'Tool denied'}]}}});return;} if(x.id===undefined)return;
 if(x.method==='initialize')send({id:x.id,result:{}});
 else if(x.method==='model/list')send({id:x.id,result:{data:[{model:'gpt-6.1-sol',displayName:'Sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'low',inputModalities:['text','image']}],nextCursor:null}});
 else if(x.method==='account/read')send({id:x.id,result:{account:{type:'chatgpt'}}});
 else if(x.method==='thread/start'||x.method==='thread/resume'){threadParams=x.params;threadMethod=x.method;send({id:x.id,result:{thread:{id:x.params.threadId??'native-thread'}}});}
 else if(x.method==='turn/start'){
  send({id:x.id,result:{turn:{id:'turn-1'}}});
  const text=x.params.input[0].text;
  if(x.params.input.some(item=>item.type==='text'&&item.text==='inspect-input')){
   send({method:'turn/completed',params:{threadId:x.params.threadId,turn:{id:'turn-1',status:'completed',items:[{id:'a',type:'agentMessage',phase:'final_answer',text:JSON.stringify(x.params.input)}]}}});return;
  }
  if(x.params.input.some(item=>item.type==='text'&&item.text==='accept-large-input')){
   send({method:'item/completed',params:{threadId:x.params.threadId,turnId:'turn-1',item:{id:'u',type:'userMessage',content:x.params.input}}});
   send({method:'turn/completed',params:{threadId:x.params.threadId,turn:{id:'turn-1',status:'completed',items:[{id:'a',type:'agentMessage',phase:'final_answer',text:`native images: ${x.params.input.filter(item=>item.type==='image').length}; history tail: ${x.params.input.some(item=>item.text?.endsWith('HISTORY-END'))}`}]}}});return;
  }
  if(text.startsWith('native-image:')){
   const scenario=text.slice('native-image:'.length);
   const image=(id='image-1',file='tiny.png')=>({type:'imageGeneration',id,status:'completed',result:readFileSync(new URL('./attachments/'+file,import.meta.url)).toString('base64'),failure:null,savedPath:'/etc/passwd'});
   const event=(method,item,scope={})=>send({method,params:{threadId:x.params.threadId,turnId:'turn-1',item,...scope}});
   let items=[image(),{id:'a',type:'agentMessage',phase:'final_answer',text:'Created artwork'}];
   if(scenario==='ordered'){
    const first=image('first'),second=image('second','transparent.png');
    event('item/started',{...first,status:'in_progress',result:''});event('item/started',{...second,status:'in_progress',result:''});
    event('item/completed',second);event('item/completed',second);event('item/completed',first);
    event('item/completed',image('foreign'),{threadId:'other-thread'});event('item/completed',image('old'),{turnId:'other-turn'});
    items=[first,second,items[1]];
   }
   if(scenario==='image-only')items=[image()];
   if(scenario==='wait'){event('item/started',{...image(),status:'in_progress',result:''});return;}
   if(scenario==='completed-then-wait'){event('item/completed',image());return;}
   if(scenario==='notification-only'){event('item/completed',image());items=[items[1]];}
   if(scenario==='wrong-turn-summary')send({method:'turn/completed',params:{threadId:x.params.threadId,turn:{id:'other-turn',status:'failed',items:[image('foreign')]}}});
   if(scenario==='oversized-frame'){process.stdout.write('x'.repeat(64*1024*1024+1));return;}
   if(scenario==='unavailable')items=[{id:'a',type:'agentMessage',phase:'final_answer',text:'Native image generation is unavailable for this model. Ordinary text is available.'}];
   if(scenario==='failed'||scenario==='mixed'||scenario==='failed-turn'){
    const failed={...image('failed'),status:'failed',result:'',failure:{type:'usageLimitExceeded',limitId:'SECRET-PROVIDER-DETAIL',resetsAt:null}};
    items=scenario==='mixed'?[image(),failed,items[1]]:[failed];
   }
   if(scenario==='failed-with-result')items=[{...image(),status:'failed'}];
   if(['mixed-missing-inline','mixed-malformed','mixed-unfinished'].includes(scenario)){
    const first=image('first'),second=image('second','transparent.png'),broken={...image('broken'),result:'SECRET'};
    if(scenario==='mixed-missing-inline'){delete broken.result;broken.fileId='remote-SECRET';}
    if(scenario==='mixed-unfinished')broken.status='in_progress';
    event('item/started',{...first,status:'in_progress',result:''});
    event('item/started',{...second,status:'in_progress',result:''});
    event('item/completed',second);event('item/completed',broken);event('item/completed',first);event('item/completed',second);
    event('item/completed',image('foreign'),{threadId:'other-thread'});
    items=[first,broken,second,items[1]];
   }
   if(scenario==='in-progress')items=[{...image(),status:'in_progress'}];
   if(scenario==='started-only'){event('item/started',{...image(),status:'in_progress',result:''});items=[items[1]];}
   if(scenario==='missing-inline'){const missing=image();delete missing.result;items=[{...missing,fileId:'remote-SECRET',savedPath:new URL('./attachments/tiny.png',import.meta.url).pathname}];}
   if(scenario==='missing-result')items=[{...image(),result:''}];
   if(scenario==='too-many')items=Array.from({length:5},(_,index)=>image('image-'+index));
   if(scenario==='four')items=Array.from({length:4},(_,index)=>image('image-'+index));
   const malformed={url:'https://example.invalid/SECRET',dataurl:'data:image/png;base64,'+image().result,whitespace:image().result+'\n',invalid:'a===',truncated:Buffer.from(image().result,'base64').subarray(0,-1).toString('base64'),trailer:Buffer.concat([Buffer.from(image().result,'base64'),Buffer.from('x')]).toString('base64'),signature:Buffer.alloc(78).toString('base64'),crc:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhH8AAAAASUVORK5CYII=',dimensions:dimensions(8193,1).toString('base64'),pixels:dimensions(8192,8192).toString('base64'),zero:dimensions(0,1).toString('base64'),object:{result:image().result},noncanonical:paddedPng(100).toString('base64').slice(0,-3)+'h=='};
   if(scenario.startsWith('malformed-'))items=[{...image(),result:malformed[scenario.slice('malformed-'.length)]}];
   if(['max-budget','total-limit','image-limit'].includes(scenario)){
    const sizes=scenario==='max-budget'?[8000000,8000000,8000000]:scenario==='total-limit'?[8000000,8000000,8000001]:[12000001];
    items=sizes.map((size,index)=>({...image('large-'+index),result:paddedPng(size).toString('base64')}));
    if(scenario==='max-budget')items.unshift({id:'user-input',type:'userMessage',content:x.params.input});
   }
   if(scenario==='policy')items=[{id:'a',type:'agentMessage',phase:'final_answer',text:JSON.stringify({config:readFileSync(process.env.CODEX_HOME+'/config.toml','utf8'),threadParams,threadMethod,turnParams:x.params})}];
   send({method:'turn/completed',params:{threadId:x.params.threadId,turn:{id:'turn-1',status:['failed-turn','completed-failed-turn'].includes(scenario)?'failed':'completed',items}}});return;
  }
  if(text==='wait')return;
  if(text.startsWith('remember:')||text==='recall'){
   if(text.startsWith('remember:'))writeFileSync(memory,text.slice(9));
   let answer='empty';try{answer=readFileSync(memory,'utf8');}catch{}
   send({method:'turn/completed',params:{threadId:x.params.threadId,turn:{id:'turn-1',status:'completed',items:[{id:'a',type:'agentMessage',phase:'final_answer',text:answer}]}}});return;
  }
  if(text.startsWith('compute:')){
   // codex-cli 0.167.2 routes dynamic tools through its isolated code-mode
   // host even with the optional code_mode feature disabled.
   if(!readFileSync(process.env.CODEX_HOME+'/config.toml','utf8').includes('code_mode_host = true')){
    send({method:'turn/completed',params:{threadId:x.params.threadId,turn:{id:'turn-1',status:'completed',items:[{id:'a',type:'agentMessage',phase:'final_answer',text:'code-mode host is disabled'}]}}});return;
   }
   toolTurn=x.params.threadId;send({id:999,method:'item/tool/call',params:{threadId:toolTurn,turnId:'turn-1',callId:'call-1',tool:'isolated_compute',arguments:{code:text.slice(8)}}});return;}
  send({method:'item/completed',params:{threadId:x.params.threadId,turnId:'turn-1',item:{id:'r',type:'reasoning',text:'private'}}});
  send({method:'item/completed',params:{threadId:x.params.threadId,turnId:'turn-1',item:{id:'c',type:'agentMessage',phase:'commentary',text:'working'}}});
  send({method:'turn/completed',params:{threadId:x.params.threadId,turn:{id:'turn-1',status:'completed',items:[{id:'a',type:'agentMessage',phase:'final_answer',text:'42'}]}}});
 } else send({id:x.id,result:{}});
});
