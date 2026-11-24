import type { CharacterState, CompanionError } from '../companion/contracts';
import { fail, isText, safeError } from '../companion/core';
import type { AudioClip } from './transcription';

export type VoicePhase='idle'|'preparing'|'recording'|'transcribing'|'review'|'sending'|'speaking'|'error';
export type VoiceState={phase:VoicePhase;characterState:CharacterState;transcript:string;reply:string;error:CompanionError|null;generation:number;sent:boolean};
export type VoiceReply={reply:string;offline?:boolean};
/** onSend 必须尊重 signal；一次确认仅调用一次现有聊天，不在 controller 内重试。 */
export type VoiceSend=(text:string,options:{signal:AbortSignal;source:'manual_voice'|'manual_text'})=>Promise<VoiceReply>;
export type VoicePorts={
  preflight():Promise<void>;
  recorder:{start(signal:AbortSignal,onStopped?:(error?:CompanionError)=>void):Promise<void>;stop():Promise<AudioClip>;cancel():Promise<void>};
  transcribe(clip:AudioClip,signal:AbortSignal):Promise<string>;
  send:VoiceSend;
  speech:{speak(text:string,signal:AbortSignal,onStart:()=>void):Promise<void>;stop():Promise<void>};
};
export class VoiceController {
  private state:VoiceState={phase:'idle',characterState:'idle',transcript:'',reply:'',error:null,generation:0,sent:false};
  private listeners=new Set<()=>void>();private controller:AbortController|null=null;private active=false;private generation=0;
  private stopTimer:ReturnType<typeof setTimeout>|null=null;private cleanup:Promise<void>=Promise.resolve();
  private source:'manual_voice'|'manual_text'='manual_text';
  private recordingEnded=false;
  constructor(private ports:VoicePorts) {}
  getState=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  private update(patch:Partial<VoiceState>){this.state={...this.state,...patch,generation:this.generation};for(const listener of this.listeners)listener();}
  private current(generation:number){return this.active&&generation===this.generation&&!this.controller?.signal.aborted;}
  setActive=(active:boolean)=>{this.active=active;if(!active)void this.cancel();};
  private clearTimer(){if(this.stopTimer!==null)clearTimeout(this.stopTimer);this.stopTimer=null;}
  cancel=():Promise<void>=>{
    this.generation++;this.controller?.abort();this.clearTimer();this.controller=null;
    this.update({phase:'idle',characterState:'idle',error:null,sent:false});
    this.cleanup=this.cleanup.then(async()=>{await Promise.allSettled([this.ports.recorder.cancel(),this.ports.speech.stop()]);});return this.cleanup;
  };
  begin=async():Promise<void>=>{
    if(!this.active){this.update({phase:'error',characterState:'error',error:safeError(undefined,'NOT_FOREGROUND')});return;}
    if(['preparing','recording','transcribing','sending'].includes(this.state.phase))return;
    const cleanup=this.cancel();
    const generation=++this.generation;const controller=new AbortController();this.controller=controller;this.source='manual_voice';this.recordingEnded=false;
    this.update({phase:'preparing',characterState:'idle',transcript:'',reply:'',error:null,sent:false});
    try {
      await cleanup;if(!this.current(generation))return;
      await this.ports.preflight();if(!this.current(generation))return;
      await this.ports.recorder.start(controller.signal,error=>{
        if(!this.current(generation)||!['preparing','recording'].includes(this.state.phase))return;
        if(error){void this.cancel();this.update({phase:'error',characterState:'error',error});}
        else {this.recordingEnded=true;if(this.state.phase==='recording')void this.finishRecording();}
      });if(!this.current(generation))return;
      this.update({phase:'recording',characterState:'listening'});
      if(this.recordingEnded)await this.finishRecording();
      else this.stopTimer=setTimeout(()=>{void this.finishRecording();},59000);
    } catch(error) {if(this.current(generation)){await this.ports.recorder.cancel();if(this.current(generation))this.update({phase:'error',characterState:'error',error:safeError(error,'PERMISSION_DENIED')});}}
  };
  finishRecording=async():Promise<void>=>{
    if(this.state.phase!=='recording'||!this.active)return;const generation=this.generation;const signal=this.controller!.signal;
    this.clearTimer();this.update({phase:'transcribing',characterState:'thinking'});
    try {
      const clip=await this.ports.recorder.stop();if(!this.current(generation))return;
      const text=await this.ports.transcribe(clip,signal);if(!this.current(generation))return;
      if(!isText(text,6000))fail('INVALID_SCHEMA');
      this.update({phase:'review',characterState:'idle',transcript:text,error:null,sent:false});
    }catch(error){if(this.current(generation))this.update({phase:'error',characterState:'error',error:safeError(error,'NETWORK_UNAVAILABLE')});}
  };
  editTranscript=(text:string)=>{
    if(['recording','preparing','transcribing','sending','speaking'].includes(this.state.phase))return;
    if(this.state.sent)return;
    this.update({transcript:text,phase:'review',characterState:'idle',error:null});
  };
  useText=async()=>{const cleanup=this.cancel();const generation=this.generation;await cleanup;if(generation!==this.generation||!this.active)return;this.source='manual_text';this.update({phase:'review',sent:false});};
  sendReviewed=async():Promise<void>=>{
    if(!this.active||this.state.phase!=='review'||this.state.sent)return;
    if(!isText(this.state.transcript,6000)){this.update({error:safeError(undefined,'INVALID_REQUEST')});return;}
    const generation=++this.generation;this.controller?.abort();const controller=new AbortController();this.controller=controller;
    this.update({phase:'sending',characterState:'thinking',sent:true,error:null});
    try {
      const reply=await this.ports.send(this.state.transcript.trim(),{signal:controller.signal,source:this.source});if(!this.current(generation))return;
      if(!isText(reply.reply,6000))fail('INVALID_SCHEMA');
      const text=reply.offline&&!reply.reply.startsWith('（离线）')?'（离线）'+reply.reply:reply.reply;
      this.update({reply:text,characterState:'idle'});
      await this.ports.speech.speak(text,controller.signal,()=>{if(this.current(generation))this.update({phase:'speaking',characterState:'speaking'});});
      if(this.current(generation))this.update({phase:'idle',characterState:'idle'});
    }catch(error){if(this.current(generation))this.update({phase:'error',characterState:'error',error:safeError(error,'NETWORK_UNAVAILABLE')});}
  };
  interruptSpeech=async()=>{if(this.state.phase==='speaking'||this.state.sent)await this.cancel();};
  dispose=()=>{this.active=false;void this.cancel();this.listeners.clear();};
}
