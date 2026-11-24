import type { BridgeResult, CompanionCapabilities, JarvisCompanionBridge, NativeEventMap, NativeEventName } from './contracts';
import { CompanionFailure, failure, ok } from './core';
import type { CompanionAdapter, StringStorage } from './core';
import { createLocalFallback } from './fallback';

export type NativeCompanionModule = JarvisCompanionBridge & {
  addListener<K extends NativeEventName>(name: K, listener: (event: NativeEventMap[K]) => void): { remove(): void };
};
/** Android 缺模块时仍声明原生权威但 lifeCommands=false，绝不创建第二份本地账本。 */
export function createCompanionAdapter(platform: 'android' | 'ios' | 'web', native: NativeCompanionModule | null, storage: StringStorage): CompanionAdapter {
  if (platform !== 'android') return createLocalFallback(storage,platform);
  if (!native) {
    const unavailable = async <T>(): Promise<BridgeResult<T>> => failure(new CompanionFailure('UNSUPPORTED'));
    const capabilities: CompanionCapabilities = { schemaVersion:1, runtime:'expo_go', authority:'native_sqlite', systemOverlay:false,screenObservation:false,backgroundTimer:false,lifeCommands:false,unsupportedReasons:['native_module_missing'] };
    return { getCapabilities:async()=>ok(capabilities),startCompanion:unavailable,stopCompanion:unavailable,startObservation:unavailable,stopObservation:unavailable,submitLifeCommand:unavailable,readChanges:unavailable,ackChanges:unavailable,getSnapshot:unavailable,subscribe:()=>()=>{},refreshTimers:async()=>{} };
  }
  async function call<T>(work:()=>Promise<BridgeResult<T>>):Promise<BridgeResult<T>> {
    try {
      const result=await work();
      if(result?.schemaVersion!==1 || typeof result.ok!=='boolean') return failure(new CompanionFailure('INVALID_SCHEMA'));
      return result.ok ? result : failure(new CompanionFailure(result.error.code));
    } catch { return failure(new CompanionFailure('STORAGE_FAILED')); }
  }
  return {
    getCapabilities:()=>call(()=>native.getCapabilities()),
    startCompanion:config=>call(()=>native.startCompanion(config)),
    stopCompanion:reason=>call(()=>native.stopCompanion(reason)),
    startObservation:(config,credentials)=>call(()=>native.startObservation(config,credentials)),
    stopObservation:reason=>call(()=>native.stopObservation(reason)),
    submitLifeCommand:command=>call(()=>native.submitLifeCommand(command)),
    readChanges:revision=>call(()=>native.readChanges(revision)),
    ackChanges:revision=>call(()=>native.ackChanges(revision)),
    getSnapshot:()=>call(()=>native.getSnapshot()),
    subscribe:(name,listener)=>{ const subscription=native.addListener(name,event=>{if(event.schemaVersion===1)listener(event);});return()=>subscription.remove(); },
    refreshTimers:async()=>{},
  };
}
