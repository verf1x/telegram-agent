import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/store.ts';

test('legacy history, materials and outbox move once into a topic and survive reopening', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'verfix-migration-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const path = join(dir, 'bot.sqlite');
  const legacy = {userId:2, history:[{role:'user',text:'old fact'}], threadId:'old-thread', pending:{refs:[{fileId:'old-file'}],captions:[]}, delivery:{parts:[{kind:'text',text:'old answer'}],next:0}};
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE dialogues (user_id INTEGER PRIMARY KEY, state TEXT NOT NULL)');
  db.prepare('INSERT INTO dialogues VALUES (?,?)').run(2, JSON.stringify(legacy));
  db.close();
  let store = new SqliteStore(path);
  assert.deepEqual(store.get(2), legacy);
  store.moveLegacy(2, 45);
  store.put({userId:2, topicId:46, history:[{role:'user',text:'new fact'}]});
  store.close();
  store = new SqliteStore(path);
  try {
    assert.equal(store.get(2).history.length, 0);
    assert.equal(store.get(2,45).pending?.refs[0]?.fileId, 'old-file');
    assert.equal(store.get(2,45).delivery?.parts[0]?.kind, 'text');
    assert.equal(store.get(2,46).history[0]?.text, 'new fact');
    assert.equal(store.get(3,45).history.length, 0);
    assert.equal(store.moveLegacy(2, 99), false);
    assert.equal(store.all().length, 2);
  } finally { store.close(); }
});

test('existing response file databases migrate without exposing files in another topic',t=>{
 const dir=mkdtempSync(join(tmpdir(),'verfix-file-schema-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'db');const old=new DatabaseSync(path);
 old.exec('CREATE TABLE dialogue_files (id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,bytes BLOB NOT NULL)');
 old.prepare('INSERT INTO dialogue_files VALUES (?,?,?,?,?,?)').run('legacy-file',2,'legacy.csv','text/csv',4,Buffer.from('data'));old.close();
 const store=new SqliteStore(path);
 try {
  assert.equal(Buffer.from(store.readFile(2,'legacy-file')).toString(),'data');
  assert.throws(()=>store.readFile({userId:2,topicId:10},'legacy-file'));
 } finally {store.close();}
});
