import assert from "node:assert/strict";
import test from "node:test";
import { fakeAppServer } from "./helpers/codex-server.js";
import { openCodexConversation } from "../src/core/codex/conversation.js";
const final = {id:"final-1",type:"agentMessage",phase:"final_answer",text:"final answer"};
const mixed = [{id:"comment",type:"agentMessage",phase:"commentary",text:"working"},{id:"reason",type:"reasoning",text:"secret"},final,final];
const handlers = {
 initialize: (_,ok)=>ok({}),
 "thread/resume":(p,ok)=>ok({thread:{id:p.threadId,cwd:process.cwd(),status:{type:"idle"}},cwd:process.cwd()}),
 "thread/turns/list":(_,ok)=>ok({data:[{id:"turn-1",status:"completed"}],nextCursor:null}),
 "thread/items/list":(_,ok)=>ok({data:mixed.map(item=>({turnId:"turn-1",item})),nextCursor:null}),
 "turn/start":(p,ok,err,send)=>{send({method:"turn/completed",params:{threadId:p.threadId,turn:{id:"turn-1",status:"completed",items:mixed}}});ok({turn:{id:"turn-1",status:"inProgress"}});},
};
for(const send of [true,false]) test(`collect ${send?'early completion':'resumed completion'} and only final output`,async()=>{
 const fake=await fakeAppServer(handlers); let c;
 try {c=await openCodexConversation("thread-1",{env:{CODEX_HOME:fake.home},expectedCwd:process.cwd()});
 const sent=send?await c.send("hello"):{turnId:"turn-1"}; if(send)assert.equal(sent.delivery,"accepted");
 const r=await c.wait({turnId:sent.turnId,messageId:sent.messageId}); assert.equal(r.execution.state,"completed");assert.equal(r.reply.text,"final answer");assert.deepEqual(r.reply.items.map(i=>i.id),["final-1"]);
 }finally{await c?.close();await fake.close();}
});

for (const status of ['failed','interrupted','completed']) test(`preserve ${status} with empty output`,async()=>{
 const fake=await fakeAppServer({...handlers,'thread/turns/list':(_,ok)=>ok({data:[{id:'turn-1',status}],nextCursor:null}),'thread/items/list':(_,ok)=>ok({data:[],nextCursor:null})});
 const c=await openCodexConversation('thread-1',{env:{CODEX_HOME:fake.home}});
 try {const r=await c.wait({turnId:'turn-1'});assert.equal(r.execution.state,status);assert.equal(r.reply.text,'');}finally{await c.close();await fake.close();}
});
test('guarded steer never falls back and persistent approvals remain unanswered',async()=>{
 const fake=await fakeAppServer({...handlers,'turn/steer':(p,ok,err,send)=>{
 send({id:'foreign-'+p.expectedTurnId,method:'item/commandExecution/requestApproval',params:{threadId:'other',turnId:'turn-1'}});
 send({id:'own-'+p.expectedTurnId,method:'item/commandExecution/requestApproval',params:{threadId:p.threadId,turnId:'turn-1'}});
 if(p.expectedTurnId==='stale')err({code:-32600,message:'guard mismatch'});else ok({turnId:'turn-1'});
 }});
 const c=await openCodexConversation('thread-1',{env:{CODEX_HOME:fake.home}});
 try {
 assert.equal((await c.send('hello',{whenBusy:'steer',expectedTurnId:'turn-1'})).delivery,'accepted');
 assert.equal((await c.send('hello',{whenBusy:'steer',expectedTurnId:'stale'})).delivery,'rejected');
 assert.equal((await c.send('hello',{whenBusy:'steer'})).delivery,'rejected');
 assert.equal(fake.received.filter(x=>x.method==='turn/start').length,0);
 assert.equal(fake.received.filter(x=>/^(own|foreign)-/.test(x.id)).length,0);
 }finally{await c.close();await fake.close();}
});
for(const mode of ['timeout','abort','missing','cycle','bounds'])test(`bounded observation ${mode}`,async()=>{
 const fake=await fakeAppServer({...handlers,'thread/turns/list':(_,ok)=>ok({data:mode==='missing'||mode==='cycle'?[]:[{id:'turn-1',status:mode==='bounds'?'completed':'inProgress'}],nextCursor:mode==='cycle'?'again':null})});
 const c=await openCodexConversation('thread-1',{env:{CODEX_HOME:fake.home}});
 try {const controller=new AbortController();if(mode==='abort')setTimeout(()=>controller.abort(),5);
 const r=await c.wait({turnId:'turn-1',messageId:'msg',timeoutMs:20,signal:controller.signal,maxOutputBytes:mode==='bounds'?1:1000});
 assert.equal(r.execution.state,({timeout:'timeout',abort:'unknown',missing:'unknown',cycle:'unknown',bounds:'completed'})[mode]);assert.equal(r.messageId,'msg');
 if(mode==='bounds')assert.equal(r.reply.truncated,true);
 assert.equal(fake.received.filter(x=>x.method==='turn/interrupt').length,0);
 }finally{await c.close();await fake.close();}
});
test('cwd mismatch fails before submission',async()=>{
 const fake=await fakeAppServer(handlers);
 try {await assert.rejects(openCodexConversation('thread-1',{env:{CODEX_HOME:fake.home},expectedCwd:'/tmp'}),/cwd/);assert.equal(fake.received.filter(x=>x.method==='turn/start').length,0);}finally{await fake.close();}
});

test('shared conversation close leaves connection alive and quiet watch is timeout',async()=>{
 const {openCodexSession}=await import('../src/core/codex-bridge.js');
 const fake=await fakeAppServer(handlers);const env={CODEX_HOME:fake.home};const session=await openCodexSession(env);
 try {const c=await openCodexConversation('thread-1',{env,session});const r=await c.watch({timeoutMs:5});assert.equal(r.reason,'timeout');await c.close();assert.equal(session.client.closed,false);assert.ok(await session.client.request('thread/turns/list',{threadId:'thread-1'}));}finally{session.client.close();await fake.close();}
});
test('disconnect is distinct from timeout',async()=>{
 const fake=await fakeAppServer({...handlers,'thread/turns/list':(_,ok,err,send,socket)=>socket.destroy()});
 const c=await openCodexConversation('thread-1',{env:{CODEX_HOME:fake.home}});
 try {const r=await c.wait({turnId:'turn-1',timeoutMs:50});assert.equal(r.execution.state,'disconnected');}finally{await c.close();await fake.close();}
});
test('paginated wrapped items use null-phase fallback only when final is absent',async()=>{
 const fake=await fakeAppServer({...handlers,'thread/items/list':(p,ok)=>ok(p.cursor?{data:[{turnId:'turn-1',item:{id:'legacy',type:'agentMessage',phase:null,text:'legacy answer'}}],nextCursor:null}:{data:[{turnId:'turn-1',item:{id:'comment',type:'agentMessage',phase:'commentary',text:'ignore'}}],nextCursor:'next'})});
 const c=await openCodexConversation('thread-1',{env:{CODEX_HOME:fake.home}});
 try {const r=await c.wait({turnId:'turn-1'});assert.equal(r.reply.text,'legacy answer');assert.equal(fake.received.filter(x=>x.method==='thread/items/list').length,2);}finally{await c.close();await fake.close();}
});
test('incomplete item coverage cannot claim complete final output',async()=>{
 const fake=await fakeAppServer({...handlers,'thread/items/list':(_,ok)=>ok({data:[{item:final}],nextCursor:null})});
 const c=await openCodexConversation('thread-1',{env:{CODEX_HOME:fake.home}});
 try {const r=await c.wait({turnId:'turn-1'});assert.equal(r.execution.state,'completed');assert.equal(r.reply.truncated,true);assert.match(r.execution.error,/Invalid/);}finally{await c.close();await fake.close();}
});
test('waiting-for-input includes only owned turn interaction',async()=>{
 const fake=await fakeAppServer({...handlers,'thread/resume':(p,ok,err,send)=>{handlers['thread/resume'](p,ok);send({id:'ask',method:'item/commandExecution/requestApproval',params:{threadId:p.threadId,turnId:'turn-1'}});send({id:'foreign',method:'item/commandExecution/requestApproval',params:{threadId:'other',turnId:'turn-1'}});},'thread/turns/list':(_,ok)=>ok({data:[{id:'turn-1',status:'inProgress'}],nextCursor:null})});
 const c=await openCodexConversation('thread-1',{env:{CODEX_HOME:fake.home}});
 try {const r=await c.wait({turnId:'turn-1'});assert.equal(r.execution.state,'waiting-for-input');assert.deepEqual(r.interactions.map(i=>i.id),['ask']);}finally{await c.close();await fake.close();}
});

test('uncertain send keeps supplied correlation even when resume disconnects',async()=>{
 let resumes=0;
 const fake=await fakeAppServer({...handlers,'thread/resume':(p,ok,err,send,socket)=>{if(++resumes===1)handlers['thread/resume'](p,ok);else socket.destroy();}});
 const c=await openCodexConversation('thread-1',{env:{CODEX_HOME:fake.home}});
 const {buildEnvelope}=await import('../src/core/codex-bridge.js');const envelope=buildEnvelope({correlationId:'corr'});
 try {const receipt=await c.send('hello',{envelope});assert.equal(receipt.threadId,'thread-1');assert.equal(receipt.correlationId,'corr');assert.equal(receipt.messageId,envelope.messageId);assert.equal(receipt.delivery,'unknown');}finally{await c.close();await fake.close();}
});
test('persistent send refuses a supplied envelope at hop bound',async()=>{
 const fake=await fakeAppServer(handlers);const c=await openCodexConversation('thread-1',{env:{CODEX_HOME:fake.home}});
 try {const receipt=await c.send('hello',{envelope:{messageId:'msg',correlationId:'corr',hop:4,maxHops:100,header:false}});assert.equal(receipt.delivery,'rejected');assert.equal(receipt.reason,'hop-limit');assert.equal(fake.received.filter(x=>x.method==='turn/start').length,0);}finally{await c.close();await fake.close();}
});

test('resolved requests without turnId no longer block the turn',async()=>{
 const fake=await fakeAppServer({...handlers,'thread/resume':(p,ok,err,send)=>{
 handlers['thread/resume'](p,ok);
 send({id:'ask',method:'item/commandExecution/requestApproval',params:{threadId:p.threadId,turnId:'turn-1'}});
 send({method:'serverRequest/resolved',params:{threadId:p.threadId,requestId:'ask'}});
 },'thread/turns/list':(_,ok)=>ok({data:[{id:'turn-1',status:'inProgress'}],nextCursor:null})});
 const c=await openCodexConversation('thread-1',{env:{CODEX_HOME:fake.home}});
 try {const r=await c.wait({turnId:'turn-1',timeoutMs:5});assert.equal(r.execution.state,'timeout');assert.deepEqual(r.interactions,[]);}finally{await c.close();await fake.close();}
});

test('history traversal enforces page and method bounds',async()=>{
 const {openCodexSession}=await import('../src/core/codex-bridge.js');
 const {visitCodexHistory}=await import('../src/core/codex/conversation.js');
 let n=0;
 const fake=await fakeAppServer({...handlers,'thread/turns/list':(_,ok)=>ok({data:[],nextCursor:'page-'+(++n)})});
 const session=await openCodexSession({CODEX_HOME:fake.home});
 try {
 await assert.rejects(visitCodexHistory(session,'thread-1','thread/turns/list',{},()=>false),/20 page limit/);assert.equal(n,20);
 await assert.rejects(visitCodexHistory(session,'thread-1','turn/interrupt',{},()=>false),/Unsupported/);
 const controller=new AbortController();controller.abort();await assert.rejects(visitCodexHistory(session,'thread-1','thread/items/list',{},()=>false,{signal:controller.signal}),/cancelled/);
 }finally{session.client.close();await fake.close();}
});
test('watch filters foreign events, reports overflow and supports cancellation',async()=>{
 const seen=[];
 const fake=await fakeAppServer({...handlers,'thread/resume':(p,ok,err,send)=>{
 for(let i=0;i<510;i++)send({method:'item/started',params:{threadId:p.threadId,turnId:'turn-1',item:{id:String(i),type:'reasoning'}}});
 send({method:'item/started',params:{threadId:'foreign',turnId:'turn-1',item:{id:'foreign',type:'reasoning'}}});handlers['thread/resume'](p,ok);
 }});
 const c=await openCodexConversation('thread-1',{env:{CODEX_HOME:fake.home},onEvent:e=>seen.push(e)});
 try {
 const r=await c.watch({maxEvents:20,timeoutMs:10});assert.equal(r.reason,'event-limit');assert.equal(r.events.length,20);assert.equal(r.truncated,true);assert.equal(seen.length,510);
 const controller=new AbortController();controller.abort();assert.equal((await c.watch({signal:controller.signal})).reason,'cancelled');
 await assert.rejects(c.wait({turnId:'turn-1',timeoutMs:0}),/timeoutMs/);await assert.rejects(c.watch({maxEvents:501}),/maxEvents/);
 }finally{await c.close();await fake.close();}
});

test('accepted turn remains observable while history has not caught up',async()=>{
 const fake=await fakeAppServer({...handlers,'turn/start':(_,ok)=>ok({turn:{id:'turn-1',status:'inProgress'}}),'thread/turns/list':(_,ok)=>ok({data:[],nextCursor:null}),'thread/items/list':(_,ok)=>ok({data:[],nextCursor:null})});
 const c=await openCodexConversation('thread-1',{env:{CODEX_HOME:fake.home}});
 try {const receipt=await c.send('hello');const r=await c.wait({turnId:receipt.turnId,timeoutMs:10});assert.equal(r.execution.state,'timeout');}finally{await c.close();await fake.close();}
});

for (const whenBusy of ['reject', 'queue', 'steer']) {
  for (const abortAt of ['before-send', 'during-resume']) {
    test(`shared ${whenBusy} cancellation ${abortAt} rejects before submission`, async () => {
      const { openCodexSession, buildEnvelope } = await import('../src/core/codex-bridge.js');
      const controller = new AbortController();
      let resumes = 0;
      const fake = await fakeAppServer({
        ...handlers,
        'thread/resume': (params, ok) => {
          if (++resumes === 2 && abortAt === 'during-resume') controller.abort();
          ok({ thread: { id: params.threadId, status: { type: whenBusy === 'reject' ? 'idle' : 'active', activeFlags: [] } } });
        },
        'thread/queue/add': (_, ok) => ok({ queuedSubmission: { id: 'queued-1' } }),
        'turn/steer': (params, ok) => ok({ turnId: params.expectedTurnId }),
      });
      const env = { CODEX_HOME: fake.home, GROK_BOT_CODEX_EXPERIMENTAL: '1' };
      const session = await openCodexSession(env, { experimental: true });
      const conversation = await openCodexConversation('thread-1', { env, session, signal: controller.signal });
      const envelope = buildEnvelope({ correlationId: 'cancel-correlation' });
      try {
        if (abortAt === 'before-send') controller.abort();
        const receipt = await conversation.send('must not submit', { whenBusy, expectedTurnId: 'turn-1', envelope });
        assert.equal(receipt.delivery, 'rejected');
        assert.equal(receipt.reason, 'cancelled');
        assert.equal(receipt.threadId, 'thread-1');
        assert.equal(receipt.messageId, envelope.messageId);
        assert.equal(receipt.correlationId, envelope.correlationId);
        assert.equal(receipt.exitCode, 1);
        assert.equal(fake.received.filter(message => ['turn/start', 'turn/steer', 'thread/queue/add'].includes(message.method)).length, 0);
        assert.equal(session.client.closed, false);
        const other = await openCodexConversation('thread-1', { env, session });
        try { assert.equal((await other.wait({ turnId: 'turn-1' })).execution.state, 'completed'); }
        finally { await other.close(); }
        assert.equal(session.client.closed, false);
      } finally {
        await conversation.close();
        session.client.close();
        await fake.close();
      }
    });
  }
}

for (const status of ['completed', 'failed']) {
  test(`completion during empty history reconciliation preserves ${status}`, async () => {
    const fake = await fakeAppServer({
      ...handlers,
      'thread/turns/list': (params, ok, err, send) => {
        send({ method: 'turn/completed', params: { threadId: params.threadId, turn: {
          id: 'turn-1', status, error: status === 'failed' ? { message: 'execution failed' } : null,
          items: [{ id: 'late-final', type: 'agentMessage', phase: 'final_answer', text: 'done' }],
        } } });
        ok({ data: [], nextCursor: null });
      },
      'thread/items/list': (_, ok) => ok({ data: [], nextCursor: null }),
    });
    const conversation = await openCodexConversation('thread-1', { env: { CODEX_HOME: fake.home } });
    try {
      const result = await conversation.wait({ turnId: 'turn-1', messageId: 'message-1' });
      assert.equal(result.execution.state, status);
      assert.equal(result.reply.text, 'done');
      assert.equal(result.reply.truncated, false);
      assert.equal(result.messageId, 'message-1');
      if (status === 'completed') assert.equal(result.execution.error, undefined);
      else assert.deepEqual(result.execution.error, { message: 'execution failed' });
    } finally {
      await conversation.close();
      await fake.close();
    }
  });
}

for (const failure of ['disconnect', 'reject']) {
  test(`guarded steer ${failure} retains known turn and correlation`, async () => {
    const { buildEnvelope } = await import('../src/core/codex-bridge.js');
    const fake = await fakeAppServer({
      ...handlers,
      'turn/steer': (_, ok, err, send, socket) => {
        if (failure === 'disconnect') socket.destroy();
        else err({ code: -32600, message: 'guard mismatch' });
      },
    });
    const conversation = await openCodexConversation('thread-1', { env: { CODEX_HOME: fake.home } });
    const envelope = buildEnvelope({ correlationId: 'steer-correlation' });
    try {
      const receipt = await conversation.send('guarded work', { whenBusy: 'steer', expectedTurnId: 'turn-1', envelope });
      assert.equal(receipt.delivery, failure === 'disconnect' ? 'unknown' : 'rejected');
      assert.equal(receipt.threadId, 'thread-1');
      assert.equal(receipt.turnId, 'turn-1');
      assert.equal(receipt.messageId, envelope.messageId);
      assert.equal(receipt.correlationId, envelope.correlationId);
      assert.doesNotMatch(receipt.error, /queue/);
      if (failure === 'disconnect') assert.match(receipt.error, /check.*turn turn-1/i);
      assert.equal(fake.received.filter(message => message.method === 'turn/start').length, 0);
    } finally {
      await conversation.close();
      await fake.close();
    }
  });
}
