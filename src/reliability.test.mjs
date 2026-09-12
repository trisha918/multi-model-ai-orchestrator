import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireIssueLock, releaseIssueLock, parseRepoSlug, emptyState, saveIssueState } from './github-state.mjs';
import { fetchGithubCiRuns, classifyCheckRuns } from './github-ci.mjs';
import { createMemoryGithubClient, createGithubClient, isPullForIssue } from './github-client.mjs';
import { runIssueAutomation } from './github-automation.mjs';
import { DEFAULT_REPO_AUTOMATION } from './github-config.mjs';
import { pickRequestedModel } from './model-select.mjs';
import { createIsolatedWorktree, removeOrchestratorWorktree, git } from './workspace.mjs';
import { controlledExecutor, workerEnvironment, validateImplementationOutput } from './run-controls.mjs';
import { runTask, parseTaskArgs } from './orchestrator.mjs';
import { listRuns } from './run-history.mjs';
import { writeModelsCache } from './model-cache.mjs';
import { emptyRegistry } from './model-registry.mjs';
import { executeProcess } from './process.mjs';

async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orch-regression-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function initRepo(dir) {
  for (const args of [['init','-b','main'],['config','user.name','Test'],['config','user.email','test@example.com']]) {
    const r = spawnSync('git', args, { cwd: dir }); assert.equal(r.status, 0);
  }
  await writeFile(path.join(dir,'README.md'),'initial\n');
  await git(dir,['add','.']); await git(dir,['commit','-m','initial']);
}

test('atomic issue lock admits exactly one of twenty concurrent callers', async t => {
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: await temporary(t) };
  const results = await Promise.all(Array.from({ length: 20 }, (_, holder) => acquireIssueLock('owner/repo', 1, env, { holder, staleMs: 0 })));
  assert.equal(results.filter(r => r.ok).length, 1);
  await releaseIssueLock('owner/repo',1,env);
  assert.equal((await acquireIssueLock('owner/repo',1,env)).ok,true);
  await releaseIssueLock('owner/repo',1,env);
});
test('repository components cannot escape the runtime directory', () => {
  for (const slug of ['../..','./repo','owner/..','owner/.']) assert.throws(() => parseRepoSlug(slug));
});
test('failed commit status cannot be hidden by a successful check and API errors propagate', async () => {
  const client = { getChecks: async () => ({ check_runs: [{name:'unit',status:'completed',conclusion:'success'}] }), getCombinedStatus: async () => ({ statuses: [{ context:'security',state:'failure' }] }) };
  assert.equal(classifyCheckRuns(await fetchGithubCiRuns(client,'a','b','sha')).status,'FAIL');
  client.getCombinedStatus = async () => { throw new Error('HTTP 403'); };
  await assert.rejects(fetchGithubCiRuns(client,'a','b','sha'),/403/);
});
test('PR ownership requires the exact issue number and AI branch', () => {
  assert.equal(isPullForIssue({ head:{ref:'ai/issue-42-fix'},body:'Closes #42' },42),true);
  assert.equal(isPullForIssue({ head:{ref:'ai/issue-420-fix'},body:'Closes #420' },42),false);
  assert.equal(isPullForIssue({ head:{ref:'feature/manual'},body:'Mentions #42' },42),false);
});
test('check pagination includes a failing check beyond the first page', async () => {
  let requests=0;
  const client=createGithubClient({env:{GITHUB_TOKEN:'test-only'},fetchImpl:async url=>{
    requests++;
    const page=new URL(url).searchParams.get('page');
    const check_runs=page==='1'?Array.from({length:100},()=>({name:'pass',status:'completed',conclusion:'success'})):[{name:'later failure',status:'completed',conclusion:'failure'}];
    return {ok:true,text:async()=>JSON.stringify({check_runs})};
  }});
  assert.equal(classifyCheckRuns(await client.getChecks('owner','repo','sha')).status,'FAIL');
  assert.equal(requests,2);
});
test('unknown budget flags and invalid numeric controls fail before launching',()=>{
  assert.throws(()=>parseTaskArgs(['--budget-usd','1']),/Unknown/);
  assert.throws(()=>parseTaskArgs(['--max-seconds','NaN']),/positive/);
  assert.throws(()=>parseTaskArgs(['--max-processes','0']),/positive/);
  assert.throws(()=>parseTaskArgs(['--task-file']),/requires a value/);
});
test('subprocess output preserves split Persian characters and redacts bare known secrets',async()=>{
  const script="const b=Buffer.from('سلام'); process.stdout.write(b.subarray(0,1)); setTimeout(()=>{process.stdout.write(b.subarray(1)); process.stdout.write(' private-example-token');},10);";
  const result=await executeProcess(process.execPath,['-e',script],{quiet:true,env:{...process.env,EXAMPLE_TOKEN:'private-example-token'}});
  assert.equal(result.exitCode,0);assert.match(result.stdout,/سلام/);assert.doesNotMatch(result.stdout,/private-example-token/);
});
test('a successful full local run preserves new files and reports actual independent tests',async t=>{
  const root=await temporary(t),repo=path.join(root,'repo');await mkdir(repo);await initRepo(repo);
  await writeFile(path.join(repo,'package.json'),JSON.stringify({scripts:{test:'node --test'}}));
  await git(repo,['add','.']);await git(repo,['commit','-m','test setup']);
  const env={...process.env,AI_ORCHESTRATOR_RUNTIME_ROOT:path.join(root,'runtime'),AI_ORCHESTRATOR_CONFIG_DIR:path.join(root,'config')};
  await writeModelsCache(emptyRegistry(new Date().toISOString()),env);
  let calls=0,result;
  const code=await runTask(['--repo',repo,'--mode','codex','--task','add code'],{env,onResult:r=>{result=r;},executeProcess:async (_command,_args,opts)=>{
    calls++;if(calls===1)await writeFile(path.join(opts.cwd,'new-code.txt'),'keep this output');
    return {exitCode:0,durationMs:1,stdout:'done',stderr:'',attempts:1};
  }});
  assert.equal(code,0);assert.equal(calls,2);assert.equal(result.tests,'PASS');assert.equal(result.review,'SKIP');
  assert.match(result.commit,/^[a-f0-9]{40}$/);assert.match(result.worktreeState,/PRESERVED/);
  assert.equal(await readFile(path.join(result.worktree,'new-code.txt'),'utf8'),'keep this output');
  assert.equal(await git(repo,['status','--porcelain']), '');
});
test('explicit auto overrides environment and user model settings', () => {
  const picked=pickRequestedModel({provider:'codex',route:'CODEX',args:{model:'auto',provided:{model:true},env:{AI_CODEX_MODEL:'old'}},config:{codexModel:'old'}});
  assert.equal(picked.kind,'auto'); assert.equal(picked.source,'cli');
});
test('uncommitted new files survive automatic worktree cleanup and branch resume is pinned', async t => {
  const dir=await temporary(t); const repo=path.join(dir,'repo'); await mkdir(repo); await initRepo(repo);
  const env={AI_ORCHESTRATOR_RUNTIME_ROOT:path.join(dir,'runtime')};
  const isolated=await createIsolatedWorktree(repo,'fix','ai/issue-1-fix','20260101T000000Z-task-a',env);
  await writeFile(path.join(isolated.worktree,'new.txt'),'irreplaceable');
  const removed=await removeOrchestratorWorktree({sourceRepo:repo,...isolated,env});
  assert.equal(removed.removed,false);
  assert.equal(await readFile(path.join(isolated.worktree,'new.txt'),'utf8'),'irreplaceable');
  await git(isolated.worktree,['add','.']); await git(isolated.worktree,['commit','-m','save']);
  const sha=await git(isolated.worktree,['rev-parse','HEAD']);
  assert.equal((await removeOrchestratorWorktree({sourceRepo:repo,...isolated,env})).removed,true);
  await assert.rejects(createIsolatedWorktree(repo,'fix','ai/issue-1-fix','20260101T000000Z-task-b',env,{expectedSha:'f'.repeat(40)}),/changed/);
  const resumed=await createIsolatedWorktree(repo,'fix','ai/issue-1-fix','20260101T000000Z-task-b',env,{expectedSha:sha});
  assert.equal(await git(resumed.worktree,['rev-parse','HEAD']),sha);
  assert.equal(await readFile(path.join(resumed.worktree,'new.txt'),'utf8'),'irreplaceable');
});
test('process budget includes retry attempts and does not launch past limit', async () => {
  let calls=0;
  const controlled=controlledExecutor(async () => { calls++; return {exitCode:1,stderr:'rate limit'}; },{maxProcesses:2});
  await assert.rejects(controlled.exec('fake',[],{maxRetries:5}),/process budget/);
  assert.equal(calls,2);
});
test('time budget bounds each process timeout and stops subsequent launches', async () => {
  let now=0; let timeout;
  const controlled=controlledExecutor(async (_c,_a,opts) => {timeout=opts.timeoutMs; now=1100; return {exitCode:0};},{maxSeconds:1,now:()=>now});
  await assert.rejects(controlled.exec('fake',[],{timeoutMs:999999}),/time budget/);
  assert.equal(timeout,1000);
  await assert.rejects(controlled.exec('fake',[]),/time budget/);
});
test('workers retain provider authentication but cannot inherit GitHub or arbitrary secrets', () => {
  const env=workerEnvironment({PATH:'bin',SystemRoot:'win',GH_TOKEN:'no',github_token:'no',DATABASE_PASSWORD:'no',OPENAI_API_KEY:'provider'});
  assert.deepEqual(env,{PATH:'bin',SystemRoot:'win',OPENAI_API_KEY:'provider'});
});
test('privileged result validation rejects SKIP, missing evidence and changed commits', () => {
  const sha='a'.repeat(40),branch='ai/issue-1-fix';
  const valid={version:1,ok:true,branch,commit:sha,tests:'PASS',review:'PASS'};
  assert.equal(validateImplementationOutput(valid,{branch,sha}),valid);
  for (const diff of [{tests:'SKIP'},{review:'UNKNOWN'},{commit:'b'.repeat(40)},{version:0}]) assert.throws(()=>validateImplementationOutput({...valid,...diff},{branch,sha}));
});
test('invalid task records a failed result and events without calling any model', async t => {
  const dir=await temporary(t); const env={...process.env,AI_ORCHESTRATOR_RUNTIME_ROOT:dir};
  let result;
  const code=await runTask([],{env,onResult:r=>{result=r;},executeProcess:async()=>{throw new Error('must not run');}});
  assert.notEqual(code,0); assert.equal(result.ok,false); assert.equal(result.tests,'UNKNOWN');
  assert.equal((await listRuns(env)).length,1);
  const events=await readFile(path.join(result.runLog,'events.jsonl'),'utf8');
  assert.ok(events.split('\n').filter(Boolean).every(line=>JSON.parse(line).version===1));
});
test('resumed successful CI cannot bypass failed required local tests or review', async t => {
  const dir=await temporary(t),env={AI_ORCHESTRATOR_RUNTIME_ROOT:dir};
  const sha='a'.repeat(40),branch='ai/issue-1-fix';
  const client=createMemoryGithubClient({ issues:{1:{number:1,title:'fix',labels:[{name:'ai-auto'}]}},events:{1:[{event:'labeled',label:{name:'ai-auto'},actor:{login:'owner'},author_association:'OWNER'}]},permissions:{owner:{permission:'admin'}},pulls:[{number:2,head:{ref:branch,sha},body:'Closes #1'}],checks:{[sha]:[{name:'test',status:'completed',conclusion:'success'}]} });
  const config=structuredClone(DEFAULT_REPO_AUTOMATION); config.automation.enabled=true; config.automation.mode='assisted'; config.tests.required=true;config.review.required=true;
  await saveIssueState({...emptyState({repo:'owner/repo',issue:{number:1}}),stage:'WAITING_FOR_CI',branch,commitSha:sha,prNumber:2,localTests:'FAIL',review:'UNKNOWN'},env);
  const result=await runIssueAutomation({client,config,repo:'owner/repo',issueNumber:1,env,runImplementation:async()=>{throw new Error('no worker expected');}});
  assert.equal(result.state.stage,'HUMAN_REVIEW_REQUIRED');assert.notEqual(result.code,0);
});
test('resume cannot push a locally tested branch without its required review', async t => {
  const env={AI_ORCHESTRATOR_RUNTIME_ROOT:await temporary(t)};
  const client=createMemoryGithubClient({issues:{1:{number:1,title:'fix',labels:[{name:'ai-auto'}]}},events:{1:[{event:'labeled',label:{name:'ai-auto'},actor:{login:'owner'},author_association:'OWNER'}]},permissions:{owner:{permission:'admin'}}});
  const config=structuredClone(DEFAULT_REPO_AUTOMATION);config.automation.enabled=true;config.automation.mode='assisted';
  await saveIssueState({...emptyState({repo:'owner/repo',issue:{number:1}}),stage:'LOCAL_TESTS',branch:'ai/issue-1-fix',commitSha:'a'.repeat(40),localTests:'PASS',review:'UNKNOWN'},env);
  const result=await runIssueAutomation({client,config,repo:'owner/repo',issueNumber:1,env,gitPush:async()=>{throw new Error('must not push');}});
  assert.equal(result.state.stage,'HUMAN_REVIEW_REQUIRED');assert.equal(client.log.filter(e=>e.op==='createPullRequest').length,0);
});
