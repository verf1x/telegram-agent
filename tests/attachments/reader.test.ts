import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SandboxedAttachmentReader} from '../../src/attachments/reader.ts';

const pythonPath=process.env.VERFIX_TEST_PYTHON;
test('a task receives complete UTF-8 text with its display name through the isolated reader',{skip:!pythonPath},async()=>{
 const reader=new SandboxedAttachmentReader({pythonPath});
 const result=await reader.prepare([{name:'../../notes.md',mime:'text/markdown',bytes:Buffer.from('# План\nПривет, мир!\n42')}],new AbortController().signal);
 assert.deepEqual(result,[{name:'../../notes.md',text:'# План\nПривет, мир!\n42',images:[]}]);
});

import {readFile,readdir} from 'node:fs/promises';
const fixture=async(name:string,mime:string)=>({name,mime,bytes:await readFile(new URL(`../fixtures/attachments/${name}`,import.meta.url))});
test('photos and uploaded PNG/JPEG/WebP become bounded vision images',{skip:!pythonPath},async()=>{
 const reader=new SandboxedAttachmentReader({pythonPath});
 const result=await reader.prepare(await Promise.all(['png','jpg','webp'].map(ext=>fixture(`question.${ext}`,`image/${ext}`))),new AbortController().signal);
 assert.equal(result.length,3);
 for(const file of result){assert.equal(file.text,'');assert.equal(file.images.length,1);assert.match(file.images[0]!.base64,/^[A-Za-z0-9+/]+=*$/);assert.ok(['image/png','image/jpeg'].includes(file.images[0]!.mime));}
});

test('a PDF retains extracted text and every rendered page including its scan',{skip:!pythonPath},async()=>{
 const reader=new SandboxedAttachmentReader({pythonPath});
 const [file]=await reader.prepare([await fixture('pages.pdf','application/pdf')],new AbortController().signal);
 assert.match(file!.text,/The answer is forty-two\./);
 assert.equal(file!.images.length,2);
 assert.ok(file!.images.every(image=>Buffer.from(image.base64,'base64').length>1000));
});

test('DOCX paragraphs, table cells and embedded pictures retain their order',{skip:!pythonPath},async()=>{
 const [file]=await new SandboxedAttachmentReader({pythonPath}).prepare([await fixture('report.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document')],new AbortController().signal);
 assert.match(file!.text,/First paragraph\.\nAlice\t42\nLast paragraph\.\[Image 1\]/);
 assert.equal(file!.images.length,1);
});

test('a Word fraction reaches the task with its numerator and denominator intact',{skip:!pythonPath},async()=>{
 const [file]=await new SandboxedAttachmentReader({pythonPath}).prepare([await fixture('fraction.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document')],new AbortController().signal);
 assert.equal(file!.text,'Compute: \\(\\frac{1}{2}\\) = ?');
 assert.doesNotMatch(file!.text,/Compute: 12/);
});
test('nested Word powers, subscripts and square or indexed roots preserve their mathematical meaning',{skip:!pythonPath},async()=>{
 const [file]=await new SandboxedAttachmentReader({pythonPath}).prepare([await fixture('nested-math.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document')],new AbortController().signal);
 assert.equal(file!.text,'Compute: \\(\\frac{{x}^{2}}{\\sqrt{{y}_{1}}}+\\sqrt[3]{8}\\) = ?');
});
test('complex and strict Word math retains complete labeled OMML instead of lossy plain text',{skip:!pythonPath},async()=>{
 const reader=new SandboxedAttachmentReader({pythonPath});
 for(const name of ['complex-math.docx','strict-math.docx']){
  const [file]=await reader.prepare([await fixture(name,'application/vnd.openxmlformats-officedocument.wordprocessingml.document')],new AbortController().signal);
  assert.match(file!.text,/\[Office Math — complete structured OMML XML\]/);
  for(const structure of ['nary','naryPr','sub','sup','e','sSup'])assert.match(file!.text,new RegExp(`<[^<>]+:${structure}[ >]`));
  assert.match(file!.text,/val="∑"/);assert.match(file!.text,/>i=1</);assert.match(file!.text,/>n</);assert.match(file!.text,/>2</);
  assert.match(file!.text,/\[\/Office Math\]\n = \?$/);
  assert.doesNotMatch(file!.text,/i=1ni2/);
 }
});

test('XLSX keeps sheet, row and cell order, shared strings and inert cached formulas',{skip:!pythonPath},async()=>{
 const [file]=await new SandboxedAttachmentReader({pythonPath}).prepare([await fixture('sheet.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')],new AbortController().signal);
 assert.match(file!.text,/Sales\nA1: Apples\tB1: 42\nB2: =B1\*2 \[cached: 84\]\n\nForecast\nA1: Next year\tB1: 100/);
});
test('PPTX uses presentation slide order and includes embedded pictures',{skip:!pythonPath},async()=>{
 const [file]=await new SandboxedAttachmentReader({pythonPath}).prepare([await fixture('slides.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation')],new AbortController().signal);
 assert.match(file!.text,/Slide 1\nOpening slide\.\n\[Image 1\]\n\nSlide 2\nFinal slide\./);
 assert.equal(file!.images.length,1);
});

test('chart-only Word, Excel and PowerPoint files reject the whole task and request a PDF export',{skip:!pythonPath},async()=>{
 const reader=new SandboxedAttachmentReader({pythonPath});
 for(const name of ['chart.docx','chart.xlsx','chart.pptx']){
  await assert.rejects(reader.prepare([{name:'safe.txt',mime:'text/plain',bytes:Buffer.from('Surrounding task')},await fixture(name,'application/octet-stream')],new AbortController().signal),(error:unknown)=>{
   assert.equal((error as Error).name,'AttachmentError');assert.match((error as Error).message,/PDF/);assert.match((error as Error).message,/диаграмм|график|рисунк/);return true;
  });
 }
});
test('PowerPoint layout and master material cannot disappear behind an empty slide',{skip:!pythonPath},async()=>{
 const reader=new SandboxedAttachmentReader({pythonPath});
 for(const name of ['slideLayout-content.pptx','slideMaster-content.pptx','slideLayout-chart.pptx','slideMaster-chart.pptx'])
  await assert.rejects(reader.prepare([await fixture(name,'application/vnd.openxmlformats-officedocument.presentationml.presentation')],new AbortController().signal),/PDF/);
});
test('Office vector drawings, spreadsheet shapes, connectors and SmartArt request PDF instead of partial content',{skip:!pythonPath},async()=>{
 const reader=new SandboxedAttachmentReader({pythonPath});
 for(const name of ['vector.docx','drawing.xlsx','connector.pptx','smartart.docx'])
  await assert.rejects(reader.prepare([await fixture(name,'application/octet-stream')],new AbortController().signal),/PDF/);
});
test('empty PowerPoint layout placeholders do not hide or reject actual slide text',{skip:!pythonPath},async()=>{
 const [file]=await new SandboxedAttachmentReader({pythonPath}).prepare([await fixture('empty-placeholders.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation')],new AbortController().signal);
 assert.equal(file!.text,'Slide 1\nActual slide text.');
});

test('a corrupt or unsupported attachment rejects the whole task with a safe actionable error',{skip:!pythonPath},async()=>{
 const reader=new SandboxedAttachmentReader({pythonPath});
 for(const file of [
  {name:'corrupt.pdf',mime:'application/pdf',bytes:Buffer.from('this is not a PDF')},
  {name:'corrupt.png',mime:'image/png',bytes:Buffer.from([137,80,78,71,13,10,26,10,0,0])},
  {name:'program.exe',mime:'application/octet-stream',bytes:Buffer.from('MZnot an allowed text document')},
  {name:'binary.txt',mime:'text/plain',bytes:Buffer.from([255,254,0,20])},
 ]){
  await assert.rejects(reader.prepare([{name:'safe.txt',mime:'text/plain',bytes:Buffer.from('safe')},file],new AbortController().signal),(error:unknown)=>{
   assert.equal((error as Error).name,'AttachmentError');assert.match((error as Error).message,/формат|Разделите|разделите/);assert.doesNotMatch((error as Error).message,/\/tmp|\/home|Traceback|runner\.py/);return true;
  });
 }
});
test('archive traversal, XML DTDs, decompression bombs and external image links are rejected',{skip:!pythonPath},async()=>{
 const reader=new SandboxedAttachmentReader({pythonPath});
 for(const name of ['traversal.docx','dtd.docx','zipbomb.docx','linked.docx'])await assert.rejects(reader.prepare([await fixture(name,'application/vnd.openxmlformats-officedocument.wordprocessingml.document')],new AbortController().signal),{name:'AttachmentError'});
});
test('PDF pages and text bytes are bounded without returning a truncated task',{skip:!pythonPath},async()=>{
 const reader=new SandboxedAttachmentReader({pythonPath});
 await assert.rejects(reader.prepare([await fixture('too-many-pages.pdf','application/pdf')],new AbortController().signal),/Разделите/);
 await assert.rejects(reader.prepare([{name:'large.txt',mime:'text/plain',bytes:Buffer.alloc(500001,65)}],new AbortController().signal),/Разделите/);
});

test('cumulative prepared text and image budgets apply across different files',{skip:!pythonPath},async()=>{
 const reader=new SandboxedAttachmentReader({pythonPath});
 await assert.rejects(reader.prepare([{name:'part1.txt',mime:'text/plain',bytes:Buffer.alloc(250001,65)},{name:'part2.txt',mime:'text/plain',bytes:Buffer.alloc(250001,66)}],new AbortController().signal),/Разделите/);
 const noise=await fixture('noise.png','image/png');
 await assert.rejects(reader.prepare([noise,noise],new AbortController().signal),/Разделите/);
});
test('raw upload counts and byte budgets reject before parsing',{skip:!pythonPath},async()=>{
 const reader=new SandboxedAttachmentReader({pythonPath});const signal=new AbortController().signal;
 const small={name:'a.txt',mime:'text/plain',bytes:Buffer.from('x')};
 await assert.rejects(reader.prepare(Array(11).fill(small),signal),/Разделите/);
 const large={...small,bytes:Buffer.alloc(20_000_001)};
 await assert.rejects(reader.prepare([large],signal),/Разделите/);
 await assert.rejects(reader.prepare(Array(3).fill({...small,bytes:Buffer.alloc(17_000_000)}),signal),/Разделите/);
});
test('encrypted members, symlink archives and unreadably tall screenshots ask for correction',{skip:!pythonPath},async()=>{
 const reader=new SandboxedAttachmentReader({pythonPath});
 for(const name of ['encrypted.docx','symlink.docx','too-tall.png'])await assert.rejects(reader.prepare([await fixture(name,name.endsWith('png')?'image/png':'application/octet-stream')],new AbortController().signal),{name:'AttachmentError'});
});
test('cancellation stops parsing promptly and a later task can still be read',{skip:!pythonPath},async()=>{
 const reader=new SandboxedAttachmentReader({pythonPath});const abort=new AbortController();
 const input=await fixture('noise.png','image/png');const started=Date.now();
 const pending=reader.prepare([input,input,input],abort.signal);
 let children:number[]=[];
 const timer=setTimeout(async()=>{
  const entries=await Promise.all((await readdir('/proc')).filter(name=>/^\d+$/.test(name)).map(async name=>{
   try {const status=await readFile(`/proc/${name}/stat`,'utf8');return {pid:Number(name),parent:Number(status.slice(status.lastIndexOf(')')+2).split(' ')[1])};}catch{return {pid:0,parent:0};}
  }));
  const descendants=new Set([process.pid]);
  for(let size=-1;size!==descendants.size;){size=descendants.size;for(const entry of entries)if(descendants.has(entry.parent))descendants.add(entry.pid);}
  children=[...descendants].filter(pid=>pid!==process.pid&&pid!==0);
  abort.abort();
 },1000);
 try{
  await assert.rejects(pending,/отменено/);assert.ok(Date.now()-started<5000);
  assert.ok(children.length>0,'the real launcher was running at cancellation');
  for(const pid of children){
   let remains=true;
   for(let tries=0;tries<20;tries++){
    try {await readFile(`/proc/${pid}/stat`);}catch{remains=false;break;}
    await new Promise(done=>setTimeout(done,50));
   }
   assert.equal(remains,false,`cancelled parser process ${pid} must exit`);
  }
 }finally{clearTimeout(timer);}
 const [next]=await reader.prepare([{name:'next.txt',mime:'text/plain',bytes:Buffer.from('Still independent.')}],new AbortController().signal);
 assert.equal(next!.text,'Still independent.');
});

test('transparent screenshots are flattened on white and EXIF orientation is respected',{skip:!pythonPath},async()=>{
 const reader=new SandboxedAttachmentReader({pythonPath});
 const result=await reader.prepare([await fixture('transparent.png','image/png'),await fixture('rotated.png','image/png')],new AbortController().signal);
 assert.deepEqual(Buffer.from(result[0]!.images[0]!.base64,'base64'),(await fixture('white.png','image/png')).bytes);
 const rotated=Buffer.from(result[1]!.images[0]!.base64,'base64');
 assert.equal(rotated.readUInt32BE(16),10);assert.equal(rotated.readUInt32BE(20),20);
});
test('rendered PDF image counts accumulate across files, without losing later pages',{skip:!pythonPath},async()=>{
 const file=await fixture('eleven-pages.pdf','application/pdf');
 await assert.rejects(new SandboxedAttachmentReader({pythonPath}).prepare([file,file],new AbortController().signal),/Разделите/);
});
