import { COMPANION_LIMITS as LIMITS } from '../app/src/companion/contracts.ts';
import { readBytes, readJson, requestLifetime, requireThat, object, fail, errorResponse } from './companionProtocol.mjs';
import { providerPolicy, applyCors, providerKey, requestProvider, createProviderTransport } from './providerSecurity.mjs';
import { observeVision } from './vision.mjs';
import { parseTranscriptionMultipart, transcribeAudio } from './transcription.mjs';
import { prepareAssistantRequest, createRequestChat, checkProviderConnection } from './assistantExtensions.mjs';
import { runAssistant } from './assistant.mjs';
import { runRecovery, validateRequest } from './recovery.mjs';
import { streamResponse } from './recoveryTransport.mjs';

const ROUTES = new Set(['/v1/vision/observations', '/voice/transcriptions', '/v1/providers/check', '/v1/assistant/stream', '/v1/recovery/stream']);
export function sendCompanionJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
/** 入口和假上游测试共用；工厂参数从不来自请求 JSON。返回 false 表示保留旧路由处理。 */
export function createCompanionHandler({ policy = providerPolicy(), upstream = createProviderTransport({ policy }), assistant = runAssistant, recovery = runRecovery } = {}) {
  let active = 0;
  return async function handleCompanion(req, res) {
    const url = new URL(req.url || '/', 'https://jarvis.invalid');
    if (!ROUTES.has(url.pathname)) return false;
    let lifetime, acquired = false;
    try {
      applyCors(req, res, policy);
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
      requireThat(req.method === 'POST' && !url.search && !url.hash && req.url === url.pathname, 'INVALID_REQUEST');
      requireThat(active < 4, 'LIMIT_REACHED'); active++; acquired = true;
      lifetime = requestLifetime(req, res);
      const { signal } = lifetime;
      if (url.pathname === '/v1/vision/observations') {
        providerKey(req, policy);
        const body = await readJson(req, LIMITS.maxVisionRequestBytes, signal);
        requireThat(body !== null && typeof body === 'object' && !Array.isArray(body), 'INVALID_REQUEST');
        const credentials = requestProvider(req, body.provider, body.credentialBinding, policy, 'vision');
        sendCompanionJson(res, 200, await observeVision(body, credentials, upstream, signal));
      } else if (url.pathname === '/voice/transcriptions') {
        providerKey(req, policy);
        const input = parseTranscriptionMultipart(await readBytes(req, LIMITS.maxMultipartBytes, signal), req.headers['content-type']);
        const credentials = requestProvider(req, input.metadata.provider, input.metadata.credentialBinding, policy, 'stt');
        sendCompanionJson(res, 200, await transcribeAudio(input, credentials, upstream, signal));
      } else if (url.pathname === '/v1/providers/check') {
        providerKey(req, policy);
        const body = await readJson(req, 4096, signal);
        object(body, ['schemaVersion', 'provider', 'credentialBinding']); requireThat(body.schemaVersion === 1);
        const credentials = requestProvider(req, body.provider, body.credentialBinding, policy);
        sendCompanionJson(res, 200, await checkProviderConnection(credentials, upstream, signal));
      } else {
        const body = await readJson(req, 128 * 1024, signal);
        const prepared = prepareAssistantRequest(req, body, policy);
        validateRequest(prepared.body);
        const runner = url.pathname === '/v1/assistant/stream' ? assistant : recovery;
        const call = prepared.credentials ? createRequestChat(prepared.credentials, upstream) : undefined;
        const status = prepared.credentials ? { configured: true, model: prepared.credentials.provider.model } : undefined;
        if (signal.aborted) throw fail('CANCELLED');
        await streamResponse(req, res, options => runner(prepared.body, call, status, { ...options, signal: AbortSignal.any([options.signal, signal]) }));
      }
    } catch (error) {
      if (!res.headersSent) {
        // 拒绝未读完的请求时不复用连接，避免攻击者继续发送无限请求体。
        if (!req.complete) res.setHeader('Connection', 'close');
        const response = errorResponse(error); sendCompanionJson(res, fail(response.error.code).status, response);
      } else if (!res.writableEnded) res.end();
    } finally {
      lifetime?.cleanup(); if (acquired) active--;
    }
    return true;
  };
}
