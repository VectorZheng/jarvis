import { DEFAULT_CHAT_PROVIDER, MEMORY_LIMITS as LIMITS, PROVIDER_KEY_HEADER } from '../app/src/companion/contracts.ts';
import { fail, requireThat, object, integer, opaque, text, chars, binding, strictJson } from './companionProtocol.mjs';
import { providerKey, authorizeProvider, validateProvider, singleHeader } from './providerSecurity.mjs';

const EXTENSIONS = ['schemaVersion', 'provider', 'credentialBinding', 'memory'];
export function hasAssistantExtension(body, req) {
  return body && EXTENSIONS.some(k => Object.hasOwn(body, k)) || req && singleHeader(req, PROVIDER_KEY_HEADER) !== undefined;
}
export function validateMemory(memory, messages) {
  object(memory, ['schemaVersion', 'limits', 'preferences']); requireThat(memory.schemaVersion === 1);
  object(memory.limits, ['recentMessages', 'maxContextChars', 'confirmedPreferences']);
  integer(memory.limits.recentMessages, 1, LIMITS.recentMessages);
  integer(memory.limits.maxContextChars, 1, LIMITS.maxContextChars);
  integer(memory.limits.confirmedPreferences, 0, LIMITS.confirmedPreferences);
  requireThat(Array.isArray(messages) && messages.length <= memory.limits.recentMessages);
  requireThat(Array.isArray(memory.preferences) && memory.preferences.length <= memory.limits.confirmedPreferences);
  let total = messages.reduce((sum, m) => sum + chars(m.content), 0); const ids = new Set();
  const preferences = memory.preferences.map(p => {
    object(p, ['id', 'text', 'sourceMessageId', 'createdAt', 'confirmedAt', 'status']);
    opaque(p.id); opaque(p.sourceMessageId); text(p.text, LIMITS.maxPreferenceChars);
    integer(p.createdAt); integer(p.confirmedAt, p.createdAt); requireThat(p.status === 'confirmed' && !ids.has(p.id)); ids.add(p.id);
    // 来源可早于最近20条；只能核验传来的来源标识和确认字段，不能伪称服务端证明用户确认。
    const source = messages.find(m => m.id === p.sourceMessageId);
    requireThat(!source || source.role === 'user'); total += chars(p.text);
    return { id: p.id, text: p.text, sourceMessageId: p.sourceMessageId, createdAt: p.createdAt, confirmedAt: p.confirmedAt, status: 'confirmed' };
  });
  requireThat(total <= memory.limits.maxContextChars);
  return { schemaVersion: 1, limits: { ...memory.limits }, preferences };
}
export function validateExtendedMessages(messages) {
  requireThat(Array.isArray(messages) && messages.length >= 1 && messages.length <= LIMITS.recentMessages);
  const ids = new Set(); let total = 0;
  for (const message of messages) {
    object(message, ['role', 'content'], ['id']);
    requireThat(['user', 'assistant'].includes(message.role)); text(message.content, LIMITS.maxMessageChars);
    if (message.id !== undefined) { opaque(message.id); requireThat(!ids.has(message.id)); ids.add(message.id); }
    total += chars(message.content);
  }
  requireThat(messages.at(-1).role === 'user' && total <= LIMITS.maxContextChars);
}
function rejectCredentialFields(value, depth = 0) {
  requireThat(depth <= 32);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    requireThat(!['apikey', 'api_key', 'authorization', 'credentials', 'credentialbinding', 'requestprovider'].includes(key.toLowerCase()), 'INVALID_REQUEST');
    rejectCredentialFields(child, depth + 1);
  }
}
export function prepareAssistantRequest(req, body, policy) {
  requireThat(body !== null && typeof body === 'object' && !Array.isArray(body), 'INVALID_REQUEST');
  for (const field of Object.keys(body)) requireThat(!['apikey', 'api_key', 'credentials', 'requestprovider', 'authorization'].includes(field.toLowerCase()), 'INVALID_REQUEST');
  rejectCredentialFields(body.health);
  if (!hasAssistantExtension(body, req)) return { body, credentials: null };
  const key = providerKey(req, policy);
  object(body, ['messages', 'schemaVersion'], ['health', 'calendar', 'reminder_receipts', 'local_time', 'timezone', 'provider', 'credentialBinding', 'memory']);
  requireThat(body.schemaVersion === 1);
  validateExtendedMessages(body.messages);
  const explicit = Object.hasOwn(body, 'provider') || Object.hasOwn(body, 'credentialBinding');
  if (explicit) { binding(body.credentialBinding); validateProvider(body.provider, 'chat'); }
  const provider = authorizeProvider(explicit ? body.provider : DEFAULT_CHAT_PROVIDER, policy);
  const safeBody = { schemaVersion: 1, messages: body.messages.map(m => ({ ...m })), health: body.health,
    local_time: body.local_time, timezone: body.timezone };
  if (body.memory !== undefined) safeBody.memory = validateMemory(body.memory, body.messages);
  return { body: safeBody, credentials: { provider, key } };
}

/** 此工厂闭包仅服务单次 HTTP 请求，不写环境、不缓存 Key 或记忆。 */
export function createRequestChat(credentials, upstream) {
  return async function call({ system, user, json = true, timeoutMs = 30000, signal, onDelta } = {}) {
    if (signal?.aborted) throw fail('CANCELLED');
    const payload = {
      model: credentials.provider.model, max_tokens: 1024, thinking: { type: 'disabled' }, stream: Boolean(onDelta),
      messages: [{ role: 'system', content: system || '' }, { role: 'user', content: user || '' }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    };
    let pending = '', content = '', stopped = false, done = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    function frame(source) {
      const lines = source.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
      if (!lines.length) return;
      const raw = lines.join('\n');
      if (raw === '[DONE]') { requireThat(stopped, 'UPSTREAM_TRUNCATED'); done = true; return; }
      requireThat(!done, 'INVALID_SCHEMA');
      const event = strictJson(raw);
      requireThat(event !== null && typeof event === 'object' && !Array.isArray(event));
      requireThat(!event.error, 'UPSTREAM_ERROR');
      if (event.choices?.length === 0 && event.usage) return;
      requireThat(Array.isArray(event.choices) && event.choices.length === 1);
      const choice = event.choices[0];
      requireThat(choice !== null && typeof choice === 'object' && !Array.isArray(choice));
      requireThat(!choice.delta?.tool_calls && !choice.delta?.function_call);
      if (typeof choice.delta?.content === 'string') {
        requireThat(!stopped || !choice.delta.content);
        content += choice.delta.content; requireThat(chars(content) <= 16000);
        if (!signal?.aborted) onDelta?.(content);
      }
      if (choice.finish_reason != null) { requireThat(choice.finish_reason === 'stop', 'UPSTREAM_TRUNCATED'); stopped = true; }
    }
    function push(chunk, last = false) {
      pending += last ? decoder.decode() : decoder.decode(chunk, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        frame(pending.slice(0, match.index)); pending = pending.slice(match.index + match[0].length);
      }
      if (last && pending.trim()) { frame(pending); pending = ''; }
    }
    const raw = await upstream({ ...credentials, path: '/chat/completions', body: JSON.stringify(payload), timeoutMs, signal, maxBytes: 256 * 1024,
      onChunk: onDelta ? chunk => push(chunk) : undefined });
    if (signal?.aborted) throw fail('CANCELLED');
    if (onDelta) { push(undefined, true); requireThat(stopped, 'UPSTREAM_TRUNCATED'); }
    else {
      const result = strictJson(raw); requireThat(Array.isArray(result?.choices) && result.choices.length === 1);
      const choice = result.choices[0];
      requireThat(choice !== null && typeof choice === 'object' && !Array.isArray(choice));
      requireThat(choice.finish_reason === 'stop', 'UPSTREAM_TRUNCATED');
      requireThat(!choice.message?.tool_calls && !choice.message?.function_call); content = choice.message?.content;
    }
    text(content, 16000);
    return json ? strictJson(content) : content;
  };
}

export const CHECK_API_DOCUMENTATION = Object.freeze([
  'https://api-docs.deepseek.com/api/get-user-balance',
  'https://platform.openai.com/docs/api-reference/models/list',
  'https://cdn.jsdelivr.net/gh/openai/openai-node@master/src/resources/models.ts',
]);
export async function checkProviderConnection(credentials, upstream, signal) {
  // Qwen 暂无已核实、可跨这三个冻结地域使用的非付费凭据检测；绝不以收费推理冒充连接检查。
  requireThat(credentials.provider.preset !== 'qwen', 'UNSUPPORTED');
  const deepseek = credentials.provider.preset === 'deepseek';
  const data = strictJson(await upstream({ ...credentials, method: 'GET', path: deepseek ? '/user/balance' : '/models', signal, timeoutMs: 8000, maxBytes: 65536 }));
  if (signal?.aborted) throw fail('CANCELLED');
  requireThat(deepseek ? typeof data?.is_available === 'boolean' && Array.isArray(data.balance_infos) : data?.object === 'list' && Array.isArray(data.data), 'INVALID_SCHEMA');
  // 不泄漏账户余额/模型列表，且不声称视觉或转写权限可用。
  return { schemaVersion: 1, ok: true, scope: 'credentials_only' };
}
