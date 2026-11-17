import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { CodexEngine } from '../../src/codex/engine.ts';
import { RequestStopped, type ModelProgress } from '../../src/contracts.ts';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhH8AAAAASUVORK5CYII=';
test('prepared documents and images reach native input in attachment order with their complete text',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 try {
  const complete='First page\n'+('полный текст '.repeat(10000))+'\nEND';
  const response=await engine.run({userId:1,text:'inspect-input',attachments:[{name:'../scan.pdf',text:complete,images:[{name:'page-1.png',mime:'image/png',base64:png}]},{name:'notes.txt',text:'Second document',images:[]}],model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}});
  const input=JSON.parse(response.text);
  assert.deepEqual(input.filter((x:any)=>x.type==='image'),[{type:'image',url:'data:image/png;base64,'+png}]);
  const texts=input.filter((x:any)=>x.type==='text').map((x:any)=>x.text);
  assert.ok(texts.some((text:string)=>text.includes(complete)));
  assert.ok(texts.some((text:string)=>text.includes('../scan.pdf')));
  assert.ok(texts.some((text:string)=>text.includes('Second document')));
  assert.ok(texts.every((text:string)=>!text.includes(png)));
  assert.ok(input.findIndex((x:any)=>x.type==='image')<input.findIndex((x:any)=>x.text?.includes('Second document')));
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('long lecture pages all reach native input, including when restored from history',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 const attachments=[{name:'lecture.pdf',text:'Complete lecture text',images:Array.from({length:101},(_,i)=>({name:`page-${i+1}.png`,mime:'image/png' as const,base64:png}))}];
 const base={userId:1,text:'inspect-input',model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}};
 try {
  for(const material of [{attachments},{history:[{role:'user' as const,text:'Напиши конспект',attachments}]}]){
   const response=await engine.run({...base,...material});
   const input=JSON.parse(response.text);
   assert.equal(input.filter((item:any)=>item.type==='image').length,101);
   assert.ok(input.some((item:any)=>item.text?.includes('Complete lecture text')));
   const labels=input.filter((item:any)=>item.text?.startsWith('Image ')).map((item:any)=>item.text);
   assert.equal(labels.length,101);
   assert.match(labels[0],/page-1\.png/);
   assert.match(labels.at(-1),/page-101\.png/);
  }
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('resumed native dialogs retain old images and interrupted dialogs rebuild them as images',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const options={runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')};
 let engine=new CodexEngine(options);
 const base={userId:1,model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}};
 const attachments=[{name:'scan.pdf',text:'Complete saved document',images:[{name:'page.png',mime:'image/png' as const,base64:png}]}];
 const history=[{role:'user' as const,text:'Original task',attachments},{role:'assistant' as const,text:'Saved answer'}];
 try {
  const first=await engine.run({...base,text:'inspect-input',attachments});
  await engine.close();engine=new CodexEngine(options);
  const resumed=JSON.parse((await engine.run({...base,threadId:first.threadId,text:'inspect-input',history})).text);
  assert.deepEqual(resumed,[{type:'text',text:'inspect-input',text_elements:[]}]);
  const abort=new AbortController();
  await assert.rejects(engine.run({...base,threadId:first.threadId,text:'wait',
   signal:AbortSignal.any([abort.signal,AbortSignal.timeout(5000)]),onProgress:()=>abort.abort()}),/cancelled/);
  const rebuilt=await engine.run({...base,threadId:first.threadId,text:'inspect-input',history});
  assert.notEqual(rebuilt.threadId,first.threadId);
  const input=JSON.parse(rebuilt.text);
  assert.deepEqual(input.filter((item:any)=>item.type==='image'),[{type:'image',url:'data:image/png;base64,'+png}]);
  assert.ok(input.some((item:any)=>item.text?.includes('Complete saved document')));
  assert.ok(input.filter((item:any)=>item.type==='text').every((item:any)=>!item.text.includes(png)));
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('invalid and oversized inputs fail before allocation and unsupported images return an explicit error',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 let persisted=false;
 const base={userId:1,text:'inspect-input',model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{persisted=true;}};
 try {
  for(const image of [{mime:'image/png',base64:'https://api.telegram.org/file/botSECRET/x'},{mime:'image/svg+xml',base64:png}]) {
   await assert.rejects(engine.run({...base,attachments:[{name:'invalid',text:'',images:[{name:'x',...image} as any]}]}),(error:Error)=>error.name==='AttachmentError'&&!error.message.includes('SECRET'));
  }
  await assert.rejects(engine.run({...base,attachments:[{name:'big.txt',text:'x'.repeat(500001),images:[]}]}),(error:Error)=>error.name==='AttachmentError'&&/Разделите/.test(error.message));
  assert.equal(persisted,false);
  await assert.rejects(engine.run({...base,model:'text-only',attachments:[{name:'scan',text:'',images:[{name:'x.png',mime:'image/png',base64:png}]}]}),(error:Error)=>error.name==='ModelSelectionError'&&/изображени/.test(error.message));
  assert.equal(persisted,true); // The allocation is tracked for cleanup even if model validation fails.
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('full multimodal rebuild and large echoed user input fit bounded app-server frames',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 const image=(size:number)=>{const bytes=Buffer.alloc(size);Buffer.from(png,'base64').copy(bytes);return {name:'page.png',mime:'image/png' as const,base64:bytes.toString('base64')};};
 try {
  const result=await engine.run({userId:1,text:'accept-large-input',history:[{role:'user',text:'prior task',attachments:[{name:'old.pdf',text:'all old text',images:[image(2_900_000)]}]},{role:'assistant',text:'h'.repeat(30_000)+'HISTORY-END'}],attachments:[{name:'current.pdf',text:'all current text',images:[image(5_800_000)]}],model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}});
  assert.equal(result.text,'native images: 2; history tail: true');
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('oversized current input fails safely without persisting or silently truncating the task',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 let persisted=false;
 try {
  await assert.rejects(engine.run({userId:1,text:'h'.repeat(24*1024*1024),model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{persisted=true;}}),(error:Error)=>error.name==='AttachmentError'&&/разделите/.test(error.message));
  assert.equal(persisted,false);
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('summarization uses an ephemeral tool-free turn and the next thread gets its bounded context',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 const model={model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal};
 try {
  const summary=await engine.summarize({...model,summary:'Keep the invoice date',text:'The newer copy is authoritative'});
  assert.deepEqual(JSON.parse(summary),{
   data:{previousSummary:'Keep the invoice date',completedMessages:'The newer copy is authoritative'},
   dynamicTools:[],permissions:'bot',
  });
  const result=await engine.run({...model,userId:1,text:'inspect-input',summary,history:[
   {role:'user',text:'x'.repeat(75_000)},
   {role:'assistant',text:'Old, already summarized answer'},
   {role:'user',text:'Use the updated date'},
   {role:'assistant',text:'Understood'},
  ],onThread:()=>{}});
  const input=JSON.parse(result.text);
  assert.ok(input.some((item:any)=>item.text?.includes('Keep the invoice date')));
  assert.ok(input.some((item:any)=>item.text?.includes('Use the updated date')));
  assert.ok(!input.some((item:any)=>item.text?.includes('Old, already summarized answer')));
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('model context pressure is reported separately from the transport limit',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 const base={model:'gpt-6.1-sol',effort:'medium',userId:1,signal:new AbortController().signal,onThread:()=>{}};
 try {
  const response=await engine.run({...base,text:'context-window-pressure'});
  assert.equal(response.contextPressure,true);
  assert.equal(response.text,'Answered within model window');
  await assert.rejects(engine.run({...base,text:'context-window-exceeded'}),/окно контекста модели/);
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('the material tool returns a saved scan as native images and denies IDs outside the dialogue',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 const attachment={name:'legacy-scan.pdf',text:'Old scan contents',images:[{name:'page.png',mime:'image/png',base64:png}]};
 const bytes=Buffer.from(JSON.stringify(attachment));
 const id='11111111-1111-4111-8111-111111111111';
 const file={id,name:attachment.name,prepared:true as const,mime:'application/json',size:bytes.length};
 let reads=0;
 const base={userId:1,topicId:12,model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{},
  text:'read-material:'+id,readFile:(requested:string)=>{reads++;assert.equal(requested,id);return bytes;}};
 try {
  const response=JSON.parse((await engine.run({...base,files:[file]})).text);
  assert.equal(response.success,true);
  assert.ok(response.contentItems.some((item:any)=>item.type==='inputImage'&&item.imageUrl==='data:image/png;base64,'+png));
  assert.ok(response.contentItems.some((item:any)=>item.text?.includes('Old scan contents')));
  const denied=JSON.parse((await engine.run({...base,topicId:13,files:[]})).text);
  assert.equal(denied.success,false);
  assert.equal(reads,1);
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('catalog preserves supported model and reasoning levels',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 try { assert.deepEqual(await engine.listModels(),[
  {id:'gpt-6.2-sol',displayName:'GPT-6.2-Sol',supportedEfforts:['low','medium'],defaultEffort:'low'},
  {id:'gpt-6.1-sol',displayName:'Sol',supportedEfforts:['medium'],defaultEffort:'low'},
  {id:'text-only',displayName:'Text Only',supportedEfforts:['medium'],defaultEffort:'medium'},
 ]); }
 finally {await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('a missing model or unsupported effort rejects the request and preserves the completed native dialogue',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 const base={userId:1,model:'gpt-6.2-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}};
 try {
  const first=await engine.run({...base,text:'remember:MODEL_CHECK'});
  const followUp={...base,threadId:first.threadId,text:'recall'};
  await assert.rejects(engine.run({...followUp,model:'missing-model'}),/Модель этого диалога недоступна/);
  await assert.rejects(engine.run({...followUp,effort:'high'}),/Уровень рассуждения недоступен/);
  const result=await engine.run(followUp);
  assert.equal(result.text,'MODEL_CHECK');
  assert.equal(result.threadId,first.threadId);
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('a transient catalog failure can be retried in the same native dialogue',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 const base={userId:1,model:'gpt-6.2-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}};
 try {
  const first=await engine.run({...base,text:'remember:CATALOG_TRANSIENT'});
  const followUp={...base,threadId:first.threadId,text:'recall'};
  await assert.rejects(engine.run(followUp),
   (error:Error)=>/Каталог моделей Codex сейчас недоступен/.test(error.message)&&!error.message.includes('PRIVATE'));
  const result=await engine.run(followUp);
  assert.equal(result.text,'CATALOG_TRANSIENT');
  assert.equal(result.threadId,first.threadId);
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('a model rejected by inference produces a safe availability error',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 try {
  await assert.rejects(engine.run({userId:1,model:'gpt-6.2-sol',effort:'medium',text:'model-not-found',signal:new AbortController().signal,onThread:()=>{}}),
   (error:Error)=>/Модель этого диалога недоступна/.test(error.message)&&!error.message.includes('PRIVATE'));
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('a dialog persists its thread before returning only the final answer',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 let saved='';
 try {
  const result=await engine.run({userId:123,text:'What is six times seven?',model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:id=>{saved=id;}});
  assert.equal(result.threadId,saved);assert.equal(result.text,'42');assert.deepEqual(result.images,[]);
 } finally {await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

const pythonPath=process.env.VERFIX_TEST_PYTHON;
test('a dialog calculates without host files, secrets, networking or process creation',{skip:!pythonPath},async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs'),pythonPath});
 try {
  const code=`import os,socket,json
report={'answer':6*7,'env':sorted(os.environ),'host':any(os.path.exists(p) for p in ['/home/nikita/.codex/auth.json','/etc/passwd','/proc/1/root/home/nikita','/run','/sys'])}
for label,action in [('inet',lambda:socket.socket(socket.AF_INET)),('unix',lambda:socket.socket(socket.AF_UNIX)),('fork',os.fork)]:
 try: action();report[label]='allowed'
 except OSError as e: report[label]=e.errno
print(json.dumps(report))`;
  const result=await engine.run({userId:123,text:'compute:'+code,model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}});
  const tool=JSON.parse(result.text);const report=JSON.parse(tool.stdout);
  assert.equal(report.answer,42);assert.equal(report.host,false);assert.equal(report.inet,1);assert.equal(report.unix,1);assert.equal(report.fork,1);
  assert.deepEqual(report.env,['HOME','LANG','MKL_NUM_THREADS','MPLBACKEND','MPLCONFIGDIR','OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','PATH','PWD']);
 }finally {await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('a dialog returns a validated PNG from its own isolated calculation',{skip:!pythonPath},async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs'),pythonPath});
 try {
  const result=await engine.run({userId:123,text:'compute:import numpy as np\nimport matplotlib.pyplot as plt\nx=np.arange(5);plt.plot(x,x*x);plt.savefig("/work/result.png")\nprint("squares plotted")',model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}});
  assert.equal(JSON.parse(result.text).stdout,'squares plotted\n');assert.equal(result.images.length,1);
  assert.equal(Buffer.from(result.images[0]!.bytes).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 }finally {await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('calculation cannot create files through Python or raw syscalls, or exceed slot size',{skip:!pythonPath},async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs'),pythonPath});
 try {
  const code=`import os,json,ctypes
report={}
for label,fn in [('create',lambda:os.open('/work/new',os.O_WRONLY|os.O_CREAT)),('tmpfile',lambda:os.open('/work',os.O_RDWR|os.O_TMPFILE)),('mkdir',lambda:os.mkdir('/tmp/new')),('symlink',lambda:os.symlink('/etc/passwd','/work/result.png')),('link',lambda:os.link('/work/scratch-0.txt','/work/new')),('root',lambda:open('/new','w')),('device',lambda:open('/dev/new','w'))]:
 try: fn();report[label]='allowed'
 except OSError: report[label]='denied'
with open('/work/scratch-0.txt','w') as f: f.write('existing file works')
report['existing']=open('/work/scratch-0.txt').read()
report['work_bytes']=os.statvfs('/work').f_blocks*os.statvfs('/work').f_frsize
report['tmp_bytes']=os.statvfs('/tmp').f_blocks*os.statvfs('/tmp').f_frsize
try: os.truncate('/work/scratch-0.txt',10*1024*1024);report['size']='allowed'
except OSError: report['size']='denied'
libc=ctypes.CDLL(None,use_errno=True)
report['raw_create']=libc.syscall(257,-100,b'/work/raw',os.O_CREAT|os.O_WRONLY,0o600)
report['raw_errno']=ctypes.get_errno()
print(json.dumps(report))`;
  const result=await engine.run({userId:123,text:'compute:'+code,model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}});
  const report=JSON.parse(JSON.parse(result.text).stdout);
  assert.deepEqual(report,{create:'denied',tmpfile:'denied',mkdir:'denied',symlink:'denied',link:'denied',root:'denied',device:'denied',existing:'existing file works',work_bytes:67108864,tmp_bytes:33554432,size:'denied',raw_create:-1,raw_errno:1});
 }finally {await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('malformed generated images never become attachments',{skip:!pythonPath},async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs'),pythonPath});
 try {
  const result=await engine.run({userId:123,text:'compute:open("/work/result.png","wb").write(b"not an image")',model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}});
  assert.deepEqual(result.images,[]);assert.match(result.text,/unavailable|limit/);
 }finally {await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('dialogs resume independently after restart and deleted context cannot resume',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const options={runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')};
 let engine=new CodexEngine(options);
 const query=(userId:number,text:string,threadId?:string)=>engine.run({userId,text,...(threadId?{threadId}:{}),model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}});
 try {
  const first=await query(1,'remember:ALPHA');const second=await query(2,'remember:BETA');
  await engine.close();engine=new CodexEngine(options);
  assert.equal((await query(1,'recall',first.threadId)).text,'ALPHA');assert.equal((await query(2,'recall',second.threadId)).text,'BETA');
  await assert.rejects(query(2,'recall',first.threadId),/unavailable/);
  await engine.deleteThread(first.threadId);
  await assert.rejects(query(1,'recall',first.threadId),/unavailable/);
  assert.equal((await query(2,'recall',second.threadId)).text,'BETA');
 }finally {await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('cancelling a calculation stops it and the next request uses a fresh thread',{skip:!pythonPath},async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs'),pythonPath});
 const abort=new AbortController();let saved='';let timer:NodeJS.Timeout|undefined;
 try {
  const started=Date.now();
  await assert.rejects(engine.run({userId:123,text:'compute:while True: pass',model:'gpt-6.1-sol',effort:'medium',signal:abort.signal,onThread:id=>{saved=id;timer=setTimeout(()=>abort.abort(),1200);}}),/cancelled/);
  assert.ok(Date.now()-started<5000,'cancellation returns promptly');
  const next=await engine.run({userId:123,threadId:saved,text:'six times seven',history:[{role:'user',text:'hello'},{role:'assistant',text:'completed answer'}],model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}});
  assert.notEqual(next.threadId,saved);assert.equal(next.text,'42');
 }finally {if(timer)clearTimeout(timer);await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('cancellation while opening a saved dialog preserves its completed context',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 const base={userId:1,model:'gpt-6.1-sol',effort:'medium',onThread:()=>{}};
 try {
  const first=await engine.run({...base,text:'remember:COMMITTED',signal:new AbortController().signal});
  const abort=new AbortController();let persisted=false;
  const pending=engine.run({...base,threadId:first.threadId,text:'recall',signal:abort.signal,onThread:()=>{persisted=true;}});
  abort.abort();
  await assert.rejects(pending,/cancelled/);assert.equal(persisted,false);
  const next=await engine.run({...base,threadId:first.threadId,text:'recall',signal:new AbortController().signal});
  assert.equal(next.text,'COMMITTED');assert.equal(next.threadId,first.threadId);
 }finally {await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('the caller controls request lifetime beyond ten minutes and can still cancel',async(t)=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 const abort=new AbortController();
 t.mock.timers.enable({apis:['setTimeout']});
 try {
  const result=await engine.run({userId:1,text:'six times seven',model:'gpt-6.1-sol',effort:'medium',signal:abort.signal,onThread:()=>{t.mock.timers.tick(600001);}});
  assert.equal(result.text,'42');assert.equal(abort.signal.aborted,false);
  await assert.rejects(engine.run({userId:1,text:'wait',model:'gpt-6.1-sol',effort:'medium',signal:abort.signal,onThread:()=>abort.abort()}),/cancelled/);
 }finally {await engine.close();t.mock.timers.reset();await rm(runtimeDir,{recursive:true,force:true});}
});


test('a native generated image returns verified inline PNG bytes without reading its savedPath',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 try {
  const result=await engine.run({userId:1,text:'native-image:valid',model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}});
  assert.equal(result.text,'Created artwork');
  assert.equal(result.images.length,1);
  assert.equal(result.images[0]!.mime,'image/png');
  assert.equal(result.images[0]!.name,'generated-image-1.png');
  assert.deepEqual(Buffer.from(result.images[0]!.bytes),await readFile('tests/fixtures/attachments/tiny.png'));
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});


test('native images retain generation order and duplicate or foreign notifications do not add images',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 try {
  const result=await engine.run({userId:1,text:'native-image:ordered',model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}});
  assert.deepEqual(result.images.map(image=>image.name),['generated-image-1.png','generated-image-2.png']);
  assert.deepEqual(Buffer.from(result.images[0]!.bytes),await readFile('tests/fixtures/attachments/tiny.png'));
  assert.deepEqual(Buffer.from(result.images[1]!.bytes),await readFile('tests/fixtures/attachments/transparent.png'));
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('native artwork without assistant prose still returns an image and a friendly explanation',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 try {
  const result=await engine.run({userId:1,text:'native-image:image-only',model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}});
  assert.equal(result.images.length,1);assert.match(result.text,/Изображени/);
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});


test('new and restarted dialogs enable native artwork while retaining the isolated worker policy',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const options={runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')};
 let engine=new CodexEngine(options);
 const base={userId:1,text:'native-image:policy',model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}};
 try {
  const first=await engine.run(base);
  await engine.close();engine=new CodexEngine(options);
  const resumed=await engine.run({...base,threadId:first.threadId});
  for(const [index,response] of [first,resumed].entries()){
   const report=JSON.parse(response.text);
   assert.equal(report.threadMethod,index?'thread/resume':'thread/start');
   assert.match(report.config,/image_generation = true/);
   assert.match(report.config,/omit_app_server_notification_media = false/);
   for(const feature of ['shell_tool','view_image','apps','plugins','hooks','computer_use','in_app_browser','code_mode','multi_agent','memories','request_permissions_tool'])assert.ok(report.config.includes(feature+' = false'));
   assert.match(report.config,/code_mode_host = true/);assert.match(report.config,/enabled = false/);
   assert.deepEqual(report.turnParams.environments,[]);
   if(index===0)assert.deepEqual(report.threadParams.environments,[]);
   assert.equal(report.threadParams.permissions,'bot');assert.equal(report.turnParams.permissions,'bot');
   assert.match(report.threadParams.developerInstructions,/image_gen__imagegen/);
   assert.match(report.threadParams.developerInstructions,/num_last_images_to_include/);
   assert.match(report.threadParams.developerInstructions,/API key/);
   if(index===0)assert.deepEqual(report.threadParams.dynamicTools.map((tool:any)=>tool.name),['isolated_compute','isolated_workspace','export_files','dialogue_materials']);
  }
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('resumed native threads can find current materials using the legacy tool',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const options={runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')};
 let engine=new CodexEngine(options);
 const base={userId:1,topicId:7,text:'native-image:policy',model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}};
 try {
  const first=await engine.run(base);
  await engine.close();
  await writeFile(join(runtimeDir,'codex','dialogs',first.threadId,'home','fake-instructions'),'Only numerical Python calculations are available.');
  engine=new CodexEngine(options);
  const files=[{id:'11111111-1111-4111-8111-111111111111',name:'saved.pdf',mime:'application/pdf',size:42}];
  const resumed=await engine.run({...base,threadId:first.threadId,files});
  assert.equal(resumed.threadId,first.threadId);
  const report=JSON.parse(resumed.text);
  assert.match(report.modelInstructions,/dialogue_materials/);
  assert.match(report.modelInstructions,/saved\.pdf/);
  assert.match(report.modelInstructions,/\/work\/materials\/11111111-1111-4111-8111-111111111111\.pdf/);
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});


test('completed native images survive another image hitting quota with their explanation and a safe partial notice',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 try {
  const result=await engine.run({userId:1,text:'native-image:mixed',model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}});
  assert.deepEqual(result.images.map(image=>image.name),['generated-image-1.png']);
  assert.deepEqual(Buffer.from(result.images[0]!.bytes),await readFile('tests/fixtures/attachments/tiny.png'));
  assert.match(result.text,/^Created artwork\n\n/);
  assert.match(result.text,/часть изображений/);
  assert.match(result.text,/лимит/);
  assert.doesNotMatch(result.text,/SECRET|\/etc/);
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('a failed turn retains its completed native image but is rebuilt on the next request',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 const base={userId:1,model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}};
 try {
  const result=await engine.run({...base,text:'native-image:completed-failed-turn'});
  assert.equal(result.images.length,1);
  assert.match(result.text,/^Created artwork\n\n/);
  assert.match(result.text,/часть изображений/);
  const next=await engine.run({...base,threadId:result.threadId,text:'native-image:valid'});
  assert.notEqual(next.threadId,result.threadId);assert.equal(next.images.length,1);
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('failed, unfinished or non-inline native generation never claims successful delivery',async(t)=>{
 for(const scenario of ['failed','failed-with-result','failed-turn','in-progress','started-only','missing-inline','missing-result'])await t.test(scenario,async()=>{
  const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
  const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
  try {
   await assert.rejects(engine.run({userId:1,text:'native-image:'+scenario,model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}}),(error:Error)=>error.name==='ImageGenerationError'&&!error.message.includes('SECRET')&&!error.message.includes('/etc'));
  }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
 });
});

test('mixed malformed or non-inline results keep verified images ordered and deduplicated with a partial notice',async(t)=>{
 for(const scenario of ['missing-inline','malformed','unfinished'])await t.test(scenario,async()=>{
  const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
  const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
  try {
   const result=await engine.run({userId:1,text:'native-image:mixed-'+scenario,model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}});
   assert.deepEqual(result.images.map(image=>image.name),['generated-image-1.png','generated-image-2.png']);
   assert.deepEqual(Buffer.from(result.images[0]!.bytes),await readFile('tests/fixtures/attachments/tiny.png'));
   assert.deepEqual(Buffer.from(result.images[1]!.bytes),await readFile('tests/fixtures/attachments/transparent.png'));
   assert.match(result.text,/^Created artwork\n\n/);assert.match(result.text,/часть изображений/);
   assert.doesNotMatch(result.text,/SECRET|\/etc|file:\/\//);
  }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
 });
});


test('native image results reject malformed base64, broken PNG chunks and excessive dimensions',async(t)=>{
 for(const scenario of ['url','dataurl','whitespace','invalid','truncated','trailer','signature','crc','dimensions','pixels','zero','object','noncanonical'])await t.test(scenario,async()=>{
  const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
  const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
  try {
   await assert.rejects(engine.run({userId:1,text:'native-image:malformed-'+scenario,model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}}),(error:Error)=>error.name==='ImageGenerationError'&&!error.message.includes('SECRET'));
  }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
 });
});

test('native output supports four images and its full byte budget alongside echoed image inputs',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 const base={userId:1,model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}};
 try {
  assert.equal((await engine.run({...base,text:'native-image:four'})).images.length,4);
  const bytes=Buffer.alloc(5500000);Buffer.from(png,'base64').copy(bytes);
  const result=await engine.run({...base,text:'native-image:max-budget',attachments:[{name:'scan.png',text:'',images:[{name:'scan.png',mime:'image/png',base64:bytes.toString('base64')}]}]});
  assert.deepEqual(result.images.map(image=>image.bytes.length),[8000000,8000000,8000000]);
  assert.ok(result.text);
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('native output rejects an excessive single image',async()=>{
  const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
  const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
  try {
   await assert.rejects(engine.run({userId:1,text:'native-image:image-limit',model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}}),(error:Error)=>error.name==='ImageGenerationError');
  }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('native output crossing image count or total byte limits keeps bounded earlier images with a partial notice',async(t)=>{
 for(const [scenario,count] of [['too-many',4],['total-limit',2]] as const)await t.test(scenario,async()=>{
  const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
  const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
  try {
   const result=await engine.run({userId:1,text:'native-image:'+scenario,model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}});
   assert.equal(result.images.length,count);
   assert.ok(result.images.reduce((sum,image)=>sum+image.bytes.length,0)<=24000000);
   assert.match(result.text,/часть изображений/);
  }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
 });
});


test('notification-only native completion delivers its image and wrong turn summaries are ignored',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 const base={userId:1,model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}};
 try {
  for(const scenario of ['notification-only','wrong-turn-summary']){
   const response=await engine.run({...base,text:'native-image:'+scenario});
   assert.equal(response.images.length,1);assert.equal(response.text,'Created artwork');
  }
  const ordinary=await engine.run({...base,text:'native-image:unavailable'});
  assert.deepEqual(ordinary.images,[]);assert.match(ordinary.text,/unavailable/);
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('cancelling native generation returns promptly and does not reuse its incomplete thread',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 const abort=new AbortController();let timer:NodeJS.Timeout|undefined,saved='';
 const base={userId:1,model:'gpt-6.1-sol',effort:'medium',signal:abort.signal,onThread:(id:string)=>{saved=id;timer=setTimeout(()=>abort.abort(),200);}};
 try {
  await assert.rejects(engine.run({...base,text:'native-image:wait'}),/cancelled/);
  const next=await engine.run({...base,threadId:saved,text:'native-image:valid',signal:new AbortController().signal,onThread:()=>{}});
  assert.notEqual(next.threadId,saved);assert.equal(next.images.length,1);
 }finally{if(timer)clearTimeout(timer);await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('cancellation after native image completion still rejects delivery',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 const abort=new AbortController();let timer:NodeJS.Timeout|undefined;
 try {
  await assert.rejects(engine.run({userId:1,text:'native-image:completed-then-wait',model:'gpt-6.1-sol',effort:'medium',signal:abort.signal,onThread:()=>{timer=setTimeout(()=>abort.abort(),200);}}),/cancelled/);
 }finally{if(timer)clearTimeout(timer);await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('an app-server frame above the bounded native media budget fails safely',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 try {
  await assert.rejects(engine.run({userId:1,text:'native-image:oversized-frame',model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}}),/^Error: Codex request failed$/);
 }finally{await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('native contexts reject reuse from another topic of the same user and bind legacy context only once',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-topics-'));
 const options={runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')};
 let engine=new CodexEngine(options);
 const base={userId:1,model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{}};
 try {
  const work=await engine.run({...base,topicId:11,text:'remember:WORK'});
  const study=await engine.run({...base,topicId:12,text:'remember:STUDY'});
  await assert.rejects(engine.run({...base,topicId:12,threadId:work.threadId,text:'recall'}),/unavailable/);
  const legacy=await engine.run({...base,text:'remember:LEGACY'});
  await engine.bindLegacyThread(legacy.threadId,{userId:1,topicId:13});
  await engine.bindLegacyThread(legacy.threadId,{userId:1,topicId:13});
  await assert.rejects(engine.bindLegacyThread(legacy.threadId,{userId:1,topicId:14}),/unavailable/);
  await assert.rejects(engine.bindLegacyThread(legacy.threadId,{userId:2,topicId:13}),/unavailable/);
  await engine.close();engine=new CodexEngine(options);
  assert.equal((await engine.run({...base,topicId:11,threadId:work.threadId,text:'recall'})).text,'WORK');
  assert.equal((await engine.run({...base,topicId:12,threadId:study.threadId,text:'recall'})).text,'STUDY');
  assert.equal((await engine.run({...base,topicId:13,threadId:legacy.threadId,text:'recall'})).text,'LEGACY');
 } finally {await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('cancelled thread allocation creates no native files after its cleanup has completed',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-allocation-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 let allocated='';
 try {
  await assert.rejects(engine.run({userId:1,topicId:11,text:'remember:SECRET',model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:id=>{allocated=id;throw new Error('allocation cancelled');}}));
  await assert.rejects(readFile(join(runtimeDir,'codex','dialogs',allocated,'state.json')),{code:'ENOENT'});
 } finally {await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

for(const scenario of ['complete','partial','legacy','missing-first'])test('document tool exports completed files through persistence: '+scenario,{skip:!process.env.VERFIX_TEST_FILES},async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-files-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 const files:any[]=[];
 try {
  const result=await engine.run({userId:2,text:'files:'+scenario,model:'gpt-6.1-sol',effort:'medium',signal:new AbortController().signal,onThread:()=>{},onFile:async file=>{
   files.push(file);return {id:'stored-'+files.length,name:file.name,mime:file.mime,size:file.bytes.length};
  }});
  assert.equal(files.length,1);assert.equal(Buffer.from(files[0].bytes).toString(),'a,b\n1,2');
  assert.deepEqual(result.fileIds,['stored-1']);
  if(scenario==='partial'||scenario==='missing-first')assert.match(result.text,/Не удалось/);
 } finally {await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});

test('engine startup collects document staging left by an interrupted previous process',async()=>{
 const {mkdir,writeFile,stat}=await import('node:fs/promises');
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-staging-'));
 const directory=join(runtimeDir,'codex','dialogs','11111111-1111-4111-8111-111111111111','workspaces');
 await mkdir(directory,{recursive:true});await writeFile(join(directory,'private-source'),'private material');
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 try {
  assert.equal((await engine.health()).available,true);
  await assert.rejects(stat(directory));
 } finally {await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
});
test('Codex streams only public answer fragments from the active turn', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'verfix-engine-test-'));
  const engine = new CodexEngine({runtimeDir, codexCommand: resolve('tests/fixtures/codex.mjs')});
  const events: ModelProgress[] = [];
  try {
    const result = await engine.run({userId: 1, topicId: 7, text: 'stream:complete',
      model: 'gpt-6.2-sol', effort: 'medium', signal: AbortSignal.timeout(5000),
      onThread: () => {}, onProgress: event => events.push(event)});
    assert.deepEqual(events, [{kind: 'text', delta: 'Hello '}, {kind: 'text', delta: 'world'}]);
    assert.equal(result.text, 'Hello world');
  } finally { await engine.close(); await rm(runtimeDir, {recursive: true, force: true}); }
});

for (const history of ['paginated', 'legacy'] as const) {
  test(`stop preserves previous native context with ${history} Codex history`, {timeout: 8000}, async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'verfix-engine-test-'));
    const engine = new CodexEngine({runtimeDir, codexCommand: resolve('tests/fixtures/codex.mjs')});
    const base = {userId: 1, topicId: 7, model: 'gpt-6.2-sol', effort: 'medium', onThread: () => {}};
    try {
      const previous = await engine.run({...base, requestId: 'previous', text: 'remember:PREVIOUS ART', signal: AbortSignal.timeout(2000)});
      const stop = new AbortController();
      const stopped = await engine.run({...base, requestId: 'stopped', threadId: previous.threadId,
        text: history === 'legacy' ? 'stream:stop-legacy' : 'stream:stop',
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(4000)]),
        onProgress(event) { if (event.kind === 'text') stop.abort(new RequestStopped()); },
      }).catch(error => error as Error);
      assert.match((stopped as Error).message, /cancelled/);
      assert.equal(await engine.restoreStoppedThread(previous.threadId, 'stopped', base), true);
      const followUp = await engine.run({...base, text: 'recall', threadId: previous.threadId, signal: AbortSignal.timeout(2000)});
      assert.equal(followUp.text, 'PREVIOUS ART');
      assert.equal(followUp.threadId, previous.threadId);
    } finally { await engine.close(); await rm(runtimeDir, {recursive: true, force: true}); }
  });
}
