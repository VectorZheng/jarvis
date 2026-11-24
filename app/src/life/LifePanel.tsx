import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import type { ExpenseLifeRecord, FoodLifeRecord, FoodQuantity, LifeCommand, LifeRecord, LifeRecordKind, PomodoroLifeRecord } from '../companion/contracts';
import type { CompanionAdapter } from '../companion/core';
import { newId, requireTrue, safeError, unwrap } from '../companion/core';
import { getCompanionAdapter } from '../companion/platform';
import { useForeground, useLifeProjection } from '../companion/hooks';
import { Action, Feedback, Field, SectionTitle, Toggle, ui } from '../companion/ui';
import { amountFromYuan, confirmationCommand, kindLabels, parseManualLife, pomodoroStart, recordAction, sourceLabels, statusLabels } from './rules';
import { captureLocationCommand } from './location';

function ConfirmEditor({record,onSubmit,onClose}:{record:FoodLifeRecord|ExpenseLifeRecord;onSubmit:(command:LifeCommand)=>Promise<boolean>;onClose:()=>void}) {
  const [name,setName]=useState(record.kind==='foodObservation'?record.name:'');const [brand,setBrand]=useState(record.kind==='foodObservation'?record.brand??'':'');const [barcode,setBarcode]=useState(record.kind==='foodObservation'?record.barcode??'':'');
  const [quantity,setQuantity]=useState(record.kind==='foodObservation'&&record.quantity?String(record.quantity.value):'');const [unit,setUnit]=useState<FoodQuantity['unit']>(record.kind==='foodObservation'&&record.quantity?record.quantity.unit:'piece');const [expiry,setExpiry]=useState(record.kind==='foodObservation'?record.expiresOn??'':'');
  const [amount,setAmount]=useState(record.kind==='expense'&&record.amountMinor!==null?(record.amountMinor/100).toFixed(2):'');const [purpose,setPurpose]=useState(record.kind==='expense'?record.purpose??record.text:'');const [merchant,setMerchant]=useState(record.kind==='expense'?record.merchant??'':'');const [confirmed,setConfirmed]=useState(false);const [error,setError]=useState('');
  const foreign=record.kind==='expense'&&record.currency!=='CNY';
  async function save(){try{
    requireTrue(confirmed,'CONSENT_REQUIRED');
    const facts=record.kind==='foodObservation'?{kind:'foodObservation' as const,name:name.trim(),brand:brand.trim()||null,barcode:barcode.trim()||null,quantity:quantity.trim()?{value:Number(quantity),unit}:null,expiresOn:expiry.trim()||null}:{kind:'expense' as const,text:record.text,amountMinor:amountFromYuan(amount)??0,currency:'CNY' as const,purpose:purpose.trim(),merchant:merchant.trim()||null};
    if(await onSubmit(confirmationCommand(record,facts)))onClose();
  }catch(cause){setError(safeError(cause).message);}}
  return <View style={ui.card} testID="life-confirm-editor"><Text style={ui.cardTitle}>核对这条{kindLabels[record.kind]}</Text>
    {record.kind==='foodObservation'?<><Field label="名称" value={name} onChangeText={setName}/><Field label="品牌（未知留空）" value={brand} onChangeText={setBrand}/><Field label="条码（未知留空）" value={barcode} onChangeText={setBarcode}/><Field label="数量（未知留空，不会累加）" value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad"/><View style={ui.row}>{(['piece','pack','g','kg','ml','l'] as const).map(value=><Action key={value} label={value} primary={unit===value} onPress={()=>setUnit(value)}/>)}</View><Field label="明确标签保质日期（YYYY-MM-DD，未知留空）" value={expiry} onChangeText={setExpiry}/></>:<><Text style={ui.muted}>原币种：{record.currency??'未知'}。仅你确认的实际人民币支出可以入账，不会自动换算。</Text><Field label="实付人民币（元）" value={amount} onChangeText={setAmount} keyboardType="decimal-pad"/><Field label="用途" value={purpose} onChangeText={setPurpose}/><Field label="商户（未知留空）" value={merchant} onChangeText={setMerchant}/></>}
    <Toggle label={record.kind==='expense'?'我确认这是已支付的人民币支出':'我已核对食材事实；未知值保留为空'} value={confirmed} onChange={setConfirmed}/><Feedback text={foreign?'原币种不是已识别的人民币；请核实后用新的手工支出记录，不会换币或猜测。':error} error/>
    <View style={ui.row}><Action label="确认并保存" primary disabled={!confirmed||foreign} onPress={()=>{void save();}}/><Action label="暂不确认" onPress={onClose}/></View>
  </View>;
}
function TimerDisplay({record,active}:{record:PomodoroLifeRecord;active:boolean}) {
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{if(!active||record.timerState!=='running')return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[active,record.timerState]);
  const delta=record.timerState==='running'?Math.max(0,now-record.clock.anchorWallTimeMs):0;
  const remaining=Math.max(0,record.durationMs-record.clock.elapsedActiveMs-delta);const seconds=Math.ceil(remaining/1000);
  return <><Text style={ui.large}>{String(Math.floor(seconds/60)).padStart(2,'0')}:{String(seconds%60).padStart(2,'0')}</Text><Text style={ui.muted}>{{running:'进行中',paused:'已暂停',finished:'已结束',interrupted:'连续性待核实'}[record.timerState]} · {record.phase==='focus'?'专注':'休息'}{record.timerState==='running'?' · 倒计时为显示估算，完成以权威状态为准':''}</Text>{record.clockIntegrity==='needs_review'?<Feedback text="检测到进程/时钟变化，请结束后重新开始，不会伪造完成。" error/>:null}</>;
}
function RecordDetails({record,active}:{record:LifeRecord;active:boolean}) {
  if(record.kind==='foodObservation')return <><Text style={ui.cardTitle}>{record.name}</Text><Text style={ui.body}>{record.quantity?`${record.quantity.value} ${record.quantity.unit}`:'数量未知'} · {record.brand??'品牌未知'}</Text><Text style={ui.muted}>标签到期日：{record.expiresOn??'未知（不推测）'}{record.barcode?` · 条码 ${record.barcode}`:''}</Text></>;
  if(record.kind==='expense')return <><Text style={ui.large}>{record.amountMinor===null?'金额待核实':`${record.currency==='CNY'?'¥ ':record.currency+' '}${(record.amountMinor/100).toFixed(2)}`}</Text><Text style={ui.body}>{record.purpose||record.text}</Text><Text style={ui.muted}>{record.merchant??'商户未知'} · {{paid:'付款证据',pending:'待付款',price_only:'仅标价',unknown:'付款状态未知'}[record.paymentStatus]}</Text></>;
  if(record.kind==='pomodoro')return <><Text style={ui.cardTitle}>{record.text}</Text><TimerDisplay record={record} active={active}/></>;
  return <><Text style={ui.body}>{record.text}</Text>{record.kind==='location'?<Text style={ui.muted}>{record.latitude.toFixed(5)}, {record.longitude.toFixed(5)} · 精度 {record.accuracyMeters===null?'未知':`约${Math.round(record.accuracyMeters)}米`}</Text>:null}</>;
}
export function LifePanel({adapter=getCompanionAdapter(),visible=true}:{adapter?:CompanionAdapter;visible?:boolean}) {
  const active=useForeground(visible);const projection=useLifeProjection(adapter,visible);
  const [input,setInput]=useState('');const [intent,setIntent]=useState<'note'|'expense'>('note');const [filter,setFilter]=useState<LifeRecordKind|'all'>('all');
  const [notice,setNotice]=useState('');const [error,setError]=useState(false);const [busy,setBusy]=useState(false);const lock=useRef(false);
  const [failed,setFailed]=useState<LifeCommand|null>(null);const [confirm,setConfirm]=useState<FoodLifeRecord|ExpenseLifeRecord|null>(null);const [danger,setDanger]=useState<LifeCommand|null>(null);
  const location=useRef<AbortController|null>(null);
  useEffect(()=>{if(!active)location.current?.abort();return()=>location.current?.abort();},[active]);
  async function submit(command:LifeCommand):Promise<boolean>{if(lock.current)return false;lock.current=true;setBusy(true);setNotice('');setError(false);try{unwrap(await adapter.submitLifeCommand(command));setFailed(null);setNotice(command.kind==='record.delete'?'记录已删除。':command.kind==='life.clear'?'生活记录已清空，观察和活动计时已停止。':command.kind==='record.revoke'?'记录已撤销（不代表退款或物理库存变化）。':'已保存到本地生活库。');await projection.refresh(true);return true;}catch(cause){setFailed(command);setError(true);setNotice(safeError(cause).message);return false;}finally{lock.current=false;setBusy(false);}}
  async function saveText(){const result=parseManualLife(input,'manual_text',intent);if(result.kind!=='command'){setError(true);setNotice(result.kind==='clarify'?result.question:'请明确想记录的内容。');return;}if(await submit(result.command))setInput('');}
  async function saveLocation(){if(lock.current)return;location.current?.abort();const control=new AbortController();location.current=control;setBusy(true);try{const command=await captureLocationCommand({signal:control.signal,isVisible:()=>!control.signal.aborted,text:'我主动记录的当前位置'});if(!control.signal.aborted)await submit(command);}catch(cause){setError(true);setNotice(safeError(cause).message);}finally{setBusy(false);}}
  if(!visible)return null;
  const records=projection.snapshot?.records??[];const running=records.some(r=>r.kind==='pomodoro'&&r.status!=='revoked'&&['running','paused'].includes(r.timerState));
  const list=records.filter(r=>filter==='all'||r.kind===filter).sort((a,b)=>b.updatedAt-a.updatedAt);
  const header=<View style={{gap:18}}><SectionTitle index="02" title="把生活，轻轻记下" subtitle="每条记录都有来处。观察不是猜测，确认由你决定。"/>
    <Text style={ui.badge}>{!projection.snapshot?'尚未取得权威快照':projection.snapshot.authority==='native_sqlite'?'Android 本地 SQLite · 唯一账本':'前台本地记录 · 不支持后台观察/计时通知'}</Text>
    <View style={ui.card}><View style={ui.row}><Action label="记笔记" primary={intent==='note'} onPress={()=>setIntent('note')}/><Action label="记支出" primary={intent==='expense'} onPress={()=>setIntent('expense')}/></View><Field label={intent==='note'?'笔记内容':'一笔已支付的人民币支出'} multiline value={input} onChangeText={setInput} placeholder={intent==='note'?'想留下的细节…':'例如：咖啡花了18元'}/><Text style={ui.muted}>本地文字规则直接保存，不为分类额外调用模型。信息不完整会先询问你。</Text><View style={ui.row}><Action label="保存这条" primary disabled={busy||!active||!input.trim()||!projection.snapshot} onPress={()=>{void saveText();}}/><Action label="主动记录一次当前位置" disabled={busy||!active||!projection.snapshot} onPress={()=>{void saveLocation();}}/>{busy?<Action label="取消定位" onPress={()=>location.current?.abort()}/>:null}</View></View>
    <View style={ui.card}><Text style={ui.cardTitle}>专注一会儿 · 25 / 5</Text><Text style={ui.muted}>独立于屏幕观察；停止观察不会停止你的番茄钟。</Text><View style={ui.row}><Action label="开始25分钟专注" primary disabled={busy||running||!projection.snapshot} onPress={()=>{void submit(pomodoroStart('focus'));}}/><Action label="开始5分钟休息" disabled={busy||running||!projection.snapshot} onPress={()=>{void submit(pomodoroStart('break'));}}/></View></View>
    <Feedback text={notice} error={error}/><Feedback text={projection.error?.message??''} error/>
    {failed?<Action label="重试同一操作（不会重复记账）" disabled={busy} onPress={()=>{void submit(failed);}}/>:null}
    {confirm?<ConfirmEditor key={confirm.id+':'+confirm.revision} record={confirm} onSubmit={submit} onClose={()=>setConfirm(null)}/>:null}
    {danger?<View style={ui.card}><Text style={ui.body}>{danger.kind==='life.clear'?'确定清空全部生活记录？观察与计时将停止。聊天和偏好不受影响。':danger.kind==='record.delete'?'确定删除这条记录？此操作无法撤回。':'确定撤销这条记录？这不代表实际退款或移除了食品。'}</Text><View style={ui.row}><Action label="确认操作" danger disabled={busy} onPress={()=>{void submit(danger).then(saved=>{if(saved)setDanger(null);});}}/><Action label="取消" onPress={()=>setDanger(null)}/></View></View>:null}
    <View style={ui.row}><Action label="全部" primary={filter==='all'} onPress={()=>setFilter('all')}/>{(Object.keys(kindLabels) as LifeRecordKind[]).map(kind=><Action key={kind} label={kindLabels[kind]} primary={filter===kind} onPress={()=>setFilter(kind)}/>)}</View>
    <View style={ui.row}><Action label="刷新记录" onPress={()=>{void projection.refresh(true);}}/><Action label="清空生活记录" danger disabled={busy||!projection.snapshot} onPress={()=>{if(projection.snapshot)setDanger({schemaVersion:1,opId:newId('clear'),kind:'life.clear',payload:{scope:'all',expectedRevision:projection.snapshot.revision,userConfirmed:true},observationIds:[]});}}/></View>
  </View>;
  return <FlatList testID="life-panel" contentContainerStyle={ui.page} keyboardShouldPersistTaps="handled" data={list} keyExtractor={record=>record.id} ListHeaderComponent={header} ItemSeparatorComponent={()=><View style={{height:14}}/>} ListEmptyComponent={<Text style={ui.muted}>{projection.loading?'正在读取记录…':'这里还没有记录；没有演示库存自动回填。'}</Text>} renderItem={({item:record})=><View style={ui.card} testID={`life-record-${record.kind}`}>
    <View style={ui.row}><Text style={ui.badge}>{kindLabels[record.kind]}</Text><Text style={ui.muted}>{statusLabels[record.status]}</Text></View><RecordDetails record={record} active={active}/><Text style={ui.muted}>{sourceLabels[record.source.kind]} · {new Date(record.createdAt).toLocaleString()}{record.lastSeenAt?` · 最近看见 ${new Date(record.lastSeenAt).toLocaleString()}`:''}</Text>
    {(record.kind==='foodObservation'||record.kind==='expense')&&record.evidence.length?<Text style={ui.muted}>最小证据：{record.evidence.map(e=>e.text??'画面可见').join(' / ')}</Text>:null}
    <View style={ui.row}>
      {(record.kind==='foodObservation'||record.kind==='expense')&&['observed','pending_confirmation'].includes(record.status)?<Action label="核对并确认" disabled={busy} onPress={()=>setConfirm(record)}/>:null}
      {record.kind==='pomodoro'&&record.status!=='revoked'&&record.timerState!=='finished'?<><Action label={record.timerState==='paused'?'继续':'暂停'} disabled={busy||record.timerState==='interrupted'} onPress={()=>{void submit(recordAction(record,record.timerState==='paused'?'pomodoro.resume':'pomodoro.pause'));}}/><Action label="结束本轮" disabled={busy} onPress={()=>{void submit(recordAction(record,'pomodoro.finish'));}}/></>:null}
      {record.status!=='revoked'?<Action label="撤销" disabled={busy} onPress={()=>setDanger(recordAction(record,'record.revoke'))}/>:null}<Action label="删除" danger disabled={busy} onPress={()=>setDanger(recordAction(record,'record.delete'))}/>
    </View>
  </View>}/>;
}
