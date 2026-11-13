import { mkdir,writeFile,readFile,chmod,rm,rename } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { DialogueAddress, ModelEngine,ModelInfo,ModelRequest,ModelResponse,EngineHealth,GeneratedImage,PreparedAttachment } from '../contracts.ts';
import { AttachmentError,ATTACHMENT_LIMITS,ImageGenerationError,GENERATED_IMAGE_LIMITS } from '../contracts.ts';
import { compute } from '../compute/compute.ts';
import { Rpc } from './rpc.ts';
import { nativePng } from './images.ts';

export interface CodexEngineOptions {runtimeDir:string;pythonPath?:string;codexCommand?:string;}
type UserInput = {type:'text';text:string;text_elements:[]} | {type:'image';url:string};

function validateAttachments(attachments:PreparedAttachment[]){
  const tooLarge=()=>{throw new AttachmentError('Слишком много материалов для одного задания. Разделите материалы на части.');};
  if(!Array.isArray(attachments)||attachments.length>ATTACHMENT_LIMITS.files)tooLarge();
  let textBytes=0,imageBytes=0;
  for(const attachment of attachments){
    if(typeof attachment.name!=='string'||typeof attachment.text!=='string'||!Array.isArray(attachment.images))throw new AttachmentError('Не удалось прочитать подготовленное вложение. Отправьте его повторно.');
    textBytes+=Buffer.byteLength(attachment.text);
    if(textBytes>ATTACHMENT_LIMITS.textBytes)tooLarge();
    for(const image of attachment.images){
      if(typeof image.name!=='string'||!['image/png','image/jpeg'].includes(image.mime)||typeof image.base64!=='string'||!image.base64||image.base64.length%4!==0||image.base64.length>Math.ceil(ATTACHMENT_LIMITS.imageBytes/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(image.base64))throw new AttachmentError('Не удалось прочитать подготовленное изображение. Отправьте его повторно.');
      // Base64 and magic bytes are cheap metadata checks. Image decoding only
      // happens in the sandboxed AttachmentReader, never in this host process.
      const bytes=Buffer.from(image.base64,'base64');
      if(bytes.toString('base64')!==image.base64||(image.mime==='image/png'?bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a':bytes.subarray(0,3).toString('hex')!=='ffd8ff'))throw new AttachmentError('Не удалось прочитать подготовленное изображение. Отправьте его повторно.');
      imageBytes+=bytes.length;
      if(imageBytes>ATTACHMENT_LIMITS.imageBytes)tooLarge();
    }
  }
}

function attachmentInput(attachments:PreparedAttachment[]):UserInput[]{
  const input:UserInput[]=[];
  for(const attachment of attachments){
    input.push({type:'text',text:`Attachment ${JSON.stringify(attachment.name)} (quoted user material):\n${attachment.text}`,text_elements:[]});
    for(const image of attachment.images){
      input.push({type:'text',text:`Image ${JSON.stringify(image.name)} from attachment ${JSON.stringify(attachment.name)}:`,text_elements:[]});
      input.push({type:'image',url:`data:${image.mime};base64,${image.base64}`});
    }
  }
  return input;
}

function requestInput(request:ModelRequest,rebuild:boolean):UserInput[]{
  const input:UserInput[]=[];
  const groups:PreparedAttachment[][]=[];
  if(rebuild&&request.history?.length){
    input.push({type:'text',text:'Completed conversation for context (quoted user and assistant data):',text_elements:[]});
    for(const message of request.history){
      const attachments=message.attachments??[];
      validateAttachments(attachments);groups.push(attachments);
      input.push({type:'text',text:`${message.role}:\n${message.text}`,text_elements:[]},...attachmentInput(attachments));
    }
    input.push({type:'text',text:'Current user message:',text_elements:[]});
  }
  const attachments=request.attachments??[];
  validateAttachments(attachments);groups.push(attachments);
  if(Buffer.byteLength(JSON.stringify(groups))>ATTACHMENT_LIMITS.dialogueBytes)throw new AttachmentError('Контекст материалов слишком большой. Начните новый диалог или разделите материалы на части.');
  input.push({type:'text',text:request.text,text_elements:[]},...attachmentInput(attachments));
  // Reserve room for the RPC envelope and scope in the 24 MiB transport cap.
  if(Buffer.byteLength(JSON.stringify(input))>23*1024*1024)throw new AttachmentError('Слишком большой контекст задания. Разделите материалы на части или начните новый диалог.');
  return input;
}
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
    // are disabled individually except native image generation; filesystem grants remain minimal.
    await writeFile(join(home,'config.toml'),`approval_policy = "never"\ndefault_permissions = "bot"\nweb_search = "live"\n[features]\nshell_tool = false\nview_image = false\napps = false\nplugins = false\nhooks = false\ncomputer_use = false\nin_app_browser = false\nimage_generation = true\nomit_app_server_notification_media = false\nmulti_agent = false\nmemories = false\ncode_mode = false\ncode_mode_host = true\nbrowser_use = false\nbrowser_use_external = false\nbrowser_use_full_cdp_access = false\nrequest_permissions_tool = false\nskill_search = false\nskill_mcp_dependency_install = false\nskip_host_skill_discovery = true\nshell_snapshot = false\ngoals = false\nsleep_tool = false\n[permissions.bot.filesystem]\n":minimal" = "read"\n${JSON.stringify(cwd)} = "read"\n[permissions.bot.network]\nenabled = false\n`,{mode:0o600});
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH??'/usr/bin:/bin',HOME:dir,CODEX_HOME:home,LANG:'C.UTF-8'};
    if(this.closed||signal?.aborted)throw new Error('Codex unavailable');
    const rpc=new Rpc(this.command,cwd,env);this.workers.add(rpc);
    rpc.onFrame=frame=>{if(frame.id!==undefined)rpc.send({id:frame.id,error:{code:-32601,message:'Request denied'}});};
    const cancel=()=>rpc.stop();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    try{await rpc.initialize();if(signal?.aborted)throw new Error();return {rpc,cwd};}
    catch{rpc.stop();this.workers.delete(rpc);throw new Error('Codex unavailable');}
    finally{signal?.removeEventListener('abort',cancel);}
  }
  async listModels(signal?:AbortSignal):Promise<ModelInfo[]>{
    const {rpc}=await this.worker(join(this.root,'catalog'),signal);
    const cancel=()=>rpc.stop();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    try{
      const all:ModelInfo[]=[];let cursor:string|null=null;
      do{
        const page=await rpc.request('model/list',{cursor,limit:100,includeHidden:false});
        for(const m of page.data)all.push({id:m.model,displayName:m.displayName,supportedEfforts:m.supportedReasoningEfforts.map((x:any)=>x.reasoningEffort),defaultEffort:m.defaultReasoningEffort});
        cursor=page.nextCursor;
        if(all.length>1000)throw new Error('Codex catalog too large');
      }while(cursor);
      return all;
    }finally{signal?.removeEventListener('abort',cancel);rpc.stop();this.workers.delete(rpc);}
  }
  async health(signal?:AbortSignal):Promise<EngineHealth>{
    try{const {rpc}=await this.worker(join(this.root,'health'),signal);const cancel=()=>rpc.stop();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();try{const r=await rpc.request('account/read',{refreshToken:false});return {available:!!r.account,detail:r.account?'Codex ready':'ChatGPT authentication required'};}finally{signal?.removeEventListener('abort',cancel);rpc.stop();this.workers.delete(rpc);}}
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
      if(state.userId!==request.userId || state.topicId!==request.topicId)throw new Error('Dialog unavailable');
      if(state.status!=='completed'){
        await this.deleteThread(id);id=randomUUID();dir=this.threadDir(id);state=undefined;
      }
    }
    const input=requestInput(request,!state);
    const abort=new AbortController();let markDone:()=>void=()=>{};
    if(request.signal.aborted)throw new Error('Request cancelled');
    const done=new Promise<void>(resolve=>{markDone=resolve;});this.active.set(id,{abort,done});
    const cancel=()=>abort.abort();request.signal.addEventListener('abort',cancel,{once:true});if(request.signal.aborted)cancel();
    let rpc:Rpc|undefined;
    const computations=new Set<Promise<void>>();
    const stopWorker=()=>rpc?.stop();abort.signal.addEventListener('abort',stopWorker,{once:true});
    try{
      // A durable owner must know the allocation before any new native files exist.
      // Existing contexts are marked interrupted before a potentially cancelled resume.
      if(state)await this.save(dir,{...state,status:'running'});
      await request.onThread(id);
      if(abort.signal.aborted)throw new Error('Request cancelled');
      await mkdir(dir,{recursive:true,mode:0o700});
      ({rpc}=await this.worker(dir,abort.signal));const connection=rpc;
      if(abort.signal.aborted)throw new Error('Request cancelled');
      if(input.some(item=>item.type==='image')){
        let cursor:string|null=null,matched=false,seen=0;
        do{
          const page=await rpc.request('model/list',{cursor,limit:100,includeHidden:false});
          const model=page.data.find((model:any)=>model.model===request.model);
          if(model){matched=Array.isArray(model.inputModalities)&&model.inputModalities.includes('image');break;}
          seen+=page.data.length;if(seen>1000)break;cursor=page.nextCursor;
        }while(cursor);
        if(!matched)throw new AttachmentError('Выбранная модель недоступна или не поддерживает изображения. Выберите модель с поддержкой изображений.');
      }
      const cwd=join(dir,'empty');
      const developerInstructions='Respond to the user in ordinary Markdown. Cite web sources as descriptive Markdown links to public URLs; internal citation tokens do not render in Telegram. Use the native tools.image_gen__imagegen tool for artwork, illustrations, posters and image editing. Use isolated_compute Python for numerical calculations and scientific plots, never as a substitute for native artwork. Image generation uses the current ChatGPT authorization and its model/account limits; if the native tool is unavailable, explain that limitation. Never ask for an API key or silently switch billing routes. For image editing use num_last_images_to_include for images in this conversation only; never use local reference paths. Computations use isolated_compute only. Generated PNG attachments are already delivered with your answer; do not link local paths.';
      const scope={model:request.model,permissions:'bot',approvalPolicy:'never',cwd,runtimeWorkspaceRoots:[cwd]};
      const thread=state?.nativeId
        ?await rpc.request('thread/resume',{...scope,threadId:state.nativeId,excludeTurns:true,developerInstructions})
        :await rpc.request('thread/start',{...scope,allowProviderModelFallback:false,ephemeral:false,environments:[],developerInstructions,dynamicTools:[{type:'function',name:'isolated_compute',description:'Execute Python calculations in a temporary isolated environment with numpy, sympy, matplotlib and Pillow. Write PNG images to the prepared files /work/result.png, /work/image-2.png through image-4.png to attach them. Eight existing scratch files /work/scratch-0.txt through scratch-7.txt can hold temporary data; creating other files/directories is denied. No network, host files or subprocesses. The code receives no prior files.',inputSchema:{type:'object',properties:{code:{type:'string'}},required:['code'],additionalProperties:false}}]});
      const nativeId=thread.thread.id as string;
      await this.save(dir,{userId:request.userId,topicId:request.topicId,nativeId,status:'running'});
      if(abort.signal.aborted)throw new Error('Request cancelled');
      const events:any[]=[];let turnId:string|undefined;const items=new Map<string,string>();
      const images:GeneratedImage[]=[];let imageBytes=0;
      const nativeImages=new Map<string,GeneratedImage|undefined>();let nativeBytes=0,nativeError:ImageGenerationError|undefined;
      const calls=new Set<string>();let computing=false;
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
      const recordImage=(item:any,completedItem:boolean)=>{
        try{
          if(typeof item.id!=='string'||!item.id||item.id.length>1024)throw new ImageGenerationError('Не удалось получить корректное изображение от Codex. Попробуйте повторить запрос.');
          if(!nativeImages.has(item.id)){
            if(nativeImages.size>=GENERATED_IMAGE_LIMITS.nativeImages)throw new ImageGenerationError('Codex вернул слишком много изображений. Попросите не более четырёх за один запрос.');
            nativeImages.set(item.id,undefined);
          }
          if(!completedItem)return;
          if(item.status!=='completed'||item.failure){
            throw new ImageGenerationError(item.failure?.type==='usageLimitExceeded'?'Достигнут лимит генерации изображений Codex. Попробуйте позднее.':'Не удалось завершить генерацию изображения в Codex. Попробуйте повторить запрос.');
          }
          if(nativeImages.get(item.id))return;
          const bytes=nativePng(item.result,GENERATED_IMAGE_LIMITS.totalBytes-nativeBytes);
          if(nativeBytes+bytes.length>GENERATED_IMAGE_LIMITS.totalBytes)throw new ImageGenerationError('Изображения Codex слишком большие для одного ответа. Попросите меньше изображений.');
          nativeBytes+=bytes.length;nativeImages.set(item.id,{bytes,name:'',mime:'image/png'});
        }catch(error){nativeError??=error instanceof ImageGenerationError?error:new ImageGenerationError('Не удалось получить корректное изображение от Codex. Попробуйте повторить запрос.');}
      };
      const recordItem=(item:any)=>{
        if(item?.type==='imageGeneration')recordImage(item,true);
        if(item?.type==='agentMessage'&&(item.phase===null||item.phase==='final_answer'))items.set(item.id,item.text);
      };
      const consume=(f:any)=>{
        if(f.id!==undefined){const task=handleTool(f);computations.add(task);void task.finally(()=>computations.delete(task));return;}
        if(f.params?.threadId!==nativeId)return;
        if(!turnId){events.push(f);return;}
        if(f.params.turnId!==undefined&&f.params.turnId!==turnId)return;
        if(f.method==='item/started'&&f.params.turnId===turnId&&f.params.item?.type==='imageGeneration')recordImage(f.params.item,false);
        if(f.method==='item/completed'&&f.params.turnId===turnId)recordItem(f.params.item);
        if(f.method==='turn/completed'&&f.params.turn.id===turnId){
          for(const item of f.params.turn.items??[])recordItem(item);
          if(f.params.turn.status!=='completed'){
            const error=new ImageGenerationError('Не удалось завершить генерацию изображения в Codex. Попробуйте повторить запрос.');
            if(f.params.turn.status!=='failed'||![...nativeImages.values()].some(image=>!!image)){
              fail(nativeError??(nativeImages.size?error:new Error('Codex request failed')));return;
            }
            nativeError??=error;
          }
          if([...nativeImages.values()].some(image=>!image)){
            nativeError??=new ImageGenerationError('Не удалось завершить генерацию изображения в Codex. Попробуйте повторить запрос.');
          }
          if(nativeError&&![...nativeImages.values()].some(image=>!!image)){fail(nativeError);return;}
          finish(f.params.turn);
        }
      };
      connection.onFrame=f=>{
        if(!turnId){events.push(f);return;}
        consume(f);
      };
      const started=await rpc.request('turn/start',{...scope,threadId:nativeId,input,effort:request.effort,environments:[]});
      turnId=started.turn.id;
      for(const event of events)consume(event);
      const turn=await completed;
      abort.signal.removeEventListener('abort',stop);
      if(abort.signal.aborted)throw new Error('Request cancelled');
      let answer=[...items.values()].join('\n\n').trim()||(nativeImages.size?'Изображения готовы.':'');if(!answer)throw new Error('Codex returned an empty answer');
      if(nativeError)answer+='\n\nГотова только часть изображений. '+nativeError.message;
      // A failed turn may have usable images, but must not be resumed as a
      // completed conversation. The existing rebuild path handles the next request.
      if(turn.status==='completed')await this.save(dir,{userId:request.userId,topicId:request.topicId,nativeId,status:'completed'});
      images.push(...[...nativeImages.values()].filter((image):image is GeneratedImage=>!!image).map((image,index)=>({...image,name:`generated-image-${index+1}.png`})));
      return {text:answer,threadId:id,images};
    }catch(error){if(!abort.signal.aborted&&(error instanceof AttachmentError||error instanceof ImageGenerationError))throw error;throw new Error(abort.signal.aborted?'Request cancelled':'Codex request failed');}
    finally{abort.signal.removeEventListener('abort',stopWorker);request.signal.removeEventListener('abort',cancel);rpc?.stop();if(rpc)this.workers.delete(rpc);await Promise.allSettled(computations);this.active.delete(id);markDone();}
  }
  /** Only the migration path may assign an unscoped legacy thread to a topic. */
  async bindLegacyThread(threadId:string,address:DialogueAddress):Promise<void>{
    const dir=this.threadDir(threadId);
    const state=JSON.parse(await readFile(join(dir,'state.json'),'utf8'));
    if(!address.topicId || state.userId!==address.userId || (state.topicId!==undefined && state.topicId!==address.topicId) || this.active.has(threadId))throw new Error('Dialog unavailable');
    await this.save(dir,{...state,topicId:address.topicId});
  }
  async deleteThread(threadId:string):Promise<void>{
    const dir=this.threadDir(threadId);const active=this.active.get(threadId);active?.abort.abort();
    await active?.done;
    await rm(dir,{recursive:true,force:true});
  }
  async close(){this.closed=true;for(const job of this.active.values())job.abort.abort();for(const rpc of this.workers)rpc.stop();this.workers.clear();await Promise.all([...this.active.values()].map(job=>job.done));}
}
