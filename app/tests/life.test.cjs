const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const ts=require('typescript');const fixtures=require('../../shared/companion-fixtures.json');const cache=new Map();
function load(file){const absolute=path.resolve(__dirname,'../src',file);if(cache.has(absolute))return cache.get(absolute).exports;const module={exports:{}};cache.set(absolute,module);new Function('module','exports','require',ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(module,module.exports,name=>name.startsWith('.')?load(path.relative(path.resolve(__dirname,'../src'),path.resolve(path.dirname(absolute),name+'.ts'))):require(name));return module.exports;}
const {parseManualLife,pomodoroStart,recordAction,confirmationCommand}=load('life/rules.ts');const {createLocalFallback,timerElapsed}=load('companion/fallback.ts');const {validateExpense,validateCommand}=load('companion/commands.ts');
const unwrap=result=>{assert.equal(result.ok,true,JSON.stringify(result));return result.value;};
// 只在合成存储边界预置观察候选，不给生产 fallback 增加屏幕写入接口。
function candidateFromFixture(caseId){
 const fixture=fixtures.modelCases.find(c=>c.id===caseId);const o=structuredClone(fixture.output.observations[0]);
 const base={schemaVersion:1,id:'synthetic-candidate',revision:7,text:o.name??'合成候选支出',source:{kind:'screen_observation',...fixtures.metadata},status:fixture.expected.records[0].status,createdAt:fixtures.metadata.capturedAt,updatedAt:fixtures.metadata.capturedAt,lastSeenAt:fixtures.metadata.capturedAt,observationIds:['synthetic-observation-a'],evidence:o.evidence};
 return o.kind==='food'?{...base,kind:'foodObservation',name:o.name,brand:o.brand,barcode:o.barcode,quantity:o.quantity,expiresOn:o.expiresOn,foodContextId:fixtures.nativeContext.foodContextId}:{...base,kind:'expense',amountMinor:o.amountMinor,currency:o.currency,merchant:o.merchant,purpose:null,paymentStatus:o.paymentStatus,transaction:o.transaction};
}
function confirmFacts(record){return record.kind==='foodObservation'?{kind:record.kind,name:record.name,brand:record.brand,barcode:record.barcode,quantity:record.quantity,expiresOn:record.expiresOn}:{kind:record.kind,text:record.text,amountMinor:record.amountMinor,currency:record.currency,purpose:'用户核对的合成用途',merchant:record.merchant};}
function candidateRepository(record){
 const key='synthetic.candidate.repository';const data=new Map([[key,JSON.stringify({schemaVersion:1,revision:7,ack:7,floor:7,records:[record],changes:[],operations:{}})]]);const events=[];let rejectWrite=false,writes=0;
 const storage={getItem:async k=>data.get(k)??null,setItem:async(k,v)=>{if(rejectWrite)throw Error('synthetic storage failure');writes++;data.set(k,v);}};
 const options={storageKey:key,clock:{bootId:'synthetic-candidate-boot',wall:()=>fixtures.metadata.capturedAt+1000,monotonic:()=>1000}};
 const repo=createLocalFallback(storage,'web',options);repo.subscribe('onLifeChanges',e=>events.push(e));
 return{repo,events,persisted:()=>JSON.parse(data.get(key)),writes:()=>writes,rejectWrites:value=>{rejectWrite=value;},reload:()=>createLocalFallback(storage,'web',options)};
}

test('实际候选确认与重放：观察/待确认食材保留未知值、数量、来源和最小证据',async()=>{
 for(const caseId of ['food-visible-quantity','food-unknown-quantity-no-expiry-guess','food-low-confidence-is-pending']){
  const initial=candidateFromFixture(caseId);const h=candidateRepository(initial);const command=confirmationCommand(initial,confirmFacts(initial));
  assert.equal(command.kind,'record.confirm');assert.equal(command.payload.expectedRevision,7);assert.equal(command.payload.userConfirmed,true);assert.deepEqual(command.observationIds,initial.observationIds);
  const receipt=unwrap(await h.repo.submitLifeCommand(command));const snapshot=unwrap(await h.repo.getSnapshot());const expected={...initial,status:'confirmed',revision:8,updatedAt:fixtures.metadata.capturedAt+1000};
  assert.equal(snapshot.revision,8);assert.deepEqual(snapshot.records,[expected]);assert.equal(receipt.revision,8);assert.equal(receipt.replayed,false);assert.deepEqual(receipt.recordIds,[initial.id]);
  const changes=unwrap(await h.repo.readChanges(7)).changes;assert.equal(changes.length,1);assert.equal(changes[0].eventId,receipt.eventId);assert.equal(changes[0].opId,command.opId);assert.deepEqual(changes[0].change,{kind:'upsert',record:expected});
  assert.deepEqual(unwrap(await h.repo.submitLifeCommand(command)),{...receipt,replayed:true});const restored=h.reload();assert.deepEqual(unwrap(await restored.submitLifeCommand(command)),{...receipt,replayed:true});assert.deepEqual(unwrap(await restored.getSnapshot()).records,[expected]);assert.equal(h.writes(),1);assert.equal(h.events.length,1);
 }
});
test('实际确认→撤销→删除每步仅加一次revision，过期操作冲突，旧收据重放不复活记录',async()=>{
 for(const caseId of ['food-unknown-quantity-no-expiry-guess','expense-paid-without-transaction-stays-pending']){
  const initial=candidateFromFixture(caseId);const h=candidateRepository(initial);const confirm=confirmationCommand(initial,confirmFacts(initial));const confirmed=unwrap(await h.repo.submitLifeCommand(confirm));let record=unwrap(await h.repo.getSnapshot()).records[0];
  assert.equal(record.status,'confirmed');assert.equal(record.revision,8);if(record.kind==='expense'){assert.equal(record.amountMinor,1299);assert.equal(record.currency,'CNY');assert.equal(record.purpose,'用户核对的合成用途');assert.equal(record.transaction,null);assert.equal(record.paymentStatus,'paid');}
  for(const kind of ['record.revoke','record.delete'])assert.equal((await h.repo.submitLifeCommand(recordAction(initial,kind))).error.code,'CONFLICT');
  assert.equal((await h.repo.submitLifeCommand(confirmationCommand(record,confirmFacts(record)))).error.code,'CONFLICT');
  const conflicting=structuredClone(confirm);if(initial.kind==='expense')conflicting.payload.facts.purpose='不同用途';else conflicting.payload.facts.name='不同食材';assert.equal((await h.repo.submitLifeCommand(conflicting)).error.code,'OP_ID_CONFLICT');assert.equal(h.writes(),1);
  const revoke=recordAction(record,'record.revoke');assert.equal(revoke.payload.expectedRevision,8);assert.deepEqual(revoke.observationIds,initial.observationIds);const revoked=unwrap(await h.repo.submitLifeCommand(revoke));record=unwrap(await h.repo.getSnapshot()).records[0];
  assert.equal(revoked.revision,9);assert.equal(record.revision,9);assert.equal(record.status,'revoked');assert.deepEqual(record.source,initial.source);assert.deepEqual(record.evidence,initial.evidence);assert.deepEqual(unwrap(await h.repo.submitLifeCommand(revoke)),{...revoked,replayed:true});assert.deepEqual(unwrap(await h.repo.submitLifeCommand(confirm)),{...confirmed,replayed:true});assert.equal(unwrap(await h.repo.getSnapshot()).records[0].status,'revoked');assert.equal(h.writes(),2);
  const beforeDelete=unwrap(await h.repo.readChanges(7)).changes;assert.deepEqual(beforeDelete.map(e=>e.revision),[8,9]);assert.deepEqual(beforeDelete.map(e=>e.change.record.status),['confirmed','revoked']);
  const remove=recordAction(record,'record.delete');assert.equal(remove.payload.expectedRevision,9);const deleted=unwrap(await h.repo.submitLifeCommand(remove));assert.equal(deleted.revision,10);assert.deepEqual(deleted.recordIds,[initial.id]);
  let snapshot=unwrap(await h.repo.getSnapshot());assert.equal(snapshot.revision,10);assert.deepEqual(snapshot.records,[]);assert.equal((await h.repo.readChanges(9)).error.code,'SNAPSHOT_REQUIRED');assert.deepEqual(unwrap(await h.repo.readChanges(10)).changes,[]);
  const restored=h.reload();for(const [command,receipt] of [[confirm,confirmed],[revoke,revoked],[remove,deleted]])assert.deepEqual(unwrap(await restored.submitLifeCommand(command)),{...receipt,replayed:true});
  snapshot=unwrap(await restored.getSnapshot());assert.equal(snapshot.revision,10);assert.deepEqual(snapshot.records,[]);assert.equal(h.writes(),3);assert.deepEqual(h.events.map(e=>e.revision),[8,9,10]);assert.equal(new Set(h.events.map(e=>e.eventId)).size,3);
  assert.equal((await restored.submitLifeCommand(recordAction(record,'record.delete'))).error.code,'NOT_FOUND');
  const saved=h.persisted();assert.equal(saved.floor,10);assert.equal(saved.changes.length,1);assert.deepEqual(saved.changes[0].change,{kind:'delete',recordId:initial.id});assert.equal(Object.keys(saved.operations).length,3);for(const op of Object.values(saved.operations)){assert.deepEqual(Object.keys(op).sort(),['hash','receipt']);assert.match(op.hash,/^[a-f0-9]{64}$/);}
  for(const secret of [initial.text,...initial.evidence.map(e=>e.text).filter(Boolean)])assert.equal(JSON.stringify(saved).includes(secret),false);
 }
});
test('实际管理拒绝未同意、观察ID注入和外币改人民币，不产生revision、事件或收据',async()=>{
 const initial=candidateFromFixture('food-visible-quantity');const h=candidateRepository(initial);const before=h.persisted();const commands=[confirmationCommand(initial,confirmFacts(initial)),recordAction(initial,'record.revoke'),recordAction(initial,'record.delete')];
 for(const original of commands){const denied=structuredClone(original);denied.payload.userConfirmed=false;assert.equal((await h.repo.submitLifeCommand(denied)).error.code,'CONSENT_REQUIRED');const injected=structuredClone(original);injected.observationIds.push('synthetic-unrelated-observation');assert.equal((await h.repo.submitLifeCommand(injected)).error.code,'INVALID_REQUEST');}
 assert.deepEqual(h.persisted(),before);assert.equal(h.writes(),0);assert.equal(h.events.length,0);assert.equal(unwrap(await h.repo.getSnapshot()).revision,7);
 const foreign=candidateFromFixture('expense-foreign-currency-never-becomes-cny');const f=candidateRepository(foreign);const conversion=confirmationCommand(foreign,{...confirmFacts(foreign),currency:'CNY',amountMinor:1299});assert.equal((await f.repo.submitLifeCommand(conversion)).error.code,'UNSUPPORTED_CURRENCY');assert.deepEqual(unwrap(await f.repo.getSnapshot()).records,[foreign]);assert.equal(f.writes(),0);assert.equal(f.events.length,0);
});
test('实际确认撤销删除持久失败不提前发布，重试同opId提交一次后可幂等重放',async()=>{
 const initial=candidateFromFixture('food-low-confidence-is-pending');const h=candidateRepository(initial);let record=initial;let revision=7;
 for(const kind of ['record.confirm','record.revoke','record.delete']){
  const command=kind==='record.confirm'?confirmationCommand(record,confirmFacts(record)):recordAction(record,kind);const before=h.persisted();const writes=h.writes();const events=h.events.length;h.rejectWrites(true);
  assert.equal((await h.repo.submitLifeCommand(command)).error.code,'STORAGE_FAILED');assert.deepEqual(h.persisted(),before);assert.equal(unwrap(await h.repo.getSnapshot()).revision,revision);assert.equal(h.writes(),writes);assert.equal(h.events.length,events);
  h.rejectWrites(false);const receipt=unwrap(await h.repo.submitLifeCommand(command));assert.equal(receipt.replayed,false);assert.equal(receipt.revision,++revision);assert.deepEqual(unwrap(await h.repo.submitLifeCommand(command)),{...receipt,replayed:true});assert.equal(h.writes(),writes+1);assert.equal(h.events.length,events+1);
  const snapshot=unwrap(await h.repo.getSnapshot());assert.equal(snapshot.revision,revision);if(kind==='record.delete')assert.deepEqual(snapshot.records,[]);else{record=snapshot.records[0];assert.equal(record.status,kind==='record.confirm'?'confirmed':'revoked');assert.equal(record.revision,revision);}
 }
});
test('完整文字/语音笔记与支出直接生成命令；歧义、外币和价格先补问',()=>{
 assert.equal(parseManualLife('笔记：明天带雨伞','manual_voice').command.payload.source,'manual_voice');
 assert.deepEqual(parseManualLife('咖啡花了18.20元').command.payload,{text:'咖啡花了18.20元',amountMinor:1820,currency:'CNY',purpose:'咖啡',merchant:null,source:'manual_text'});
 for(const input of ['记账：18元','记账：咖啡18.999元','记账：咖啡-18元','记账：咖啡0元','记账：咖啡12元，午饭25元','记账：咖啡12美元','记账：购物车咖啡18元','记账：设备1,200元','记账：咖啡.5元','记账：设备1e3元','记账：咖啡- 18元'])assert.equal(parseManualLife(input).kind,'clarify',input);
 assert.equal(parseManualLife('今天过得怎么样？').kind,'not_life');
 assert.equal(parseManualLife('记账：咖啡，18元').command.payload.amountMinor,1800);
});
test('消费共享金额边界 fixtures，不允许隐式转数值或外币伪记人民币',()=>{
 for(const variant of fixtures.variantCases.filter(v=>['INVALID_AMOUNT','UNSUPPORTED_CURRENCY'].includes(v.expected.errorCode))){
  const base=fixtures.modelCases.find(c=>c.id===variant.modelCaseId).output.observations[0];
  const facts={...base,...variant.observationPatch,text:'合成记录',purpose:'合成用途'};
  assert.throws(()=>validateExpense(facts),e=>e.detail.code===variant.expected.errorCode,variant.id);
 }
 const command=structuredClone(fixtures.idempotencyScenario.command);command.opId='internal.fake';assert.throws(()=>validateCommand(command));command.opId='manual-a';command.payload.source='screen_observation';assert.throws(()=>validateCommand(command));
});
test('25/5开始暂停继续结束与同进程单调时钟恢复，不依赖视觉',async()=>{
 const data=new Map();let monotonic=1000,wall=1700000000000;const clock={bootId:'boot-a',wall:()=>wall,monotonic:()=>monotonic};const storage={getItem:async k=>data.get(k)??null,setItem:async(k,v)=>data.set(k,v)};
 const repo=createLocalFallback(storage,'web',{clock});const start=pomodoroStart('focus');assert.equal(start.payload.durationMs,1500000);unwrap(await repo.submitLifeCommand(start));
 let record=unwrap(await repo.getSnapshot()).records[0];monotonic+=60000;wall-=9999999;
 assert.equal(timerElapsed(record,clock),60000);unwrap(await repo.submitLifeCommand(recordAction(record,'pomodoro.pause')));
 record=unwrap(await repo.getSnapshot()).records[0];monotonic+=5000;assert.equal(timerElapsed(record,clock),60000);unwrap(await repo.submitLifeCommand(recordAction(record,'pomodoro.resume')));
 record=unwrap(await repo.getSnapshot()).records[0];assert.equal(record.clock.accumulatedPausedMs,5000);monotonic+=1440000;record=unwrap(await repo.getSnapshot()).records[0];assert.equal(record.timerState,'finished');assert.equal(record.finishReason,'completed');
 unwrap(await repo.submitLifeCommand(pomodoroStart('break')));const restored=createLocalFallback(storage,'web',{clock:{...clock,bootId:'boot-b'}});record=unwrap(await restored.getSnapshot()).records.find(r=>r.phase==='break');assert.equal(record.timerState,'interrupted');assert.equal(record.clockIntegrity,'needs_review');assert.equal((await restored.submitLifeCommand(recordAction(record,'pomodoro.resume'))).error.code,'CLOCK_UNCERTAIN');unwrap(await restored.submitLifeCommand(recordAction(record,'pomodoro.finish')));
});
test('位置和确认命令拒绝非法边界与额外授权字段',()=>{
 const location={schemaVersion:1,opId:'location-a',kind:'location.create',payload:{text:'合成位置',latitude:90,longitude:-180,accuracyMeters:null,capturedAt:0,userConfirmed:true},observationIds:[]};validateCommand(location);location.payload.latitude=90.1;assert.throws(()=>validateCommand(location));
});
