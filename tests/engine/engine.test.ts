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
