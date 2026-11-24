import { ERROR_HTTP_STATUS } from './contracts';
import type { BridgeResult, CompanionError, CompanionErrorCode, JarvisCompanionBridge, NativeEventMap, NativeEventName } from './contracts';

export interface StringStorage { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> }
export type Unsubscribe = () => void;
export interface CompanionAdapter extends JarvisCompanionBridge {
  subscribe<K extends NativeEventName>(name: K, listener: (event: NativeEventMap[K]) => void): Unsubscribe;
  /** 只在可见前台调用；Android 计时仍完全由原生负责。 */
  refreshTimers(): Promise<void>;
}
const MESSAGES: Partial<Record<CompanionErrorCode, string>> = {
  UNSUPPORTED: '当前供应商或运行环境不支持此能力，不会自动改用付费调用或伪造成功。',
  INSECURE_TRANSPORT: '携带 Key 的请求仅允许发送到你已确认的可信 HTTPS 服务。',
  AUTH_REQUIRED: '请先在设置中保存该用途的独立 Key。',
  AUTH_FAILED: '凭据验证未通过，请检查对应供应商与地域。',
  CONSENT_REQUIRED: '请先明确确认此次用途与云分析风险。',
  PERMISSION_DENIED: '权限未开启，可继续使用文字输入。',
  NOT_FOREGROUND: '此操作只能在可见前台主动执行。',
  STORAGE_FAILED: '保存失败，尚未记录，请保留输入后重试。',
  CONFLICT: '记录已发生变化，请刷新后重新确认。',
  OP_ID_CONFLICT: '同一操作编号对应了不同内容，已拒绝写入。',
  CLOCK_UNCERTAIN: '无法确认计时连续性，请结束这轮后重新开始。',
  CANCELLED: '操作已取消。', TIMEOUT: '请求超时，可继续使用文字输入。',
  NETWORK_UNAVAILABLE: '暂时无法连接服务，可继续使用文字输入。',
  INVALID_AMOUNT: '金额必须为有效的人民币整数分，不能超过上限。',
  UNSUPPORTED_CURRENCY: '暂不支持确认非人民币支出，不会换算或伪记人民币。',
  INVALID_SCHEMA: '数据格式不符合当前协议，已拒绝处理。',
  INVALID_REQUEST: '输入不完整或超出允许范围。',
  NOT_FOUND: '记录已不存在。', ALREADY_RUNNING: '已有活动会话，请先结束。',
  INVALID_REVISION: '同步序号无效，请重新加载。', SNAPSHOT_REQUIRED: '需要重新读取完整快照。',
  PAYLOAD_TOO_LARGE: '内容超过大小限制，请缩短后重试。',
};
export function errorOf(code: CompanionErrorCode): CompanionError {
  return { code, message: MESSAGES[code] ?? '暂时无法完成操作，请稍后重试。', retryable: ['NETWORK_UNAVAILABLE', 'TIMEOUT', 'STORAGE_FAILED', 'UPSTREAM_ERROR'].includes(code) };
}
export class CompanionFailure extends Error {
  readonly detail: CompanionError;
  constructor(code: CompanionErrorCode) { const detail = errorOf(code); super(detail.message); this.name = 'CompanionFailure'; this.detail = detail; }
}
export function fail(code: CompanionErrorCode): never { throw new CompanionFailure(code); }
export function safeError(error: unknown, fallback: CompanionErrorCode = 'STORAGE_FAILED'): CompanionError {
  return error instanceof CompanionFailure ? error.detail : errorOf(fallback);
}
export function ok<T>(value: T): BridgeResult<T> { return { schemaVersion: 1, ok: true, value }; }
export function failure<T>(error: unknown, fallback?: CompanionErrorCode): BridgeResult<T> { return { schemaVersion: 1, ok: false, error: safeError(error, fallback) }; }
export function unwrap<T>(result: BridgeResult<T>): T { if (!result.ok) fail(result.error.code); return result.value; }
export function parseRemoteError(value: unknown): CompanionError {
  if (value && typeof value === 'object' && 'error' in value) {
    const error = value.error;
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && Object.hasOwn(ERROR_HTTP_STATUS, error.code)) return errorOf(error.code as CompanionErrorCode);
  }
  return errorOf('UPSTREAM_ERROR');
}
export function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function points(value: string): number { return Array.from(value).length; }
export function slicePoints(value: string, limit: number): string { return Array.from(value).slice(0, limit).join(''); }
export function isId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }
export function isInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max; }
export function isText(value: unknown, max: number): value is string { return typeof value === 'string' && value.trim().length > 0 && points(value) <= max; }
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SCHEMA'); return value as Record<string, unknown>; }
export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = object(value); const actual = Object.keys(row);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail('INVALID_SCHEMA');
  return row;
}
export function requireTrue(condition: unknown, code: CompanionErrorCode = 'INVALID_REQUEST'): asserts condition { if (!condition) fail(code); }
let sequence = 0;
export function newId(prefix = 'ui'): string {
  sequence = (sequence + 1) % 1000000;
  return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
/** 防重收据仅保存摘要，不在删除后留下笔记或位置正文。纯 TS 供跨平台和 node:test 共用。 */
export function digest(value: string): string {
  const bytes = Array.from(new TextEncoder().encode(value)); const bitLength = bytes.length * 8;
  bytes.push(128); while (bytes.length % 64 !== 56) bytes.push(0);
  for (let shift = 7; shift >= 0; shift--) bytes.push(Math.floor(bitLength / 2 ** (shift * 8)) & 255);
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const r = (n: number, b: number) => (n >>> b) | (n << (32 - b));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = new Array<number>(64);
    for (let i = 0; i < 16; i++) w[i] = (bytes[offset+i*4]<<24)|(bytes[offset+i*4+1]<<16)|(bytes[offset+i*4+2]<<8)|bytes[offset+i*4+3];
    for (let i = 16; i < 64; i++) { const a=w[i-15], b=w[i-2]; w[i]=(w[i-16]+(r(a,7)^r(a,18)^(a>>>3))+w[i-7]+(r(b,17)^r(b,19)^(b>>>10)))|0; }
    let [a,b,c,d,e,f,g,j] = h;
    for (let i=0;i<64;i++) { const t1=(j+(r(e,6)^r(e,11)^r(e,25))+((e&f)^(~e&g))+k[i]+w[i])|0; const t2=((r(a,2)^r(a,13)^r(a,22))+((a&b)^(a&c)^(b&c)))|0; j=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0; }
    [a,b,c,d,e,f,g,j].forEach((n,i)=>{h[i]=(h[i]+n)|0;});
  }
  return h.map(n=>(n>>>0).toString(16).padStart(8,'0')).join('');
}
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> { const next = this.tail.then(work, work); this.tail = next.catch(() => undefined); return next; }
}
