import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {startEgress} from '../../src/files/egress.ts';

test('workspace egress rejects loopback, private networks, metadata and non-HTTP destinations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'verfix-proxy-'));
 const socket=join(dir,'proxy.sock');const close=await startEgress(socket);
 try {
  for(const url of ['http://127.0.0.1/','http://10.0.0.1/','http://172.17.0.1/','http://192.168.1.1/','http://169.254.169.254/','http://[::1]/','http://[::ffff:127.0.0.1]/','http://localhost/','file:///etc/passwd','http://example.com:2375/']) {
   const status=await new Promise<number|undefined>((accept,reject)=>{
    const req=request({socketPath:socket,path:url},res=>{res.resume();accept(res.statusCode);});req.on('error',reject);req.end();
   });
   assert.equal(status,403,url);
  }
 } finally {await close();await rm(dir,{recursive:true,force:true});}
});
