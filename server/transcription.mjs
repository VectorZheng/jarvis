import { randomBytes } from 'node:crypto';
import { COMPANION_LIMITS as LIMITS, TRANSCRIPTION_MEDIA } from '../app/src/companion/contracts.ts';
import { requireThat, object, integer, opaque, binding, text, strictJson, checkBodySize, fail } from './companionProtocol.mjs';
import { validateProvider } from './providerSecurity.mjs';
import { inspectMedia } from './mediaInspection.mjs';

export const STT_API_DOCUMENTATION = Object.freeze([
  'https://platform.openai.com/docs/api-reference/audio/createTranscription',
  'https://raw.githubusercontent.com/openai/openai-node/master/src/resources/audio/transcriptions.ts',
]);
export function checkAudioBounds(bytes, durationMs) {
  checkBodySize(bytes, LIMITS.maxAudioBytes);
  integer(durationMs, 1, LIMITS.maxAudioDurationMs, 'INVALID_REQUEST');
  requireThat(bytes > 0, 'INVALID_REQUEST');
}
export function validateTranscriptionMetadata(value) {
  object(value, ['schemaVersion', 'requestId', 'provider', 'credentialBinding', 'durationMs', 'language']);
  requireThat(value.schemaVersion === 1); opaque(value.requestId); binding(value.credentialBinding);
  validateProvider(value.provider, 'stt');
  integer(value.durationMs, 1, LIMITS.maxAudioDurationMs, 'INVALID_REQUEST');
  requireThat(value.language === null || typeof value.language === 'string' && /^[a-z]{2}$/.test(value.language));
  return value;
}
/** 只接受两个有界 part，无磁盘、嵌套 multipart、重复名称、额外字段或容错补全。 */
export function parseTranscriptionMultipart(bytes, contentType) {
  checkBodySize(bytes.length, LIMITS.maxMultipartBytes);
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([A-Za-z0-9'()+_,.\/:=? -]{1,70})"|([A-Za-z0-9'()+_,.\/:=?-]{1,70}))$/i.exec(contentType || '');
  requireThat(match, 'UNSUPPORTED_MEDIA_TYPE');
  const boundary = match[1] || match[2], marker = Buffer.from('--' + boundary), delimiter = Buffer.from('\r\n--' + boundary);
  requireThat(bytes.subarray(0, marker.length).equals(marker), 'INVALID_REQUEST');
  let at = marker.length, parts = new Map();
  while (true) {
    if (bytes.subarray(at, at + 2).equals(Buffer.from('--'))) {
      at += 2;
      if (bytes.subarray(at, at + 2).equals(Buffer.from('\r\n'))) at += 2;
      requireThat(at === bytes.length, 'INVALID_REQUEST'); break;
    }
    requireThat(bytes.subarray(at, at + 2).equals(Buffer.from('\r\n')) && parts.size < 2, 'INVALID_REQUEST'); at += 2;
    const headEnd = bytes.indexOf('\r\n\r\n', at);
    requireThat(headEnd >= at && headEnd - at <= 2048, 'INVALID_REQUEST');
    const raw = bytes.subarray(at, headEnd);
    requireThat(raw.every(b => b === 13 || b === 10 || b >= 32 && b <= 126), 'INVALID_REQUEST');
    const headers = {};
    for (const line of raw.toString('ascii').split('\r\n')) {
      const h = /^([A-Za-z-]+):[ \t]*(.*)$/.exec(line);
      requireThat(h && ['content-disposition', 'content-type'].includes(h[1].toLowerCase()) && !Object.hasOwn(headers, h[1].toLowerCase()), 'INVALID_REQUEST');
      headers[h[1].toLowerCase()] = h[2];
    }
    const disposition = /^form-data;\s*name="(file|metadata)"(?:;\s*filename="([A-Za-z0-9_.-]{1,100})")?$/i.exec(headers['content-disposition'] || '');
    requireThat(disposition && !parts.has(disposition[1]), 'INVALID_REQUEST');
    const name = disposition[1], start = headEnd + 4, end = bytes.indexOf(delimiter, start);
    requireThat(end >= start, 'INVALID_REQUEST');
    parts.set(name, { bytes: bytes.subarray(start, end), filename: disposition[2], contentType: headers['content-type'] });
    at = end + delimiter.length;
  }
  requireThat(parts.size === 2 && parts.has('file') && parts.has('metadata'), 'INVALID_REQUEST');
  const metadataPart = parts.get('metadata'), file = parts.get('file');
  checkBodySize(metadataPart.bytes.length, LIMITS.maxTranscriptionMetadataBytes);
  requireThat(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(metadataPart.contentType || ''), 'UNSUPPORTED_MEDIA_TYPE');
  const metadata = validateTranscriptionMetadata(strictJson(metadataPart.bytes));
  checkAudioBounds(file.bytes.length, metadata.durationMs);
  const mime = /^(audio\/[a-z0-9-]+)(?:\s*;\s*codecs=(?:"[a-z0-9., -]+"|[a-z0-9.,-]+))?$/i.exec(file.contentType || '');
  requireThat(mime && file.filename && /^[A-Za-z0-9_-]{1,80}\.[a-z0-9]{2,4}$/i.test(file.filename), 'UNSUPPORTED_MEDIA_TYPE');
  const mimeType = mime[1].toLowerCase(), extension = file.filename.split('.').at(-1).toLowerCase();
  requireThat(TRANSCRIPTION_MEDIA.some(media => media.mimeType === mimeType && media.extensions.includes(extension)), 'UNSUPPORTED_MEDIA_TYPE');
  return { metadata, file: { bytes: file.bytes, mimeType, contentType: file.contentType, extension } };
}
export function transcriptionPayload(input) {
  let boundary;
  do { boundary = 'jarvis-' + randomBytes(24).toString('hex'); } while (input.file.bytes.includes(Buffer.from(boundary)));
  const pieces = [];
  const field = (name, value) => pieces.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  field('model', input.metadata.provider.model); field('response_format', 'json');
  if (input.metadata.language !== null) field('language', input.metadata.language);
  pieces.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.${input.file.extension}"\r\nContent-Type: ${input.file.contentType}\r\n\r\n`));
  pieces.push(input.file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(pieces), contentType: `multipart/form-data; boundary=${boundary}` };
}
export async function transcribeAudio(input, credentials, upstream, signal) {
  const inspected = await inspectMedia('audio', input.file.bytes, { mimeType: input.file.mimeType, signal });
  requireThat(Number.isFinite(inspected.durationMs) && inspected.durationMs > 0 && inspected.durationMs <= LIMITS.maxAudioDurationMs, 'INVALID_REQUEST');
  requireThat(Math.abs(inspected.durationMs - input.metadata.durationMs) <= 1000, 'INVALID_REQUEST');
  if (signal?.aborted) throw fail('CANCELLED');
  const bytes = await upstream({ ...credentials, ...transcriptionPayload(input), path: '/audio/transcriptions', signal, timeoutMs: LIMITS.transcriptionTimeoutMs, maxBytes: LIMITS.maxUpstreamResponseBytes });
  if (signal?.aborted) throw fail('CANCELLED');
  const result = strictJson(bytes); text(result?.text, LIMITS.maxTranscriptionChars);
  return { schemaVersion: 1, requestId: input.metadata.requestId, text: result.text };
}
