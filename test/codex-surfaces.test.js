import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fakeAppServer } from './helpers/codex-server.js';
const handlers={initialize:(_,ok)=>ok({}),'thread/list':(_,ok)=>ok({data:[],nextCursor:null}),'thread/resume':(p,ok)=>ok({thread:{id:p.threadId,status:{type:'idle'}}}),'turn/start':(_,ok)=>ok({turn:{id:'turn-1',status:'inProgress'}}),'turn/steer':(p,ok)=>ok({turnId:p.expectedTurnId}),'thread/turns/list':(_,ok)=>ok({data:[{id:'turn-1',status:'inProgress'}],nextCursor:null}),'thread/items/list':(_,ok)=>ok({data:[],nextCursor:null})};
const fixtureEnv=home=>({...process.env,GROK_BOT_TEST:'1',CODEX_HOME:home,CODEX_APP_SERVER_SOCK:'',GROK_BOT_CODEX_THREADS:'',GROK_BOT_CODEX_EXPERIMENTAL:''});
const cli=(home,...args)=>new Promise(resolveResult=>execFile(process.execPath,['dist/bin/gbot.mjs',...args,'--json'],{env:fixtureEnv(home)},(error,out,err)=>resolveResult({code:error?.code??0,out,err})));
test('built CLI discovers wait/watch and separates accepted delivery from timeout',async()=>{
 const fake=await fakeAppServer(handlers);
 try {
 for(const args of [['send','--wait','--timeout-ms','20','thread-1','hello'],['wait','--timeout-ms','20','thread-1','turn-1']]){
 const r=await cli(fake.home,'codex',...args);assert.equal(r.code,1,r.err);const value=JSON.parse(r.out);assert.equal(value.execution.state,'timeout');if(args[0]==='send')assert.equal(value.delivery,'accepted');
 }
 const watch=await cli(fake.home,'codex','watch','--timeout-ms','20','--max-events','20','thread-1');assert.equal(watch.code,0,watch.err);assert.equal(JSON.parse(watch.out).reason,'timeout');
 const plain=await cli(fake.home,'codex','send','thread-1','hello');assert.equal(plain.code,0,plain.err);assert.equal(JSON.parse(plain.out).execution,undefined);
 const bad=await cli(fake.home,'codex','wait','--timeout-ms','0','thread-1','turn-1');assert.equal(bad.code,2);
 }finally{await fake.close();}
});
test('generated MCP discovers old and new tools and invokes socket-backed calls',async()=>{
 const fake=await fakeAppServer(handlers);
 const manifest=JSON.parse(readFileSync('artifact/mcp.json','utf8'));
 const child=spawn(process.execPath,manifest.mcpServers['grok-bot'].args,{cwd:resolve('artifact'),env:fixtureEnv(fake.home),stdio:['pipe','pipe','pipe']});
 let buf='',seq=0,stderr='';const pending=new Map();child.stderr.on('data',x=>stderr+=x);
 child.stdout.on('data',x=>{buf+=x;for(;;){const i=buf.indexOf('\n');if(i<0)break;const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;const msg=JSON.parse(line);pending.get(msg.id)?.(msg);pending.delete(msg.id);}});
 const rpc=(method,params)=>new Promise((resolveRpc,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`MCP timeout ${stderr}`));},15000);pending.set(id,msg=>{clearTimeout(timer);resolveRpc(msg);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 try {
 const init=await rpc('initialize',{protocolVersion:'2024-11-05',clientInfo:{name:'test',version:'1'},capabilities:{}});assert.ok(init.result,JSON.stringify(init));child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const listed=await rpc('tools/list',{});const names=listed.result.tools.map(t=>t.name);for(const name of ['gbot_send','gbot_thread','codex_threads','codex_send','codex_wait','codex_watch'])assert.ok(names.includes(name),name);
 for(const [name,args] of [['codex_threads',{}],['codex_send',{threadId:'thread-1',message:'hello',wait:true,timeoutMs:20}],['codex_send',{threadId:'thread-1',message:'hello',whenBusy:'steer',expectedTurnId:'turn-1'}],['codex_wait',{threadId:'thread-1',turnId:'turn-1',timeoutMs:20}],['codex_watch',{threadId:'thread-1',timeoutMs:20}]]){
 const response=await rpc('tools/call',{name,arguments:args});assert.ok(response.result,!response.error&&stderr);assert.equal(response.result.isError,undefined,JSON.stringify(response));
 const value=response.result.structuredContent;assert.ok(value,JSON.stringify(response));if(args.wait){assert.equal(value.delivery,'accepted');assert.equal(value.execution.state,'timeout');}
 }
 }finally{child.kill();await fake.close();}
});
