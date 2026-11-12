#!/usr/bin/env node
import readline from 'node:readline';
import {readFileSync,writeFileSync} from 'node:fs';
const memory=process.env.CODEX_HOME+'/fake-memory';
let toolTurn;
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line); if(x.id===999&&(x.result||x.error)){send({method:'turn/completed',params:{threadId:toolTurn,turn:{id:'turn-1',status:'completed',items:[{id:'a',type:'agentMessage',phase:'final_answer',text:x.result?.contentItems[0].text??'Tool denied'}]}}});return;} if(x.id===undefined)return;
 if(x.method==='initialize')send({id:x.id,result:{}});
 else if(x.method==='model/list')send({id:x.id,result:{data:[{model:'gpt-6.1-sol',displayName:'Sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'low'}],nextCursor:null}});
 else if(x.method==='account/read')send({id:x.id,result:{account:{type:'chatgpt'}}});
 else if(x.method==='thread/start'||x.method==='thread/resume')send({id:x.id,result:{thread:{id:x.params.threadId??'native-thread'}}});
 else if(x.method==='turn/start'){
  send({id:x.id,result:{turn:{id:'turn-1'}}});
  const text=x.params.input[0].text;
  if(text==='wait')return;
  if(text.startsWith('remember:')||text==='recall'){
   if(text.startsWith('remember:'))writeFileSync(memory,text.slice(9));
   let answer='empty';try{answer=readFileSync(memory,'utf8');}catch{}
   send({method:'turn/completed',params:{threadId:x.params.threadId,turn:{id:'turn-1',status:'completed',items:[{id:'a',type:'agentMessage',phase:'final_answer',text:answer}]}}});return;
  }
  if(text.startsWith('compute:')){toolTurn=x.params.threadId;send({id:999,method:'item/tool/call',params:{threadId:toolTurn,turnId:'turn-1',callId:'call-1',tool:'isolated_compute',arguments:{code:text.slice(8)}}});return;}
  send({method:'item/completed',params:{threadId:x.params.threadId,turnId:'turn-1',item:{id:'r',type:'reasoning',text:'private'}}});
  send({method:'item/completed',params:{threadId:x.params.threadId,turnId:'turn-1',item:{id:'c',type:'agentMessage',phase:'commentary',text:'working'}}});
  send({method:'turn/completed',params:{threadId:x.params.threadId,turn:{id:'turn-1',status:'completed',items:[{id:'a',type:'agentMessage',phase:'final_answer',text:'42'}]}}});
 } else send({id:x.id,result:{}});
});
