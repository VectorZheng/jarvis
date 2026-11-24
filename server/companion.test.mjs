import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import jpeg from 'jpeg-js';
import { COMPANION_LIMITS as LIMITS, VISION_PRESETS, DEFAULT_CHAT_PROVIDER, DEFAULT_STT_PROVIDER } from '../app/src/companion/contracts.ts';
import { fail, errorResponse, strictJson, readBytes, checkBodySize } from './companionProtocol.mjs';
import { providerPolicy, authorizeProvider, providerKey, requireTls, isPublicIp, createProviderTransport, applyCors } from './providerSecurity.mjs';
import { parseVisionCompletion, validateVisionRequest, checkImageBounds, visionPayload, observeVision } from './vision.mjs';
import { inspectMedia } from './mediaInspection.mjs';
import { parseTranscriptionMultipart, checkAudioBounds, transcribeAudio } from './transcription.mjs';
import { prepareAssistantRequest, createRequestChat, checkProviderConnection, validateMemory } from './assistantExtensions.mjs';
import { runAssistant } from './assistant.mjs';
import { runRecovery, validateRequest } from './recovery.mjs';
import { createCompanionHandler } from './companionHttp.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../shared/companion-fixtures.json', import.meta.url), 'utf8'));
const policy = providerPolicy({ JARVIS_PROVIDER_HOSTS: 'api.deepseek.com,api.openai.com,dashscope.aliyuncs.com,dashscope-intl.aliyuncs.com,dashscope-us.aliyuncs.com', JARVIS_ALLOWED_ORIGINS: 'https://ui.synthetic.invalid', JARVIS_TRUSTED_TLS_PROXIES: '127.0.0.1' });
const slot = { credentialId: 'synthetic-slot', credentialRevision: 1 };
const secret = 'synthetic-key-not-a-real-credential';
const credentials = { provider: VISION_PRESETS.deepseek, key: secret };
const completion = (output, reason = 'stop') => ({ choices: [{ finish_reason: reason, message: { content: JSON.stringify(output) } }] });
const expectCode = code => error => { assert.equal(error.code, code); assert.equal(error.message, fail(code).message); return true; };
function fakeRequest(bytes = Buffer.alloc(0), headers = {}, url = '/v1/vision/observations') {
  const req = Readable.from([bytes]);
  Object.assign(req, { headers, rawHeaders: Object.entries(headers).flat(), url, method: 'POST', socket: { encrypted: true, remoteAddress: '198.51.100.1' }, complete: false });
  req.once('end', () => { req.complete = true; }); return req;
}
class FakeResponse extends EventEmitter {
  constructor() { super(); this.headers = {}; this.chunks = []; this.headersSent = false; this.writableEnded = false; this.destroyed = false; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.statusCode = status; this.headersSent = true; for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); }
  write(value) { this.chunks.push(value); return true; }
  end(value) { if (value) this.write(value); this.writableEnded = true; this.emit('finish'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  get text() { return this.chunks.join(''); }
  get json() { return JSON.parse(this.text); }
}
function jpegImage(width = 8, height = 8) {
  const data = Buffer.alloc(width * height * 4, 180);
  return { mimeType: 'image/jpeg', width, height, base64: jpeg.encode({ data, width, height }, 60).data.toString('base64') };
}
const visionRequest = () => ({ schemaVersion: 1, provider: { ...VISION_PRESETS.deepseek }, credentialBinding: { ...slot }, metadata: { ...fixtures.metadata }, image: jpegImage() });
function wav(durationMs = 1000) {
  const size = Math.round(durationMs * 32), bytes = Buffer.alloc(44 + size);
  bytes.write('RIFF'); bytes.writeUInt32LE(36 + size, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(size, 40); return bytes;
}
// 合成媒体覆盖完整帧/容器结构；不把元数据解析通过当作波形解码或真实 STT 成功。
function mp3(frames = 40) {
  const frame = Buffer.alloc(417); frame.set([0xff, 0xfb, 0x90, 0xc0]);
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}
const uint32 = (...values) => { const bytes = Buffer.alloc(values.length * 4); values.forEach((value, i) => bytes.writeUInt32BE(value, i * 4)); return bytes; };
function box(name, ...parts) { const body = Buffer.concat(parts); return Buffer.concat([uint32(body.length + 8), Buffer.from(name), body]); }
function m4a(frames = 48) {
  const sample = Buffer.from('01402280a34ee880', 'hex'), ticks = frames * 1024;
  const ftyp = box('ftyp', Buffer.from('M4A '), uint32(0), Buffer.from('M4A isom'));
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(48000, 12); mvhd.writeUInt32BE(ticks, 16); mvhd.writeUInt32BE(65536, 20); mvhd.writeUInt16BE(256, 24); mvhd.writeUInt32BE(2, 96);
  const tkhd = Buffer.alloc(84); tkhd[3] = 7; tkhd.writeUInt32BE(1, 12); tkhd.writeUInt32BE(ticks, 20); tkhd.writeUInt16BE(256, 36);
  for (const [bytes, start] of [[mvhd, 36], [tkhd, 40]]) { bytes.writeUInt32BE(65536, start); bytes.writeUInt32BE(65536, start + 16); bytes.writeUInt32BE(1073741824, start + 32); }
  const mdhd = Buffer.alloc(24); mdhd.writeUInt32BE(48000, 12); mdhd.writeUInt32BE(ticks, 16); mdhd.writeUInt16BE(0x55c4, 20);
  const hdlr = Buffer.alloc(25); hdlr.write('soun', 8);
  const sound = Buffer.alloc(28); sound.writeUInt16BE(1, 6); sound.writeUInt16BE(1, 16); sound.writeUInt16BE(16, 18); sound.writeUInt32BE(48000 * 65536, 24);
  const decoder = Buffer.concat([Buffer.from([0x40, 0x15]), Buffer.alloc(11), Buffer.from([0x05, 0x02, 0x11, 0x88])]);
  const esds = box('esds', uint32(0), Buffer.from([0x03, 0x19, 0, 1, 0, 0x04, 0x11]), decoder, Buffer.from([0x06, 0x01, 0x02]));
  const stbl = box('stbl', box('stsd', uint32(0, 1), box('mp4a', sound, esds)), box('stts', uint32(0, 1, frames, 1024)),
    box('stsc', uint32(0, 1, 1, frames, 1)), box('stsz', uint32(0, sample.length, frames)), box('stco', uint32(0, 1, ftyp.length + 8)));
  const minf = box('minf', box('smhd', Buffer.alloc(8)), box('dinf', box('dref', uint32(0, 1), box('url ', uint32(1)))), stbl);
  const moov = box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd), box('mdia', box('mdhd', mdhd), box('hdlr', hdlr), minf)));
  return Buffer.concat([ftyp, box('mdat', Buffer.concat(Array.from({ length: frames }, () => sample))), moov]);
}
const ebmlUint = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const ebmlFloat = value => { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return bytes; };
function ebml(id, ...parts) {
  const body = Buffer.concat(parts), identifier = Buffer.from(id.toString(16), 'hex'); let width = 1;
  while (body.length >= 2 ** (width * 7) - 1) width++;
  const size = Buffer.alloc(width); size.writeUIntBE(2 ** (width * 7) + body.length, 0, width);
  return Buffer.concat([identifier, size, body]);
}
function webm({ unknown = false, clusters = 5, declaredMs, offsetMs = 0, duplicateTrack = false, blockGroup = false } = {}) {
  const header = ebml(0x1a45dfa3, ebml(0x4286, Buffer.from([1])), ebml(0x42f7, Buffer.from([1])), ebml(0x42f2, Buffer.from([4])),
    ebml(0x42f3, Buffer.from([8])), ebml(0x4282, Buffer.from('webm')), ebml(0x4287, Buffer.from([4])), ebml(0x4285, Buffer.from([2])));
  const info = ebml(0x1549a966, ebml(0x2ad7b1, ebmlUint(1000000)), ...(declaredMs === undefined ? [] : [ebml(0x4489, ebmlFloat(declaredMs))]));
  const opus = Buffer.alloc(19); opus.write('OpusHead'); opus[8] = 1; opus[9] = 1; opus.writeUInt32LE(48000, 12);
  const track = ebml(0xae, ebml(0xd7, Buffer.from([1])), ebml(0x73c5, Buffer.from([1])), ebml(0x83, Buffer.from([2])),
    ebml(0x86, Buffer.from('A_OPUS')), ebml(0x63a2, opus), ebml(0x23e383, ebmlUint(20000000)),
    ebml(0xe1, ebml(0xb5, ebmlFloat(48000)), ebml(0x9f, Buffer.from([1]))));
  const media = Array.from({ length: clusters }, (_, cluster) => {
    const blocks = Array.from({ length: 10 }, (_, index) => {
      const packet = Buffer.from([0x81, 0, 0, 0x80, 0xf8, 0xff, 0xfe]); packet.writeInt16BE(index * 20, 1);
      return blockGroup ? ebml(0xa0, ebml(0xa1, packet), ebml(0x9b, Buffer.from([20]))) : ebml(0xa3, packet);
    });
    const content = Buffer.concat([ebml(0xe7, ebmlUint(offsetMs + cluster * 200)), ...blocks]);
    return unknown ? Buffer.concat([Buffer.from('1f43b675ff', 'hex'), content]) : ebml(0x1f43b675, content);
  });
  const segment = Buffer.concat([info, ebml(0x1654ae6b, track, ...(duplicateTrack ? [track] : [])), ...media]);
  return Buffer.concat([header, unknown ? Buffer.concat([Buffer.from('18538067ff', 'hex'), segment]) : ebml(0x18538067, segment)]);
}
function multipart({ metadata = fixtures.transcriptionExample.metadata, audio = wav(), filename = 'synthetic.wav', mimeType = 'audio/wav', extra = '' } = {}) {
  const boundary = 'synthetic-boundary';
  const bytes = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`), audio,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${typeof metadata === 'string' ? metadata : JSON.stringify(metadata)}\r\n${extra}--${boundary}--\r\n`),
  ]);
  return { bytes, type: `multipart/form-data; boundary=${boundary}` };
}
function fakeHttps({ status = 200, chunks = [Buffer.from('{}')], responseHeaders = {}, seen = [], hang = false } = {}) {
  return (url, options, callback) => {
    const request = new EventEmitter(); request.destroyed = false; request.destroy = () => { request.destroyed = true; };
    request.end = body => {
      seen.push({ url, options, body, request });
      if (hang) return;
      queueMicrotask(() => {
        if (request.destroyed) return;
        const response = Readable.from(chunks); response.statusCode = status; response.headers = responseHeaders;
        callback(response);
      });
    };
    return request;
  };
}
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
const requestHeaders = { 'content-type': 'application/json', 'x-jarvis-provider-key': secret };
const reply = { topic: 'general', confidence: 0.99, reply: '合成回应。', cards: [], quick_replies: [], reminder_request: null };
function memory(preferences = []) { return { schemaVersion: 1, limits: { recentMessages: 20, maxContextChars: 16000, confirmedPreferences: 20 }, preferences }; }
const preference = { id: 'pref-a', text: '喜欢简短回应', sourceMessageId: 'message-old', createdAt: 1, confirmedAt: 2, status: 'confirmed' };
const chatBody = () => ({ schemaVersion: 1, provider: { ...DEFAULT_CHAT_PROVIDER }, credentialBinding: { ...slot }, messages: [{ role: 'user', content: '你好' }], memory: memory() });

test('全部 modelCases 实际经过最终content与Schema校验，服务端从不执行动作或写库', () => {
  assert.equal(fixtures.synthetic, true); assert.equal(fixtures.schemaVersion, 1);
  for (const item of fixtures.modelCases) {
    const metadata = { ...fixtures.metadata, ...item.metadataOverride };
    const result = parseVisionCompletion(completion(item.output), metadata);
    assert.equal(result.observations.length, item.output.observations.length, item.id);
    const { observationId, ...observation } = result.observations[0];
    assert.deepEqual(observation, item.output.observations[0], item.id);
    assert.equal(observationId, 'obs_' + createHash('sha256').update(JSON.stringify([metadata.sessionId, metadata.generation, metadata.frameId, 0])).digest('hex'));
    assert.equal(result.observations.some(o => o.kind === 'expense' && o.status === 'confirmed'), false);
    assert.equal(Object.hasOwn(result, 'actions'), false); assert.equal(Object.hasOwn(result, 'records'), false);
    assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, totalTokens: null });
  }
});
test('全部 variantCases：服务端验证模式/金额，代际与单调帧龄不越权代替原生裁决', () => {
  for (const variant of fixtures.variantCases) {
    const model = fixtures.modelCases.find(m => m.id === variant.modelCaseId);
    const output = structuredClone(model.output); Object.assign(output.observations[0], variant.observationPatch);
    const metadata = { ...fixtures.metadata, ...model.metadataOverride, ...variant.metadataOverride };
    const nativeOnly = ['STALE_GENERATION', 'STALE_FRAME'].includes(variant.expected.errorCode);
    if (!variant.expected.accepted && !nativeOnly) assert.throws(() => parseVisionCompletion(completion(output), metadata), expectCode(variant.expected.errorCode), variant.id);
    else {
      const result = parseVisionCompletion(completion(output), metadata);
      assert.equal(result.observations.length, 1, variant.id);
      assert.equal(Object.hasOwn(result, 'nativeContext'), false);
      if (nativeOnly) assert.equal(result.generation, fixtures.metadata.generation);
    }
  }
});
test('全部 upstreamCases：禁止修复截断、reasoning替代、未知动作和额外模型调用', async () => {
  for (const item of fixtures.upstreamCases) {
    let calls = 0;
    const body = visionRequest();
    await assert.rejects(observeVision(body, credentials, async () => {
      calls++;
      return Buffer.from(JSON.stringify({ choices: [{ finish_reason: item.finishReason, message: { content: item.rawContent, reasoning_content: item.reasoningContent } }] }));
    }), expectCode(item.expected.errorCode), item.id);
    assert.equal(calls, 1, item.id);
  }
});
test('全部 transportBoundaryCases：长度描述用于实际边界函数，不冒充可解码媒体', () => {
  for (const item of fixtures.transportBoundaryCases) {
    const check = () => {
      if (item.decodedJpegBytes !== undefined || item.width !== undefined) return checkImageBounds(item.decodedJpegBytes ?? 1, item.width ?? 1, item.height ?? 1);
      if (item.requestBytes !== undefined) return checkBodySize(item.requestBytes, LIMITS.maxVisionRequestBytes);
      if (item.fileBytes !== undefined || item.durationMs !== undefined) return checkAudioBounds(item.fileBytes ?? 1, item.durationMs ?? 1);
      const url = new URL(item.backendOrigin); assert.equal(item.hasEphemeralCredential, true);
      const req = fakeRequest(); req.socket.encrypted = url.protocol === 'https:';
      return requireTls(req, providerPolicy({}));
    };
    if (item.expectedErrorCode) assert.throws(check, expectCode(item.expectedErrorCode), item.id);
    else assert.doesNotThrow(check, item.id);
  }
});
test('严格 JSON 拒绝重复键、转义重复、BOM、非有限数、超深和原型字段越权', () => {
  for (const raw of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '\ufeff{}', '{"n":1e999}', '{"n":9007199254740992}', '{"x":1,}', '['.repeat(34) + '0' + ']'.repeat(34)]) assert.throws(() => strictJson(raw));
  assert.throws(() => strictJson(Buffer.from([0xc0, 0xaf])));
  const parsed = strictJson('{"__proto__":{"polluted":true}}');
  assert.equal({}.polluted, undefined); assert.equal(Object.hasOwn(parsed, '__proto__'), true);
  assert.throws(() => parseVisionCompletion(completion({ schemaVersion: 1, observations: [], extra: true }), fixtures.metadata), expectCode('INVALID_SCHEMA'));
  for (const choice of [null, [], 1, 'stop']) assert.throws(() => parseVisionCompletion({ choices: [choice] }, fixtures.metadata), expectCode('INVALID_SCHEMA'));
});
test('未知观察字段、无证据日期、无效日历、数量字符串、超过6对象整批拒绝', () => {
  const base = structuredClone(fixtures.modelCases[0].output);
  for (const patch of [{ actions: [] }, { quantity: { value: '2', unit: 'piece' } }, { expiresOn: '2025-02-30' }, { evidence: [] }]) {
    const output = structuredClone(base); Object.assign(output.observations[0], patch);
    assert.throws(() => parseVisionCompletion(completion(output), fixtures.metadata), expectCode('INVALID_SCHEMA'));
  }
  assert.throws(() => parseVisionCompletion(completion({ schemaVersion: 1, observations: Array(7).fill(base.observations[0]) }), fixtures.metadata));
  assert.throws(() => parseVisionCompletion({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(base), tool_calls: [] } }] }, fixtures.metadata));
});
test('真实 JPEG 编码/解码、伪造尺寸、畸形图片与data URI拒绝', async () => {
  await validateVisionRequest(visionRequest());
  const mismatch = visionRequest(); mismatch.image.width++;
  await assert.rejects(validateVisionRequest(mismatch), expectCode('INVALID_REQUEST'));
  const malformed = visionRequest(); malformed.image.base64 = Buffer.from([255, 216, 0, 0, 255, 217]).toString('base64');
  await assert.rejects(validateVisionRequest(malformed), expectCode('INVALID_REQUEST'));
  const uri = visionRequest(); uri.image.base64 = 'data:image/jpeg;base64,' + uri.image.base64;
  await assert.rejects(validateVisionRequest(uri), expectCode('INVALID_REQUEST'));
  const cancelled = AbortSignal.abort(); await assert.rejects(validateVisionRequest(visionRequest(), cancelled), expectCode('CANCELLED'));
  await assert.rejects(inspectMedia('jpeg', Buffer.from(jpegImage().base64, 'base64'), { timeoutMs: 0 }), expectCode('TIMEOUT'));
});
test('双视觉适配固定内联JPEG、JSON Object、关闭思考和768 tokens，地域不切换', async () => {
  for (const provider of [VISION_PRESETS.deepseek, VISION_PRESETS.qwen, { ...VISION_PRESETS.qwen, baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' }, { ...VISION_PRESETS.qwen, baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1' }]) {
    const body = visionRequest(); body.provider = provider;
    const payload = visionPayload(body);
    assert.equal(payload.max_tokens, 768); assert.equal(payload.stream, false); assert.deepEqual(payload.response_format, { type: 'json_object' });
    assert.equal(provider.preset === 'deepseek' ? payload.thinking.type : payload.enable_thinking, provider.preset === 'deepseek' ? 'disabled' : false);
    assert.match(payload.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
    assert(!JSON.stringify(payload).includes(secret)); assert(!JSON.stringify(payload).includes(fixtures.metadata.sessionId));
    let calls = 0;
    await observeVision(body, { provider, key: secret }, async request => { calls++; assert.deepEqual(request.provider, provider); assert.equal(request.timeoutMs, 12000); return Buffer.from(JSON.stringify(completion({ schemaVersion: 1, observations: [] }))); });
    assert.equal(calls, 1);
  }
});
test('白名单默认关闭；拒绝子域、任意代理、凭据URL、端口、query及自定义路径', () => {
  assert.throws(() => authorizeProvider(VISION_PRESETS.deepseek, providerPolicy({})), expectCode('PROVIDER_NOT_ALLOWED'));
  for (const baseUrl of ['http://api.deepseek.com', 'https://api.deepseek.com.evil.invalid', 'https://key@api.deepseek.com', 'https://127.0.0.1', 'https://api.deepseek.com:444', 'https://api.deepseek.com?apiKey=x', 'https://api.deepseek.com/proxy', 'https://api.deepseek.com/#fragment']) {
    assert.throws(() => authorizeProvider({ ...VISION_PRESETS.deepseek, baseUrl }, policy), expectCode('PROVIDER_NOT_ALLOWED'));
  }
  for (const ip of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '192.168.1.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '64:ff9b::1', '2001:db8::1']) assert.equal(isPublicIp(ip), false, ip);
  assert.equal(isPublicIp('8.8.8.8'), true); assert.equal(isPublicIp('2606:4700:4700::1111'), true);
});
test('TLS入口仅信任指定代理，拒绝伪造转发头/重复Key；CORS不开放通配', () => {
  const req = fakeRequest(Buffer.alloc(0), { 'x-jarvis-provider-key': secret, 'x-forwarded-proto': 'https' }); req.socket.encrypted = false;
  assert.throws(() => providerKey(req, policy), expectCode('INSECURE_TRANSPORT'));
  req.socket.remoteAddress = '127.0.0.1'; assert.equal(providerKey(req, policy), secret);
  req.rawHeaders.push('X-Jarvis-Provider-Key', 'second'); assert.throws(() => providerKey(req, policy), expectCode('INVALID_REQUEST'));
  const res = new FakeResponse(); const corsReq = fakeRequest(Buffer.alloc(0), { origin: 'https://ui.synthetic.invalid' });
  applyCors(corsReq, res, policy); assert.equal(res.headers['access-control-allow-origin'], 'https://ui.synthetic.invalid');
  corsReq.headers.origin = 'https://evil.invalid'; assert.throws(() => applyCors(corsReq, new FakeResponse(), policy), expectCode('PERMISSION_DENIED'));
});
test('假 HTTPS 上游拒绝重定向/私网DNS，固定本次解析地址，原始错误永不泄露', async () => {
  const seen = []; let lookups = 0;
  const transport = createProviderTransport({ policy, lookupFn: async () => { lookups++; return publicLookup(); }, requestFn: fakeHttps({ seen }) });
  await transport({ ...credentials, path: '/chat/completions', body: '{}' });
  assert.equal(seen[0].options.agent, false); assert.equal(seen[0].options.rejectUnauthorized, true);
  assert.equal(seen[0].options.headers.Authorization, `Bearer ${secret}`);
  assert(!seen[0].url.href.includes(secret)); assert(!seen[0].body.includes(secret));
  seen[0].options.lookup('api.deepseek.com', {}, (error, address) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); });
  seen[0].options.lookup('api.deepseek.com', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); });
  assert.equal(lookups, 1);
  for (const status of [301, 302, 307, 308, 401, 403, 429, 500]) {
    const upstream = createProviderTransport({ policy, lookupFn: publicLookup, requestFn: fakeHttps({ status, chunks: [Buffer.from(secret)] }) });
    await assert.rejects(upstream({ ...credentials, path: '/chat/completions', body: '{}' }), error => { assert(!JSON.stringify(errorResponse(error)).includes(secret)); return true; });
  }
  let network = 0;
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
    const blocked = createProviderTransport({ policy, lookupFn: async () => addresses, requestFn: () => { network++; } });
    await assert.rejects(blocked({ ...credentials, path: '/chat/completions' }), expectCode('PROVIDER_NOT_ALLOWED'));
  }
  assert.equal(network, 0);
});
test('假 HTTPS 上游总时限包含DNS，取消销毁请求且不接受迟到结果/超大响应', async () => {
  const dnsHang = createProviderTransport({ policy, lookupFn: () => new Promise(() => {}), requestFn: () => assert.fail('不应开始网络') });
  await assert.rejects(dnsHang({ ...credentials, path: '/chat/completions', timeoutMs: 5 }), expectCode('TIMEOUT'));
  const seen = [], controller = new AbortController();
  const upstream = createProviderTransport({ policy, lookupFn: publicLookup, requestFn: fakeHttps({ seen, hang: true }) });
  const promise = upstream({ ...credentials, path: '/chat/completions', signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(promise, expectCode('CANCELLED')); assert.equal(seen[0].request.destroyed, true);
  const oversized = createProviderTransport({ policy, lookupFn: publicLookup, requestFn: fakeHttps({ chunks: [Buffer.alloc(65537)] }) });
  await assert.rejects(oversized({ ...credentials, path: '/chat/completions' }), expectCode('PAYLOAD_TOO_LARGE'));
});
test('DNS取消后迟到解析不再联网；HTTPS取消后的迟到响应立即销毁', async () => {
  let finishDns, calls = 0;
  const dnsController = new AbortController();
  const dnsTransport = createProviderTransport({ policy, lookupFn: () => new Promise(resolve => { finishDns = resolve; }), requestFn: () => { calls++; } });
  const dnsRejected = assert.rejects(dnsTransport({ ...credentials, path: '/chat/completions', signal: dnsController.signal }), expectCode('CANCELLED'));
  dnsController.abort(); await dnsRejected; finishDns([{ address: '8.8.8.8', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0);
  let callback, request;
  const controller = new AbortController(), transport = createProviderTransport({ policy, lookupFn: publicLookup, requestFn: (_url, _options, cb) => {
    callback = cb; request = new EventEmitter(); request.end = () => {}; request.destroy = () => { request.destroyed = true; }; return request;
  } });
  const rejected = assert.rejects(transport({ ...credentials, path: '/chat/completions', signal: controller.signal }), expectCode('CANCELLED'));
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejected;
  const late = new Readable({ read() {} }); late.statusCode = 200; late.headers = {}; callback(late);
  assert.equal(request.destroyed, true); assert.equal(late.destroyed, true); assert.equal(late.listenerCount('data'), 0);
});
test('STT合成fixture真正生成 WAV、严格两part、保持原字节且只转写一次', async () => {
  const form = multipart(); assert.equal(wav().length, fixtures.transcriptionExample.syntheticFileDescriptor.bytes);
  const input = parseTranscriptionMultipart(form.bytes, form.type); let calls = 0;
  const result = await transcribeAudio(input, { provider: DEFAULT_STT_PROVIDER, key: secret }, async request => {
    calls++; assert.equal(request.path, '/audio/transcriptions'); assert.equal(request.timeoutMs, 30000);
    assert(request.body.includes(wav())); assert(!request.body.includes(Buffer.from(secret)));
    assert(request.body.includes(Buffer.from('whisper-1'))); assert(!request.body.includes(Buffer.from('credentialBinding')));
    return Buffer.from(JSON.stringify({ text: fixtures.transcriptionExample.success.text }));
  });
  assert.deepEqual(result, fixtures.transcriptionExample.success); assert.equal(calls, 1);
});
test('STT拒绝额外/重复part、metadata重复键、MIME扩展名错配、空/畸形/超时音频', async () => {
  const extra = '--synthetic-boundary\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n{}\r\n';
  for (const options of [{ extra }, { filename: 'synthetic.mp3' }, { audio: Buffer.alloc(0) }, { metadata: '{"schemaVersion":1,"schemaVersion":1}' }]) {
    const form = multipart(options); assert.throws(() => parseTranscriptionMultipart(form.bytes, form.type));
  }
  for (const audio of [Buffer.alloc(44, 1), wav(60001)]) {
    const form = multipart({ audio }), input = parseTranscriptionMultipart(form.bytes, form.type);
    await assert.rejects(transcribeAudio(input, { provider: DEFAULT_STT_PROVIDER, key: secret }, async () => assert.fail('无效音频不得上云')), expectCode(audio.length > 44 ? 'INVALID_REQUEST' : 'UNSUPPORTED_MEDIA_TYPE'));
  }
  await assert.rejects(inspectMedia('audio', wav(), { mimeType: 'audio/wav', timeoutMs: 0 }), expectCode('TIMEOUT'));
  const input = parseTranscriptionMultipart(multipart().bytes, multipart().type);
  await assert.rejects(transcribeAudio(input, { provider: DEFAULT_STT_PROVIDER, key: secret }, async () => assert.fail('取消后不得上云'), AbortSignal.abort()), expectCode(fixtures.transcriptionExample.cancelled.error.code));
  const bad = wav(); bad.writeUInt32LE(10, 40);
  await assert.rejects(inspectMedia('audio', bad, { mimeType: 'audio/wav' }), expectCode('INVALID_REQUEST'));
  const mismatched = multipart({ audio: wav(3000) });
  await assert.rejects(transcribeAudio(parseTranscriptionMultipart(mismatched.bytes, mismatched.type), { provider: DEFAULT_STT_PROVIDER, key: secret }, async () => assert.fail('时长声明不符不得上云')), expectCode('INVALID_REQUEST'));
  assert.equal((await inspectMedia('audio', wav(60000), { mimeType: 'audio/wav' })).durationMs, 60000);
});
test('MP3/M4A/WebM 合成音频实际经过有界worker和转写适配，原始字节/扩展名不改', async () => {
  for (const [audio, mimeType, filename, durationMs, container] of [
    [mp3(), 'audio/mpeg', 'synthetic.mp3', Math.round(40 * 1152 / 44100 * 1000), 'mp3'],
    [m4a(), 'audio/mp4', 'synthetic.m4a', 1024, 'mp4'],
    [webm(), 'audio/webm;codecs=opus', 'synthetic.webm', 1000, 'webm'],
    [webm({ unknown: true, clusters: 12 }), 'audio/webm', 'synthetic.webm', 2400, 'webm'],
    [webm({ declaredMs: 1000, blockGroup: true }), 'audio/webm', 'synthetic.webm', 1000, 'webm'],
  ]) {
    const inspected = await inspectMedia('audio', audio, { mimeType: mimeType.split(';')[0] });
    assert.equal(inspected.container, container); assert(Math.abs(inspected.durationMs - durationMs) <= 1);
    const metadata = { ...fixtures.transcriptionExample.metadata, durationMs, language: null }, form = multipart({ metadata, audio, mimeType, filename });
    const input = parseTranscriptionMultipart(form.bytes, form.type); let calls = 0;
    const output = await transcribeAudio(input, { provider: DEFAULT_STT_PROVIDER, key: secret }, async request => {
      calls++; assert(request.body.includes(audio)); assert(request.body.includes(Buffer.from(`recording.${filename.split('.').at(-1)}`)));
      assert(!request.body.includes(Buffer.from('name="language"'))); return Buffer.from('{"text":"合成转写"}');
    });
    assert.equal(output.text, '合成转写'); assert.equal(calls, 1);
  }
});
test('音频短时长伪造、截断帧、mdat越界、多WebM音轨与60秒以上块时间线拒绝', async () => {
  const xing = mp3(); xing.write('Xing', 21); xing.writeUInt32BE(3, 25); xing.writeUInt32BE(4, 29); xing.writeUInt32BE(xing.length, 33);
  const wrongDuration = m4a(); wrongDuration.writeUInt32BE(48000, wrongDuration.indexOf('mdhd') + 20);
  const wrongOffset = m4a(); wrongOffset.writeUInt32BE(wrongOffset.length + 100, wrongOffset.indexOf('stco') + 12);
  const wrongMapping = m4a(); wrongMapping.writeUInt32BE(2, wrongMapping.indexOf('stsc') + 20);
  for (const [audio, mimeType] of [[xing, 'audio/mpeg'], [mp3().subarray(0, -1), 'audio/mpeg'], [wrongDuration, 'audio/mp4'],
    [wrongOffset, 'audio/mp4'], [wrongMapping, 'audio/mp4'], [m4a(2813), 'audio/mp4'], [webm({ declaredMs: 1 }), 'audio/webm'],
    [webm({ offsetMs: 61000, declaredMs: 1000 }), 'audio/webm'], [webm().subarray(0, -1), 'audio/webm']]) {
    await assert.rejects(inspectMedia('audio', audio, { mimeType }), expectCode('INVALID_REQUEST'));
  }
  await assert.rejects(inspectMedia('audio', webm({ duplicateTrack: true }), { mimeType: 'audio/webm' }), expectCode('UNSUPPORTED_MEDIA_TYPE'));
});
test('聊天请求级并行隔离，无扩展兼容，扩展缺Key不回退，凭据不进入模型上下文', async () => {
  const body = chatBody();
  assert.throws(() => prepareAssistantRequest(fakeRequest(), body, policy), expectCode('AUTH_REQUIRED'));
  const legacy = { messages: [{ role: 'user', content: '旧会话' }], health: { source: 'manual' } };
  assert.equal(prepareAssistantRequest(fakeRequest(), legacy, policy).credentials, null);
  assert.throws(() => prepareAssistantRequest(fakeRequest(), { ...legacy, health: { nested: { Api_Key: secret } } }, policy), expectCode('INVALID_REQUEST'));
  for (const field of ['apiKey', 'APIKEY', 'Api_Key', 'authorization', 'CREDENTIALS', 'RequestProvider']) {
    assert.throws(() => prepareAssistantRequest(fakeRequest(), { ...legacy, [field]: secret }, policy), expectCode('INVALID_REQUEST'));
  }
  const memoryOnly = { schemaVersion: 1, messages: legacy.messages, memory: memory() };
  assert.throws(() => prepareAssistantRequest(fakeRequest(), memoryOnly, policy), expectCode('AUTH_REQUIRED'));
  assert.deepEqual(prepareAssistantRequest(fakeRequest(Buffer.alloc(0), requestHeaders), memoryOnly, policy).credentials.provider, DEFAULT_CHAT_PROVIDER);
  await Promise.all(['synthetic-a', 'synthetic-b'].map(async key => {
    const prepared = prepareAssistantRequest(fakeRequest(Buffer.alloc(0), { 'x-jarvis-provider-key': key }), body, policy);
    assert(!JSON.stringify(validateRequest(prepared.body)).includes(key));
    const call = createRequestChat(prepared.credentials, async req => { assert.equal(req.key, key); assert(!req.body.includes(key)); return Buffer.from(JSON.stringify(completion(reply))); });
    const result = await runAssistant(prepared.body, call, { configured: true }); assert.equal(result.reply, reply.reply);
  }));
  assert.deepEqual(await runAssistant(legacy, async () => reply, { configured: true }), reply);
  const recovered = await runRecovery(legacy, async () => reply, { configured: true }); assert.equal(recovered.mode, 'agent');
});
test('有限记忆白名单、码点长度和来源验证；删除后下一请求不残留', async () => {
  const body = chatBody(); body.memory = memory([preference]);
  const req = fakeRequest(Buffer.alloc(0), { 'x-jarvis-provider-key': secret });
  const prepared = prepareAssistantRequest(req, body, policy);
  assert.deepEqual(validateRequest(prepared.body).memory.preferences, [preference]);
  const cleared = prepareAssistantRequest(req, { ...body, memory: memory() }, policy);
  assert.deepEqual(validateRequest(cleared.body).memory.preferences, []);
  for (const p of [{ ...preference, apiKey: secret }, { ...preference, status: 'unconfirmed' }, { ...preference, sourceMessageId: '' }, { ...preference, confirmedAt: 0 }, { ...preference, text: '字'.repeat(241) }]) assert.throws(() => validateMemory(memory([p]), body.messages));
  assert.doesNotThrow(() => validateMemory(memory([{ ...preference, text: '\u{1F600}'.repeat(240) }]), body.messages));
  assert.throws(() => validateMemory(memory([preference]), [{ id: preference.sourceMessageId, role: 'assistant', content: '模型推断' }]));
  assert.throws(() => validateMemory({ ...memory(), limits: { recentMessages: 21, confirmedPreferences: 20, maxContextChars: 16000 } }, body.messages));
  const huge = chatBody(); huge.messages = Array.from({ length: 3 }, () => ({ role: 'user', content: '字'.repeat(6000) }));
  assert.throws(() => prepareAssistantRequest(req, huge, policy));
  assert.throws(() => prepareAssistantRequest(req, { ...body, health: { apiKey: secret } }, policy));
});
test('请求级聊天流仅消费最终content；保留增量、停止条件和取消', async () => {
  const accumulated = [], payload = JSON.stringify(reply);
  const call = createRequestChat({ provider: DEFAULT_CHAT_PROVIDER, key: secret }, async req => {
    const events = [{ choices: [{ delta: { reasoning_content: '不公开推理' } }] }, ...[...payload].map(content => ({ choices: [{ delta: { content } }] })), { choices: [{ finish_reason: 'stop', delta: {} }] }];
    for (const event of events) req.onChunk(Buffer.from('data: ' + JSON.stringify(event) + '\n\n'));
    req.onChunk(Buffer.from('data: [DONE]\n\n')); return Buffer.alloc(0);
  });
  assert.deepEqual(await call({ system: '规则', user: '输入', onDelta: text => accumulated.push(text) }), reply);
  assert.equal(accumulated.at(-1), payload); assert(!accumulated.some(t => t.includes('不公开推理')));
  await assert.rejects(call({ signal: AbortSignal.abort() }), expectCode('CANCELLED'));
});
test('请求级聊天畸形JSON/空choice和非最终流被明确拒绝，不泄漏原始异常', async () => {
  for (const raw of ['null', '{"choices":[null]}', '{"choices":[[]]}']) {
    const plain = createRequestChat({ provider: DEFAULT_CHAT_PROVIDER, key: secret }, async () => Buffer.from(raw));
    await assert.rejects(plain({ system: '规则', user: '输入' }), expectCode('INVALID_SCHEMA'));
    const stream = createRequestChat({ provider: DEFAULT_CHAT_PROVIDER, key: secret }, async request => {
      request.onChunk(Buffer.from(`data: ${raw}\n\n`)); return Buffer.alloc(0);
    });
    await assert.rejects(stream({ onDelta: () => {} }), expectCode('INVALID_SCHEMA'));
  }
  for (const finish_reason of [null, 'length']) {
    const stream = createRequestChat({ provider: DEFAULT_CHAT_PROVIDER, key: secret }, async request => {
      request.onChunk(Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) }, finish_reason }] }) + '\n\n'));
      return Buffer.alloc(0);
    });
    await assert.rejects(stream({ onDelta: () => {} }), expectCode('UPSTREAM_TRUNCATED'));
  }
});
test('连接检测只用非推理GET，Qwen诚实unsupported，STT不继承chat Key', async () => {
  for (const provider of [DEFAULT_CHAT_PROVIDER, DEFAULT_STT_PROVIDER]) {
    let calls = 0;
    const result = await checkProviderConnection({ provider, key: secret }, async req => { calls++; assert.equal(req.method, 'GET'); assert.equal(req.body, undefined); return Buffer.from(JSON.stringify(provider.preset === 'deepseek' ? { is_available: false, balance_infos: [] } : { object: 'list', data: [] })); });
    assert.deepEqual(result, { schemaVersion: 1, ok: true, scope: 'credentials_only' }); assert.equal(calls, 1);
  }
  await assert.rejects(checkProviderConnection({ provider: VISION_PRESETS.qwen, key: secret }, async () => assert.fail('不得付费试跑')), expectCode('UNSUPPORTED'));
  const form = multipart(), handler = createCompanionHandler({ policy, upstream: async () => assert.fail('缺Key不得调用上游') });
  const res = new FakeResponse(); await handler(fakeRequest(form.bytes, { 'content-type': form.type }, '/voice/transcriptions'), res);
  assert.equal(res.statusCode, 401); assert.equal(res.json.error.code, 'AUTH_REQUIRED');
});
test('HTTP实际接线：旧NDJSON/new BYOK、ErrorResponse、大小、CORS与Key HTTP防护', async () => {
  const handler = createCompanionHandler({ policy, assistant: (body, call, status, options) => runAssistant(body, call || (async () => reply), status || { configured: true }, options), upstream: async req => {
    if (req.method === 'GET') return Buffer.from('{"is_available":true,"balance_infos":[]}');
    req.onChunk(Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) }, finish_reason: 'stop' }] }) + '\n\n'));
    return Buffer.alloc(0);
  } });
  for (const body of [{ messages: [{ role: 'user', content: '旧格式' }] }, chatBody()]) {
    const res = new FakeResponse(), headers = body.schemaVersion ? requestHeaders : { 'content-type': 'application/json' };
    await handler(fakeRequest(Buffer.from(JSON.stringify(body)), headers, '/v1/assistant/stream'), res);
    const events = res.text.trim().split('\n').map(JSON.parse);
    assert.equal(events[0].type, 'start'); assert.equal(events.at(-1).type, 'complete'); assert.equal(events.at(-1).result.reply, reply.reply);
    if (body.schemaVersion) assert(events.some(e => e.type === 'reply'));
  }
  const check = new FakeResponse();
  await handler(fakeRequest(Buffer.from(JSON.stringify({ schemaVersion: 1, provider: DEFAULT_CHAT_PROVIDER, credentialBinding: slot })), requestHeaders, '/v1/providers/check'), check);
  assert.equal(check.json.scope, 'credentials_only');
  const nullBody = new FakeResponse(); await handler(fakeRequest(Buffer.from('null'), requestHeaders), nullBody);
  assert.equal(nullBody.statusCode, 400); assert.equal(nullBody.json.error.code, 'INVALID_REQUEST');
  const req = fakeRequest(Buffer.from('{}'), requestHeaders); req.socket.encrypted = false;
  const denied = new FakeResponse(); await handler(req, denied); assert.equal(denied.json.error.code, 'INSECURE_TRANSPORT');
  const oversized = new FakeResponse(); await handler(fakeRequest(Buffer.alloc(LIMITS.maxVisionRequestBytes + 1), requestHeaders), oversized); assert.equal(oversized.statusCode, 413);
  const cors = new FakeResponse(); await handler(fakeRequest(Buffer.from('{}'), { ...requestHeaders, origin: 'https://evil.invalid' }), cors); assert.equal(cors.statusCode, 403);
});
test('HTTP视觉与STT成功路径使用单次假上游，额外参数/重复JSON键拒绝', async () => {
  let calls = 0;
  const handler = createCompanionHandler({ policy, upstream: async request => {
    calls++;
    return Buffer.from(JSON.stringify(request.path === '/audio/transcriptions' ? { text: '合成音频' } : completion({ schemaVersion: 1, observations: [] })));
  } });
  const image = new FakeResponse(); await handler(fakeRequest(Buffer.from(JSON.stringify(visionRequest())), requestHeaders), image);
  assert.equal(image.statusCode, 200); assert.deepEqual(image.json.observations, []);
  const form = multipart(), audio = new FakeResponse();
  await handler(fakeRequest(form.bytes, { ...requestHeaders, 'content-type': form.type }, '/voice/transcriptions'), audio);
  assert.equal(audio.statusCode, 200); assert.equal(audio.json.text, '合成音频'); assert.equal(calls, 2);
  for (const [body, url] of [['{}', '/v1/vision/observations?key=synthetic'], ['{"schemaVersion":1,"schemaVersion":1}', '/v1/vision/observations']]) {
    const res = new FakeResponse(); await handler(fakeRequest(Buffer.from(body), requestHeaders, url), res); assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 2);
});
test('idempotencyScenario属原生：服务端不接命令/ACK，不以事件重复实现另一份账本', async () => {
  const scenario = fixtures.idempotencyScenario;
  const handler = createCompanionHandler({ policy, upstream: async () => assert.fail('原生事务不得调用模型') });
  for (const step of scenario.steps) {
    const body = step.operation === 'submitCommand' ? scenario.command : step.operation === 'deliverEvent' ? scenario.committedEvent : { revision: step.revision };
    const req = fakeRequest(Buffer.from(JSON.stringify(body)), requestHeaders, `/v1/life/${step.operation}`), res = new FakeResponse();
    assert.equal(await handler(req, res), false); assert.equal(res.text, '');
  }
  const res = new FakeResponse(); await handler(fakeRequest(Buffer.from(JSON.stringify(scenario.command)), requestHeaders), res);
  assert.equal(res.statusCode, 422); assert.equal(res.json.error.code, 'INVALID_SCHEMA');
});
test('请求读取拒绝声明长度不符/压缩；流内异常脱敏且不伪造complete', async () => {
  await assert.rejects(readBytes(fakeRequest(Buffer.from('{}'), { 'content-length': '1' }), 100), expectCode('INVALID_REQUEST'));
  await assert.rejects(readBytes(fakeRequest(Buffer.from('{}'), { 'content-encoding': 'gzip' }), 100), expectCode('UNSUPPORTED_MEDIA_TYPE'));
  const handler = createCompanionHandler({ policy, assistant: async () => { throw new Error(secret); } }), res = new FakeResponse();
  await handler(fakeRequest(Buffer.from(JSON.stringify(chatBody())), requestHeaders, '/v1/assistant/stream'), res);
  const events = res.text.trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e => e.type), ['start', 'error']); assert.equal(events[1].code, 'UPSTREAM_ERROR'); assert(!res.text.includes(secret));
});
test('关闭NDJSON连接贯穿取消且不产生complete；上传取消与错误脱敏', async () => {
  let ready; const started = new Promise(resolve => { ready = resolve; }); let cancelled = false;
  const handler = createCompanionHandler({ policy, assistant: async (_body, _call, _status, options) => {
    ready(); await new Promise(resolve => options.signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true })); return reply;
  } });
  const res = new FakeResponse(), promise = handler(fakeRequest(Buffer.from(JSON.stringify(chatBody())), requestHeaders, '/v1/assistant/stream'), res);
  await started; res.destroy(); await promise; assert.equal(cancelled, true); assert(!res.text.includes('complete'));
  const req = new Readable({ read() {} }); req.headers = {};
  const controller = new AbortController(); const read = readBytes(req, 100, controller.signal); controller.abort();
  await assert.rejects(read, expectCode('CANCELLED'));
  assert(!JSON.stringify(errorResponse(new Error(secret))).includes(secret));
});
