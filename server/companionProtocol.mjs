import { ERROR_HTTP_STATUS } from '../app/src/companion/contracts.ts';

const MESSAGES = {
  INVALID_REQUEST: '请求格式不正确。', INVALID_SCHEMA: '数据不符合约定。',
  INVALID_AMOUNT: '金额必须为有效整数分。', UNSUPPORTED_CURRENCY: '不支持此币种金额。',
  INSECURE_TRANSPORT: '凭据只能通过可信 HTTPS 传输。', PROVIDER_NOT_ALLOWED: '此提供商尚未获管理员允许。',
  AUTH_REQUIRED: '请先配置此服务的独立凭据。', AUTH_FAILED: '凭据无效或不适用于所选地域。',
  PERMISSION_DENIED: '此来源不允许访问。', UNSUPPORTED: '当前服务不支持此操作。',
  PAYLOAD_TOO_LARGE: '请求或响应超过大小限制。', UNSUPPORTED_MEDIA_TYPE: '不支持此媒体格式。',
  UPSTREAM_TRUNCATED: '上游未返回完整最终结果。', UPSTREAM_ERROR: '上游服务暂时不可用。',
  NETWORK_UNAVAILABLE: '网络连接不可用。', TIMEOUT: '请求已超时。', CANCELLED: '请求已取消。',
  LIMIT_REACHED: '请求次数过多，请稍后重试。',
};
export function fail(code = 'INVALID_REQUEST') {
  const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'UPSTREAM_ERROR';
  return Object.assign(new Error(MESSAGES[safeCode]), {
    code: safeCode, status: ERROR_HTTP_STATUS[safeCode],
    retryable: ['NETWORK_UNAVAILABLE', 'TIMEOUT', 'UPSTREAM_ERROR', 'LIMIT_REACHED'].includes(safeCode),
  });
}
export function errorResponse(error) {
  const statusCodes = { 400: 'INVALID_REQUEST', 401: 'AUTH_FAILED', 403: 'PERMISSION_DENIED', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 422: 'INVALID_SCHEMA', 429: 'LIMIT_REACHED', 499: 'CANCELLED', 501: 'UNSUPPORTED', 502: 'UPSTREAM_ERROR', 503: 'NETWORK_UNAVAILABLE', 504: 'TIMEOUT' };
  const safe = fail(error?.code || statusCodes[error?.status] || 'UPSTREAM_ERROR');
  return { schemaVersion: 1, error: { code: safe.code, message: safe.message, retryable: safe.retryable } };
}
export function requireThat(value, code = 'INVALID_SCHEMA') { if (!value) throw fail(code); }
export function object(value, keys, optional = []) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireThat(keys.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => keys.includes(k) || optional.includes(k)));
  return value;
}
export const chars = value => typeof value === 'string' ? [...value].length : Infinity;
export function text(value, max, nullable = false) {
  requireThat(nullable && value === null || typeof value === 'string' && value.trim().length > 0 && chars(value) <= max && !/[\u0000\uD800-\uDFFF]/u.test(value));
  return value;
}
export function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER, code = 'INVALID_SCHEMA') {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max, code);
  return value;
}
export function opaque(value) { requireThat(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)); return value; }
export function binding(value) {
  object(value, ['credentialId', 'credentialRevision']); opaque(value.credentialId); integer(value.credentialRevision, 1);
  return { credentialId: value.credentialId, credentialRevision: value.credentialRevision };
}

/** 严格解析：拒绝重复键（包括转义后的同名键）、BOM、超深结构和非安全数字。 */
export function strictJson(raw, code = 'INVALID_SCHEMA') {
  try {
    const source = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    let at = 0;
    const bad = () => { throw fail(code); };
    const ws = () => { while (/[ \t\r\n]/.test(source[at] || '\x01')) at++; };
    function string() {
      const start = at++;
      while (at < source.length) {
        const c = source[at++];
        if (c === '"') return JSON.parse(source.slice(start, at));
        if (c === '\\') at++;
        else if (c.charCodeAt(0) < 32) bad();
      }
      bad();
    }
    function value(depth = 0) {
      if (depth > 32) bad(); ws();
      if (source[at] === '"') return string();
      if (source[at] === '{' || source[at] === '[') {
        const isObject = source[at++] === '{', end = isObject ? '}' : ']';
        const result = isObject ? {} : [], seen = new Set(); ws();
        if (source[at] === end) { at++; return result; }
        while (at < source.length) {
          ws(); let key;
          if (isObject) {
            if (source[at] !== '"') bad(); key = string();
            if (seen.has(key)) bad(); seen.add(key); ws();
            if (source[at++] !== ':') bad();
          }
          const item = value(depth + 1);
          if (isObject) Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true });
          else result.push(item);
          ws(); const delimiter = source[at++];
          if (delimiter === end) return result;
          if (delimiter !== ',') bad();
        }
        bad();
      }
      for (const [word, result] of [['true', true], ['false', false], ['null', null]]) {
        if (source.startsWith(word, at)) { at += word.length; return result; }
      }
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(at));
      if (!match) bad(); at += match[0].length;
      const number = Number(match[0]);
      if (!Number.isFinite(number) || Number.isInteger(number) && !Number.isSafeInteger(number)) bad();
      return number;
    }
    const result = value(); ws(); if (at !== source.length) bad(); return result;
  } catch { throw fail(code); }
}

export function checkBodySize(size, limit) { requireThat(size <= limit, 'PAYLOAD_TOO_LARGE'); }
export async function readBytes(req, limit, signal) {
  requireThat(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 'UNSUPPORTED_MEDIA_TYPE');
  const declared = req.headers['content-length'];
  if (declared !== undefined) {
    requireThat(/^\d+$/.test(declared), 'INVALID_REQUEST');
    checkBodySize(Number(declared), limit);
  }
  const chunks = []; let size = 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.pause(); error(fail('TIMEOUT')); }, 15000);
    function cleanup() {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', abort);
      signal?.removeEventListener('abort', abort);
    }
    function error(e) { cleanup(); chunks.length = 0; reject(e?.code && ERROR_HTTP_STATUS[e.code] ? e : fail('INVALID_REQUEST')); }
    function abort() { req.pause(); error(fail('CANCELLED')); }
    function data(chunk) {
      size += chunk.length;
      if (size > limit) { req.pause(); error(fail('PAYLOAD_TOO_LARGE')); return; }
      chunks.push(chunk);
    }
    function end() {
      cleanup();
      if (declared !== undefined && Number(declared) !== size) reject(fail('INVALID_REQUEST'));
      else resolve(Buffer.concat(chunks, size));
    }
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', abort);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted || req.aborted) abort();
  });
}
export async function readJson(req, limit, signal) {
  requireThat(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || ''), 'UNSUPPORTED_MEDIA_TYPE');
  return strictJson(await readBytes(req, limit, signal), 'INVALID_REQUEST');
}
export function requestLifetime(req, res) {
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  req.on('aborted', abort); res.on('close', abort);
  if (req.aborted || res.destroyed) abort();
  return { signal: controller.signal, cleanup() { req.off('aborted', abort); res.off('close', abort); } };
}
