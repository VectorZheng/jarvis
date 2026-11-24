import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { points, safeError } from '../companion/core';
import { Action, Feedback, Field, SectionTitle, Toggle, ui } from '../companion/ui';
import { getMemoryStore } from './platform';
import type { MemoryStore } from './store';

export function MemoryPanel({store=getMemoryStore(),visible=true}:{store?:MemoryStore;visible?:boolean}) {
  const state=useSyncExternalStore(store.subscribe,store.getState,store.getState);
  const [text,setText]=useState('');const [source,setSource]=useState('');const [confirmed,setConfirmed]=useState(false);const [notice,setNotice]=useState('');const [error,setError]=useState(false);const [busy,setBusy]=useState(false);const [clear,setClear]=useState<'preferences'|'messages'|null>(null);
  useEffect(()=>{void store.initialize().catch(cause=>{setError(true);setNotice(safeError(cause).message);});},[store]);
  async function run(work:()=>Promise<unknown>,success:string){if(busy)return;setBusy(true);setNotice('');setError(false);try{await work();setNotice(success);}catch(cause){setError(true);setNotice(safeError(cause).message+' 若正在撤销，已从本会话后续偏好上下文排除；请重试以完成设备保存。');}finally{setBusy(false);}}
  if(!visible)return null;
  return <ScrollView testID="memory-panel" contentContainerStyle={ui.page} keyboardShouldPersistTaps="handled">
    <SectionTitle index="03" title="只记得，你允许的" subtitle="有限的记忆，不替你定义自己。"/>
    <View style={ui.row}><Text style={ui.badge}>{state.messages.length} / 20 条最近聊天</Text><Text style={ui.badge}>{state.preferences.length} / 20 条确认偏好</Text></View>
    <View style={ui.card}><Text style={ui.cardTitle}>留下一条偏好</Text><Text style={ui.muted}>先选择你说过的话作为来源，再编辑成明确偏好。不会从模型猜测自动保存；单条最多240个 Unicode 码点。</Text>
      {state.messages.filter(message=>message.role==='user').slice(-6).map(message=><View key={message.id} style={{gap:6}}><Text numberOfLines={2} style={ui.muted}>{message.content}</Text><Action label={source===message.id?'已选作来源':'选作来源'} primary={source===message.id} onPress={()=>{setSource(message.id);setConfirmed(false);}}/></View>)}
      {!state.messages.some(message=>message.role==='user')?<Text style={ui.muted}>还没有可选的用户聊天。聊过之后再回来确认。</Text>:null}
      <Field label="我明确希望记住的偏好" multiline value={text} onChangeText={value=>{setText(value);setConfirmed(false);}} placeholder="例如：我喜欢清淡一点的晚餐"/><Text style={ui.muted}>{points(text)} / 240</Text>
      <Toggle label="这是我的明确偏好，同意用于后续聊天" value={confirmed} onChange={setConfirmed}/><Action label="确认并保存偏好" primary disabled={busy||!state.ready||!source||!confirmed||points(text)>240||!text.trim()} onPress={()=>{void run(async()=>{await store.confirmPreference(text,source,confirmed);setText('');setConfirmed(false);},'偏好已保存；之后可随时撤销。');}}/>
    </View>
    {state.preferences.map(preference=><View key={preference.id} style={ui.card}><Text style={ui.body}>{preference.text}</Text><Text style={ui.muted}>明确确认于 {new Date(preference.confirmedAt).toLocaleString()}</Text><Text style={ui.muted}>来源消息：{preference.sourceMessageId} · 原消息时间 {new Date(preference.createdAt).toLocaleString()}</Text><Action label="撤销这条偏好" danger disabled={busy} onPress={()=>{void run(()=>store.revokePreference(preference.id),'偏好已撤销，不再进入后续请求上下文。');}}/></View>)}
    <View style={ui.card}><Text style={ui.cardTitle}>最近的对话</Text><Text style={ui.muted}>单条最多6000码点；消息与确认偏好总上下文最多16000码点，仅发送放得下的最近消息。不会附带完整生活库。</Text>{state.messages.map(message=><View key={message.id} style={{gap:5}}><Text style={ui.label}>{message.role==='user'?'你':'Jarvis'}</Text><Text style={ui.body}>{message.content}</Text></View>)}</View>
    <View style={ui.row}><Action label="清空确认偏好" danger disabled={busy} onPress={()=>setClear('preferences')}/><Action label="清空最近聊天" danger disabled={busy} onPress={()=>setClear('messages')}/></View>
    {clear?<View style={ui.card}><Text style={ui.body}>确定清空{clear==='preferences'?'所有确认偏好？后续请求立即不再使用。':'最近聊天？生活记录和确认偏好不会被一并删除。'}</Text><View style={ui.row}><Action label="确认清空" danger disabled={busy} onPress={()=>{const target=clear;setClear(null);void run(()=>target==='preferences'?store.clearPreferences():store.clearMessages(),'已完成清空。');}}/><Action label="取消" onPress={()=>setClear(null)}/></View></View>:null}
    <Feedback text={notice} error={error}/>
  </ScrollView>;
}
