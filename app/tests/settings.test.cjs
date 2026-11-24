const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const ts=require('typescript');
const fixtures=require('../../shared/companion-fixtures.json');const cache=new Map();
function load(file,modules=cache,boundaries={}){
 const absolute=path.resolve(__dirname,'../src',file);if(modules.has(absolute))return modules.get(absolute).exports;const module={exports:{}};modules.set(absolute,module);
 const resolve=name=>name.startsWith('.')?load(path.relative(path.resolve(__dirname,'../src'),path.resolve(path.dirname(absolute),name+'.ts')),modules,boundaries):Object.hasOwn(boundaries,name)?boundaries[name]:require(name);
 new Function('module','exports','require',ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(module,module.exports,resolve);return module.exports;
}
const {SettingsStore}=load('settings/store.ts');const {checkProvider,assistantWire,providerCheckFailureNotice}=load('settings/transport.ts');const {VISION_PRESETS,DEFAULT_CHAT_PROVIDER}=load('companion/contracts.ts');
// 每个页面拥有独立模块缓存；只替换系统/存储/网络边界，platform、store、adapter 均加载真实实现。
function webPages(){
 const data=new Map(),writes=[];let secureCalls=0,nativeCalls=0,networkCalls=0;
 const storage={getItem:async key=>data.get(key)??null,setItem:async(key,value)=>{writes.push([key,value]);data.set(key,value);}};
 const secure=()=>{secureCalls++;throw Error('Web 不得调用原生凭据存储');};
 const page=()=>{
  const modules=new Map();const boundaries={
   '@react-native-async-storage/async-storage':{__esModule:true,default:storage},
   'expo-secure-store':{WHEN_UNLOCKED_THIS_DEVICE_ONLY:1,getItemAsync:secure,setItemAsync:secure,deleteItemAsync:secure},
   'react-native':{Platform:{OS:'web'},AppState:{currentState:'active'}},
   'expo':{requireOptionalNativeModule:()=>{nativeCalls++;throw Error('Web 不得加载原生桥');}},
   'expo/fetch':{fetch:async()=>{networkCalls++;throw Error('会话保险库测试不得联网');}},
  };
  const platform=load('settings/platform.ts',modules,boundaries);return{platform,reimport:()=>load('settings/platform.ts',modules,boundaries)};
 };
 return{page,data,writes,counts:()=>({secureCalls,nativeCalls,networkCalls})};
}
test('实际Web platform保险库只在页面会话存Key；普通配置跨重载保留但凭据丢失',async()=>{
 const h=webPages();const first=h.page();const store=first.platform.getSettingsStore();await store.initialize();await store.setBackend('https://synthetic.invalid',true);
 const keys={chat:'synthetic-page-chat',stt:'synthetic-page-stt',vision:'synthetic-page-vision'};
 for(const slot of ['chat','stt','vision']){await store.saveKey(slot,keys[slot]);assert.equal(await store.hasKey(slot),true);assert.equal((await store.getRequestProvider(slot)).credentials.apiKey,keys[slot]);assert.equal(JSON.parse(await first.platform.credentialVault.read(slot)).apiKey,keys[slot]);}
 assert.equal(first.reimport(),first.platform);assert.equal(first.reimport().getSettingsStore(),store);
 const before=structuredClone(store.getState().settings);assert.equal(h.data.size,1);assert.ok(h.data.has('jarvis.providers.v1'));assert.ok(h.writes.length>0);
 for(const write of h.writes){const serialized=JSON.stringify(write);assert.doesNotMatch(serialized,/apiKey/);for(const key of Object.values(keys))assert.equal(serialized.includes(key),false);}
 const second=h.page();assert.notEqual(second.platform,first.platform);assert.notEqual(second.platform.credentialVault,first.platform.credentialVault);const reloaded=second.platform.getSettingsStore();assert.notEqual(reloaded,store);await reloaded.initialize();assert.deepEqual(reloaded.getState().settings,before);
 for(const slot of ['chat','stt','vision']){assert.equal(await second.platform.credentialVault.read(slot),null);assert.equal(await reloaded.hasKey(slot),false);await assert.rejects(reloaded.getRequestProvider(slot),e=>e.detail.code==='AUTH_REQUIRED');}
 assert.deepEqual(h.counts(),{secureCalls:0,nativeCalls:0,networkCalls:0});
});
test('实际Web三用途凭据互相隔离，清一项不误清其他项，另一页面不能读取旧会话Key',async()=>{
 const h=webPages();const first=h.page();const store=first.platform.getSettingsStore();await store.initialize();await store.setBackend('https://synthetic.invalid',true);await store.saveKey('chat','synthetic-isolated-chat');
 for(const slot of ['stt','vision'])await assert.rejects(store.getRequestProvider(slot),e=>e.detail.code==='AUTH_REQUIRED');
 await store.saveKey('stt','synthetic-isolated-stt');await store.saveKey('vision','synthetic-isolated-vision');const before=structuredClone(store.getState().settings.bindings);await store.clearKey('stt');
 assert.equal(await first.platform.credentialVault.read('stt'),null);assert.equal(await store.hasKey('stt'),false);await assert.rejects(store.getRequestProvider('stt'),e=>e.detail.code==='AUTH_REQUIRED');assert.equal(store.getState().settings.bindings.stt.credentialRevision,before.stt.credentialRevision+1);
 for(const slot of ['chat','vision']){assert.deepEqual(store.getState().settings.bindings[slot],before[slot]);assert.equal((await store.getRequestProvider(slot)).credentials.apiKey,`synthetic-isolated-${slot}`);}
 const second=h.page();const other=second.platform.getSettingsStore();await other.initialize();await assert.rejects(other.getRequestProvider('chat'),e=>e.detail.code==='AUTH_REQUIRED');await other.saveKey('chat','synthetic-other-page');assert.equal((await other.getRequestProvider('chat')).credentials.apiKey,'synthetic-other-page');assert.equal((await store.getRequestProvider('chat')).credentials.apiKey,'synthetic-isolated-chat');
 await store.clearKey('chat');assert.equal(await first.platform.credentialVault.read('chat'),null);assert.equal((await other.getRequestProvider('chat')).credentials.apiKey,'synthetic-other-page');assert.equal((await store.getRequestProvider('vision')).credentials.apiKey,'synthetic-isolated-vision');await store.clearKey('vision');assert.equal(await first.platform.credentialVault.read('vision'),null);
 for(const write of h.writes)assert.doesNotMatch(JSON.stringify(write),/synthetic-isolated|synthetic-other-page|apiKey/);assert.deepEqual(h.counts(),{secureCalls:0,nativeCalls:0,networkCalls:0});
});
function setup(sendCheck){const data=new Map();const secrets=new Map();const order=[];const adapter={stopObservation:async()=>{order.push('stop');return{schemaVersion:1,ok:true,value:{}};},getCapabilities:async()=>({ok:true,value:{screenObservation:true}})};const store=new SettingsStore({getItem:async k=>data.get(k)??null,setItem:async(k,v)=>{data.set(k,v);order.push('config');}},{read:async k=>secrets.get(k)??null,write:async(k,v)=>{order.push('key');secrets.set(k,v);},remove:async k=>{order.push('clear');secrets.delete(k);}},adapter,()=>true,sendCheck);return{store,data,secrets,order,adapter};}
test('Key 与普通配置隔离，凭据变更严格先停观察；STT 永不继承聊天 Key',async()=>{
 const {store,data,order}=setup();await store.initialize();await store.setBackend('https://synthetic.invalid',true);order.length=0;
 await store.saveKey('chat','synthetic-placeholder');assert.deepEqual(order,['stop','config','key']);assert.doesNotMatch(JSON.stringify([...data]),/synthetic-placeholder/);
 assert.equal((await store.getRequestProvider('chat')).credentials.apiKey,'synthetic-placeholder');
 await assert.rejects(store.getRequestProvider('stt'),e=>e.detail.code==='AUTH_REQUIRED');
 await store.setProvider({...VISION_PRESETS.deepseek});await assert.rejects(store.getRequestProvider('vision'),e=>e.detail.code==='CONSENT_REQUIRED');
 await store.acceptChatKeyReuse(true);assert.equal((await store.getRequestProvider('vision')).credentials.apiKey,'synthetic-placeholder');
 order.length=0;await store.clearKey('chat');assert.deepEqual(order,['stop','config','clear']);await assert.rejects(store.getRequestProvider('chat'),e=>e.detail.code==='AUTH_REQUIRED');
});
test('停止失败不能变更任何凭据或绑定',async()=>{const{store,adapter,secrets}=setup();await store.initialize();adapter.stopObservation=async()=>({schemaVersion:1,ok:false,error:{code:'STORAGE_FAILED'}});const before=store.getState().settings.bindings.chat.credentialRevision;await assert.rejects(store.saveKey('chat','synthetic-placeholder'));assert.equal(secrets.size,0);assert.equal(store.getState().settings.bindings.chat.credentialRevision,before);});
test('共享 transport fixture：携 Key 的 HTTP 请求在网络前拒绝',async()=>{
 const fixture=fixtures.transportBoundaryCases.find(c=>c.id==='key-bearing-http-is-blocked');let calls=0;
 await assert.rejects(checkProvider({origin:fixture.backendOrigin,confirmed:true},{provider:DEFAULT_CHAT_PROVIDER,credentials:{credentialId:'test-slot',credentialRevision:1,apiKey:'synthetic'}},undefined,async()=>{calls++;}),e=>e.detail.code===fixture.expectedErrorCode);
 assert.equal(calls,fixture.expectedNetworkCalls);
});
test('连接检测只发固定端点、白名单 JSON、专用头；诚实保留 unsupported',async()=>{
 const request={provider:DEFAULT_CHAT_PROVIDER,credentials:{credentialId:'test-slot',credentialRevision:1,apiKey:'synthetic-placeholder'}};let calls=0;
 const result=await checkProvider({origin:'https://synthetic.invalid',confirmed:true},request,undefined,async(url,options)=>{calls++;assert.equal(url,'https://synthetic.invalid/v1/providers/check');assert.equal(options.redirect,'error');assert.equal(options.headers['X-Jarvis-Provider-Key'],request.credentials.apiKey);assert.deepEqual(JSON.parse(options.body),{schemaVersion:1,provider:request.provider,credentialBinding:{credentialId:'test-slot',credentialRevision:1}});return{ok:true,json:async()=>({schemaVersion:1,ok:true,scope:'credentials_only'})};});
 assert.equal(result.scope,'credentials_only');assert.equal(calls,1);
 await assert.rejects(checkProvider({origin:'https://synthetic.invalid',confirmed:true},request,undefined,async()=>({ok:false,json:async()=>({schemaVersion:1,error:{code:'UNSUPPORTED',message:'原始消息不得泄露'}})})),e=>e.detail.code==='UNSUPPORTED'&&!e.message.includes('原始消息'));
 const wire=assistantWire({origin:'https://synthetic.invalid',confirmed:true},{requestProvider:request});assert.doesNotMatch(JSON.stringify(wire.body),/synthetic-placeholder/);assert.equal(wire.headers['X-Jarvis-Provider-Key'],'synthetic-placeholder');
});
test('Qwen不支持免费检测不等于凭据无效，不删除Key、不改变授权、不付费重试',async()=>{
 for(const code of ['UNSUPPORTED','AUTH_FAILED']){
  let calls=0;
  const {store}=setup(async(url,options)=>{calls++;assert.equal(url,'https://synthetic.invalid/v1/providers/check');assert.equal(JSON.parse(options.body).provider.preset,'qwen');return{ok:false,json:async()=>({schemaVersion:1,error:{code,message:'synthetic-private-response'}})};});
  await store.initialize();await store.setBackend('https://synthetic.invalid',true);await store.saveKey('vision','synthetic-qwen');await store.acceptCloudVision();
  const before=structuredClone(store.getState());let notice;
  await assert.rejects(store.check('vision'),error=>{notice=providerCheckFailureNotice(error);return error.detail.code===code;});
  assert.equal(calls,1);assert.deepEqual(store.getState(),before);assert.equal(await store.hasKey('vision'),true);assert.equal((await store.getRequestProvider('vision')).provider.preset,'qwen');
  assert.equal(notice.error,code==='AUTH_FAILED');assert.doesNotMatch(notice.text,/synthetic-private-response|synthetic-qwen/);
  if(code==='UNSUPPORTED'){assert.match(notice.text,/不支持非付费连接检测/);assert.match(notice.text,/尚未验证凭据/);assert.match(notice.text,/不代表实际功能不可用/);assert.match(notice.text,/不会自动发起付费调用/);}
  else {assert.match(notice.text,/凭据验证未通过/);assert.doesNotMatch(notice.text,/不支持非付费连接检测/);}
 }
});
test('等待系统授权不占凭据队列；全停立即调用桥，Key变更不死锁',{timeout:2000},async()=>{
 const {store,adapter,order}=setup();await store.initialize();await store.setBackend('https://synthetic.invalid',true);await store.saveKey('vision','synthetic');await store.acceptCloudVision();
 let entered;const enteredPromise=new Promise(resolve=>{entered=resolve;});let finish;
 adapter.startObservation=()=>{entered();return new Promise(resolve=>{finish=resolve;});};
 adapter.stopCompanion=async()=>{order.push('companion-stop');return{schemaVersion:1,ok:true,value:{}};};
 const pending=store.startObservation();await enteredPromise;
 await store.stopAll();assert.equal(order.at(-1),'companion-stop');
 await store.saveKey('vision','synthetic-new');assert.equal(order.at(-1),'key');
 finish({schemaVersion:1,ok:false,error:{code:'CANCELLED'}});await assert.rejects(pending,e=>e.detail.code==='CANCELLED');
});
test('全停发生在配置准备期间，晚到配置不再启动原生观察',{timeout:2000},async()=>{
 const {store,adapter}=setup();await store.initialize();await store.setBackend('https://synthetic.invalid',true);await store.saveKey('vision','synthetic');await store.acceptCloudVision();
 let calls=0;adapter.startObservation=async()=>{calls++;return{schemaVersion:1,ok:true,value:{}};};adapter.stopCompanion=async()=>({schemaVersion:1,ok:true,value:{}});
 const pending=store.startObservation();const rejected=assert.rejects(pending,e=>e.detail.code==='CANCELLED');await store.stopAll();await rejected;assert.equal(calls,0);
});
