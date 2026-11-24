import { COMPANION_LIMITS, POMODORO_DEFAULTS } from '../companion/contracts';
import type { LifeCommand, LifeRecord, ManualOrigin } from '../companion/contracts';
import { isInteger, isText, newId, points, requireTrue } from '../companion/core';
import { validateCommand } from '../companion/commands';

export type ManualLifeResult = {kind:'command';command:LifeCommand}|{kind:'clarify';question:string}|{kind:'not_life'};
export function amountFromYuan(value:string):number|null {
  if(!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value.trim()))return null;
  const [whole,fraction='']=value.trim().split('.');const amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  return isInteger(amount,1,COMPANION_LIMITS.maxAmountMinor)?amount:null;
}
/** 仅处理用户实际输入；屏幕文字和模型输出不得调用。解析不发起任何模型请求。 */
export function parseManualLife(text:string,source:'manual_text'|'manual_voice'='manual_text',intent:'auto'|'note'|'expense'='auto'):ManualLifeResult {
  const input=text.trim();if(!input)return{kind:'clarify',question:'想记下什么？请补充内容。'};
  if(points(input)>2000)return{kind:'clarify',question:'这条记录超过2000字，请缩短后保存。'};
  const note=/^(?:笔记|记笔记|备忘|记一下|记住这件事)\s*[:：，,]?\s*/.exec(input);
  if(intent==='note'||note){const body=note?input.slice(note[0].length).trim():input;if(!body)return{kind:'clarify',question:'请补充笔记的具体内容。'};return{kind:'command',command:{schemaVersion:1,opId:newId('note'),kind:'note.create',payload:{text:body,source},observationIds:[]}};}
  const expense=intent==='expense'||/^(?:记账|记一笔|支出|消费)\s*[:：，,]?/.test(input)||/(?:花了|付了|支付了|买了|已付款)/.test(input);
  if(!expense)return{kind:'not_life'};
  if(/(?:美元|美金|港币|欧元|日元|英镑|USD|HKD|EUR|JPY|GBP|\$|€|£)/i.test(input))return{kind:'clarify',question:'目前只支持人民币支出；这笔外币不会自动换算或入账。'};
  if(/(?:待付|未付|还没付|没买|打算|准备买|标价|购物车|退款|退了)/.test(input))return{kind:'clarify',question:'这是已经实际支付的人民币支出吗？请确认实付金额和用途；标价、待付款及退款不直接记支出。'};
  const amounts=[...input.matchAll(/(?:人民币\s*|[¥￥]\s*)?(\d+(?:\.\d+)?)\s*(?:元|块(?:钱)?)/g)];
  if(amounts.length!==1)return{kind:'clarify',question:'请给出一笔明确的人民币金额和用途，例如“咖啡花了18元”；多笔请分开记录。'};
  const match=amounts[0];const amount=amountFromYuan(match[1]);
  const before=input.slice(0,match.index??0).trimEnd();
  if(amount===null||/(?:[\d.．eE+＋\-−－]|\d[,，])$/.test(before))return{kind:'clarify',question:'请填写大于0、最多两位小数且不超9999999.99元的实际支出。'};
  const purpose=input.replace(match[0],'').replace(/^(?:记账|记一笔|支出|消费)\s*[:：，,]?\s*/,'').replace(/(?:花了|付了|支付了|买了|已付款)/g,'').replace(/^[\s，,：:。]+|[\s，,：:。]+$/g,'').trim();
  if(!isText(purpose,120))return{kind:'clarify',question:'这笔钱用来做什么？请补充简短用途。'};
  return{kind:'command',command:{schemaVersion:1,opId:newId('expense'),kind:'expense.create',payload:{text:input,amountMinor:amount,currency:'CNY',purpose,merchant:null,source},observationIds:[]}};
}
export function recordAction(record:LifeRecord,kind:'record.revoke'|'record.delete'|'pomodoro.pause'|'pomodoro.resume'|'pomodoro.finish'):LifeCommand {
  const common={schemaVersion:1 as const,opId:newId('action'),observationIds:[...record.observationIds]};
  const target={recordId:record.id,expectedRevision:record.revision};
  if(kind==='record.revoke'||kind==='record.delete')return{...common,kind,payload:{...target,userConfirmed:true}};
  return{...common,kind,payload:target};
}
export function pomodoroStart(phase:'focus'|'break',text?:string,source:ManualOrigin='manual_action'):LifeCommand {
  return{schemaVersion:1,opId:newId('timer'),kind:'pomodoro.start',payload:{text:text?.trim()||(phase==='focus'?'专注25分钟':'休息5分钟'),phase,durationMs:phase==='focus'?POMODORO_DEFAULTS.focusDurationMs:POMODORO_DEFAULTS.breakDurationMs,source},observationIds:[]};
}
export function confirmationCommand(record:LifeRecord,facts:Extract<LifeCommand,{kind:'record.confirm'}>['payload']['facts']):LifeCommand {
  requireTrue(record.kind===facts.kind,'INVALID_SCHEMA');
  const command:LifeCommand={schemaVersion:1,opId:newId('confirm'),kind:'record.confirm',payload:{recordId:record.id,expectedRevision:record.revision,userConfirmed:true,facts},observationIds:[...record.observationIds]};validateCommand(command);return command;
}
export const sourceLabels:Record<LifeRecord['source']['kind'],string>={screen_observation:'屏幕观察',manual_text:'文字输入',manual_voice:'语音输入',manual_action:'手动操作',foreground_location:'前台定位'};
export const kindLabels:Record<LifeRecord['kind'],string>={foodObservation:'食材观察',expense:'支出',pomodoro:'番茄钟',note:'笔记',location:'位置'};
export const statusLabels:Record<LifeRecord['status'],string>={observed:'观察到 · 非已确认库存',pending_confirmation:'待你确认',confirmed:'已确认',revoked:'已撤销'};
