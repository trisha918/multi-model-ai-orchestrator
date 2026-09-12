import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addMemory, listMemory, searchMemory, removeMemory, memoryContext } from './memory.mjs';
import { enqueue, listQueue, drainQueue, changeJob } from './local-queue.mjs';
import { recommendRoute, routingStats } from './learned-routing.mjs';
import { classifyTask } from './router.mjs';
import { runResult, saveRunResult, listRuns, resultPath } from './run-history.mjs';
import { localCommand } from './local-cli.mjs';

async function context(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'orch-modules-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return { root,env:{AI_ORCHESTRATOR_RUNTIME_ROOT:root} };
}
test('memory stays repository-scoped, expires, supports Persian retrieval and deletion',async t=>{
  const {root,env}=await context(t),repo=path.join(root,'one'),other=path.join(root,'two');
  const note=await addMemory(repo,'تست حساب کاربری با npm test اجرا شود',{env,days:1,now:1000});
  assert.equal((await listMemory(other,{env,now:1000})).length,0);
  assert.equal((await searchMemory(repo,'حساب کاربری',{env,now:1000}))[0].id,note.id);
  assert.equal((await listMemory(repo,{env,now:86401001})).length,0);
  assert.equal(await memoryContext(other,'حساب',{env,now:1000}),'');
  await removeMemory(repo,note.id,env);
  assert.equal((await listMemory(repo,{env,now:1000})).length,0);
  await assert.rejects(removeMemory(repo,'../two',env),/Invalid record id/);
});
test('queue is inert on add, bounded on drain, and persists success and failure',async t=>{
  const {env}=await context(t);
  const first=await enqueue(['--task','one'],{env});
  await enqueue(['--task','two'],{env});
  let count=0;
  const execute=async (_argv,{onResult})=>{count++;await onResult({runId:'test-run',ok:true});return 0;};
  assert.equal(count,0);
  assert.equal((await drainQueue(execute,{env,limit:1})).length,1);
  assert.equal(count,1);
  assert.equal((await listQueue(env)).filter(j=>j.status==='PENDING').length,1);
  const failed=await drainQueue(async()=>{throw new Error('offline');},{env});
  assert.equal(failed[0].status,'FAILED');
  assert.equal((await listQueue(env)).find(j=>j.status==='COMPLETED').runId,'test-run');
  await assert.rejects(changeJob(first.id,'cancel',env));
});
test('two queue workers cannot execute the same job',async t=>{
  const {env}=await context(t);
  await enqueue(['--task','once'],{env});
  let release; const hold=new Promise(r=>{release=r;});
  let started; const running=new Promise(r=>{started=r;});
  const first=drainQueue(async (_argv,{onResult})=>{started();await hold;await onResult({ok:true,runId:'run'});return 0;},{env});
  await running;
  await assert.rejects(drainQueue(async()=>0,{env}),/Lock held/);
  release(); await first;
  assert.equal((await listQueue(env))[0].status,'COMPLETED');
});
test('numeric-only queue success is not promoted to verified completion',async t=>{
  const {env}=await context(t);
  await enqueue(['--task','one'],{env});
  assert.equal((await drainQueue(async()=>0,{env}))[0].status,'FAILED');
});
test('history has versioned JSON, unknown billing, safe ids and parsable events',async t=>{
  const {env}=await context(t);
  const record=runResult({runId:'run-1',ok:true,tests:'SKIP',commit:'not-a-sha'});
  await saveRunResult(record,env);
  assert.equal((await listRuns(env))[0].costUsd,null);
  assert.equal(record.tests,'SKIP');assert.equal(record.commit,'');
  const events=await readFile(path.join(path.dirname(resultPath('run-1',env)),'events.jsonl'),'utf8');
  assert.equal(JSON.parse(events).type,'run.result');
  assert.throws(()=>resultPath('../escape',env));
  const output=[];assert.equal(await localCommand('runs',['list'],{env,print:v=>output.push(v)}),0);
  assert.equal(JSON.parse(output[0])[0].runId,'run-1');
});
test('learned routing needs verified matching history, preserves read-only and high-risk routes',()=>{
  const repo=path.join(os.tmpdir(),'project'),task='fix bug';
  const records=Array.from({length:5},()=>({repository:repo,status:'COMPLETED',ok:true,tests:'PASS',route:'CURSOR',classification:classifyTask(task),models:{worker:{model:'test'}},durationMs:500}));
  assert.equal(recommendRoute(records.slice(0,4),{repo,task}).learned,false);
  assert.equal(recommendRoute(records,{repo,task}).route,'CURSOR');
  assert.equal(recommendRoute(records,{repo:repo+'-other',task}).learned,false);
  assert.equal(recommendRoute(records.map(r=>({...r,tests:'SKIP'})),{repo,task}).learned,false);
  assert.equal(recommendRoute(records,{repo,task:'read-only review'}).route,'GEMINI');
  assert.equal(recommendRoute(records,{repo,task:'implement authentication system'}).route,'TEAM');
  assert.equal(routingStats(records,{repo})[0].samples,5);
});
