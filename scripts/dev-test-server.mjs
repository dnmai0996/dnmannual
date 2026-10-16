// Local review server with test storage; never use this command for production.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname} from 'node:path';
import handler from '../netlify/functions/api.mjs';
const root=fileURLToPath(new URL('../public/',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.json':'application/json'};
http.createServer(async(req,res)=>{try{if(req.url.startsWith('/api/')){const chunks=[];for await(const c of req)chunks.push(c);const b=Buffer.concat(chunks);const request=new Request('http://127.0.0.1:8765'+req.url,{method:req.method,headers:req.headers,...(b.length?{body:b,duplex:'half'}:{})});const result=await handler(request,{});res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));return;}const url=new URL(req.url,'http://localhost');const p=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));if(!p.startsWith(root))throw Error('forbidden');const data=await readFile(p);res.writeHead(200,{'Content-Type':types[extname(p)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);}catch(e){res.writeHead(404);res.end('Not found');}}).listen(8765,'127.0.0.1',()=>console.log('Review server http://127.0.0.1:8765 - mock storage'));
