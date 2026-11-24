import { COMPANION_LIMITS, OBSERVATION_DEFAULTS } from './contracts';
import type { BridgeResult, CommandReceipt, CompanionState, LifeChange, LifeRecord, LifeRecordBase, NativeEventMap, NativeEventName, ObservationState, PomodoroLifeRecord } from './contracts';
import { canonical, clone, CompanionFailure, digest, fail, failure, isInteger, newId, ok, requireTrue, SerialQueue } from './core';
import type { CompanionAdapter, StringStorage } from './core';
import { validateCommand, validateTarget } from './commands';

export type LocalClock = { bootId: string; wall(): number; monotonic(): number };
export const stoppedCompanion = (): CompanionState => ({ running: false, characterState: 'idle', overlayVisible: false });
export const stoppedObservation = (): ObservationState => ({
  state:'stopped', session:null, generation:1, stopReason:null, lastObservationAt:null, lastRecordId:null,
  counters:{ sessionAttempts:0, dailyAttempts:0, consecutiveFailures:0, sessionLimit:OBSERVATION_DEFAULTS.maxSessionAttempts, dailyLimit:OBSERVATION_DEFAULTS.maxDailyAttempts, sessionEndsAt:null, dailyBucket:new Date().toISOString().slice(0,10) },
});
type StoredState = {
  schemaVersion: 1; revision: number; ack: number; floor: number; records: LifeRecord[]; changes: LifeChange[];
  operations: Record<string, { hash: string; receipt: CommandReceipt }>;
};
const empty = (): StoredState => ({ schemaVersion:1, revision:0, ack:0, floor:0, records:[], changes:[], operations:{} });
export function timerElapsed(record: PomodoroLifeRecord, clock: LocalClock): number {
  if (record.timerState !== 'running' || record.clock.bootId !== clock.bootId) return record.clock.elapsedActiveMs;
  return Math.min(record.durationMs, record.clock.elapsedActiveMs + Math.max(0, Math.floor(clock.monotonic() - record.clock.anchorMonotonicMs)));
}
/** 仅 Web/iOS 的本地权威。Android 不得实例化它。单份持久对象提交成功后才替换内存状态。 */
export function createLocalFallback(storage: StringStorage, runtime: 'web' | 'ios', options: { clock?: LocalClock; id?: (prefix: string) => string; storageKey?: string } = {}): CompanionAdapter {
  const queue = new SerialQueue();
  const clock: LocalClock = options.clock ?? { bootId:newId('page'), wall:()=>Date.now(), monotonic:()=>Math.floor(performance.now()) };
  const id = options.id ?? newId;
  const key = options.storageKey ?? `jarvis.life.local.${runtime}.v1`;
  let state: StoredState | null = null;
  const listeners = new Map<NativeEventName, Set<(event: never) => void>>();
  const emit = <K extends NativeEventName>(name: K, event: NativeEventMap[K]) => {
    for (const listener of listeners.get(name) ?? []) { try { listener(event as never); } catch { /* UI 回调不能回滚持久化事务。 */ } }
  };
  async function load(): Promise<StoredState> {
    if (state) return state;
    const raw = await storage.getItem(key);
    if (!raw) { state = empty(); return state; }
    let parsed: StoredState;
    try { parsed = JSON.parse(raw) as StoredState; } catch { fail('STORAGE_FAILED'); }
    requireTrue(parsed.schemaVersion === 1 && isInteger(parsed.revision) && isInteger(parsed.ack) && isInteger(parsed.floor) && parsed.ack <= parsed.revision && parsed.floor <= parsed.revision && Array.isArray(parsed.records) && Array.isArray(parsed.changes) && !!parsed.operations, 'STORAGE_FAILED');
    requireTrue(parsed.records.every(record => record.schemaVersion === 1 && isInteger(record.revision) && record.revision <= parsed.revision), 'STORAGE_FAILED');
    state = parsed; return state;
  }
  async function commit(next: StoredState, events: LifeChange[] = []) {
    await storage.setItem(key, JSON.stringify(next)); state = next;
    for (const event of events) emit('onLifeChanges', { schemaVersion:1, emittedAt:clock.wall(), revision:event.revision, eventId:event.eventId });
  }
  function event(next: StoredState, opId: string, change: LifeChange['change']): LifeChange {
    const revision = ++next.revision;
    if (change.kind === 'upsert') change.record.revision = revision;
    const result: LifeChange = { schemaVersion:1, eventId:id('event'), opId, revision, occurredAt:clock.wall(), change };
    next.changes.push(result); return result;
  }
  async function reconcileTimers() {
    const current = await load(); const next = clone(current); const events: LifeChange[] = [];
    for (const record of next.records) {
      if (record.kind !== 'pomodoro' || !['running','paused'].includes(record.timerState)) continue;
      const uncertain = record.clock.bootId !== clock.bootId || clock.monotonic() < record.clock.anchorMonotonicMs;
      const elapsed = timerElapsed(record, clock);
      if (!uncertain && (record.timerState !== 'running' || elapsed < record.durationMs)) continue;
      record.timerState = uncertain ? 'interrupted' : 'finished';
      record.clockIntegrity = uncertain ? 'needs_review' : 'verified';
      record.clock.elapsedActiveMs = elapsed;
      record.finishedAt = uncertain ? null : clock.wall(); record.finishReason = uncertain ? null : 'completed'; record.updatedAt = clock.wall();
      events.push(event(next, id('local_timer'), { kind:'upsert', record:clone(record) })); record.revision = next.revision;
    }
    if (events.length) await commit(next, events);
  }
  async function result<T>(work: () => Promise<T>): Promise<BridgeResult<T>> {
    return queue.run(async () => { try { return ok(await work()); } catch (error) { return failure<T>(error); } });
  }
  const unsupported = async <T>(): Promise<BridgeResult<T>> => failure(new CompanionFailure('UNSUPPORTED'));
  const adapter: CompanionAdapter = {
    getCapabilities: async () => ok({ schemaVersion:1, runtime, authority:'local_fallback', systemOverlay:false, screenObservation:false, backgroundTimer:false, lifeCommands:true, unsupportedReasons:['not_android'] }),
    startCompanion: () => unsupported(), stopCompanion: async () => ok(stoppedCompanion()),
    startObservation: () => unsupported(),
    stopObservation: async reason => ok({ stoppedSessionId:null, invalidatedGeneration:null, currentGeneration:1, reason }),
    getSnapshot: () => result(async () => {
      await reconcileTimers(); const s = await load();
      return { schemaVersion:1 as const, authority:'local_fallback' as const, revision:s.revision, records:clone(s.records), companion:stoppedCompanion(), observation:stoppedObservation() };
    }),
    readChanges: afterRevision => result(async () => {
      await reconcileTimers(); const s = await load();
      requireTrue(isInteger(afterRevision) && afterRevision <= s.revision, 'INVALID_REVISION');
      requireTrue(afterRevision >= s.floor, 'SNAPSHOT_REQUIRED');
      const changes = clone(s.changes.filter(change => change.revision > afterRevision).slice(0,COMPANION_LIMITS.changePageSize));
      const throughRevision = changes.at(-1)?.revision ?? afterRevision;
      return { schemaVersion:1 as const, afterRevision, throughRevision, currentRevision:s.revision, changes, hasMore:throughRevision < s.revision };
    }),
    ackChanges: revision => result(async () => {
      const s = await load(); requireTrue(isInteger(revision) && revision <= s.revision, 'INVALID_REVISION');
      if (revision > s.ack) {
        const next = clone(s); next.ack = revision; next.floor = Math.max(next.floor,revision); next.changes = next.changes.filter(change => change.revision > revision); await commit(next);
      }
      return { schemaVersion:1 as const, ackedRevision:state!.ack };
    }),
    submitLifeCommand: command => result(async () => {
      validateCommand(command);
      const s = await load(); const hash = digest(canonical({ kind:command.kind, payload:command.payload, observationIds:command.observationIds }));
      const previous = Object.hasOwn(s.operations, command.opId) ? s.operations[command.opId] : undefined;
      if (previous) { requireTrue(previous.hash === hash,'OP_ID_CONFLICT'); return { ...clone(previous.receipt), replayed:true }; }
      const target = validateTarget(command,s.records,s.revision);
      const next = clone(s); const now = clock.wall(); const base: LifeRecordBase = { schemaVersion:1, id:id('record'), revision:s.revision+1, text:'', source:{kind:'manual_action'}, status:'confirmed', createdAt:now, updatedAt:now, lastSeenAt:null, observationIds:[] };
      let change: LifeChange['change']; let record: LifeRecord | undefined;
      switch (command.kind) {
        case 'note.create': record = { ...base, kind:'note', status:'confirmed', text:command.payload.text, source:{kind:command.payload.source} }; break;
        case 'expense.create': {
          const {source,...facts}=command.payload;
          record={...base,...facts,kind:'expense',status:'confirmed',source:{kind:source},paymentStatus:'paid',transaction:null,evidence:[]}; break;
        }
        case 'location.create': {
          const {text,latitude,longitude,accuracyMeters}=command.payload;
          record={...base,kind:'location',status:'confirmed',text,latitude,longitude,accuracyMeters,source:{kind:'foreground_location'}}; break;
        }
        case 'pomodoro.start': {
          requireTrue(!s.records.some(r=>r.kind==='pomodoro' && r.status!=='revoked' && ['running','paused'].includes(r.timerState)), 'ALREADY_RUNNING');
          const p=command.payload;
          record={...base,kind:'pomodoro',status:'confirmed',text:p.text,source:{kind:p.source},phase:p.phase,durationMs:p.durationMs,timerState:'running',startedAt:now,pausedAt:null,finishedAt:null,finishReason:null,clockIntegrity:'verified',clock:{bootId:clock.bootId,anchorMonotonicMs:clock.monotonic(),anchorWallTimeMs:now,elapsedActiveMs:0,accumulatedPausedMs:0}}; break;
        }
        case 'record.confirm': {
          requireTrue(target && (target.kind==='foodObservation'||target.kind==='expense'));
          if (target.kind==='expense') requireTrue(target.currency === 'CNY', 'UNSUPPORTED_CURRENCY');
          record={...clone(target),...command.payload.facts,status:'confirmed'} as LifeRecord; break;
        }
        case 'record.revoke': {
          requireTrue(target); record={...clone(target),status:'revoked'};
          if(record.kind==='pomodoro') { record.clock.elapsedActiveMs=timerElapsed(record,clock); record.timerState='finished';record.finishedAt=now;record.finishReason='user'; }
          break;
        }
        case 'record.delete': requireTrue(target); next.records=next.records.filter(r=>r.id!==target.id); break;
        case 'life.clear': next.records=[]; break;
        default: {
          requireTrue(target?.kind==='pomodoro'); const r=clone(target); const elapsed=timerElapsed(r,clock);
          if(command.kind==='pomodoro.pause') { requireTrue(r.timerState==='running','CONFLICT'); requireTrue(r.clock.bootId===clock.bootId,'CLOCK_UNCERTAIN'); r.timerState='paused';r.pausedAt=now; }
          if(command.kind==='pomodoro.resume') {
            requireTrue(r.clock.bootId===clock.bootId && r.clockIntegrity==='verified','CLOCK_UNCERTAIN');requireTrue(r.timerState==='paused','CONFLICT');
            r.clock.accumulatedPausedMs+=Math.max(0,clock.monotonic()-r.clock.anchorMonotonicMs);r.timerState='running';r.pausedAt=null;
          }
          if(command.kind==='pomodoro.finish') { requireTrue(r.timerState!=='finished','CONFLICT');r.timerState='finished';r.finishedAt=now;r.finishReason='user'; }
          r.clock.elapsedActiveMs=elapsed;r.clock.anchorMonotonicMs=clock.monotonic();r.clock.anchorWallTimeMs=now; record=r;
        }
      }
      if(record) {
        record.updatedAt=now;record.revision=next.revision+1;
        next.records=next.records.filter(r=>r.id!==record!.id);next.records.push(record);
        change={kind:'upsert',record:clone(record)};
      } else if(command.kind==='record.delete') change={kind:'delete',recordId:command.payload.recordId};
      else change={kind:'clear'};
      // 删除/清空时压缩全部旧事件正文，落后的消费者必须装快照。
      if(command.kind==='life.clear'||command.kind==='record.delete') { next.changes=[];next.floor=next.revision+1; }
      const committed=event(next,command.opId,change);
      const receipt: CommandReceipt={schemaVersion:1,opId:command.opId,eventId:committed.eventId,revision:committed.revision,recordIds:record?[record.id]:target?[target.id]:[],committedAt:now,replayed:false};
      Object.defineProperty(next.operations,command.opId,{value:{hash,receipt},enumerable:true,writable:true,configurable:true});
      await commit(next,[committed]);return clone(receipt);
    }),
    subscribe: (name,listener) => { let set=listeners.get(name);if(!set){set=new Set();listeners.set(name,set);}set.add(listener as (event:never)=>void);return()=>set.delete(listener as (event:never)=>void); },
    refreshTimers: async () => { const outcome=await result(reconcileTimers);if(!outcome.ok)fail(outcome.error.code); },
  };
  return adapter;
}
