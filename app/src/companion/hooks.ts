import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { CharacterState } from './contracts';
import type { CompanionAdapter } from './core';
import { getLifeProjection } from './projection';
import { getCompanionAdapter } from './platform';

const subscribeAppState=(listener:()=>void)=>{const sub=AppState.addEventListener('change',listener);return()=>sub.remove();};
const getForeground=()=>AppState.currentState==='active';
export function useForeground(visible=true):boolean {return useSyncExternalStore(subscribeAppState,getForeground,()=>false)&&visible;}
export function useLifeProjection(adapter:CompanionAdapter=getCompanionAdapter(),visible=true) {
  const projection=getLifeProjection(adapter);const active=useForeground(visible);
  const state=useSyncExternalStore(projection.subscribe,projection.getState,projection.getState);
  useEffect(()=>active?projection.connect():undefined,[projection,active]);
  useEffect(()=>{
    if(!active)return;
    const timer=setInterval(()=>{void adapter.refreshTimers().catch(()=>projection.refresh());},1000);
    return()=>clearInterval(timer);
  },[adapter,projection,active]);
  return {...state,refresh:projection.refresh};
}
export type CharacterFeedback = { state:CharacterState; active:boolean; reduceMotion:boolean; animationAllowed:boolean };
export function characterFeedback(input:{visible:boolean;foreground:boolean;reduceMotion:boolean;error?:boolean;listening?:boolean;speaking?:boolean;thinking?:boolean;observing?:boolean}):CharacterFeedback {
  const active=input.visible&&input.foreground;
  const state:CharacterState=input.error?'error':active&&input.listening?'listening':active&&input.speaking?'speaking':active&&input.thinking?'thinking':input.observing?'observing':'idle';
  return {state,active,reduceMotion:input.reduceMotion,animationAllowed:active&&!input.reduceMotion};
}
