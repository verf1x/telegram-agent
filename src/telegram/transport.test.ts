import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { TelegramApi } from './transport.ts';
import { formatAnswer } from './format.ts';

async function downloadServer(handler: Parameters<typeof createServer>[0]) {
  const http = createServer(handler);
  await new Promise<void>(resolve => http.listen(0,'127.0.0.1',resolve));
  return {api:new TelegramApi('123:secret',{baseUrl:`http://127.0.0.1:${(http.address() as {port:number}).port}`}),close:()=>new Promise<void>(resolve=>{http.closeAllConnections();http.close(()=>resolve());})};
}

test('downloads bytes by Telegram file ID without treating the file name as a host path',async()=>{
  const seen:string[]=[];
  const remote=await downloadServer((request,response)=>{
    seen.push(request.url!);
    if(request.url!.endsWith('/getFile'))response.end(JSON.stringify({ok:true,result:{file_path:'documents/file_12.txt',file_size:5}}));
    else response.end('hello');
  });
  try{
    assert.equal(Buffer.from(await remote.api.downloadFile('telegram-id',10)).toString(),'hello');
    assert.deepEqual(seen,['/bot123:secret/getFile','/file/bot123:secret/documents/file_12.txt']);
  }finally{await remote.close();}
});

test('download limits apply to metadata, headers and streamed bytes with safe diagnostics',async()=>{
  for(const mode of ['metadata','headers','stream']) {
    let downloads=0;
    const remote=await downloadServer((request,response)=>{
      if(request.url!.endsWith('/getFile')) {response.end(JSON.stringify({ok:true,result:{file_path:'documents/file.txt',...(mode==='metadata'?{file_size:11}:{})}}));return;}
      downloads++;
      if(mode==='headers')response.setHeader('content-length','11');
      else response.setHeader('transfer-encoding','chunked');
      response.write('12345');response.end('678901');
    });
    try {
      await assert.rejects(remote.api.downloadFile('id',10),(error:Error)=>/слишком большой/.test(error.message)&&!String(error).includes('secret'));
      assert.equal(downloads,mode==='metadata'?0:1);
    }finally{await remote.close();}
  }
});

test('unsafe Telegram paths and redirects cannot forward bot credentials',async()=>{
  for(const path of ['https://evil.test/x','//evil.test/x','/photos/x','../file','photos/../x','photos/%2e%2e/x','photos/%252e%252e/x','photos/a?x=1','photos/a#x','photos/a\\x','photos/a\nx']){
    let downloads=0;
    const remote=await downloadServer((request,response)=>{
      if(request.url!.endsWith('/getFile'))response.end(JSON.stringify({ok:true,result:{file_path:path}}));
      else {downloads++;response.end('bad');}
    });
    try {await assert.rejects(remote.api.downloadFile('id',10));assert.equal(downloads,0);}finally{await remote.close();}
  }
  let leaked=0;
  const remote=await downloadServer((request,response)=>{
    if(request.url!.endsWith('/getFile'))response.end(JSON.stringify({ok:true,result:{file_path:'photos/x.jpg'}}));
    else if(request.url!.includes('/file/')){response.writeHead(302,{location:'/leak/123:secret'});response.end();}
    else {leaked++;response.end('leaked');}
  });
  try {await assert.rejects(remote.api.downloadFile('id',10),(error:Error)=>!String(error).includes('secret'));assert.equal(leaked,0);}finally{await remote.close();}
});

test('a stalled download can be cancelled without exposing an abort reason or remote errors',async()=>{
  const abort=new AbortController();
  const remote=await downloadServer((request,response)=>{
    if(request.url!.endsWith('/getFile'))response.end(JSON.stringify({ok:true,result:{file_path:'photos/x.jpg'}}));
    else {response.write('x');setTimeout(()=>abort.abort(new Error('123:secret')),20);}
  });
  try {await assert.rejects(remote.api.downloadFile('id',10,abort.signal),(error:Error)=>error.name==='AbortError'&&!String(error).includes('secret'));}finally{await remote.close();}
  const failure=await server(()=>({ok:false,error_code:400,description:'https://api.telegram.org/bot123:secret/getFile'}));
  try {await assert.rejects(failure.api.downloadFile('id',10),(error:Error)=>!String(error).includes('secret'));}finally{await failure.close();}
});

async function server(handler: (method: string, body: string, contentType: string, raw: Buffer) => unknown | Promise<unknown>) {
  const http = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const result = await handler(request.url!.split('/').at(-1)!, raw.toString(), request.headers['content-type'] ?? '', raw);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address() as {port:number};
  return { api: new TelegramApi('123:secret', {baseUrl: `http://127.0.0.1:${address.port}`}), close: () => new Promise<void>(resolve => http.close(() => resolve())) };
}

test('delivers headings, a table and LaTeX as Telegram rich Markdown', async () => {
  let delivered: unknown;
  const remote = await server((method, body) => {
    assert.equal(method, 'sendRichMessage');
    delivered = JSON.parse(body);
    return {ok:true,result:{message_id:42}};
  });
  try {
    const [part] = formatAnswer({text:'# Решение\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n\\(x^2\\)\n\n\\[x+y\\]',images:[]});
    assert.equal(await remote.api.sendPart(7, part!), 42);
    assert.deepEqual(delivered, {chat_id:7,rich_message:{markdown:'# Решение\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n$x^2$\n\n$$x+y$$'}});
  } finally { await remote.close(); }
});

test('does not interpret math delimiters inside fenced or inline code', async () => {
  const seen: string[] = [];
  const remote = await server((_method, body) => { seen.push(JSON.parse(body).rich_message.markdown); return {ok:true,result:{message_id:1}}; });
  try {
    for (const part of formatAnswer({text:'`\\(literal\\)`\n\n```python\n\\[literal\\]\n```\n\n\\(x\\)',images:[]})) await remote.api.sendPart(7,part);
    assert.equal(seen.join(''),'`\\(literal\\)`\n\n```python\n\\[literal\\]\n```\n\n$x$');
  } finally { await remote.close(); }
});

test('unsupported rich formatting falls back to complete readable text without parse_mode', async () => {
  const received: string[] = [];
  const remote = await server((method, body) => {
    if (method === 'sendRichMessage') return {ok:false,error_code:400,description:"Bad Request: can't parse rich message"};
    const value = JSON.parse(body);
    assert.equal(value.parse_mode,undefined);
    assert.ok(value.text.length <= 4096);
    assert.equal(value.text.isWellFormed(),true);
    received.push(value.text);
    return {ok:true,result:{message_id:received.length}};
  });
  try {
    const text = '**Длинный ответ** ' + '😀'.repeat(6000) + ' Конец';
    await remote.api.sendPart(7,{kind:'rich',text});
    assert.equal(received.join(''),text);
  } finally { await remote.close(); }
});

test('temporary failures remain retryable without duplicate plain delivery or leaked token', async () => {
  const received: string[] = [];
  const remote = await server((method) => { received.push(method); return {ok:false,error_code:429,description:'token 123:secret',parameters:{retry_after:3}}; });
  try {
    await assert.rejects(remote.api.sendPart(7,{kind:'rich',text:'answer'}),(error: any) => {
      assert.equal(error.retryAfter,3);
      assert.equal(error.permanent,false);
      assert.equal(String(error).includes('secret'),false);
      return true;
    });
    assert.deepEqual(received,['sendRichMessage']);
  } finally { await remote.close(); }
});

test('an unfinished code fence is readable and math source remains literal', async () => {
  let text = '';
  const remote = await server((_method, body) => { const data = JSON.parse(body); text += data.rich_message?.markdown ?? data.text; return {ok:true,result:{message_id:1}}; });
  try {
    const original = '```python\nprint("\\(literal\\)")';
    for (const part of formatAnswer({text:original,images:[]})) await remote.api.sendPart(7,part);
    assert.equal(text,original);
  } finally { await remote.close(); }
});

test('long answers preserve every code, table and formula character in order', async () => {
  const messages: string[] = [];
  const remote = await server((method, body) => {
    const data = JSON.parse(body);
    const text = data.rich_message?.markdown ?? data.text;
    assert.ok(text.length <= (method === 'sendMessage' ? 4096 : 8000));
    messages.push(text);
    return {ok:true,result:{message_id:messages.length}};
  });
  try {
    const text = '# Ответ\n\n' + ('Абзац '.repeat(600) + '\n\n').repeat(4) + '```python\n' + 'print("😀")\n'.repeat(1200) + '```\n\n' + '| x | y |\n|---|---|\n' + '| 1 | 2 |\n'.repeat(600) + '\n$$' + 'x+'.repeat(5000) + 'y$$\n\nГотово';
    for (const part of formatAnswer({text,images:[]})) await remote.api.sendPart(7,part);
    assert.equal(messages.join(''),text);
  } finally { await remote.close(); }
});

test('polling carries durable offset, permits callbacks, and supports cancellation', async () => {
  const remote = await server((method, body) => {
    assert.equal(method,'getUpdates');
    assert.deepEqual(JSON.parse(body),{offset:71,timeout:20,allowed_updates:['message','callback_query']});
    return {ok:true,result:[{update_id:71,message:{message_id:1,date:123,chat:{id:7,type:'private'},text:'hi'}}]};
  });
  try {
    assert.equal((await remote.api.getUpdates({offset:71,timeout:20}))[0]?.update_id,71);
    const controller = new AbortController();
    controller.abort(new Error('secret 123:secret'));
    await assert.rejects(remote.api.getUpdates({offset:71,timeout:20,signal:controller.signal}), (error: any) => error.name === 'AbortError' && !String(error).includes('secret'));
  } finally { await remote.close(); }
});

test('chat actions and model keyboard callbacks use Bot API without parse modes', async () => {
  const seen: Array<[string,unknown]> = [];
  const remote = await server((method,body) => { seen.push([method,JSON.parse(body)]); return {ok:true,result:{message_id:8}}; });
  try {
    await remote.api.typing(7);
    await remote.api.answerCallback('cb','Выбрано');
    await remote.api.sendText(7,'Модель',{reply_markup:{inline_keyboard:[[{text:'GPT',callback_data:'model:0'}]]}});
    assert.deepEqual(seen,[['sendChatAction',{chat_id:7,action:'typing'}],['answerCallbackQuery',{callback_query_id:'cb',text:'Выбрано'}],['sendMessage',{chat_id:7,text:'Модель',reply_markup:{inline_keyboard:[[{text:'GPT',callback_data:'model:0'}]]}}]]);
  } finally { await remote.close(); }
});

test('generated PNGs arrive as multipart images, with image-document fallback for extreme dimensions', async () => {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhH8AAAAASUVORK5CYII=','base64');
  const seen: Array<[string,string,Uint8Array]> = [];
  const remote = await server(async (method, _body, contentType, raw) => {
    const form = await new Response(raw,{headers:{'content-type':contentType}}).formData();
    assert.equal(form.get('chat_id'),'7');
    const file = form.get(method === 'sendPhoto' ? 'photo' : 'document') as File;
    seen.push([method,file.type,new Uint8Array(await file.arrayBuffer())]);
    return {ok:true,result:{message_id:3}};
  });
  try {
    await remote.api.sendPart(7,{kind:'image',base64:image.toString('base64'),name:'plot.png',mime:'image/png'});
    assert.equal(seen[0]?.[0],'sendPhoto');
    assert.equal(seen[0]?.[1],'image/png');
    assert.deepEqual(Buffer.from(seen[0]![2]),image);
    const wide = Buffer.from(image);
    wide.writeUInt32BE(10001,16);
    await remote.api.sendPart(7,{kind:'image',base64:wide.toString('base64'),name:'plot.png',mime:'image/png'});
    assert.equal(seen[1]?.[0],'sendDocument');
  } finally { await remote.close(); }
});

test('topic routing survives rich fallback, uploads, typing and topic management', async () => {
  const seen:Array<{method:string;body:string}> = [];
  const remote = await server((method,body) => {
    seen.push({method,body});
    if (method === 'sendRichMessage') return {ok:false,error_code:400,description:'unsupported markdown format'};
    if (method === 'createForumTopic') return {ok:true,result:{message_thread_id:78}};
    return {ok:true,result:{message_id:9}};
  });
  try {
    await remote.api.sendPart(2,{kind:'rich',text:'hello'},{message_thread_id:78});
    await remote.api.typing(2,undefined,78);
    const {readFileSync} = await import('node:fs');
    const png = readFileSync(new URL('../../tests/fixtures/attachments/tiny.png',import.meta.url));
    await remote.api.sendPart(2,{kind:'image',name:'result.png',mime:'image/png',base64:png.toString('base64')},{message_thread_id:78});
    assert.equal(await remote.api.createTopic(2,'Предыдущий диалог'),78);
    await remote.api.deleteTopic(2,78);
    for (const call of seen.filter(x=>x.method!=='createForumTopic')) {
      if (call.method==='sendPhoto') assert.match(call.body,/name="message_thread_id"\r\n\r\n78/);
      else assert.equal(JSON.parse(call.body).message_thread_id,78,call.method);
    }
  } finally { await remote.close(); }
});

test('arbitrary response files use sendDocument with their original editable bytes and Unicode filename',async()=>{
 let received:any;
 const api=new TelegramApi('123:secret',{fetch:async(url,options)=>{
  received={url,body:options!.body};
  return new Response(JSON.stringify({ok:true,result:{message_id:9}}));
 }});
 const bytes=Buffer.from('a,b\n1,2');
 assert.equal(await api.sendFile(2,{name:'Отчёт.csv',mime:'text/csv',bytes},{message_thread_id:78}),9);
 assert.ok(received.url.endsWith('/sendDocument'));
 assert.equal(received.body.get('chat_id'),'2');
 assert.equal(received.body.get('message_thread_id'),'78');
 const file=received.body.get('document') as File;
 assert.equal(file.name,'Отчёт.csv');assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes);
 await assert.rejects(api.sendFile(2,{name:'large.bin',mime:'application/octet-stream',bytes:Buffer.alloc(50_000_001)}));
});
