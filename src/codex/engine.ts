import { mkdir,writeFile,readFile,chmod,rm,rename } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { ModelEngine,ModelInfo,ModelRequest,ModelResponse,EngineHealth,GeneratedImage } from '../contracts.ts';
import { compute } from '../compute/compute.ts';
import { Rpc } from './rpc.ts';

export interface CodexEngineOptions {runtimeDir:string;pythonPath?:string;codexCommand?:string;}
export class CodexEngine implements ModelEngine {
  private root:string;
  private command:string;
  private pythonPath:string;
  private workers=new Set<Rpc>();
  private active=new Map<string,{abort:AbortController;done:Promise<void>}>();
  private closed=false;
  constructor(options:CodexEngineOptions){this.root=resolve(options.runtimeDir,'codex');this.command=options.codexCommand??'codex';this.pythonPath=options.pythonPath??resolve('.venv/bin/python');}
  private async worker(dir:string,signal?:AbortSignal){
    if(this.closed||signal?.aborted)throw new Error('Codex unavailable');
    const home=join(dir,'home'),cwd=join(dir,'empty');
    await mkdir(home,{recursive:true,mode:0o700});await mkdir(cwd,{recursive:true,mode:0o700});
    await chmod(dir,0o700);
    try{await readFile(join(home,'auth.json'));}catch{try{
      const source=JSON.parse(await readFile(join(homedir(),'.codex','auth.json'),'utf8'));
      if(source.auth_mode==='chatgpt'&&source.tokens){
        const tokens=Object.fromEntries(['id_token','access_token','refresh_token','account_id'].filter(key=>typeof source.tokens[key]==='string').map(key=>[key,source.tokens[key]]));
        await writeFile(join(home,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens,last_refresh:source.last_refresh}),{mode:0o600});
      }
    }catch{/* account/read reports missing authentication */}}
    // Current models route function calls through the isolated code-mode host;
    // disabling that host disables even our external dynamic tool. Native tools
    // remain disabled individually and filesystem grants remain minimal.
    await writeFile(join(home,'config.toml'),`approval_policy = "never"\ndefault_permissions = "bot"\nweb_search = "live"\n[features]\nshell_tool = false\nview_image = false\napps = false\nplugins = false\nhooks = false\ncomputer_use = false\nin_app_browser = false\nimage_generation = false\nmulti_agent = false\nmemories = false\ncode_mode = false\ncode_mode_host = true\nbrowser_use = false\nbrowser_use_external = false\nbrowser_use_full_cdp_access = false\nrequest_permissions_tool = false\nskill_search = false\nskill_mcp_dependency_install = false\nskip_host_skill_discovery = true\nshell_snapshot = false\ngoals = false\nsleep_tool = false\n[permissions.bot.filesystem]\n":minimal" = "read"\n${JSON.stringify(cwd)} = "read"\n[permissions.bot.network]\nenabled = false\n`,{mode:0o600});
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH??'/usr/bin:/bin',HOME:dir,CODEX_HOME:home,LANG:'C.UTF-8'};
    if(this.closed||signal?.aborted)throw new Error('Codex unavailable');
    const rpc=new Rpc(this.command,cwd,env);this.workers.add(rpc);
    rpc.onFrame=frame=>{if(frame.id!==undefined)rpc.send({id:frame.id,error:{code:-32601,message:'Request denied'}});};
    const cancel=()=>rpc.stop();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    try{await rpc.initialize();if(signal?.aborted)throw new Error();return {rpc,cwd};}
    catch{rpc.stop();this.workers.delete(rpc);throw new Error('Codex unavailable');}
    finally{signal?.removeEventListener('abort',cancel);}
  }
  async listModels():Promise<ModelInfo[]>{
    const {rpc}=await this.worker(join(this.root,'catalog'));
    try{
      const all:ModelInfo[]=[];let cursor:string|null=null;
      do{
        const page=await rpc.request('model/list',{cursor,limit:100,includeHidden:false});
        for(const m of page.data)all.push({id:m.model,displayName:m.displayName,supportedEfforts:m.supportedReasoningEfforts.map((x:any)=>x.reasoningEffort),defaultEffort:m.defaultReasoningEffort});
        cursor=page.nextCursor;
        if(all.length>1000)throw new Error('Codex catalog too large');
      }while(cursor);
      return all;
    }finally{rpc.stop();this.workers.delete(rpc);}
  }
  async health():Promise<EngineHealth>{
    try{const {rpc}=await this.worker(join(this.root,'health'));try{const r=await rpc.request('account/read',{refreshToken:false});return {available:!!r.account,detail:r.account?'Codex ready':'ChatGPT authentication required'};}finally{rpc.stop();this.workers.delete(rpc);}}
    catch{return {available:false,detail:'Codex unavailable'};}
  }
  private threadDir(id:string){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))throw new Error('Invalid dialog');
    return join(this.root,'dialogs',id);
  }
  private async save(dir:string,state:unknown){
    const path=join(dir,'state.json');await writeFile(path+'.tmp',JSON.stringify(state),{mode:0o600});await rename(path+'.tmp',path);
  }
  async run(request:ModelRequest):Promise<ModelResponse>{
    if(this.closed||request.signal.aborted)throw new Error('Request cancelled');
    let id=request.threadId??randomUUID(),dir=this.threadDir(id);
    if(this.active.has(id))throw new Error('Dialog busy');
    let state:any;
    if(request.threadId){
      try{state=JSON.parse(await readFile(join(dir,'state.json'),'utf8'));}catch{throw new Error('Dialog unavailable');}
      if(state.userId!==request.userId)throw new Error('Dialog unavailable');
      if(state.status!=='completed'){
        await this.deleteThread(id);id=randomUUID();dir=this.threadDir(id);state=undefined;
      }
    }
    const abort=new AbortController();let markDone:()=>void=()=>{};
    if(request.signal.aborted)throw new Error('Request cancelled');
    const done=new Promise<void>(resolve=>{markDone=resolve;});this.active.set(id,{abort,done});
    const cancel=()=>abort.abort();request.signal.addEventListener('abort',cancel,{once:true});if(request.signal.aborted)cancel();
    let rpc:Rpc|undefined;
    const computations=new Set<Promise<void>>();
    const stopWorker=()=>rpc?.stop();abort.signal.addEventListener('abort',stopWorker,{once:true});
    const deadline=setTimeout(()=>abort.abort(),600000);
    try{
      await mkdir(dir,{recursive:true,mode:0o700});
      ({rpc}=await this.worker(dir,abort.signal));const connection=rpc;
      if(abort.signal.aborted)throw new Error('Request cancelled');
      const cwd=join(dir,'empty');
      const scope={model:request.model,permissions:'bot',approvalPolicy:'never',cwd,runtimeWorkspaceRoots:[cwd]};
      const thread=state?.nativeId
        ?await rpc.request('thread/resume',{...scope,threadId:state.nativeId,excludeTurns:true})
        :await rpc.request('thread/start',{...scope,allowProviderModelFallback:false,ephemeral:false,environments:[],developerInstructions:'Respond to the user in ordinary Markdown. Cite web sources as descriptive Markdown links to public URLs; internal citation tokens do not render in Telegram. Computations use isolated_compute only. Generated PNG attachments are already delivered with your answer; do not link local paths.',dynamicTools:[{type:'function',name:'isolated_compute',description:'Execute Python calculations in a temporary isolated environment with numpy, sympy, matplotlib and Pillow. Write PNG images to the prepared files /work/result.png, /work/image-2.png through image-4.png to attach them. Eight existing scratch files /work/scratch-0.txt through scratch-7.txt can hold temporary data; creating other files/directories is denied. No network, host files or subprocesses. The code receives no prior files.',inputSchema:{type:'object',properties:{code:{type:'string'}},required:['code'],additionalProperties:false}}]});
      const nativeId=thread.thread.id as string;
      await this.save(dir,{userId:request.userId,nativeId,status:'running'});
      await request.onThread(id);
      if(abort.signal.aborted)throw new Error('Request cancelled');
      const events:any[]=[];let turnId:string|undefined;const items=new Map<string,string>();
      const images:GeneratedImage[]=[];let imageBytes=0;const calls=new Set<string>();let computing=false;
      let finish:(x:any)=>void=()=>{},fail:(e:Error)=>void=()=>{};
      const completed=new Promise<any>((resolve,reject)=>{finish=resolve;fail=reject;});
      // The completion promise may reject while awaiting the turn/start RPC.
      void completed.catch(()=>{});
      const stop=()=>{fail(new Error('Request cancelled'));connection.stop();};
      abort.signal.addEventListener('abort',stop,{once:true});
      connection.onClose=()=>fail(new Error('Codex unavailable'));
      const handleTool=async(f:any)=>{
        const p=f.params;
        if(f.method!=='item/tool/call'||p?.threadId!==nativeId||p.turnId!==turnId||p.tool!=='isolated_compute'||(p.namespace!==undefined&&p.namespace!==null)||typeof p.callId!=='string'||calls.has(p.callId)||calls.size>=16||computing||abort.signal.aborted||typeof p.arguments?.code!=='string'||Object.keys(p.arguments).length!==1){
          connection.send({id:f.id,error:{code:-32601,message:'Request denied'}});return;
        }
        calls.add(p.callId);computing=true;
        try{
          const result=await compute(p.arguments.code,this.pythonPath,abort.signal);
          const bytes=result.images.reduce((sum,image)=>sum+image.bytes.length,0);
          if(images.length+result.images.length>4||imageBytes+bytes>6*1024*1024)throw new Error();
          imageBytes+=bytes;images.push(...result.images);
          const contentItems:any[]=[{type:'inputText',text:JSON.stringify({stdout:result.stdout,stderr:result.stderr,images:result.images.map(i=>i.name)})}];
          for(const image of result.images)contentItems.push({type:'inputImage',imageUrl:'data:image/png;base64,'+Buffer.from(image.bytes).toString('base64')});
          if(connection.alive&&!abort.signal.aborted)connection.send({id:f.id,result:{contentItems,success:result.success}});
        }catch{
          if(connection.alive&&!abort.signal.aborted)connection.send({id:f.id,result:{contentItems:[{type:'inputText',text:'Calculation unavailable or resource limit exceeded'}],success:false}});
        }finally{computing=false;}
      };
      const consume=(f:any)=>{
        if(f.id!==undefined){const task=handleTool(f);computations.add(task);void task.finally(()=>computations.delete(task));return;}
        if(f.params?.threadId!==nativeId)return;
        if(!turnId){events.push(f);return;}
        if(f.params.turnId!==undefined&&f.params.turnId!==turnId)return;
        if(f.method==='item/completed'){
          const item=f.params.item;
          if(item.type==='agentMessage'&&(item.phase===null||item.phase==='final_answer'))items.set(item.id,item.text);
        }
        if(f.method==='turn/completed'&&f.params.turn.id===turnId){
          if(f.params.turn.status!=='completed'){fail(new Error('Codex request failed'));return;}
          for(const item of f.params.turn.items??[])
            if(item.type==='agentMessage'&&(item.phase===null||item.phase==='final_answer'))items.set(item.id,item.text);
          finish(f.params.turn);
        }
      };
      connection.onFrame=f=>{
        if(!turnId){events.push(f);return;}
        consume(f);
      };
      let text=request.text;
      if(!state&&request.history?.length)text='Completed conversation for context (quoted data):\n'+JSON.stringify(request.history)+'\nCurrent user message:\n'+text;
      const started=await rpc.request('turn/start',{...scope,threadId:nativeId,input:[{type:'text',text,text_elements:[]}],effort:request.effort,environments:[]});
      turnId=started.turn.id;
      for(const event of events)consume(event);
      await completed;
      abort.signal.removeEventListener('abort',stop);
      if(abort.signal.aborted)throw new Error('Request cancelled');
      const answer=[...items.values()].join('\n\n');if(!answer)throw new Error('Codex returned an empty answer');
      await this.save(dir,{userId:request.userId,nativeId,status:'completed'});
      return {text:answer,threadId:id,images};
    }catch{throw new Error(abort.signal.aborted?'Request cancelled':'Codex request failed');}
    finally{clearTimeout(deadline);abort.signal.removeEventListener('abort',stopWorker);request.signal.removeEventListener('abort',cancel);rpc?.stop();if(rpc)this.workers.delete(rpc);await Promise.allSettled(computations);this.active.delete(id);markDone();}
  }
  async deleteThread(threadId:string):Promise<void>{
    const dir=this.threadDir(threadId);const active=this.active.get(threadId);active?.abort.abort();
    await active?.done;
    await rm(dir,{recursive:true,force:true});
  }
  async close(){this.closed=true;for(const job of this.active.values())job.abort.abort();for(const rpc of this.workers)rpc.stop();this.workers.clear();await Promise.all([...this.active.values()].map(job=>job.done));}
}
