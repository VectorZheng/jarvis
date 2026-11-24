import { MEMORY_LIMITS } from '../companion/contracts';
import type { ConfirmedPreference, MemoryRequestContext } from '../companion/contracts';
import { clone, exact, fail, isId, isInteger, isText, newId, points, requireTrue, SerialQueue } from '../companion/core';
import type { StringStorage } from '../companion/core';

export type MemoryMessage = { id:string; role:'user'|'assistant'; content:string; createdAt:number };
export type MessageInput = { id:string; role:'user'|'assistant'; content:string; createdAt?:number };
export type MemoryData = { schemaVersion:1; messages:MemoryMessage[]; preferences:ConfirmedPreference[] };
export type MemoryState = MemoryData & { ready:boolean };
export type PreparedMemory = { messages:MemoryMessage[]; memory:MemoryRequestContext };
export function boundedContext(messages:readonly MemoryMessage[],preferences:readonly ConfirmedPreference[]):PreparedMemory {
  const keptPreferences=clone(preferences.slice(-MEMORY_LIMITS.confirmedPreferences).map(preferenceFrom));
  let available=MEMORY_LIMITS.maxContextChars-keptPreferences.reduce((sum,p)=>sum+points(p.text),0);
  const kept:MemoryMessage[]=[];
  for(const message of messages.slice(-MEMORY_LIMITS.recentMessages).map(messageFrom).reverse()) {
    const size=points(message.content);requireTrue(size<=MEMORY_LIMITS.maxMessageChars,'INVALID_SCHEMA');
    if(size>available)break;kept.unshift(clone(message));available-=size;
  }
  return {messages:kept,memory:{schemaVersion:1,limits:{recentMessages:MEMORY_LIMITS.recentMessages,maxContextChars:MEMORY_LIMITS.maxContextChars,confirmedPreferences:MEMORY_LIMITS.confirmedPreferences},preferences:keptPreferences}};
}
function messageFrom(value:MessageInput):MemoryMessage {
  requireTrue(isId(value.id)&&['user','assistant'].includes(value.role)&&isText(value.content,MEMORY_LIMITS.maxMessageChars),'INVALID_SCHEMA');
  const createdAt=value.createdAt??Date.now();requireTrue(isInteger(createdAt),'INVALID_SCHEMA');
  return{id:value.id,role:value.role,content:value.content,createdAt};
}
function preferenceFrom(value:unknown):ConfirmedPreference {
  const p=exact(value,['id','text','sourceMessageId','createdAt','confirmedAt','status']);
  requireTrue(isId(p.id)&&isId(p.sourceMessageId)&&isText(p.text,240)&&isInteger(p.createdAt)&&isInteger(p.confirmedAt)&&p.confirmedAt>=p.createdAt&&p.status==='confirmed','INVALID_SCHEMA');
  return p as ConfirmedPreference;
}
/** 聊天/偏好是有限上下文，不读取也不上传生活数据库。 */
export class MemoryStore {
  private state:MemoryState={schemaVersion:1,ready:false,messages:[],preferences:[]};
  private listeners=new Set<()=>void>();private queue=new SerialQueue();
  private excluded=new Set<string>();private suppressAll=false;
  private readonly key='jarvis.memory.v1';
  constructor(private storage:StringStorage) {}
  getState=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  private publish(data:MemoryData){this.state={...clone(data),ready:true};for(const listener of this.listeners)listener();}
  private async persist(data:MemoryData){await this.storage.setItem(this.key,JSON.stringify(data));this.publish(data);}
  private async load(){
    if(this.state.ready)return;const raw=await this.storage.getItem(this.key);
    if(!raw){this.publish({schemaVersion:1,messages:[],preferences:[]});return;}
    let data:MemoryData;try{data=JSON.parse(raw);}catch{fail('STORAGE_FAILED');}
    requireTrue(data.schemaVersion===1&&Array.isArray(data.messages)&&Array.isArray(data.preferences),'STORAGE_FAILED');
    const messages=data.messages.slice(-20).map(messageFrom);const preferences=data.preferences.slice(-20).map(preferenceFrom);
    requireTrue(new Set(messages.map(m=>m.id)).size===messages.length&&new Set(preferences.map(p=>p.id)).size===preferences.length,'STORAGE_FAILED');
    this.publish({schemaVersion:1,messages,preferences});
  }
  initialize=()=>this.queue.run(()=>this.load());
  replaceMessages=(messages:readonly MessageInput[])=>this.queue.run(async()=>{
    await this.load();const selected=messages.slice(-20).map(value=>messageFrom({...value,createdAt:value.createdAt??this.state.messages.find(m=>m.id===value.id)?.createdAt}));
    requireTrue(new Set(selected.map(m=>m.id)).size===selected.length,'INVALID_SCHEMA');
    await this.persist({schemaVersion:1,messages:selected,preferences:this.state.preferences});
  });
  appendMessage=(message:MessageInput)=>this.queue.run(async()=>{
    await this.load();const value=messageFrom(message);const messages=[...this.state.messages.filter(m=>m.id!==value.id),value].slice(-20);
    await this.persist({schemaVersion:1,messages,preferences:this.state.preferences});
  });
  confirmPreference=(text:string,sourceMessageId:string,userConfirmed:boolean)=>this.queue.run(async()=>{
    await this.load();requireTrue(userConfirmed===true,'CONSENT_REQUIRED');requireTrue(isText(text.trim(),240));
    const source=this.state.messages.find(message=>message.id===sourceMessageId&&message.role==='user');requireTrue(source,'NOT_FOUND');
    requireTrue(this.state.preferences.length<20,'LIMIT_REACHED');
    const now=Date.now();const preference:ConfirmedPreference={id:newId('preference'),text:text.trim(),sourceMessageId,createdAt:Math.min(source.createdAt,now),confirmedAt:now,status:'confirmed'};
    await this.persist({schemaVersion:1,messages:this.state.messages,preferences:[...this.state.preferences,preference]});return clone(preference);
  });
  revokePreference=(id:string):Promise<void>=>{
    // 同步失效，甚至在持久化失败时也不再进入本会话后续请求。
    this.excluded.add(id);
    return this.queue.run(async()=>{await this.load();await this.persist({schemaVersion:1,messages:this.state.messages,preferences:this.state.preferences.filter(p=>p.id!==id)});});
  };
  clearPreferences=():Promise<void>=>{
    this.suppressAll=true;
    return this.queue.run(async()=>{await this.load();await this.persist({schemaVersion:1,messages:this.state.messages,preferences:[]});this.suppressAll=false;});
  };
  clearMessages=()=>this.queue.run(async()=>{await this.load();await this.persist({schemaVersion:1,messages:[],preferences:this.state.preferences});});
  context=()=>this.queue.run(async()=>{
    await this.load();const preferences=this.suppressAll?[]:this.state.preferences.filter(p=>!this.excluded.has(p.id));return boundedContext(this.state.messages,preferences);
  });
  /** 集成者在实际聊天请求前 await；失败时不能声称聊天已持久化。 */
  prepareTurn=async(messages:readonly MessageInput[])=>{await this.replaceMessages(messages);return this.context();};
}
