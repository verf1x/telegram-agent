import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStore} from '../../src/store.ts';

test('dialogue files survive restart, are scoped to their user, and reset deletes bytes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'verfix-files-'));
 try {
  let store=new SqliteStore(join(dir,'db'));
  const file=store.saveFile(2,{name:'../Отчёт.csv',mime:'text/csv',bytes:Buffer.from('a,b\n1,2')},100);
  store.close();store=new SqliteStore(join(dir,'db'));
  assert.equal(store.listFiles(2)[0]?.name,'Отчёт.csv');
  assert.equal(Buffer.from(store.readFile(2,file.id)).toString(),'a,b\n1,2');
  assert.throws(()=>store.readFile(3,file.id));
  assert.equal(store.listFiles(3).length,0);
  store.deleteFiles(2);
  assert.throws(()=>store.readFile(2,file.id));
  store.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('quota refuses new files without deleting old material and accepts the exact boundary',()=>{
 const store=new SqliteStore(':memory:');
 try {
  const first=store.saveFile(2,{name:'first.bin',mime:'application/octet-stream',bytes:Buffer.alloc(6)},10);
  store.saveFile(2,{name:'second.bin',mime:'application/octet-stream',bytes:Buffer.alloc(4)},10);
  assert.throws(()=>store.saveFile(2,{name:'third.bin',mime:'application/octet-stream',bytes:Buffer.alloc(1)},10),/заполнено/);
  assert.equal(store.readFile(2,first.id).length,6);
  assert.equal(store.listFiles(2).length,2);
  assert.throws(()=>store.saveFile(2,{name:'too-large.bin',mime:'application/octet-stream',bytes:Buffer.alloc(50_000_001)},100_000_000),/50 МБ/);
  const exact=store.saveFile(3,{name:'exact.bin',mime:'application/octet-stream',bytes:Buffer.alloc(50_000_000)},50_000_000);
  assert.equal(exact.size,50_000_000);
 } finally {store.close();}
});

test('500 MB dialogue quota accepts its exact boundary, survives restart and reset preserves other users',{skip:!process.env.VERFIX_TEST_FILES},()=>{
 const dir=mkdtempSync(join(tmpdir(),'verfix-quota-'));
 let store=new SqliteStore(join(dir,'db'));
 try {
  const bytes=Buffer.alloc(50_000_000);
  for(let n=0;n<10;n++)store.saveFile(2,{name:n+'.bin',mime:'application/octet-stream',bytes});
  const other=store.saveFile(3,{name:'other.txt',mime:'text/plain',bytes:Buffer.from('other')});
  assert.throws(()=>store.saveFile(2,{name:'overflow.bin',mime:'application/octet-stream',bytes:Buffer.from('x')}),/заполнено/);
  store.close();store=new SqliteStore(join(dir,'db'));
  assert.equal(store.listFiles(2).reduce((sum,file)=>sum+file.size,0),500_000_000);
  store.deleteFiles(2);assert.equal(store.listFiles(2).length,0);
  assert.equal(Buffer.from(store.readFile(3,other.id)).toString(),'other');
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('files and quota are independent between topics of the same user',()=>{
 const store=new SqliteStore(':memory:');
 const work={userId:2,topicId:11},study={userId:2,topicId:12};
 try {
  const first=store.saveFile(work,{name:'work.csv',mime:'text/csv',bytes:Buffer.from('work')},4);
  const second=store.saveFile(study,{name:'study.csv',mime:'text/csv',bytes:Buffer.from('study')},5);
  assert.throws(()=>store.readFile(study,first.id),/недоступен/);
  assert.throws(()=>store.readFile(work,second.id),/недоступен/);
  assert.equal(store.listFiles(work).length,1);assert.equal(store.listFiles(study).length,1);
  assert.throws(()=>store.saveFile(work,{name:'overflow',mime:'text/plain',bytes:Buffer.from('x')},4),/заполнено/);
  store.deleteFiles(work);assert.equal(Buffer.from(store.readFile(study,second.id)).toString(),'study');
 } finally {store.close();}
});

test('moving a legacy dialogue moves its saved originals and response file references atomically',()=>{
 const store=new SqliteStore(':memory:');
 try {
  const file=store.saveFile(2,{name:'legacy.csv',mime:'text/csv',bytes:Buffer.from('legacy')});
  store.put({userId:2,history:[],delivery:{parts:[{kind:'file',id:file.id}],next:0}});
  assert.equal(store.moveLegacy(2,77),true);
  assert.equal(store.listFiles(2).length,0);
  assert.equal(Buffer.from(store.readFile({userId:2,topicId:77},file.id)).toString(),'legacy');
  assert.equal(store.get(2,77).delivery!.parts[0]!.kind,'file');
  assert.throws(()=>store.readFile({userId:2,topicId:78},file.id));
  store.remove({userId:2,topicId:77});assert.equal(store.listFiles({userId:2,topicId:77}).length,0);
 } finally {store.close();}
});
