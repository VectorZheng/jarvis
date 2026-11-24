import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Platform, ScrollView, Text, View } from 'react-native';
import { PROVIDER_BASE_URLS, VISION_PRESETS } from '../companion/contracts';
import type { CompanionCapabilities, ProviderConfig } from '../companion/contracts';
import { safeError, unwrap } from '../companion/core';
import { useForeground, useLifeProjection } from '../companion/hooks';
import { Action, Feedback, Field, SectionTitle, Toggle, ui } from '../companion/ui';
import { getSettingsStore } from './platform';
import type { CredentialSlot, SettingsStore } from './store';
import { providerCheckFailureNotice } from './transport';

function ProviderEditor({store,purpose}:{store:SettingsStore;purpose:CredentialSlot}) {
  const {settings}=useSyncExternalStore(store.subscribe,store.getState,store.getState);
  const provider=settings[purpose];
  const [model,setModel]=useState(provider.model);const [key,setKey]=useState('');const [saved,setSaved]=useState(false);
  const [busy,setBusy]=useState(false);const [notice,setNotice]=useState('');const [error,setError]=useState(false);
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>{
    // 清理发生在前后台事件中；Web 的 change 事件也覆盖页面隐藏。
    const subscription=AppState.addEventListener('change',state=>{
      if(state!=='active'){setKey('');controller.current?.abort();}
    });
    return()=>{subscription?.remove();controller.current?.abort();};
  },[]);
  const slot=purpose==='vision'?settings.vision.credentialSource:purpose;
  useEffect(()=>{let active=true;void store.hasKey(slot).then(value=>{if(active)setSaved(value);}).catch(()=>{if(active)setNotice('无法读取 Key 状态。');});return()=>{active=false;controller.current?.abort();};},[store,slot,settings.bindings]);
  async function run(work:()=>Promise<unknown>,success:string,checking=false){
    if(busy)return;setBusy(true);setNotice('');setError(false);
    try{await work();setNotice(success);setSaved(await store.hasKey(slot));}
    catch(cause){const feedback=checking?providerCheckFailureNotice(cause):{error:true,text:safeError(cause,'NETWORK_UNAVAILABLE').message};setError(feedback.error);setNotice(feedback.text);}
    finally{setBusy(false);}
  }
  const titles={chat:'聊天 · DeepSeek',stt:'语音转写 · OpenAI',vision:'屏幕理解 · 独立配置'};
  return <View style={ui.card} testID={`provider-${purpose}`}>
    <Text style={ui.cardTitle}>{titles[purpose]}</Text><Text style={ui.muted}>{provider.baseUrl}</Text>
    {purpose==='vision'?<>
      <View style={ui.row}><Action label="Qwen3-VL-Plus" disabled={busy} primary={settings.vision.preset==='qwen'} onPress={()=>{void run(()=>store.setProvider({...VISION_PRESETS.qwen}),'视觉配置已保存，需重新同意云分析。');}}/><Action label="DeepSeek Flash" disabled={busy} primary={settings.vision.preset==='deepseek'} onPress={()=>{void run(()=>store.setProvider({...VISION_PRESETS.deepseek}),'视觉配置已保存，需单独确认复用聊天 Key。');}}/></View>
      {settings.vision.preset==='qwen'?<View style={ui.row}>{([['中国内地',PROVIDER_BASE_URLS.qwenCn],['国际',PROVIDER_BASE_URLS.qwenIntl],['美国',PROVIDER_BASE_URLS.qwenUs]] as const).map(([label,baseUrl])=><Action key={baseUrl} label={label} disabled={busy} primary={settings.vision.baseUrl===baseUrl} onPress={()=>{void run(()=>store.setProvider({...VISION_PRESETS.qwen,baseUrl}),'地域已保存，请确认该地域独立 Key。');}}/>)}</View>:<Toggle label="明确同意：复用聊天 Key 做视觉分析" detail="仅限 DeepSeek 视觉；不会把聊天 Key 交给 STT。" value={settings.reuseChatKeyAcceptedAt!==null} disabled={busy} onChange={value=>{void run(()=>store.acceptChatKeyReuse(value),value?'已确认复用，可继续确认云分析。':'已撤销复用并停止观察。');}}/>}
    </>:<><Field label="模型" value={model} onChangeText={setModel} autoCapitalize="none"/><Action label="保存模型配置" disabled={busy} onPress={()=>{void run(()=>store.setProvider({...provider,model} as ProviderConfig),'模型配置已保存。');}}/></>}
    <Text style={ui.badge}>{saved?'该用途 Key 已保存':'该用途尚无 Key'}</Text>
    {purpose==='vision'&&slot==='chat'?<Text style={ui.muted}>此预设只读取已明确同意复用的聊天 Key。请在聊天卡片保存或清除它。</Text>:<>
      <Field label={`${purpose.toUpperCase()} 独立 Key`} secureTextEntry value={key} onChangeText={setKey} autoCapitalize="none" autoCorrect={false} placeholder="仅在此输入，不要发到聊天" textContentType="none" autoComplete="off"/>
      <View style={ui.row}><Action label="保存 Key" disabled={busy||!key.trim()} primary onPress={()=>{const value=key;setKey('');void run(()=>store.saveKey(slot,value),'Key 已保存；原观察已停止，重新开启需授权。');}}/><Action label="清除 Key" disabled={busy} danger onPress={()=>{setKey('');void run(()=>store.clearKey(slot),'Key 已清除，原绑定已失效。');}}/></View>
    </>}
    <Action label={busy?'处理中…':'非付费连接检测'} disabled={busy||!saved} onPress={()=>{controller.current?.abort();controller.current=new AbortController();void run(()=>store.check(purpose,controller.current!.signal),'凭据/连接检查通过；这不代表视觉、转写或模型调用能力已验证。',true);}}/>
    {busy?<Action label="取消连接检测" onPress={()=>controller.current?.abort()}/>:null}
    <Text style={ui.muted}>仅检查官方支持的非付费凭据端点。供应商不支持时明确提示，不自动付费试跑。</Text>
    <Feedback text={notice} error={error}/>
  </View>;
}
function BackendEditor({store}:{store:SettingsStore}) {
  const initial=store.getState().settings.backend;const [origin,setOrigin]=useState(initial.origin);const [trust,setTrust]=useState(false);const [notice,setNotice]=useState('');
  return <View style={ui.card}><Text style={ui.cardTitle}>可信服务入口</Text><Text style={ui.muted}>本地 HTTP 页面可以浏览；BYOK 必须连接可信 HTTPS 后端。Key 会经这个服务转发到你选择的云供应商，不会放入 URL 或正文。</Text><Field label="HTTPS 后端 origin" value={origin} onChangeText={value=>{setOrigin(value);setTrust(false);}} autoCapitalize="none" autoCorrect={false} placeholder="https://你的服务域名"/><Toggle label="我确认这是可信的 HTTPS 服务" value={trust} onChange={setTrust}/><Action label="保存可信入口" primary disabled={!trust} onPress={()=>{void store.setBackend(origin,trust).then(()=>setNotice('可信入口已保存；云分析需重新确认。')).catch(error=>setNotice(safeError(error).message));}}/><Feedback text={notice}/></View>;
}
export function SettingsPanel({store=getSettingsStore(),visible=true,reduceMotion=false}:{store?:SettingsStore;visible?:boolean;reduceMotion?:boolean}) {
  const state=useSyncExternalStore(store.subscribe,store.getState,store.getState);const active=useForeground(visible);
  const life=useLifeProjection(store.adapter,visible);const [capabilities,setCapabilities]=useState<CompanionCapabilities|null>(null);
  const [notice,setNotice]=useState('');const [error,setError]=useState(false);const [busy,setBusy]=useState(false);const [cloudRead,setCloudRead]=useState(false);const [expenseRead,setExpenseRead]=useState(false);
  useEffect(()=>{void store.initialize().catch(cause=>{setError(true);setNotice(safeError(cause).message);});void store.adapter.getCapabilities().then(value=>{if(value.ok)setCapabilities(value.value);});},[store]);
  async function run(work:()=>Promise<unknown>,success:string,interrupt=false){if(busy&&!interrupt)return;setBusy(true);setNotice('');setError(false);try{await work();await life.refresh(true);setNotice(success);}catch(cause){setError(true);setNotice(safeError(cause).message);}finally{setBusy(false);}}
  if(!visible)return null;
  if(!state.ready)return <View style={ui.page}><SectionTitle index="01" title="连接与边界"/><Feedback text={notice||'正在读取设置…'} error={error}/><Action label="重新读取设置" onPress={()=>{void run(()=>store.initialize(),'设置已读取。');}}/></View>;
  const s=state.settings;const observation=life.snapshot?.observation;const companion=life.snapshot?.companion;
  return <ScrollView contentContainerStyle={ui.page} keyboardShouldPersistTaps="handled" testID="companion-settings">
    <SectionTitle index="01" title="连接与边界" subtitle="你的助手，你决定它能看什么、何时停下。"/>
    <Text style={ui.badge}>{capabilities?.screenObservation?'Android 原生观察 / 本地 SQLite':'仅前台功能 · 不支持后台观察'}</Text>
    <Text style={ui.muted}>{Platform.OS==='web'?'Web Key 仅保留在当前页面内存，刷新后需重新填写。':'Key 保存在设备 SecureStore，不进入普通配置。'}</Text>
    <BackendEditor store={store}/>
    {(['chat','stt','vision'] as const).map(purpose=><ProviderEditor key={purpose} store={store} purpose={purpose}/>)}
    <View style={ui.card}>
      <Text style={ui.cardTitle}>陪伴与观察，分别授权</Text>
      <Text style={ui.body}>云分析：{s.vision.preset==='deepseek'?'DeepSeek':'阿里云 Qwen'} · {s.vision.model}</Text>
      <Text style={ui.muted}>用途：识别屏幕中的食材与支出线索。图像默认仅在内存中处理，但会上传至所选云供应商。调用可能计费，失败也计入本地次数；实际费用与 token 用量未知时不会显示为零。</Text>
      <Text style={ui.muted}>不能保证自动遮住聊天、密码、银行或其他敏感画面。进入敏感内容前请手动停止观察。系统限制或黑屏不会被绕过；取消不能追回已上传数据，也不保证免费。</Text>
      <Text style={ui.muted}>每次最长30分钟、会话40次、每日100次；连续3次失败停止观察。系统共享授权和云分析同意缺一不可。</Text>
      <Toggle label="我已阅读云上传、费用和敏感画面风险" value={cloudRead} onChange={setCloudRead}/>
      <Action label="确认本次云分析用途" disabled={!cloudRead||busy||!active} onPress={()=>{void run(()=>store.acceptCloudVision(),'云分析同意已保存，开启时还会请求系统共享授权。');}}/>
      <View style={ui.row}>{(['food','expense','mixed'] as const).map(mode=><Action key={mode} label={{food:'只看食材',expense:'只看支出',mixed:'食材与支出'}[mode]} primary={s.taskMode===mode} disabled={busy} onPress={()=>{void run(()=>store.setTaskMode(mode),'用途已更新；观察已停止，请重新开启。');}}/>)}</View>
      <Toggle label="桌面陪伴" detail="只开启人物悬浮，不会偷偷开启看屏。" value={companion?.running??false} disabled={busy||!active||!capabilities?.systemOverlay} onChange={value=>{void run(async()=>unwrap(await (value?store.adapter.startCompanion({schemaVersion:1,reduceMotion}):store.adapter.stopCompanion('user'))),value?'桌面陪伴已开启。':'桌面陪伴已停止；观察状态独立。');}}/>
      <Toggle label="持续观察屏幕" detail="每次开启均需新的系统共享授权；暂停等于停止。" value={observation?.state==='observing'||observation?.state==='starting'} disabled={busy||!active||!capabilities?.screenObservation} onChange={value=>{void run(()=>value?store.startObservation():store.stopObservation('user'),value?'观察会话已开启。':'观察已停止，晚到结果不会写入。');}}/>
      <Toggle label="我理解自动支出确认须有完整付款证据" detail="标价、购物车和待付款绝不等于已付款。" value={expenseRead} onChange={setExpenseRead}/>
      <Toggle label="允许符合条件的屏幕支出自动确认" value={s.autoConfirmExpensesAcceptedAt!==null} disabled={busy||(!expenseRead&&s.autoConfirmExpensesAcceptedAt===null)} onChange={value=>{void run(()=>store.setAutoConfirmExpenses(value),value?'已开启独立自动确认；原观察停止，需重新开启。':'已关闭自动确认。');}}/>
      <Action label="一键全停" danger testID="companion-stop-all" onPress={()=>{void run(()=>store.stopAll(),'观察与桌面陪伴均已停止。',true);}}/>
    </View>
    <View style={ui.card}><Text style={ui.cardTitle}>此刻 · 观察状态</Text><Text style={ui.large}>{observation?.state==='observing'?'观察中':observation?.state==='starting'?'等待授权':'已停止'}</Text><Text style={ui.muted}>会话 {observation?.counters.sessionAttempts??'—'} / {observation?.counters.sessionLimit??40} 次 · 今日 {observation?.counters.dailyAttempts??'—'} / {observation?.counters.dailyLimit??100} 次</Text><Text style={ui.muted}>实际费用 / token：未知；次数不是账单。最近识别：{observation?.lastObservationAt?new Date(observation.lastObservationAt).toLocaleString():'暂无识别'}{observation?.lastRecordId?' · 可在生活记录中查看':''}</Text>{observation?.stopReason?<Text style={ui.muted}>停止原因：{observation.stopReason}</Text>:null}<Action label="刷新状态" onPress={()=>{void life.refresh(true);}}/></View>
    <Feedback text={notice} error={error}/><Feedback text={life.error?.message??''} error/>
  </ScrollView>;
}
