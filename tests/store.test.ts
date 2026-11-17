import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/store.ts';
import { createBot } from '../src/bot.ts';
import type { BotConfig, ModelEngine, TelegramTransport } from '../src/contracts.ts';

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

test('old pending operations resume around an unreadable dialogue and pick it up after repair', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'verfix-scheduling-schema-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, 'db');
  const marker = 'PRIVATE-LEGACY-DIALOGUE';
  const diagnostic = t.mock.method(console, 'error', () => {});
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE dialogues (user_id INTEGER NOT NULL, topic_id INTEGER NOT NULL,
    state TEXT NOT NULL, PRIMARY KEY(user_id,topic_id))`);
  const insert = db.prepare('INSERT INTO dialogues VALUES (2,?,?)');
  const reply = (topicId: number, text: string) => JSON.stringify({userId: 2, topicId, history: [],
    delivery: {parts: [{kind: 'text', text: 'already acknowledged'}, {kind: 'text', text}], next: 1}});
  const unreadable = JSON.stringify({userId: 2, topicId: 10, history: [{role: 'user', text: marker}],
    pending: {refs: [], readyAt: {}}});
  insert.run(10, unreadable);
  insert.run(11, reply(11, 'valid answer'));
  insert.run(12, JSON.stringify({userId: 2, topicId: 12, history: [], reset: {threadIds: ['old']}}));
  insert.run(13, JSON.stringify({userId: 2, topicId: 13, history: [], request: {id: 'running', imageIds: {length: 1}}}));
  insert.run(14, JSON.stringify({userId: 2, topicId: 14, history: [], request: {id: 'repeat', repeat: true},
    latestTask: {sources: null, completed: {}}}));
  insert.run(15, JSON.stringify({userId: 2, topicId: 15, history: [], request: {id: 'thread', threadId: {}}}));
  db.close();

  const sent: string[] = [], cleaned: string[] = [];
  const telegram = {sendPart: async (_id, part) => { if (part.kind === 'text') sent.push(part.text); return 1; }} satisfies Partial<TelegramTransport>;
  const engine = {deleteThread: async id => { cleaned.push(id); }} satisfies Partial<ModelEngine>;
  const config: BotConfig = {botToken: '123:TEST', ownerId: 1, allowedUserIds: [2],
    databasePath: path, runtimeDir: directory, defaultModel: 'gpt-6.2-sol', defaultEffort: 'medium',
    maxConcurrentRequests: 4, requestTimeoutMs: 1000, pollTimeoutSeconds: 30};
  async function recover() {
    const store = new SqliteStore(path);
    const bot = createBot({store, config: {snapshot: () => ({valid: true, config})},
      telegram: telegram as TelegramTransport, engine: engine as ModelEngine});
    try { await bot.recover(); }
    finally { await bot.shutdown(); store.close(); }
  }
  await recover();
  const delivered = ['valid answer', 'Диалог сброшен. Отправьте новый запрос.'];
  assert.deepEqual(sent.slice().sort(), delivered.slice().sort());
  assert.deepEqual(cleaned, ['old']);
  assert.equal(diagnostic.mock.callCount(), 4);
  assert.ok(diagnostic.mock.calls.every(call => !String(call.arguments).includes(marker)));

  const repair = new DatabaseSync(path);
  assert.equal(repair.prepare('SELECT state FROM dialogues WHERE topic_id=10').get()?.state, unreadable);
  repair.prepare('UPDATE dialogues SET state=? WHERE topic_id=10').run(reply(10, 'repaired answer'));
  repair.close();
  await recover();
  assert.equal(sent.length, 3);
  assert.equal(sent[2], 'repaired answer');
  assert.equal(diagnostic.mock.callCount(), 4);
});

test('an unreadable confirmed broadcast does not prevent the following one from reaching its recipients', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'verfix-broadcast-schema-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const path = join(dir, 'db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE broadcasts (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, state TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO broadcasts VALUES (?,1,?)');
  insert.run('bad', JSON.stringify({id: 'bad', owner: {}, text: 'PRIVATE-BROADCAST', recipients: []}));
  insert.run('good', JSON.stringify({id: 'good', owner: {userId: 1}, text: 'announcement',
    recipients: [{userId: 2, status: 'pending'}]}));
  db.close();
  const diagnostic = t.mock.method(console, 'error', () => {});
  const store = new SqliteStore(path);
  const sends: [number, string][] = [];
  const telegram = {sendText: async (id, text) => { sends.push([id, text]); return 1; }} satisfies Partial<TelegramTransport>;
  const config = {ownerId: 1, allowedUserIds: [2]} as BotConfig;
  const bot = createBot({store, config: {snapshot: () => ({valid: true, config})},
    telegram: telegram as TelegramTransport, engine: {} as ModelEngine});
  try {
    await bot.recover();
    await bot.drain();
    assert.deepEqual(sends.filter(([id]) => id === 2), [[2, 'announcement']]);
    assert.equal(diagnostic.mock.callCount(), 1);
    assert.ok(!String(diagnostic.mock.calls[0]?.arguments).includes('PRIVATE-BROADCAST'));
  } finally { await bot.shutdown(); store.close(); }
});

test('malformed stored state never exposes dialogue content through parser errors', t=>{
 const directory=mkdtempSync(join(tmpdir(),'verfix-malformed-state-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const path=join(directory,'db');const store=new SqliteStore(path);
 const db=new DatabaseSync(path);const marker='PRIVATE-DIALOGUE-MUST-NOT-LEAK';
 db.prepare('INSERT INTO dialogues(user_id,topic_id,state) VALUES(?,?,?)').run(2,10,'{"userId":2,"history":[{"role":"user ,"text":"'+marker+'"}]}');
 try {
  for(const read of [()=>store.all(),()=>store.get(2,10)]) {
   assert.throws(read,(error:Error)=>error.name==='StoredDialogueError'&&!String(error).includes(marker)&&!error.stack?.includes(marker));
  }
  // The invalid snapshot is preserved; a valid replacement restores normal reads.
  assert.equal(db.prepare('SELECT count(*) AS count FROM dialogues').get()!.count,1);
  store.put({userId:2,topicId:10,history:[]});assert.equal(store.all().length,1);
 }finally {db.close();store.close();}
});

test('a malformed snapshot in background delivery does not terminate the bot process',async()=>{
 const {spawnSync}=await import('node:child_process');
 const directory=mkdtempSync(join(tmpdir(),'verfix-timer-state-'));
 const code=String.raw`
 import {DatabaseSync} from 'node:sqlite';
 import {SqliteStore} from './src/store.ts';
 import {createBot} from './src/bot.ts';
 const path=process.argv[1],mode=process.argv[2];const store=new SqliteStore(path);
 const config={ownerId:1,allowedUserIds:[2],maxConcurrentRequests:4,requestTimeoutMs:2000,defaultModel:'gpt-6.2-sol',defaultEffort:'medium'};let listener,parts=0,texts=0,tasks=0;
 const bot=createBot({store,config:{snapshot:()=>({valid:true,config}),watch:callback=>{listener=callback;return ()=>{};}},telegram:{sendPart:async()=>{parts++;return 1;},sendText:async()=>{texts++;return 1;},typing:async()=>{}},engine:{run:async request=>{if(request.text!=='saved album task')throw new Error('Album task changed');tasks++;return {text:'done',threadId:'recovered-thread',images:[]};}}});
 if(mode==='album'||mode==='album-dispatch'){
  store.put({userId:2,topicId:10,history:[],pending:{refs:[],captions:mode==='album-dispatch'?['saved album task']:[],readyAt:Date.now()+75}});
  listener({valid:true,config});
 }
 const db=new DatabaseSync(path);db.prepare('INSERT INTO dialogues(user_id,topic_id,state) VALUES(?,?,?) ON CONFLICT(user_id,topic_id) DO UPDATE SET state=excluded.state').run(mode==='album-dispatch'?3:2,mode==='album-dispatch'?11:10,'{"userId":2,"history":[{"role":"user ,"text":"PRIVATE-DIALOGUE-MUST-NOT-LEAK"}]}');db.close();
 if(mode==='reload'){config.allowedUserIds=[];listener({valid:true,config});}
 if(mode!=='preserve')setTimeout(()=>{
  if(mode==='album-dispatch'){store.put({userId:3,topicId:11,history:[]});return;}
  const state={userId:2,topicId:10,history:[]};
  if(mode==='repair')state.delivery={parts:[{kind:'text',text:'recovered delivery'}],next:0};
  if(mode==='reload'||mode==='album')state.pending={refs:[],captions:[],readyAt:Date.now()+1};
  store.put(state);
 },400);
 setTimeout(async()=>{
  if(mode==='repair'&&parts!==1)process.exitCode=2;
  if(mode==='reload'&&!store.get(2,10).pending?.awaitingTask)process.exitCode=3;
  if(mode==='album'&&(texts!==1||store.get(2,10).pending?.readyAt))process.exitCode=4;
  if(mode==='album-dispatch'&&(tasks!==1||parts!==1))process.exitCode=5;
  await bot.shutdown();store.close();console.log('SURVIVED_AND_RECOVERED');
 },1200);
 `;
 try {
  for(const mode of ['repair','preserve','reload','album','album-dispatch']) {
   const child=spawnSync(process.execPath,['--input-type=module','-e',code,join(directory,mode+'.sqlite'),mode],{encoding:'utf8',timeout:8000});
   assert.equal(child.status,0,'Background parser error must not kill the process: '+mode);
   assert.match(child.stdout,/SURVIVED_AND_RECOVERED/);
   assert.doesNotMatch(child.stderr,/PRIVATE-DIALOGUE-MUST-NOT-LEAK/);
  }
 }finally {rmSync(directory,{recursive:true,force:true});}
});
