import type { CompanionError, CompanionState, LifeChange, LifeSnapshot, ObservationState } from './contracts';
import { clone, fail, requireTrue, safeError, SerialQueue, unwrap } from './core';
import type { CompanionAdapter } from './core';

/** 非权威 UI 投影；重复事件不会形成命令，也不会向任何数据库回写记录。 */
export function applyLifeChanges(snapshot: LifeSnapshot, changes: readonly LifeChange[]): LifeSnapshot {
  const next=clone(snapshot); const seen=new Set<string>();
  for(const event of changes) {
    if(event.revision<=next.revision || seen.has(event.eventId)) continue;
    requireTrue(event.schemaVersion===1 && event.revision===next.revision+1,'SNAPSHOT_REQUIRED');
    seen.add(event.eventId);
    const change=event.change;
    if(change.kind==='clear') next.records=[];
    if(change.kind==='delete') next.records=next.records.filter(record=>record.id!==change.recordId);
    if(change.kind==='upsert') {
      requireTrue(change.record.revision===event.revision,'INVALID_SCHEMA');
      next.records=next.records.filter(record=>record.id!==change.record.id);next.records.push(clone(change.record));
    }
    next.revision=event.revision;
  }
  return next;
}
export type ProjectionState = { snapshot: LifeSnapshot | null; loading: boolean; error: CompanionError | null };
export class LifeProjection {
  private value: ProjectionState={snapshot:null,loading:false,error:null};
  private listeners=new Set<()=>void>();
  private queue=new SerialQueue();
  private removers: (()=>void)[]=[];
  private consumers=0;
  private companionEvent:CompanionState|null=null;
  private observationEvent:ObservationState|null=null;
  constructor(readonly adapter:CompanionAdapter) {}
  getState=():ProjectionState=>this.value;
  subscribe=(listener:()=>void):(()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  private publish(value:ProjectionState){this.value=value;for(const listener of this.listeners)listener();}
  private async readSnapshot():Promise<LifeSnapshot>{
    const companionBefore=this.companionEvent;const observationBefore=this.observationEvent;
    const snapshot=unwrap(await this.adapter.getSnapshot());
    if(this.companionEvent!==companionBefore&&this.companionEvent)snapshot.companion=this.companionEvent;
    if(this.observationEvent!==observationBefore&&this.observationEvent)snapshot.observation=this.observationEvent;
    return snapshot;
  }
  connect=(): (()=>void) => {
    if(this.consumers++===0) {
      this.removers=[
        this.adapter.subscribe('onLifeChanges',()=>{void this.refresh();}),
        this.adapter.subscribe('onCompanionState',event=>{this.companionEvent=event.state;if(this.value.snapshot)this.publish({...this.value,snapshot:{...this.value.snapshot,companion:event.state}});}),
        this.adapter.subscribe('onObservationState',event=>{this.observationEvent=event.state;if(this.value.snapshot)this.publish({...this.value,snapshot:{...this.value.snapshot,observation:event.state}});}),
        this.adapter.subscribe('onCompanionError',event=>this.publish({...this.value,error:event.error})),
      ];
      void this.refresh(true);
    }
    let active=true;
    return()=>{if(!active)return;active=false;if(--this.consumers===0){this.removers.forEach(remove=>remove());this.removers=[];}};
  };
  refresh=(forceSnapshot=false):Promise<void>=>this.queue.run(async()=>{
    this.publish({...this.value,loading:true,error:null});
    try {
      if(forceSnapshot||!this.value.snapshot) this.publish({...this.value,snapshot:await this.readSnapshot()});
      let snapshot=this.value.snapshot!;
      for(let pages=0;pages<1000;pages++) {
        const result=await this.adapter.readChanges(snapshot.revision);
        if(!result.ok && result.error.code==='SNAPSHOT_REQUIRED') {snapshot=await this.readSnapshot();this.publish({...this.value,snapshot});continue;}
        const page=unwrap(result);
        requireTrue(page.afterRevision===snapshot.revision,'INVALID_REVISION');
        snapshot=applyLifeChanges(snapshot,page.changes);
        requireTrue(snapshot.revision===page.throughRevision,'SNAPSHOT_REQUIRED');
        if(!page.hasMore)break;
        if(!page.changes.length)fail('INVALID_SCHEMA');
      }
      snapshot={...snapshot,companion:this.value.snapshot?.companion??snapshot.companion,observation:this.value.snapshot?.observation??snapshot.observation};
      this.publish({snapshot,loading:false,error:null});
      // 先安装投影，再 ACK；ACK 失败仅重试游标，绝不重投业务命令。
      unwrap(await this.adapter.ackChanges(snapshot.revision));
    } catch(error) {this.publish({...this.value,loading:false,error:safeError(error)});}
  });
}
const projections=new WeakMap<CompanionAdapter,LifeProjection>();
export function getLifeProjection(adapter:CompanionAdapter):LifeProjection {
  let projection=projections.get(adapter);if(!projection){projection=new LifeProjection(adapter);projections.set(adapter,projection);}return projection;
}
