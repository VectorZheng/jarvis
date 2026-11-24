import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { PROVIDER_BASE_URLS as BASE, PROVIDER_HOST_CANDIDATES, PROVIDER_KEY_HEADER } from '../app/src/companion/contracts.ts';
import { fail, requireThat, object, text, binding } from './companionProtocol.mjs';

const list = value => typeof value === 'string' ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
const normalizeIp = ip => ip?.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
/** 空白名单默认拒绝。仅在请求开始读取管理员配置，不读取或修改任何提供商环境 Key。 */
export function providerPolicy(env = process.env) {
  return {
    allowedHosts: new Set(list(env.JARVIS_PROVIDER_HOSTS).filter(h => PROVIDER_HOST_CANDIDATES.includes(h))),
    allowedOrigins: new Set(list(env.JARVIS_ALLOWED_ORIGINS)),
    trustedTlsProxies: new Set(list(env.JARVIS_TRUSTED_TLS_PROXIES).filter(ip => isIP(ip)).map(normalizeIp)),
  };
}
export function validateProvider(value, purpose = value?.purpose) {
  requireThat(['chat', 'stt', 'vision'].includes(purpose));
  object(value, ['purpose', 'preset', 'baseUrl', 'model', ...(purpose === 'vision' ? ['thinking', 'credentialSource'] : [])]);
  requireThat(value.purpose === purpose); text(value.model, 128);
  if (purpose === 'chat') requireThat(value.preset === 'deepseek' && value.baseUrl === BASE.deepseek, 'PROVIDER_NOT_ALLOWED');
  if (purpose === 'stt') {
    requireThat(value.preset === 'openai' && value.baseUrl === BASE.openai, 'PROVIDER_NOT_ALLOWED');
    requireThat(value.model === 'whisper-1', 'UNSUPPORTED');
  }
  if (purpose === 'vision') {
    requireThat(value.thinking === 'disabled');
    if (value.preset === 'deepseek') requireThat(value.baseUrl === BASE.deepseek && value.model === 'deepseek-flash' && value.credentialSource === 'chat', 'PROVIDER_NOT_ALLOWED');
    else requireThat(value.preset === 'qwen' && [BASE.qwenCn, BASE.qwenIntl, BASE.qwenUs].includes(value.baseUrl) && value.model === 'qwen3-vl-plus' && value.credentialSource === 'vision', 'PROVIDER_NOT_ALLOWED');
  }
  return { ...value };
}
export function authorizeProvider(value, policy) {
  const provider = validateProvider(value), url = new URL(provider.baseUrl);
  requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash, 'PROVIDER_NOT_ALLOWED');
  requireThat(PROVIDER_HOST_CANDIDATES.includes(url.hostname) && policy.allowedHosts.has(url.hostname), 'PROVIDER_NOT_ALLOWED');
  return provider;
}
export function singleHeader(req, name) {
  const lower = name.toLowerCase();
  if (req.rawHeaders) {
    let count = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === lower) count++;
    requireThat(count <= 1, 'INVALID_REQUEST');
  }
  const value = req.headers[lower]; requireThat(value === undefined || typeof value === 'string', 'INVALID_REQUEST');
  return value;
}
export function requireTls(req, policy) {
  if (req.socket?.encrypted === true) return;
  const address = normalizeIp(req.socket?.remoteAddress);
  requireThat(policy.trustedTlsProxies.has(address) && singleHeader(req, 'x-forwarded-proto') === 'https', 'INSECURE_TRANSPORT');
}
export function providerKey(req, policy) {
  const key = singleHeader(req, PROVIDER_KEY_HEADER);
  requireThat(typeof key === 'string' && key.trim().length > 0, 'AUTH_REQUIRED');
  requireThat(key.length <= 4096 && !/[\r\n\0]/.test(key), 'INVALID_REQUEST');
  requireTls(req, policy);
  return key;
}
export function requestProvider(req, value, credentialBinding, policy, purpose) {
  const key = providerKey(req, policy);
  binding(credentialBinding);
  return { provider: authorizeProvider(validateProvider(value, purpose), policy), key };
}
export function applyCors(req, res, policy) {
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const origin = singleHeader(req, 'origin');
  if (origin !== undefined) {
    requireThat(policy.allowedOrigins.has(origin) && origin !== 'null', 'PERMISSION_DENIED');
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  if (req.method === 'OPTIONS') {
    const headers = list(singleHeader(req, 'access-control-request-headers')).map(h => h.toLowerCase());
    requireThat(headers.every(h => ['content-type', PROVIDER_KEY_HEADER.toLowerCase()].includes(h)), 'PERMISSION_DENIED');
    const method = singleHeader(req, 'access-control-request-method');
    requireThat(!method || ['GET', 'POST', 'DELETE'].includes(method), 'PERMISSION_DENIED');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${PROVIDER_KEY_HEADER}`);
  }
}

const denied = new BlockList();
for (const [ip, bits] of [ ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3] ]) denied.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) denied.addSubnet(ip, bits, 'ipv6');
const publicV6 = new BlockList(); publicV6.addSubnet('2000::', 3, 'ipv6');
export function isPublicIp(ip) {
  const family = isIP(ip);
  if (family === 4) return !denied.check(ip, 'ipv4');
  // IPv4 映射、NAT64、ULA、链路本地等均不属于此允许区间。
  return family === 6 && publicV6.check(ip, 'ipv6') && !denied.check(ip, 'ipv6');
}
function abortRace(promise, signal) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(signal.reason || fail('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(value => finish(null, value), error => finish(error));
  });
}

/** 假上游通过服务端工厂注入，客户端无法指定传输器、DNS、路径或请求头。 */
export function createProviderTransport({ policy = providerPolicy(), lookupFn = lookup, requestFn = https.request } = {}) {
  return async function upstream({ provider, key, path, method = 'POST', body, contentType = 'application/json', signal, timeoutMs = 12000, maxBytes = 65536, onChunk }) {
    provider = authorizeProvider(provider, policy);
    const permitted = method === 'GET' ? ['/models', '/user/balance'] : provider.purpose === 'stt' ? ['/audio/transcriptions'] : ['/chat/completions'];
    requireThat(permitted.includes(path) && ['GET', 'POST'].includes(method), 'PROVIDER_NOT_ALLOWED');
    requireThat(typeof key === 'string' && key.trim() && key.length <= 4096 && !/[\r\n\0]/.test(key), 'AUTH_REQUIRED');
    const controller = new AbortController();
    const cancelled = () => controller.abort(fail('CANCELLED'));
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    const timer = setTimeout(() => controller.abort(fail('TIMEOUT')), timeoutMs);
    let active, response;
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const url = new URL(provider.baseUrl + path);
      const addresses = await abortRace(lookupFn(url.hostname, { all: true, verbatim: true }), controller.signal);
      requireThat(addresses.length > 0 && addresses.every(a => isPublicIp(a.address)), 'PROVIDER_NOT_ALLOWED');
      const pinned = addresses[0];
      if (controller.signal.aborted) throw controller.signal.reason;
      return await new Promise((resolve, reject) => {
        const chunks = []; let size = 0, settled = false;
        const finish = (error, result) => {
          if (settled) return; settled = true;
          controller.signal.removeEventListener('abort', abort);
          if (error) { response?.destroy(); active?.destroy(); chunks.length = 0; reject(error); }
          else resolve(result);
        };
        const abort = () => finish(controller.signal.reason || fail('CANCELLED'));
        controller.signal.addEventListener('abort', abort, { once: true });
        active = requestFn(url, {
          method, agent: false, rejectUnauthorized: true, servername: url.hostname,
          // 固定本次已检查的地址，连接期间绝不二次查询；禁用代理/全局连接池。
          lookup: (_host, options, callback) => options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Accept-Encoding': 'identity',
            ...(body !== undefined ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) } : {}) },
        }, res => {
          if (settled) { res.destroy(); return; }
          response = res;
          const status = res.statusCode;
          if (status < 200 || status >= 300) {
            const code = status === 401 || status === 403 ? 'AUTH_FAILED' : status === 429 ? 'LIMIT_REACHED' : 'UPSTREAM_ERROR';
            finish(fail(code)); return;
          }
          if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { finish(fail('UPSTREAM_ERROR')); return; }
          if (Number(res.headers['content-length']) > maxBytes) { finish(fail('PAYLOAD_TOO_LARGE')); return; }
          res.on('data', chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > maxBytes) { finish(fail('PAYLOAD_TOO_LARGE')); return; }
            try { onChunk?.(chunk); chunks.push(chunk); } catch (error) { finish(fail(error?.code || 'INVALID_SCHEMA')); }
          });
          res.once('end', () => finish(null, Buffer.concat(chunks, size)));
          res.once('aborted', () => finish(fail('UPSTREAM_TRUNCATED')));
          res.once('error', () => finish(fail('NETWORK_UNAVAILABLE')));
        });
        active.once('error', () => finish(controller.signal.aborted ? controller.signal.reason : fail('NETWORK_UNAVAILABLE')));
        if (controller.signal.aborted) abort();
        else active.end(body);
      });
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : fail(error?.code || 'NETWORK_UNAVAILABLE');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancelled);
      active?.destroy(); response?.destroy();
    }
  };
}
