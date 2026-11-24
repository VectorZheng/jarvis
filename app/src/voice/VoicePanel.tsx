import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { characterFeedback } from '../companion/hooks';
import type { CharacterFeedback } from '../companion/hooks';
import { Action, Feedback, Field, SectionTitle, Toggle, ui } from '../companion/ui';
import { points } from '../companion/core';
import type { SettingsStore } from '../settings/store';
import type { VoiceSend } from './controller';
import { useVoiceController } from './useVoiceController';

export type VoicePanelProps={onSend:VoiceSend;visible?:boolean;reduceMotion?:boolean;observing?:boolean;settings?:SettingsStore;onFeedback?:(feedback:CharacterFeedback)=>void;renderCharacter?:(feedback:CharacterFeedback)=>React.ReactNode};
export function VoicePanel({onSend,visible=true,reduceMotion=false,observing=false,settings,onFeedback,renderCharacter}:VoicePanelProps) {
  const {controller,state,active}=useVoiceController(onSend,visible,settings);const [reviewed,setReviewed]=useState(false);
  const feedback=characterFeedback({visible,foreground:active,reduceMotion,error:!!state.error,listening:state.characterState==='listening',thinking:state.characterState==='thinking',speaking:state.characterState==='speaking',observing});
  useEffect(()=>{onFeedback?.({state:feedback.state,active:feedback.active,reduceMotion:feedback.reduceMotion,animationAllowed:feedback.animationAllowed});},[onFeedback,feedback.state,feedback.active,feedback.reduceMotion,feedback.animationAllowed]);
  if(!visible)return null;
  const labels={idle:'准备好就说吧',preparing:'正在准备麦克风',recording:'正在听 · 最多60秒',transcribing:'正在转写 · 不会自动发送',review:'先检查，再发送',sending:'正在回应',speaking:'正在朗读',error:'可以继续用文字聊'};
  const recordingBusy=['preparing','recording','transcribing','sending','speaking'].includes(state.phase);
  return <View style={ui.page} testID="foreground-voice-panel">
    <SectionTitle index="04" title="说给我听" subtitle="只在你主动点击、页面可见时打开麦克风。"/>
    <View style={ui.card}>
      {renderCharacter?renderCharacter(feedback):<Text style={ui.eyebrow}>JARVIS / {feedback.state.toUpperCase()}</Text>}
      <Text accessibilityLiveRegion="polite" style={ui.cardTitle}>{labels[state.phase]}</Text>
      <Text style={ui.muted}>录音停止后上传到独立配置的 OpenAI STT，可能产生费用。一次录音只转写一次；检查文本后才发送一次聊天。离开页面或进入后台会停止录音、请求与朗读。</Text>
      <View style={ui.row}>
        {state.phase==='recording'?<Action label="结束录音并转写" primary testID="voice-finish-recording" onPress={()=>{void controller.finishRecording();}}/>:<Action label="同意上传并开始录音" primary disabled={!active||recordingBusy} testID="voice-start-recording" onPress={()=>{setReviewed(false);void controller.begin();}}/>}
        <Action label="取消并停止" testID="voice-cancel" onPress={()=>{setReviewed(false);void controller.cancel();}}/>
        <Action label="改用文字" disabled={state.phase==='sending'} onPress={()=>{setReviewed(false);void controller.useText();}}/>
      </View>
      <Feedback text={state.error?.message??''} error/>
      {state.error?<Text style={ui.muted}>缺少配置、权限拒绝或网络不可用时不会伪造转写；保留文字输入入口。</Text>:null}
    </View>
    <View style={ui.card}><Text style={ui.cardTitle}>你想说的是</Text><Field label="可编辑转写或文字" testID="voice-transcript" multiline editable={!recordingBusy&&!state.sent} value={state.transcript} onChangeText={text=>{setReviewed(false);controller.editTranscript(text);}} placeholder="转写完成后在这里核对，也可以直接输入…"/><Text style={ui.muted}>{points(state.transcript)} / 6000 码点</Text><Toggle label="我已检查文本，确认发送一次" value={reviewed} disabled={recordingBusy||state.sent} onChange={setReviewed}/><Action label="发送已检查的文本" primary testID="voice-send-reviewed" disabled={!active||state.phase!=='review'||state.sent||!reviewed||!state.transcript.trim()||points(state.transcript)>6000} onPress={()=>{void controller.sendReviewed();}}/></View>
    {state.reply?<View style={ui.card}><Text style={ui.eyebrow}>JARVIS / 回复</Text><Text style={ui.body}>{state.reply}</Text>{state.phase==='speaking'?<Action label="打断朗读" onPress={()=>{void controller.interruptSpeech();}}/>:null}</View>:null}
    <Text style={ui.muted}>系统 TTS 不等于云语音。iPhone 静音模式可能无声；不支持时保留文字回复。减少动态效果或不可见时，人物动画应由接线方暂停。</Text>
  </View>;
}
