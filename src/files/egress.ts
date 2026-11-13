import {createServer, request as httpRequest} from 'node:http';
import {connect, isIP, type Socket} from 'node:net';
import {lookup} from 'node:dns/promises';
import {networkInterfaces} from 'node:os';
import {chmod} from 'node:fs/promises';

/** Only public internet destinations; resolved once and pinned before connect. */
function publicAddress(ip:string): boolean {
  if(isIP(ip)===4) {
    const [a,b]=ip.split('.').map(Number) as [number,number];
    return !(a===0 || a===10 || a===127 || a>=224 || a===169&&b===254 || a===172&&b>=16&&b<=31 || a===192&&(b===168||b===0||b===2) || a===100&&b>=64&&b<=127 || a===198&&(b===18||b===19||b===51) || a===203&&b===0);
  }
  return isIP(ip)===6 && /^[23]/i.test(ip) && !/^2001:(?:db8|0):/i.test(ip) && !/^2002:/i.test(ip);
}
async function destination(host:string) {
  const addresses=await lookup(host,{all:true});
  const local=new Set(Object.values(networkInterfaces()).flatMap(items=>items?.map(item=>item.address)??[]));
  if(!addresses.length || addresses.some(item=>!publicAddress(item.address)||local.has(item.address)))throw new Error('Destination denied');
  return addresses.find(item=>item.family===4)??addresses[0]!;
}

/** Unix socket grants HTTP(S), never access to the host network or Docker API. */
export async function startEgress(socketPath:string):Promise<()=>Promise<void>> {
  const sockets=new Set<Socket>();
  const server=createServer({maxHeaderSize:16384},(req,res)=>{
    void (async()=>{
      const url=new URL(req.url??'');
      if(url.protocol!=='http:' || url.port && url.port!=='80' || url.username || url.password)throw new Error('Denied');
      const target=await destination(url.hostname);
      const headers:Record<string,string|string[]|undefined>={...req.headers,host:url.host};
      delete headers['proxy-authorization'];delete headers['proxy-connection'];
      const upstream=httpRequest({hostname:target.address,family:target.family,port:80,method:req.method,path:url.pathname+url.search,headers,timeout:30000},response=>{
        res.writeHead(response.statusCode??502,response.headers);response.pipe(res);
      });
      upstream.on('socket',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
      upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>res.destroy());
      req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
    })().catch(()=>{if(!res.headersSent)res.writeHead(403);res.end('Destination denied');});
  });
  server.maxConnections=32;server.requestTimeout=60000;server.headersTimeout=10000;
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.setTimeout(60000,()=>socket.destroy());});
  server.on('connect',(req,client,head)=>{
    void (async()=>{
      const url=new URL('https://'+req.url);
      if(url.port && url.port!=='443' || url.username || url.password || url.pathname!=='/')throw new Error('Denied');
      const target=await destination(url.hostname);
      if(client.destroyed)return;
      const upstream=connect({host:target.address,family:target.family,port:443});
      sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));
      upstream.setTimeout(60000,()=>upstream.destroy());upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
      upstream.on('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
    })().catch(()=>client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  });
  await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(socketPath,()=>accept());});
  await chmod(socketPath,0o666);
  return async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(accept=>server.close(()=>accept()));};
}
