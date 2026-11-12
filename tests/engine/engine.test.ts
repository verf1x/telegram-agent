import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { CodexEngine } from '../../src/codex/engine.ts';

test('catalog preserves supported model and reasoning levels',async()=>{
 const runtimeDir=await mkdtemp(join(tmpdir(),'verfix-engine-test-'));
 const engine=new CodexEngine({runtimeDir,codexCommand:resolve('tests/fixtures/codex.mjs')});
 try { assert.deepEqual(await engine.listModels(),[{id:'gpt-6.1-sol',displayName:'Sol',supportedEfforts:['medium'],defaultEffort:'low'}]); }
 finally {await engine.close();await rm(runtimeDir,{recursive:true,force:true});}
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
