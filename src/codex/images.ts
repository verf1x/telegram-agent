import { GENERATED_IMAGE_LIMITS,ImageGenerationError } from '../contracts.ts';

const invalid=()=>new ImageGenerationError('Не удалось получить корректное изображение от Codex. Попробуйте повторить запрос.');
const crcTable=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let bit=0;bit<8;bit++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes:Uint8Array){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]!^(crc>>>8);return (crc^0xffffffff)>>>0;}

/** Metadata and chunk integrity only. No image decoder or model-supplied path runs on the host. */
export function nativePng(result:unknown,remainingBytes:number):Buffer {
  if(typeof result!=='string'||!result||result.length%4!==0||result.length>Math.ceil(GENERATED_IMAGE_LIMITS.imageBytes/3)*4)throw invalid();
  const decodedBytes=result.length/4*3-(result.endsWith('==')?2:result.endsWith('=')?1:0);
  if(decodedBytes>remainingBytes)throw new ImageGenerationError('Изображения Codex слишком большие для одного ответа. Попросите меньше изображений.');
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(result))throw invalid();
  const bytes=Buffer.from(result,'base64');
  if(bytes.length>GENERATED_IMAGE_LIMITS.imageBytes||bytes.toString('base64')!==result||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw invalid();
  let offset=8,header=false,palette=false,data=false,dataEnded=false,dataBytes=0,color=-1;
  while(offset+12<=bytes.length){
    const length=bytes.readUInt32BE(offset),end=offset+12+length;
    if(end>bytes.length)throw invalid();
    const kind=bytes.toString('latin1',offset+4,offset+8);
    if(!/^[A-Za-z]{4}$/.test(kind)||kind[2]!==kind[2]!.toUpperCase()||crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))throw invalid();
    if(!header&&kind!=='IHDR')throw invalid();
    if(kind==='IHDR'){
      if(header||length!==13)throw invalid();
      const width=bytes.readUInt32BE(offset+8),height=bytes.readUInt32BE(offset+12),depth=bytes[offset+16]!;color=bytes[offset+17]!;
      const depths:Record<number,number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if(!width||!height||width>GENERATED_IMAGE_LIMITS.dimension||height>GENERATED_IMAGE_LIMITS.dimension||width*height>GENERATED_IMAGE_LIMITS.pixels||!depths[color]?.includes(depth)||bytes[offset+18]!==0||bytes[offset+19]!==0||bytes[offset+20]!>1)throw invalid();
      header=true;
    }else if(kind==='PLTE'){
      if(palette||data||color===0||color===4||!length||length>768||length%3)throw invalid();palette=true;
    }else if(kind==='IDAT'){
      if(dataEnded||(color===3&&!palette))throw invalid();data=true;dataBytes+=length;
    }else if(kind==='IEND'){
      if(length||!data||!dataBytes||end!==bytes.length)throw invalid();return bytes;
    }else{
      // Unknown critical chunks cannot be interpreted safely as PNG.
      if(kind[0]===kind[0]!.toUpperCase())throw invalid();
      if(data)dataEnded=true;
    }
    offset=end;
  }
  throw invalid();
}
