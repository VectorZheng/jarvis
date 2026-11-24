import { COMPANION_LIMITS } from '../companion/contracts';
import type { CompanionError } from '../companion/contracts';
import { fail, requireTrue, safeError, SerialQueue } from '../companion/core';
import type { VoicePorts } from './controller';
import { validateAudioClip } from './transcription';
import type { AudioClip } from './transcription';

export type NativeRecordingStatus = { isFinished:boolean; hasError:boolean; mediaServicesDidReset?:boolean };
export interface NativeRecordingResource {
  readonly isRecording:boolean;
  readonly uri:string|null;
  prepareToRecordAsync():Promise<void>;
  record(options:{forDuration:number}):void;
  stop():Promise<void>;
  release():void;
  addListener(name:'recordingStatusUpdate',listener:(status:NativeRecordingStatus)=>void):{remove():void};
}
export type NativeRecordingEnvironment = {
  requestPermission():Promise<{granted:boolean}>;
  isForeground():boolean;
  setRecordingMode(enabled:boolean):Promise<void>;
  createRecorder():NativeRecordingResource;
  readBytes(uri:string):Promise<Uint8Array>;
  discard(uri:string):void;
};
type RecordingSession = {
  generation:number; signal:AbortSignal; resource:NativeRecordingResource;
  prepared:boolean; recording:boolean; released:boolean; lastUri:string|null;
  abort:()=>void;
  subscription:{remove():void}|null;
  onStopped:((error?:CompanionError)=>void)|null;
};

// Expo 自动停止会清零运行时长；从本地 M4A 的 moov/mvhd 读取实际容器时长，不猜填上限。
function recordingDuration(bytes:Uint8Array):number {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const uint64=(offset:number)=>view.getUint32(offset)*2**32+view.getUint32(offset+4);
  const find=(start:number,end:number,type:string):{start:number;end:number}|null=>{
    for(let offset=start;offset<end;) {
      requireTrue(offset+8<=end,'INVALID_SCHEMA');
      let size=view.getUint32(offset);let header=8;
      const name=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
      if(size===1){requireTrue(offset+16<=end,'INVALID_SCHEMA');size=uint64(offset+8);header=16;}
      else if(size===0)size=end-offset;
      requireTrue(Number.isSafeInteger(size)&&size>=header&&size<=end-offset,'INVALID_SCHEMA');
      if(name===type)return {start:offset+header,end:offset+size};
      offset+=size;
    }
    return null;
  };
  const movie=find(0,bytes.byteLength,'moov');requireTrue(movie,'INVALID_SCHEMA');
  const header=find(movie.start,movie.end,'mvhd');requireTrue(header&&header.start+4<=header.end,'INVALID_SCHEMA');
  const version=view.getUint8(header.start);requireTrue(version===0||version===1,'INVALID_SCHEMA');
  requireTrue(header.start+(version===0?100:112)<=header.end,'INVALID_SCHEMA');
  const scale=view.getUint32(header.start+(version===0?12:20));
  const ticks=version===0?view.getUint32(header.start+16):uint64(header.start+24);
  requireTrue(scale>0&&Number.isSafeInteger(ticks)&&ticks>0,'INVALID_SCHEMA');
  const durationMs=ticks/scale*1000;
  requireTrue(durationMs>0&&durationMs<=COMPANION_LIMITS.maxAudioDurationMs);
  return Math.round(durationMs);
}

type RecorderPort = VoicePorts['recorder'];
/** 每次录音独立持有资源；React 只消费 controller，不持有异步可变闭包或 ref。 */
export class NativeRecorderAdapter implements RecorderPort {
  private queue=new SerialQueue();
  private generation=0;
  private session:RecordingSession|null=null;
  constructor(private environment:NativeRecordingEnvironment) {}

  private check(generation:number,signal:AbortSignal) {
    if(signal.aborted||generation!==this.generation)fail('CANCELLED');
    requireTrue(this.environment.isForeground(),'NOT_FOREGROUND');
  }
  private detach(session:RecordingSession) {
    session.onStopped=null;
    session.subscription?.remove();session.subscription=null;
    session.signal.removeEventListener('abort',session.abort);
  }
  private async stopResource(session:RecordingSession) {
    this.detach(session);
    try {
      if(session.resource.isRecording||session.prepared)await session.resource.stop();
    } finally {session.recording=false;session.prepared=false;}
  }
  private async disposeSession(session:RecordingSession) {
    if(session.released)return;
    try {await this.stopResource(session);}
    finally {
      try {session.lastUri=session.lastUri??session.resource.uri;}
      finally {
        session.released=true;
        try {session.resource.release();}
        finally {
          try {if(session.lastUri)this.environment.discard(session.lastUri);}
          finally {
            session.lastUri=null;
            if(this.session===session)this.session=null;
            await this.environment.setRecordingMode(false);
          }
        }
      }
    }
  }
  private status(session:RecordingSession,status:NativeRecordingStatus) {
    if(this.session!==session||session.generation!==this.generation||session.signal.aborted||!session.recording)return;
    if(!status.isFinished&&!status.hasError&&!status.mediaServicesDidReset)return;
    const callback=session.onStopped;
    this.detach(session);
    if(status.isFinished){session.recording=false;session.prepared=false;}
    const error=status.hasError||status.mediaServicesDidReset?safeError(undefined,'PERMISSION_DENIED'):undefined;
    if(error)void this.cancel().catch(()=>undefined);
    callback?.(error);
  }
  start=(signal:AbortSignal,onStopped?:((error?:CompanionError)=>void)):Promise<void>=>{
    const generation=this.generation;
    return this.queue.run(async()=>{
      this.check(generation,signal);requireTrue(!this.session,'ALREADY_RUNNING');
      const permission=await this.environment.requestPermission();
      this.check(generation,signal);requireTrue(permission.granted,'PERMISSION_DENIED');
      try {
        await this.environment.setRecordingMode(true);this.check(generation,signal);
        const session:RecordingSession={generation,signal,resource:this.environment.createRecorder(),prepared:false,recording:false,released:false,lastUri:null,subscription:null,onStopped:onStopped??null,abort:()=>{void this.cancel().catch(()=>undefined);}};
        this.session=session;
        signal.addEventListener('abort',session.abort,{once:true});
        session.subscription=session.resource.addListener('recordingStatusUpdate',status=>this.status(session,status));
        await session.resource.prepareToRecordAsync();session.prepared=true;this.check(generation,signal);
        session.recording=true;
        session.resource.record({forDuration:COMPANION_LIMITS.maxAudioDurationMs/1000});
      } catch(error) {
        if(this.session)await this.disposeSession(this.session);
        else await this.environment.setRecordingMode(false);
        throw error;
      }
    });
  };
  stop=():Promise<AudioClip>=>this.queue.run(async()=>{
    const session=this.session;requireTrue(session,'INVALID_REQUEST');
    let clip:AudioClip;
    try {
      this.check(session.generation,session.signal);
      await this.stopResource(session);session.lastUri=session.resource.uri;
      this.check(session.generation,session.signal);requireTrue(session.lastUri,'INVALID_REQUEST');
      const bytes=await this.environment.readBytes(session.lastUri);
      this.check(session.generation,session.signal);
      requireTrue(bytes.byteLength<=COMPANION_LIMITS.maxAudioBytes,'PAYLOAD_TOO_LARGE');
      clip={bytes,filename:'recording.m4a',mimeType:'audio/mp4',durationMs:recordingDuration(bytes)};
      validateAudioClip(clip);
    } finally {await this.disposeSession(session);}
    this.check(session.generation,session.signal);return clip;
  });
  cancel=():Promise<void>=>{
    this.generation++;
    if(this.session)this.detach(this.session);
    return this.queue.run(async()=>{if(this.session)await this.disposeSession(this.session);});
  };
}
