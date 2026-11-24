const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const ts=require('typescript');const fixtures=require('../../shared/companion-fixtures.json');const cache=new Map();
function load(file){const absolute=path.resolve(__dirname,'../src',file);if(cache.has(absolute))return cache.get(absolute).exports;const module={exports:{}};cache.set(absolute,module);new Function('module','exports','require',ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(module,module.exports,name=>name.startsWith('.')?load(path.relative(path.resolve(__dirname,'../src'),path.resolve(path.dirname(absolute),name+'.ts'))):require(name));return module.exports;}
const {VoiceController}=load('voice/controller.ts');const{encodeTranscription,validateAudioClip,validateTranscriptionResponse,transcribeAudio}=load('voice/transcription.ts');const{createWebRecorder}=load('voice/webRecorder.ts');
const {NativeRecorderAdapter}=load('voice/nativeRecorder.ts');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
// 仅构造容器元数据与占位数据，不冒充可解码音频；实际适配器负责解析与校验。
function syntheticM4a(durationMs=1234,version=0,extended=false,scale=1000){
 const box=(type,payload,large=false)=>{const header=large?16:8;const bytes=new Uint8Array(header+payload.length);const view=new DataView(bytes.buffer);view.setUint32(0,large?1:bytes.length);bytes.set(new TextEncoder().encode(type),4);if(large)view.setUint32(12,bytes.length);bytes.set(payload,header);return bytes;};
 const header=new Uint8Array(version===1?112:100);const view=new DataView(header.buffer);header[0]=version;view.setUint32(version===1?20:12,scale);const ticks=durationMs*scale/1000;
 if(version===1){view.setUint32(24,Math.floor(ticks/2**32));view.setUint32(28,ticks%2**32);}else view.setUint32(16,ticks);
 const parts=[box('ftyp',new TextEncoder().encode('M4A \0\0\0\0M4A ')),box('mdat',new Uint8Array([11,22,33])),box('moov',box('mvhd',header),extended)];
 const bytes=new Uint8Array(parts.reduce((size,part)=>size+part.length,0));let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}
function nativeSetup(options={}){
 const resources=[],modes=[],discards=[];let permissionCalls=0,reads=0,foreground=true;
 const environment={
  requestPermission:async()=>{permissionCalls++;return options.permission?options.permission():{granted:true};},isForeground:()=>foreground,
  setRecordingMode:async enabled=>{modes.push(enabled);if(options.mode)await options.mode(enabled);},
  createRecorder:()=>{
   const state={recording:false,prepared:false,released:false,listener:null,late:null,stops:0,releases:0,starts:[],removed:0,uri:`file:///synthetic-${resources.length}.m4a`};
   const alive=()=>assert.equal(state.released,false,'释放后不得再次访问原生资源');
   const resource={
    get isRecording(){alive();return state.recording;},get uri(){alive();return state.uri;},
    prepareToRecordAsync:async()=>{alive();if(options.prepare)await options.prepare();state.prepared=true;},
    record:config=>{alive();assert.equal(state.prepared,true);state.starts.push(config);state.recording=true;if(options.record)options.record(state);},
    getStatus:()=>{alive();return{durationMillis:state.recording?1234:0};},
    stop:async()=>{alive();state.stops++;state.recording=false;state.prepared=false;if(options.stop)await options.stop();},
    release:()=>{alive();assert.equal(state.listener,null);state.releases++;state.released=true;state.recording=false;},
    addListener:(name,callback)=>{alive();assert.equal(name,'recordingStatusUpdate');state.listener=callback;state.late=callback;return{remove:()=>{alive();state.removed++;state.listener=null;}};},
   };
   state.finish=(status={isFinished:true,hasError:false})=>{state.recording=false;state.prepared=false;state.late(status);};state.resource=resource;resources.push(state);return resource;
  },
  readBytes:async uri=>{reads++;assert.equal(uri,resources.at(-1).uri);return options.read?options.read():syntheticM4a();},
  discard:uri=>{assert.equal(resources.find(r=>r.uri===uri).released,true);discards.push(uri);},
 };
 return{recorder:new NativeRecorderAdapter(environment),resources,modes,discards,counts:()=>({permissionCalls,reads}),setForeground:value=>{foreground=value;}};
}
function phaseReached(controller,phase){if(controller.getState().phase===phase)return Promise.resolve();return new Promise(resolve=>{const unsubscribe=controller.subscribe(()=>{if(controller.getState().phase===phase){unsubscribe();resolve();}});});}

test('实际原生适配器惰性分配，前台权限门禁与重复启动不破坏现有录音',{timeout:2000},async()=>{
 const h=nativeSetup();assert.equal(h.resources.length,0);h.setForeground(false);await assert.rejects(h.recorder.start(new AbortController().signal),e=>e.detail.code==='NOT_FOREGROUND');assert.equal(h.counts().permissionCalls,0);
 h.setForeground(true);await h.recorder.start(new AbortController().signal);await assert.rejects(h.recorder.start(new AbortController().signal),e=>e.detail.code==='ALREADY_RUNNING');assert.equal(h.counts().permissionCalls,1);assert.equal(h.resources.length,1);assert.deepEqual(h.resources[0].starts,[{forDuration:60}]);
 const clip=await h.recorder.stop();assert.equal(clip.durationMs,1234);assert.equal(h.resources[0].releases,1);
 const denied=nativeSetup({permission:async()=>({granted:false})});await assert.rejects(denied.recorder.start(new AbortController().signal),e=>e.detail.code==='PERMISSION_DENIED');assert.equal(denied.resources.length,0);assert.deepEqual(denied.modes,[]);
});
test('实际原生权限晚到取消不开麦；准备中取消仍停止、移除监听、释放和删缓存',{timeout:2000},async()=>{
 for(const stage of ['permission','prepare']){
  const gate=deferred(),entered=deferred();const h=nativeSetup({[stage]:async()=>{entered.resolve();await gate.promise;return{granted:true};}});const control=new AbortController();let notices=0;
  const pending=h.recorder.start(control.signal,()=>{notices++;});const rejected=assert.rejects(pending,e=>e.detail.code==='CANCELLED');await entered.promise;control.abort();const cancelled=h.recorder.cancel();gate.resolve();await rejected;await cancelled;
  assert.equal(notices,0);assert.equal(h.counts().reads,0);
  if(stage==='permission'){assert.equal(h.resources.length,0);assert.deepEqual(h.modes,[]);}
  else{const r=h.resources[0];assert.deepEqual(r.starts,[]);assert.equal(r.stops,1);assert.equal(r.releases,1);assert.equal(r.removed,1);assert.deepEqual(h.discards,[r.uri]);assert.deepEqual(h.modes,[true,false]);r.late({isFinished:true,hasError:false});assert.equal(notices,0);}
 }
});
test('实际原生停止保留二进制并读取M4A v0/v1、64位box及非零字节偏移的时长',{timeout:2000},async()=>{
 for(const [version,scale] of [[0,1000],[1,100000000]]){
  const raw=syntheticM4a(version===1?60000:2345,version,true,scale);const backing=new Uint8Array(raw.length+9);backing.set(raw,5);const bytes=backing.subarray(5,5+raw.length);const h=nativeSetup({read:async()=>bytes});
  await h.recorder.start(new AbortController().signal);const clip=await h.recorder.stop();assert.equal(clip.bytes,bytes);assert.equal(clip.durationMs,version===1?60000:2345);assert.equal(clip.filename,'recording.m4a');assert.equal(clip.mimeType,'audio/mp4');assert.deepEqual([...clip.bytes],[...raw]);
  const r=h.resources[0];assert.equal(r.stops,1);assert.equal(r.releases,1);assert.equal(r.removed,1);assert.deepEqual(h.discards,[r.uri]);assert.deepEqual(h.modes,[true,false]);await h.recorder.cancel();assert.equal(r.releases,1);
 }
});
test('实际原生60秒自动完成及准备阶段完成均只转写一次，运行时长归零不猜填',{timeout:2000},async()=>{
 for(const early of [false,true]){
  const h=nativeSetup({read:async()=>syntheticM4a(early?875:60000),record:early?r=>r.finish():undefined});let transcriptions=0;const done=setup({recorder:h.recorder,transcribe:async clip=>{transcriptions++;assert.equal(clip.durationMs,early?875:60000);return'合成自动完成';}});const c=done.controller;
  try{await c.begin();const r=h.resources[0];if(!early){assert.equal(c.getState().phase,'recording');const reviewed=phaseReached(c,'review');r.finish();assert.equal(r.resource.getStatus().durationMillis,0);r.late({isFinished:true,hasError:false});await reviewed;}
   assert.equal(c.getState().phase,'review');assert.equal(transcriptions,1);assert.equal(done.counts().chat,0);assert.equal(r.stops,0);assert.equal(r.releases,1);assert.deepEqual(r.starts,[{forDuration:60}]);r.late({isFinished:true,hasError:false});assert.equal(transcriptions,1);
  }finally{await c.cancel();c.dispose();}
 }
});
test('实际原生错误与媒体服务重置退出录音、脱敏且不转写，旧会话事件不影响新会话',{timeout:2000},async()=>{
 for(const extra of [{hasError:true,error:'synthetic-private-native-error'},{mediaServicesDidReset:true}]){
  const h=nativeSetup();const {controller:c,counts}=setup({recorder:h.recorder});try{
   await c.begin();const old=h.resources[0];old.finish({isFinished:true,hasError:false,...extra});assert.equal(c.getState().phase,'error');assert.equal(c.getState().error.code,'PERMISSION_DENIED');assert.doesNotMatch(JSON.stringify(c.getState()),/synthetic-private-native-error/);await h.recorder.cancel();assert.equal(old.releases,1);assert.equal(counts().stt,0);
   await c.begin();old.late({isFinished:true,hasError:false});old.late({isFinished:true,hasError:true});assert.equal(c.getState().phase,'recording');assert.equal(h.resources[1].releases,0);assert.equal(counts().stt,0);
  }finally{await c.cancel();c.dispose();}
 }
});
test('实际原生读取期间取消拒绝晚到字节，退后台停止路径也释放且不读文件',{timeout:2000},async()=>{
 const gate=deferred(),entered=deferred();const h=nativeSetup({read:async()=>{entered.resolve();return gate.promise;}});const control=new AbortController();let notices=0;
 await h.recorder.start(control.signal,()=>{notices++;});const pending=h.recorder.stop();const rejected=assert.rejects(pending,e=>e.detail.code==='CANCELLED');await entered.promise;control.abort();const cancelled=h.recorder.cancel();h.resources[0].late({isFinished:true,hasError:false});gate.resolve(syntheticM4a());await rejected;await cancelled;assert.equal(notices,0);assert.equal(h.resources[0].releases,1);assert.equal(h.discards.length,1);assert.deepEqual(h.modes,[true,false]);
 const background=nativeSetup();await background.recorder.start(new AbortController().signal);background.setForeground(false);await assert.rejects(background.recorder.stop(),e=>e.detail.code==='NOT_FOREGROUND');assert.equal(background.counts().reads,0);assert.equal(background.resources[0].releases,1);assert.deepEqual(background.modes,[true,false]);
});
test('实际原生关闭录音模式期间取消，资源已经释放也不返回晚到片段',{timeout:2000},async()=>{
 const gate=deferred(),entered=deferred();const h=nativeSetup({mode:async enabled=>{if(!enabled){entered.resolve();await gate.promise;}}});const control=new AbortController();
 await h.recorder.start(control.signal);const pending=h.recorder.stop();const rejected=assert.rejects(pending,e=>e.detail.code==='CANCELLED');await entered.promise;assert.equal(h.resources[0].releases,1);assert.equal(h.discards.length,1);control.abort();const cancelled=h.recorder.cancel();gate.resolve();await rejected;await cancelled;assert.equal(h.resources[0].releases,1);assert.deepEqual(h.modes,[true,false]);
});
test('实际原生prepare、record、stop或读取失败均清理资源，重复cancel不重复释放',{timeout:2000},async()=>{
 for(const stage of ['prepare','record','stop','read']){
  const error=Error(`synthetic-${stage}`);const h=nativeSetup({[stage]:()=>{throw error;}});
  if(stage==='prepare'||stage==='record')await assert.rejects(h.recorder.start(new AbortController().signal),e=>e===error);
  else{await h.recorder.start(new AbortController().signal);await assert.rejects(h.recorder.stop(),e=>e===error);}
  const r=h.resources[0];assert.equal(r.releases,1);assert.equal(r.removed,1);assert.deepEqual(h.discards,[r.uri]);assert.deepEqual(h.modes,[true,false]);await h.recorder.cancel();await h.recorder.cancel();assert.equal(r.releases,1);
 }
});
test('实际原生拒绝缺失损坏或超限容器时长，不用墙钟或60秒伪造元数据',{timeout:2000},async()=>{
 const malformed=syntheticM4a();new DataView(malformed.buffer).setUint32(0,malformed.length+1);
 const zeroScale=syntheticM4a(1000,0,false,0);const tooLong=fixtures.transportBoundaryCases.find(c=>c.id==='audio-too-long');const tooLarge=fixtures.transportBoundaryCases.find(c=>c.id==='audio-over-limit');
 const cases=[[new Uint8Array([0,1,2]),'INVALID_SCHEMA'],[malformed,'INVALID_SCHEMA'],[syntheticM4a(0),'INVALID_SCHEMA'],[syntheticM4a(1,2),'INVALID_SCHEMA'],[zeroScale,'INVALID_SCHEMA'],[syntheticM4a(tooLong.durationMs),tooLong.expectedErrorCode],[new Uint8Array(tooLarge.fileBytes),tooLarge.expectedErrorCode]];
 for(const [bytes,code] of cases){const h=nativeSetup({read:async()=>bytes});await h.recorder.start(new AbortController().signal);h.resources[0].finish();await assert.rejects(h.recorder.stop(),e=>e.detail.code===code);assert.equal(h.resources[0].releases,1);assert.equal(h.discards.length,1);assert.deepEqual(h.modes,[true,false]);}
});// 后续用例继续使用冻结共享 fixtures，保留原断言。

function setup(overrides={}){let stt=0,chat=0,mic=0,tts=0;const ports={preflight:async()=>{},recorder:{start:async()=>{mic++;},stop:async()=>({bytes:new Uint8Array([1]),filename:'recording.wav',mimeType:'audio/wav',durationMs:1000}),cancel:async()=>{}},transcribe:async()=>{stt++;return'合成转写';},send:async()=>{chat++;return{reply:'合成回复'};},speech:{speak:async(text,signal,onStart)=>{tts++;onStart();},stop:async()=>{}},...overrides};const controller=new VoiceController(ports);controller.setActive(true);return{controller,ports,counts:()=>({stt,chat,mic,tts})};}
test('共享 STT fixtures：恰好 file+metadata 两 part，JSON元数据和真实扩展名，不含 Key',()=>{
 const example=fixtures.transcriptionExample;const clip={bytes:new Uint8Array(example.syntheticFileDescriptor.bytes),filename:example.syntheticFileDescriptor.filename,mimeType:example.syntheticFileDescriptor.mimeType,durationMs:example.metadata.durationMs};
 const wrong=structuredClone(example.metadata);wrong.provider={purpose:'chat',preset:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash'};assert.throws(()=>encodeTranscription(clip,wrong),error=>error.detail.code==='INVALID_SCHEMA');
 const encoded=encodeTranscription(clip,example.metadata,'synthetic_boundary');const text=new TextDecoder().decode(encoded.body);assert.equal((text.match(/Content-Disposition:/g)||[]).length,2);assert.match(text,/name="metadata"\r\nContent-Type: application\/json/);assert.match(text,/filename="synthetic.wav"/);assert.doesNotMatch(text,/apiKey|file:\/\/|X-Jarvis/);assert.deepEqual(validateTranscriptionResponse(example.success,example.metadata.requestId),example.success);
 for(const c of fixtures.transportBoundaryCases.filter(c=>c.fileBytes||c.durationMs)){assert.throws(()=>validateAudioClip({...clip,bytes:new Uint8Array(c.fileBytes??32044),durationMs:c.durationMs??1000}),e=>e.detail.code===c.expectedErrorCode,c.id);}
});
test('准备期间连续点击只启动一个麦克风；取消预检后不再开麦',{timeout:2000},async()=>{
 const first=setup();await Promise.all([first.controller.begin(),first.controller.begin()]);assert.equal(first.counts().mic,1);first.controller.dispose();
 const gate=deferred(),entered=deferred();const second=setup({preflight:async()=>{entered.resolve();await gate.promise;}});const preparing=second.controller.begin();await entered.promise;await second.controller.cancel();gate.resolve();await preparing;assert.equal(second.counts().mic,0);assert.equal(second.controller.getState().phase,'idle');second.controller.dispose();
});
test('浏览器权限晚到时取消仍释放音轨，不开始录制',{timeout:2000},async()=>{
 const gate=deferred(),entered=deferred();let stopped=0,created=0;const stream={getTracks:()=>[{stop:()=>{stopped++;}}]};
 const recorder=createWebRecorder({getUserMedia:()=>{entered.resolve();return gate.promise;},supports:()=>true,createRecorder:()=>{created++;throw Error('不可到达');},now:()=>0});const control=new AbortController();
 const pending=recorder.start(control.signal);const rejected=assert.rejects(pending,error=>error.detail.code==='CANCELLED');await entered.promise;control.abort();const cancelled=recorder.cancel();gate.resolve(stream);await rejected;await cancelled;assert.equal(stopped,1);assert.equal(created,0);
});
test('浏览器真实MIME与二进制保留，停止释放音轨',{timeout:2000},async()=>{
 let now=1000,stopped=0;const stream={getTracks:()=>[{stop:()=>{stopped++;}}]};
 const recorder=createWebRecorder({getUserMedia:async()=>stream,supports:mime=>mime==='audio/mp4',now:()=>now,createRecorder:(_,mimeType)=>({mimeType,state:'inactive',start(){this.state='recording';},stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable({data:new Blob([new Uint8Array([1,2,3])],{type:mimeType})});this.onstop();});}})});
 await recorder.start(new AbortController().signal);now=2345;const clip=await recorder.stop();assert.equal(clip.durationMs,1345);assert.equal(clip.mimeType,'audio/mp4');assert.equal(clip.filename,'recording.mp4');assert.deepEqual([...clip.bytes],[1,2,3]);assert.ok(stopped>=1);
});
test('系统TTS打断会中止信号并保持idle，晚到完成不复活朗读',{timeout:2000},async()=>{
 const gate=deferred(),entered=deferred();let spokenSignal;
 const {controller}=setup({speech:{speak:async(_,signal,onStart)=>{spokenSignal=signal;onStart();entered.resolve();await gate.promise;},stop:async()=>{}}});
 controller.editTranscript('合成文字');const pending=controller.sendReviewed();await entered.promise;assert.equal(controller.getState().characterState,'speaking');await controller.interruptSpeech();assert.equal(spokenSignal.aborted,true);gate.resolve();await pending;assert.equal(controller.getState().characterState,'idle');controller.dispose();
});
test('录音硬件异常停止立即退出listening，旧回调不触发转写',{timeout:2000},async()=>{
 let ended;const {controller,counts}=setup({recorder:{start:async(_,callback)=>{ended=callback;},stop:async()=>{throw Error('异常后不能转写');},cancel:async()=>{}}});
 await controller.begin();ended({code:'PERMISSION_DENIED',message:'权限已撤销',retryable:false});assert.equal(controller.getState().characterState,'error');assert.equal(counts().stt,0);ended();assert.equal(counts().stt,0);controller.dispose();
});
test('录音一次STT，等待用户检查编辑后仅一次聊天与TTS',async()=>{const{controller,counts}=setup();await controller.begin();assert.equal(controller.getState().characterState,'listening');await Promise.all([controller.finishRecording(),controller.finishRecording()]);assert.equal(controller.getState().phase,'review');assert.deepEqual(counts(),{stt:1,chat:0,mic:1,tts:0});controller.editTranscript('用户修改后的内容');await Promise.all([controller.sendReviewed(),controller.sendReviewed()]);assert.deepEqual(counts(),{stt:1,chat:1,mic:1,tts:1});controller.dispose();});
test('取消在途 STT 拒绝晚到文本，不继续聊天；隐藏前台不再开麦',async()=>{const late=deferred();const{controller,counts}=setup({transcribe:()=>late.promise});await controller.begin();const pending=controller.finishRecording();await Promise.resolve();await controller.cancel();late.resolve('迟到内容');await pending;assert.equal(controller.getState().transcript,'');assert.equal(counts().chat,0);controller.setActive(false);await controller.begin();assert.equal(counts().mic,1);controller.dispose();});
test('发送后取消拒绝迟到回复与TTS，不自动重试',async()=>{const late=deferred();let sends=0;const{controller,counts}=setup({send:async()=>{sends++;return late.promise;}});controller.editTranscript('合成文本');const pending=controller.sendReviewed();await controller.cancel();late.resolve({reply:'迟到回复'});await pending;assert.equal(sends,1);assert.equal(counts().tts,0);assert.equal(controller.getState().reply,'');controller.dispose();});
test('离线生成回复有明确标记，缺配置不开麦',async()=>{const{controller}=setup({send:async()=>({reply:'本地提示',offline:true})});controller.editTranscript('文本');await controller.sendReviewed();assert.equal(controller.getState().reply,'（离线）本地提示');controller.dispose();const bad=setup({preflight:async()=>{throw Error('无配置');}});await bad.controller.begin();assert.equal(bad.counts().mic,0);assert.equal(bad.controller.getState().phase,'error');bad.controller.dispose();});
test('HTTP带Key禁止发送；取消信号贯穿转写且不重试',async()=>{const e=fixtures.transcriptionExample;const provider={provider:e.metadata.provider,credentials:{...e.metadata.credentialBinding,apiKey:'synthetic'}};const clip={bytes:new Uint8Array([1]),filename:'synthetic.wav',mimeType:'audio/wav',durationMs:1000};let calls=0;await assert.rejects(transcribeAudio({origin:'http://synthetic.invalid',confirmed:true},provider,clip,undefined,async()=>{calls++;}),error=>error.detail.code==='INSECURE_TRANSPORT');assert.equal(calls,0);const abort=new AbortController();abort.abort();await assert.rejects(transcribeAudio({origin:'https://synthetic.invalid',confirmed:true},provider,clip,abort.signal,async()=>{calls++;}),error=>error.detail.code==='CANCELLED');assert.equal(calls,0);});
