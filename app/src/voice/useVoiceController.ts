import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import * as Speech from 'expo-speech';
import { fail } from '../companion/core';
import { useForeground } from '../companion/hooks';
import type { SettingsStore } from '../settings/store';
import { getSettingsStore } from '../settings/platform';
import { transcribeAudio } from './transcription';
import { VoiceController } from './controller';
import { NativeRecorderAdapter } from './nativeRecorder';
import { createNativeRecordingEnvironment } from './nativeRecorderFactory';
import type { VoiceSend } from './controller';
import { createWebRecorder } from './webRecorder';

async function speak(text:string,signal:AbortSignal,onStart:()=>void):Promise<void> {
  await Speech.stop();if(signal.aborted)fail('CANCELLED');
  const max=Math.min(2500,Speech.maxSpeechInputLength);const chunks:string[]=[];
  let chunk='';for(const point of Array.from(text)){if(chunk.length+point.length>max){chunks.push(chunk);chunk='';}chunk+=point;}if(chunk)chunks.push(chunk);
  for(const part of chunks) {
    if(signal.aborted)fail('CANCELLED');
    await new Promise<void>((resolve,reject)=>{
      let settled=false;const finish=(error=false)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);if(error){try{fail(signal.aborted?'CANCELLED':'UNSUPPORTED');}catch(cause){reject(cause);}}else resolve();};
      const abort=()=>{void Speech.stop();finish(true);};signal.addEventListener('abort',abort,{once:true});
      Speech.speak(part,{language:'zh-CN',onStart:()=>{if(!signal.aborted)onStart();},onDone:()=>finish(),onStopped:()=>finish(signal.aborted),onError:()=>finish(true)});
    });
  }
}
function createController(onSend:VoiceSend,settings:SettingsStore):VoiceController {
  return new VoiceController({
    preflight:async()=>{await settings.getRequestProvider('stt');},
    recorder:Platform.OS==='web'?createWebRecorder():new NativeRecorderAdapter(createNativeRecordingEnvironment()),
    transcribe:async(clip,signal)=>{
      const request=await settings.getRequestProvider('stt');if(signal.aborted)fail('CANCELLED');
      return transcribeAudio(settings.getState().settings.backend,request,clip,signal,expoFetch);
    },
    send:onSend,speech:{speak,stop:Speech.stop},
  });
}
/** onSend 应由集成层 useCallback 稳定提供，不能在 render 中重建 controller。 */
export function useVoiceController(onSend:VoiceSend,visible=true,settings:SettingsStore=getSettingsStore()) {
  const active=useForeground(visible);
  const controller=useMemo(()=>createController(onSend,settings),[onSend,settings]);
  const state=useSyncExternalStore(controller.subscribe,controller.getState,controller.getState);
  useEffect(()=>{controller.setActive(active);return()=>controller.setActive(false);},[controller,active]);
  useEffect(()=>()=>controller.dispose(),[controller]);
  return {controller,state,active};
}
