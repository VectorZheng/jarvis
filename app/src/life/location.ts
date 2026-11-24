import * as Location from 'expo-location';
import { AppState } from 'react-native';
import type { LifeCommand } from '../companion/contracts';
import { fail, newId, requireTrue } from '../companion/core';

/** 仅由按钮主动调用；不注册位置监听，不申请后台定位，不在模块加载时申请权限。 */
export async function captureLocationCommand(options:{signal?:AbortSignal;isVisible:()=>boolean;text?:string}):Promise<LifeCommand> {
  const controller=new AbortController();let timedOut=false;
  const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted)controller.abort();
  const subscription=AppState.addEventListener('change',state=>{if(state!=='active')controller.abort();});
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},20000);
  const check=()=>{if(controller.signal.aborted)fail(timedOut?'TIMEOUT':'CANCELLED');requireTrue(AppState.currentState==='active'&&options.isVisible(),'NOT_FOREGROUND');};
  try {
    check();const permission=await Location.requestForegroundPermissionsAsync();check();requireTrue(permission.granted,'PERMISSION_DENIED');
    const position=await Promise.race([
      Location.getCurrentPositionAsync({accuracy:Location.Accuracy.Balanced}),
      new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>{try{check();}catch(error){reject(error);}},{once:true});}),
    ]);
    check();return{schemaVersion:1,opId:newId('location'),kind:'location.create',payload:{text:options.text?.trim()||'此刻的位置',latitude:position.coords.latitude,longitude:position.coords.longitude,accuracyMeters:position.coords.accuracy,capturedAt:Math.round(position.timestamp),userConfirmed:true},observationIds:[]};
  } finally {clearTimeout(timer);subscription.remove();options.signal?.removeEventListener('abort',abort);}
}
