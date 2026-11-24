const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const fixtures = require('../../shared/companion-fixtures.json');
const cache = new Map();
function load(file) {
  const absolute = path.resolve(__dirname, '../src', file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const module = { exports: {} }; cache.set(absolute, module);
  const js = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('module', 'exports', 'require', js)(module, module.exports, name => name.startsWith('.') ? load(path.relative(path.resolve(__dirname, '../src'), path.resolve(path.dirname(absolute), name + '.ts'))) : require(name));
  return module.exports;
}
const { createLocalFallback, stoppedCompanion, stoppedObservation } = load('companion/fallback.ts');
const { createCompanionAdapter } = load('companion/adapter.ts');
const { applyLifeChanges, LifeProjection } = load('companion/projection.ts');
const { digest } = load('companion/core.ts');
function storage() { const data = new Map(); return { data, getItem: async key => data.get(key) ?? null, setItem: async (key,value) => { data.set(key,value); } }; }
const unwrap = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const clock = { bootId:'synthetic-boot', wall:()=>1700000000100, monotonic:()=>100 };
test('共享 fixtures：命令重投、重复事件和 ACK 不会重复写入', async () => {
  const scenario = fixtures.idempotencyScenario;
  const db = storage();
  const repo = createLocalFallback(db,'web',{clock,id:prefix=>prefix==='event'?'synthetic-event-note-a':'synthetic-note-a'});
  let projection = { schemaVersion:1,authority:'local_fallback',revision:0,records:[],companion:stoppedCompanion(),observation:stoppedObservation() };
  for (const step of scenario.steps) {
    if (step.operation === 'submitCommand') {
      const command = structuredClone(scenario.command);
      if (step.payloadPatch) Object.assign(command.payload,step.payloadPatch);
      const result = await repo.submitLifeCommand(command);
      if (step.expectedErrorCode) assert.equal(result.error.code,step.expectedErrorCode);
      else { const receipt=unwrap(result); assert.equal(receipt.replayed,step.expectedReplayed); assert.equal(receipt.revision,step.expectedRevision); assert.equal(receipt.eventId,scenario.expectedReceipt.eventId); }
    } else if (step.operation === 'deliverEvent') {
      const persisted=JSON.stringify([...db.data]);
      projection=applyLifeChanges(projection,[scenario.committedEvent]);
      assert.equal(projection.records.length,step.expectedProjectedRecords);
      assert.equal(JSON.stringify([...db.data]),persisted);
    } else {
      const result=await repo.ackChanges(step.revision);
      if(step.expectedErrorCode) assert.equal(result.error.code,step.expectedErrorCode);
      else assert.equal(unwrap(result).ackedRevision,step.expectedAckedRevision);
    }
    const snapshot=unwrap(await repo.getSnapshot());
    if(step.expectedRevision!==undefined)assert.equal(snapshot.revision,step.expectedRevision);
    if(step.expectedRecords!==undefined)assert.equal(snapshot.records.length,step.expectedRecords);
  }
  const restored=createLocalFallback(db,'web',{clock});
  assert.equal(unwrap(await restored.getSnapshot()).records.length,1);
  assert.equal(unwrap(await restored.submitLifeCommand(scenario.command)).replayed,true);
});
test('保存失败不产生投影、收据或成功提示，重试同 opId 正常提交',async()=>{
  const db=storage();let broken=true;const set=db.setItem;db.setItem=async(...args)=>{if(broken)throw Error('disk');return set(...args);};
  const repo=createLocalFallback(db,'web',{clock});let events=0;repo.subscribe('onLifeChanges',()=>events++);
  assert.equal((await repo.submitLifeCommand(fixtures.idempotencyScenario.command)).error.code,'STORAGE_FAILED');
  assert.equal(unwrap(await repo.getSnapshot()).revision,0);assert.equal(events,0);
  broken=false;assert.equal(unwrap(await repo.submitLifeCommand(fixtures.idempotencyScenario.command)).replayed,false);assert.equal(events,1);
});
test('Android 缺模块不读取或写入降级库；保持冻结单参数命令',async()=>{
  const forbidden={getItem:async()=>{throw Error('禁止读取');},setItem:async()=>{throw Error('禁止写入');}};
  const adapter=createCompanionAdapter('android',null,forbidden);
  assert.equal(unwrap(await adapter.getCapabilities()).lifeCommands,false);
  assert.equal((await adapter.submitLifeCommand(fixtures.idempotencyScenario.command)).error.code,'UNSUPPORTED');
  let received;
  const native={submitLifeCommand:async(...args)=>{received=args;return{schemaVersion:1,ok:true,value:fixtures.idempotencyScenario.expectedReceipt};}};
  unwrap(await createCompanionAdapter('android',native,forbidden).submitLifeCommand(fixtures.idempotencyScenario.command));
  assert.equal(received.length,1);assert.deepEqual(received[0],fixtures.idempotencyScenario.command);
});
test('清空不归零，保留无正文防重收据并要求重新装快照',async()=>{
  const db=storage();const repo=createLocalFallback(db,'ios',{clock});
  unwrap(await repo.submitLifeCommand(fixtures.idempotencyScenario.command));
  unwrap(await repo.submitLifeCommand({schemaVersion:1,opId:'clear-a',kind:'life.clear',payload:{scope:'all',expectedRevision:1,userConfirmed:true},observationIds:[]}));
  assert.equal(unwrap(await repo.getSnapshot()).revision,2);
  assert.equal((await repo.readChanges(0)).error.code,'SNAPSHOT_REQUIRED');
  assert.equal(unwrap(await repo.submitLifeCommand(fixtures.idempotencyScenario.command)).replayed,true);
  assert.equal(unwrap(await repo.getSnapshot()).records.length,0);
  assert.doesNotMatch(JSON.stringify([...db.data]),/合成幂等笔记/);
});
test('摘要为 SHA256，规范键排序不依赖输入顺序',()=>{
  assert.equal(digest('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('投影恢复期间收到的新生命周期状态不被旧快照或outbox覆盖',{timeout:2000},async()=>{
  const handlers=new Map();let releaseSnapshot,enteredSnapshot,releasePage,enteredPage;
  const snapshotGate=new Promise(resolve=>{releaseSnapshot=resolve;});const snapshotEntered=new Promise(resolve=>{enteredSnapshot=resolve;});
  const pageGate=new Promise(resolve=>{releasePage=resolve;});const pageEntered=new Promise(resolve=>{enteredPage=resolve;});let first=true;
  const adapter={subscribe:(name,listener)=>{handlers.set(name,listener);return()=>handlers.delete(name);},getSnapshot:async()=>{enteredSnapshot();await snapshotGate;return{schemaVersion:1,ok:true,value:{schemaVersion:1,authority:'native_sqlite',revision:0,records:[],companion:stoppedCompanion(),observation:stoppedObservation()}};},readChanges:async()=>{if(first){first=false;enteredPage();await pageGate;}return{schemaVersion:1,ok:true,value:{schemaVersion:1,afterRevision:0,throughRevision:0,currentRevision:0,changes:[],hasMore:false}};},ackChanges:async()=>({schemaVersion:1,ok:true,value:{schemaVersion:1,ackedRevision:0}})};
  const projection=new LifeProjection(adapter);const disconnect=projection.connect();await snapshotEntered;
  handlers.get('onObservationState')({schemaVersion:1,emittedAt:1,state:{...stoppedObservation(),generation:8,stopReason:'user'}});releaseSnapshot();await pageEntered;
  assert.equal(projection.getState().snapshot.observation.generation,8);
  handlers.get('onObservationState')({schemaVersion:1,emittedAt:2,state:{...stoppedObservation(),generation:9,stopReason:'credentials_changed'}});releasePage();await projection.refresh();
  assert.equal(projection.getState().snapshot.observation.generation,9);assert.equal(projection.getState().error,null);disconnect();
});
test('投影序号缺口要求快照，不能将跳过的事件伪装成完整恢复',()=>{
  const snapshot={schemaVersion:1,authority:'local_fallback',revision:0,records:[],companion:stoppedCompanion(),observation:stoppedObservation()};
  const event=structuredClone(fixtures.idempotencyScenario.committedEvent);event.revision=2;event.change.record.revision=2;
  assert.throws(()=>applyLifeChanges(snapshot,[event]),error=>error.detail.code==='SNAPSHOT_REQUIRED');assert.equal(snapshot.records.length,0);
});
