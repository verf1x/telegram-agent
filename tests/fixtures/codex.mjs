#!/usr/bin/env node
import readline from 'node:readline';
import {readFileSync,writeFileSync} from 'node:fs';
const memory=process.env.CODEX_HOME+'/fake-memory';
let toolTurn;
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line); if(x.id===999&&(x.result||x.error)){send({method:'turn/completed',params:{threadId:toolTurn,turn:{id:'turn-1',status:'completed',items:[{id:'a',type:'agentMessage',phase:'final_answer',text:x.result?.contentItems[0].text??'Tool denied'}]}}});return;} if(x.id===undefined)return;
 if(x.method==='initialize')send({id:x.id,result:{}});
 else if(x.method==='model/list')send({id:x.id,result:{data:[{model:'gpt-6.1-sol',displayName:'Sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'low',inputModalities:['text','image']}],nextCursor:null}});
 else if(x.method==='account/read')send({id:x.id,result:{account:{type:'chatgpt'}}});
 else if(x.method==='thread/start'||x.method==='thread/resume')send({id:x.id,result:{thread:{id:x.params.threadId??'native-thread'}}});
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
