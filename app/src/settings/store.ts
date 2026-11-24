import { DEFAULT_CHAT_PROVIDER, DEFAULT_STT_PROVIDER, OBSERVATION_DEFAULTS, VISION_PRESETS } from '../companion/contracts';
import type { ChatProviderConfig, CloudVisionConsent, CredentialBinding, ObservationConfig, ObservationStopReason, ObservationTaskMode, ProviderConfig, RequestProvider, SttProviderConfig, VisionProviderConfig } from '../companion/contracts';
import { canonical, clone, fail, isId, isInteger, newId, requireTrue, SerialQueue, unwrap } from '../companion/core';
import type { CompanionAdapter, StringStorage } from '../companion/core';
import { checkProvider, trustedOrigin, validateCredentials, validateProvider } from './transport';
import type { ProviderCheckSender, TrustedBackend } from './transport';

export type CredentialSlot = 'chat' | 'stt' | 'vision';
export interface CredentialVault { read(slot:CredentialSlot):Promise<string|null>; write(slot:CredentialSlot,value:string):Promise<void>; remove(slot:CredentialSlot):Promise<void> }
export type ProviderSettings = {
  schemaVersion:1; backend:TrustedBackend; chat:ChatProviderConfig; stt:SttProviderConfig; vision:VisionProviderConfig;
  bindings:Record<CredentialSlot,CredentialBinding>;
  reuseChatKeyAcceptedAt:number|null; cloudConsent:CloudVisionConsent|null;
  autoConfirmExpensesAcceptedAt:number|null; taskMode:ObservationTaskMode; foodContextId:string;
};
export type SettingsState = { ready:boolean; settings:ProviderSettings };
function defaults():ProviderSettings {
  return {schemaVersion:1,backend:{origin:'',confirmed:false},chat:{...DEFAULT_CHAT_PROVIDER},stt:{...DEFAULT_STT_PROVIDER},vision:{...VISION_PRESETS.qwen},bindings:{chat:{credentialId:newId('chat'),credentialRevision:1},stt:{credentialId:newId('stt'),credentialRevision:1},vision:{credentialId:newId('vision'),credentialRevision:1}},reuseChatKeyAcceptedAt:null,cloudConsent:null,autoConfirmExpensesAcceptedAt:null,taskMode:'mixed',foodContextId:newId('fridge')};
}
/** 普通配置不含 Key；凭据带 revision 存在保险库，崩溃在任一步都不会复用失效 Key。 */
export class SettingsStore {
  private state:SettingsState={ready:false,settings:defaults()};
  private listeners=new Set<()=>void>();
  private queue=new SerialQueue();
  private readonly key='jarvis.providers.v1';
  private observationEpoch=0;
  constructor(private storage:StringStorage,private vault:CredentialVault,readonly adapter:CompanionAdapter,private foreground:()=>boolean=()=>true,private sendCheck:ProviderCheckSender=fetch) {}
  getState=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  private publish(settings:ProviderSettings){this.state={ready:true,settings};for(const listener of this.listeners)listener();}
  private async persist(settings:ProviderSettings){await this.storage.setItem(this.key,JSON.stringify(settings));this.publish(settings);}
  private async load() {
    if(this.state.ready)return;
    const raw=await this.storage.getItem(this.key);
    if(!raw){await this.persist(this.state.settings);return;}
    let saved:ProviderSettings;
    try{saved=JSON.parse(raw) as ProviderSettings;}catch{fail('STORAGE_FAILED');}
    requireTrue(saved.schemaVersion===1 && !!saved.bindings && !!saved.backend && isId(saved.foodContextId),'STORAGE_FAILED');
    validateProvider(saved.chat);validateProvider(saved.stt);validateProvider(saved.vision);
    for(const slot of ['chat','stt','vision'] as const)requireTrue(isId(saved.bindings[slot]?.credentialId)&&isInteger(saved.bindings[slot]?.credentialRevision,1),'STORAGE_FAILED');
    // 只按白名单恢复，不接受注入的凭据或额外字段。
    this.publish({schemaVersion:1,backend:{origin:saved.backend.origin,confirmed:saved.backend.confirmed===true},chat:clone(saved.chat),stt:clone(saved.stt),vision:clone(saved.vision),bindings:clone(saved.bindings),reuseChatKeyAcceptedAt:isInteger(saved.reuseChatKeyAcceptedAt)?saved.reuseChatKeyAcceptedAt:null,cloudConsent:saved.cloudConsent,autoConfirmExpensesAcceptedAt:isInteger(saved.autoConfirmExpensesAcceptedAt)?saved.autoConfirmExpensesAcceptedAt:null,taskMode:['food','expense','mixed'].includes(saved.taskMode)?saved.taskMode:'mixed',foodContextId:saved.foodContextId});
  }
  initialize=()=>this.queue.run(()=>this.load());
  private async stopBeforeChange(cleared=false) {
    this.observationEpoch++;
    const result=await this.adapter.stopObservation(cleared?'credentials_cleared':'credentials_changed');
    if(!result.ok) {
      const capabilities=unwrap(await this.adapter.getCapabilities());
      if(result.error.code!=='UNSUPPORTED'||capabilities.screenObservation)fail(result.error.code);
    }
  }
  saveKey=(slot:CredentialSlot,apiKey:string)=>this.queue.run(async()=>{
    await this.load();requireTrue(this.foreground(),'NOT_FOREGROUND');
    validateCredentials({...this.state.settings.bindings[slot],apiKey});
    await this.stopBeforeChange();
    const next=clone(this.state.settings);next.bindings[slot].credentialRevision++;next.cloudConsent=null;
    await this.persist(next);
    await this.vault.write(slot,JSON.stringify({...next.bindings[slot],apiKey}));
  });
  clearKey=(slot:CredentialSlot)=>this.queue.run(async()=>{
    await this.load();await this.stopBeforeChange(true);
    const next=clone(this.state.settings);next.bindings[slot].credentialRevision++;next.cloudConsent=null;
    if(slot==='chat')next.reuseChatKeyAcceptedAt=null;
    await this.persist(next);await this.vault.remove(slot);
  });
  private async request<P extends ProviderConfig>(provider:P):Promise<RequestProvider<P>> {
    requireTrue(this.foreground(),'NOT_FOREGROUND');trustedOrigin(this.state.settings.backend);validateProvider(provider);
    const slot:CredentialSlot=provider.purpose==='vision' ? provider.credentialSource : provider.purpose;
    if(provider.purpose==='vision' && provider.credentialSource==='chat')requireTrue(this.state.settings.reuseChatKeyAcceptedAt!==null,'CONSENT_REQUIRED');
    const raw=await this.vault.read(slot);requireTrue(raw,'AUTH_REQUIRED');
    let credentials;
    try{credentials=JSON.parse(raw);}catch{fail('AUTH_REQUIRED');}
    validateCredentials(credentials);
    requireTrue(canonical({credentialId:credentials.credentialId,credentialRevision:credentials.credentialRevision})===canonical(this.state.settings.bindings[slot]),'AUTH_REQUIRED');
    return {provider:clone(provider),credentials};
  }
  getRequestProvider<P extends CredentialSlot>(purpose:P):Promise<RequestProvider<Extract<ProviderConfig,{purpose:P}>>> {
    return this.queue.run(async()=>{await this.load();return this.request(this.state.settings[purpose]) as unknown as Promise<RequestProvider<Extract<ProviderConfig,{purpose:P}>>>;});
  }
  hasKey=(slot:CredentialSlot)=>this.queue.run(async()=>{
    await this.load();const raw=await this.vault.read(slot);if(!raw)return false;
    try{const c=JSON.parse(raw);validateCredentials(c);const b=this.state.settings.bindings[slot];return c.credentialId===b.credentialId&&c.credentialRevision===b.credentialRevision;}catch{return false;}
  });
  setBackend=(origin:string,confirmed:boolean)=>this.queue.run(async()=>{
    await this.load();const backend={origin:origin.trim().replace(/\/$/,''),confirmed};trustedOrigin(backend);
    await this.stopBeforeChange();await this.persist({...clone(this.state.settings),backend,cloudConsent:null});
  });
  setProvider=(provider:ProviderConfig)=>this.queue.run(async()=>{
    await this.load();validateProvider(provider);await this.stopBeforeChange();
    const next=clone(this.state.settings);
    if(provider.purpose==='chat')next.chat=clone(provider);
    if(provider.purpose==='stt')next.stt=clone(provider);
    if(provider.purpose==='vision') {next.vision=clone(provider);next.reuseChatKeyAcceptedAt=null;}
    next.cloudConsent=null;await this.persist(next);
  });
  acceptChatKeyReuse=(accepted:boolean)=>this.queue.run(async()=>{
    await this.load();await this.stopBeforeChange();await this.persist({...clone(this.state.settings),reuseChatKeyAcceptedAt:accepted?Date.now():null,cloudConsent:null});
  });
  setAutoConfirmExpenses=(accepted:boolean)=>this.queue.run(async()=>{
    await this.load();await this.stopBeforeChange();await this.persist({...clone(this.state.settings),autoConfirmExpensesAcceptedAt:accepted?Date.now():null});
  });
  setTaskMode=(taskMode:ObservationTaskMode)=>this.queue.run(async()=>{
    requireTrue(['food','expense','mixed'].includes(taskMode));await this.load();await this.stopBeforeChange();await this.persist({...clone(this.state.settings),taskMode});
  });
  acceptCloudVision=()=>this.queue.run(async()=>{
    await this.load();const s=this.state.settings;const origin=trustedOrigin(s.backend);
    requireTrue(s.vision.credentialSource!=='chat'||s.reuseChatKeyAcceptedAt!==null,'CONSENT_REQUIRED');
    await this.persist({...clone(s),cloudConsent:{accepted:true,acceptedAt:Date.now(),provider:clone(s.vision),backendOrigin:origin,reuseChatKeyAccepted:s.vision.credentialSource==='chat'}});
  });
  check=async(purpose:CredentialSlot,signal?:AbortSignal)=>{
    const request=await this.getRequestProvider(purpose);return checkProvider(this.state.settings.backend,request,signal,this.sendCheck);
  };
  startObservation=()=>{
    const epoch=this.observationEpoch;
    return this.queue.run(async()=>{
    await this.load();requireTrue(this.foreground(),'NOT_FOREGROUND');requireTrue(epoch===this.observationEpoch,'CANCELLED');const s=this.state.settings;
    requireTrue(s.cloudConsent && s.cloudConsent.backendOrigin===s.backend.origin && canonical(s.cloudConsent.provider)===canonical(s.vision),'CONSENT_REQUIRED');
    const request=await this.request(s.vision);
    const config:ObservationConfig={schemaVersion:1,backendOrigin:trustedOrigin(s.backend),provider:clone(s.vision),credentialBinding:{credentialId:request.credentials.credentialId,credentialRevision:request.credentials.credentialRevision},taskMode:s.taskMode,cloudConsent:clone(s.cloudConsent),autoConfirmExpenses:s.autoConfirmExpensesAcceptedAt!==null,autoConfirmExpensesAcceptedAt:s.autoConfirmExpensesAcceptedAt,budget:{sessionDurationMs:OBSERVATION_DEFAULTS.sessionDurationMs,maxSessionAttempts:OBSERVATION_DEFAULTS.maxSessionAttempts,maxDailyAttempts:OBSERVATION_DEFAULTS.maxDailyAttempts},budgetAcceptedAt:null,foodContextId:s.foodContextId};
    return {config,credentials:request.credentials};
    }).then(async({config,credentials})=>{
      requireTrue(epoch===this.observationEpoch,'CANCELLED');requireTrue(this.foreground(),'NOT_FOREGROUND');
      return unwrap(await this.adapter.startObservation(config,credentials));
    });
  };
  stopObservation=async(reason:ObservationStopReason='user')=>{
    this.observationEpoch++;
    return unwrap(await this.adapter.stopObservation(reason));
  };
  stopAll=async()=>{
    this.observationEpoch++;
    const observation=await this.adapter.stopObservation('stop_all');
    const companion=await this.adapter.stopCompanion('stop_all');
    unwrap(observation);unwrap(companion);
  };
}
