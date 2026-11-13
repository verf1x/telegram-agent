import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IsolatedWorkspace} from '../../src/files/workspace.ts';

test('workspace creates an arbitrary file and refuses host paths and symlinks', {skip: !process.env.VERFIX_TEST_FILES}, async()=>{
 const workspace=new IsolatedWorkspace([],()=>{throw new Error('missing');});
 try {
  await workspace.run("printf 'a,b\\n1,2\\n' > result.csv; ln -s /etc/passwd secret",new AbortController().signal);
  const file=await workspace.export('/work/result.csv','Отчёт.csv','text/csv',new AbortController().signal);
  assert.equal(Buffer.from(file.bytes).toString(),'a,b\n1,2\n');
  await assert.rejects(workspace.export('/etc/passwd','secret','text/plain',new AbortController().signal));
  await assert.rejects(workspace.export('/work/secret','secret','text/plain',new AbortController().signal));
  const result=await workspace.run('test ! -e /var/run/docker.sock && test ! -e /home/nikita && curl -fsS --max-time 5 http://127.0.0.1:80',new AbortController().signal);
  assert.notEqual(result.code,0);
 } finally {await workspace.close();}
});

test('uploaded source material is readable in production umask and isolated from other workspaces',{skip:!process.env.VERFIX_TEST_FILES},async()=>{
 const previous=process.umask(0o077);
 const id='11111111-1111-4111-8111-111111111111';
 const one=new IsolatedWorkspace([{id,name:'source.txt',mime:'text/plain',size:6}],()=>Buffer.from('source'));
 const two=new IsolatedWorkspace([],()=>{throw new Error('missing');});
 try {
  const result=await one.run('cat '+one.materials[0]!.path,new AbortController().signal);
  assert.equal(result.output,'source');assert.equal(result.code,0);
  const absent=await two.run('test ! -e '+one.materials[0]!.path,new AbortController().signal);
  assert.equal(absent.code,0);
 } finally {await one.close();await two.close();process.umask(previous);}
});

test('document workspace installs libraries via public internet but cannot use direct host networking',{skip:!process.env.VERFIX_TEST_FILES},async()=>{
 const workspace=new IsolatedWorkspace([],()=>{throw new Error('missing');});const signal=new AbortController().signal;
 try {
  const installed=await workspace.run('python -m pip install --disable-pip-version-check --no-cache-dir --target /work/packages six==1.17.0 && python -c "import six; print(six.__version__)"',signal);
  assert.equal(installed.code,0,installed.output);assert.match(installed.output,/1\.17\.0/);
  const remote=await workspace.run('curl -fsSI --max-time 20 https://example.com',signal);assert.equal(remote.code,0,remote.output);
  const denied=await workspace.run('curl -fsS --max-time 3 http://169.254.169.254',signal);assert.notEqual(denied.code,0);
  const direct=await workspace.run('curl --noproxy "*" -fsS --max-time 3 https://example.com',signal);assert.notEqual(direct.code,0);
  const hardlink=await workspace.run('printf safe >/work/first; ln /work/first /work/second',signal);assert.equal(hardlink.code,0);
  await assert.rejects(workspace.export('/work/second','second','text/plain',signal));
 } finally {await workspace.close();}
});
