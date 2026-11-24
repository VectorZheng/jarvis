import { fail, requireThat } from './companionProtocol.mjs';

const valid = value => requireThat(value, 'INVALID_REQUEST');
const ascii = (bytes, start, length) => bytes.toString('latin1', start, start + length);
/** 只验证上传字节，不访问 URL/文件；不把容器声明时长当作解码后的语音时长。 */
export function sniffAudio(bytes, mimeType) {
  valid(bytes.length >= 12);
  if (['audio/wav', 'audio/x-wav'].includes(mimeType)) {
    requireThat(ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE', 'UNSUPPORTED_MEDIA_TYPE'); return 'wav';
  }
  if (['audio/mp4', 'audio/m4a', 'audio/x-m4a'].includes(mimeType)) {
    requireThat(ascii(bytes, 4, 4) === 'ftyp', 'UNSUPPORTED_MEDIA_TYPE'); return 'mp4';
  }
  if (mimeType === 'audio/mpeg') {
    requireThat(ascii(bytes, 0, 3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224, 'UNSUPPORTED_MEDIA_TYPE'); return 'mp3';
  }
  if (mimeType === 'audio/webm') {
    requireThat(bytes.readUInt32BE(0) === 0x1a45dfa3, 'UNSUPPORTED_MEDIA_TYPE'); return 'webm';
  }
  throw fail('UNSUPPORTED_MEDIA_TYPE');
}
export function wavDuration(bytes) {
  valid(bytes.readUInt32LE(4) + 8 === bytes.length);
  let at = 12, format, data;
  while (at < bytes.length) {
    valid(at + 8 <= bytes.length);
    const name = ascii(bytes, at, 4), size = bytes.readUInt32LE(at + 4), start = at + 8;
    valid(start + size <= bytes.length);
    if (name === 'fmt ') {
      valid(!format && size >= 16); format = bytes.subarray(start, start + size);
    }
    if (name === 'data') { valid(data === undefined && size > 0); data = size; }
    at = start + size + size % 2;
  }
  valid(at === bytes.length && format && data);
  const code = format.readUInt16LE(0), channels = format.readUInt16LE(2), rate = format.readUInt32LE(4);
  const byteRate = format.readUInt32LE(8), alignment = format.readUInt16LE(12), bits = format.readUInt16LE(14);
  requireThat([1, 3].includes(code), 'UNSUPPORTED_MEDIA_TYPE');
  valid(channels >= 1 && channels <= 8 && rate >= 8000 && rate <= 192000 && [8, 16, 24, 32, 64].includes(bits));
  valid(alignment === channels * bits / 8 && byteRate === rate * alignment && data % alignment === 0);
  return data / byteRate;
}
export function mp3Duration(bytes) {
  let at = 0, frames = 0, duration = 0;
  if (ascii(bytes, 0, 3) === 'ID3') {
    valid(bytes.length >= 10 && bytes.slice(6, 10).every(n => n < 128));
    const size = bytes[6] * 2097152 + bytes[7] * 16384 + bytes[8] * 128 + bytes[9];
    at = 10 + size + (bytes[5] & 16 ? 10 : 0); valid(at < bytes.length);
  }
  let end = bytes.length;
  if (end >= 128 && ascii(bytes, end - 128, 3) === 'TAG') end -= 128;
  while (at < end) {
    valid(at + 4 <= end);
    const h = bytes.readUInt32BE(at), version = h >>> 19 & 3, layer = h >>> 17 & 3;
    valid((h >>> 21) === 2047 && version !== 1 && layer === 1);
    const bitIndex = h >>> 12 & 15, rateIndex = h >>> 10 & 3;
    valid(bitIndex > 0 && bitIndex < 15 && rateIndex !== 3);
    const bitrates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const rate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const length = Math.floor((version === 3 ? 144000 : 72000) * bitrates[bitIndex] / rate) + (h >>> 9 & 1);
    valid(length > 4 && at + length <= end); at += length; frames++; duration += (version === 3 ? 1152 : 576) / rate;
  }
  valid(frames >= 2 && at === end); return duration;
}
function boxes(bytes, start = 0, end = bytes.length) {
  const result = []; let at = start;
  while (at < end) {
    valid(at + 8 <= end); let size = bytes.readUInt32BE(at), header = 8;
    if (size === 1) { valid(at + 16 <= end); size = Number(bytes.readBigUInt64BE(at + 8)); header = 16; }
    if (size === 0) size = end - at;
    valid(Number.isSafeInteger(size) && size >= header && at + size <= end);
    result.push({ name: ascii(bytes, at + 4, 4), start: at + header, end: at + size });
    valid(result.length <= 20000); at += size;
  }
  return result;
}
function one(items, name) { const found = items.filter(b => b.name === name); valid(found.length === 1); return found[0]; }
/** MP4 以 stts 样本时间表交叉核对 mdhd，并逐 chunk 核对样本字节确实位于 mdat。 */
export function mp4Duration(bytes) {
  const root = boxes(bytes); requireThat(!root.some(b => b.name === 'moof'), 'UNSUPPORTED_MEDIA_TYPE');
  const media = root.filter(b => b.name === 'mdat'); valid(media.length > 0);
  const moov = one(root, 'moov'), tracks = boxes(bytes, moov.start, moov.end).filter(b => b.name === 'trak');
  requireThat(tracks.length === 1, 'UNSUPPORTED_MEDIA_TYPE');
  const mdia = one(boxes(bytes, tracks[0].start, tracks[0].end), 'mdia'), children = boxes(bytes, mdia.start, mdia.end);
  const handler = one(children, 'hdlr'); valid(handler.start + 12 <= handler.end);
  requireThat(ascii(bytes, handler.start + 8, 4) === 'soun', 'UNSUPPORTED_MEDIA_TYPE');
  const mdhd = one(children, 'mdhd'), version = bytes[mdhd.start]; valid(version === 0 || version === 1);
  const scaleOffset = mdhd.start + (version === 0 ? 12 : 20); valid(scaleOffset + (version === 0 ? 8 : 12) <= mdhd.end);
  const scale = bytes.readUInt32BE(scaleOffset), declared = version === 0 ? bytes.readUInt32BE(scaleOffset + 4) : Number(bytes.readBigUInt64BE(scaleOffset + 4));
  valid(scale > 0 && Number.isSafeInteger(declared));
  const minf = one(children, 'minf'), stbl = one(boxes(bytes, minf.start, minf.end), 'stbl');
  const tables = boxes(bytes, stbl.start, stbl.end);
  const stsd = one(tables, 'stsd'); valid(stsd.start + 8 <= stsd.end);
  requireThat(bytes.readUInt32BE(stsd.start + 4) === 1, 'UNSUPPORTED_MEDIA_TYPE');
  const stts = one(tables, 'stts'); valid(stts.start + 8 <= stts.end);
  const entries = bytes.readUInt32BE(stts.start + 4); valid(entries > 0 && stts.start + 8 + entries * 8 === stts.end);
  let samples = 0, ticks = 0;
  for (let p = stts.start + 8; p < stts.end; p += 8) {
    const count = bytes.readUInt32BE(p), delta = bytes.readUInt32BE(p + 4); valid(count > 0 && delta > 0);
    samples += count; ticks += count * delta;
  }
  valid(Number.isSafeInteger(ticks) && samples <= 1000000 && samples > 0 && Math.abs(declared - ticks) <= 1);
  const stsz = one(tables, 'stsz'); valid(stsz.start + 12 <= stsz.end);
  const fixed = bytes.readUInt32BE(stsz.start + 4), sampleCount = bytes.readUInt32BE(stsz.start + 8);
  valid(sampleCount === samples && stsz.start + 12 + (fixed ? 0 : samples * 4) === stsz.end);
  const offsets = tables.filter(b => b.name === 'stco' || b.name === 'co64'); valid(offsets.length === 1);
  const offset = offsets[0], stride = offset.name === 'co64' ? 8 : 4;
  valid(offset.start + 8 <= offset.end);
  const chunks = bytes.readUInt32BE(offset.start + 4); valid(chunks > 0 && offset.start + 8 + chunks * stride === offset.end);
  const stsc = one(tables, 'stsc'); valid(stsc.start + 8 <= stsc.end);
  const mappings = bytes.readUInt32BE(stsc.start + 4); valid(mappings > 0 && stsc.start + 8 + mappings * 12 === stsc.end);
  let previousChunk = 0;
  for (let p = stsc.start + 8; p < stsc.end; p += 12) {
    const first = bytes.readUInt32BE(p);
    valid(first > previousChunk && first <= chunks && bytes.readUInt32BE(p + 4) > 0 && bytes.readUInt32BE(p + 8) === 1);
    previousChunk = first;
  }
  let sample = 0, map = 0, previousEnd = 0;
  for (let chunk = 1; chunk <= chunks; chunk++) {
    while (map + 1 < mappings && bytes.readUInt32BE(stsc.start + 8 + (map + 1) * 12) <= chunk) map++;
    const p = stsc.start + 8 + map * 12;
    valid(bytes.readUInt32BE(stsc.start + 8) === 1 && bytes.readUInt32BE(p) <= chunk);
    const count = bytes.readUInt32BE(p + 4); valid(count > 0 && sample + count <= samples);
    let size = 0;
    for (let n = 0; n < count; n++, sample++) { const length = fixed || bytes.readUInt32BE(stsz.start + 12 + sample * 4); valid(length > 0); size += length; }
    const pos = offset.start + 8 + (chunk - 1) * stride;
    const location = stride === 4 ? bytes.readUInt32BE(pos) : Number(bytes.readBigUInt64BE(pos));
    valid(Number.isSafeInteger(location) && location >= previousEnd && media.some(b => location >= b.start && location + size <= b.end));
    previousEnd = location + size;
  }
  valid(sample === samples); return ticks / scale;
}

function vint(bytes, at, identifier = false) {
  valid(at < bytes.length); const first = bytes[at]; let width = 1, mask = 128;
  while (width <= 8 && !(first & mask)) { width++; mask >>= 1; }
  valid(width <= (identifier ? 4 : 8) && at + width <= bytes.length);
  let value = identifier ? first : first & mask - 1;
  let unknown = !identifier && (first & mask - 1) === mask - 1;
  for (let i = 1; i < width; i++) { value = value * 256 + bytes[at + i]; unknown &&= bytes[at + i] === 255; }
  valid(unknown || Number.isSafeInteger(value)); return { value, width, unknown };
}
/** 只在 worker 内的解析副本中移除声明 Duration/统计标签，迫使库扫描音频块时间线。 */
export function webmTimingBuffer(bytes, clearTiming = true) {
  let blocks = 0, docType = false, elements = 0, headers = 0, segments = 0, infos = 0, tracks = 0, entries = 0;
  const blockTracks = new Set(), declaredTracks = new Set();
  const segmentChildren = [0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1f43b675, 0x1c53bb6b, 0x1941a469, 0x1043a770, 0x1254c367];
  const uint = (start, end) => {
    valid(end > start && end - start <= 8); let value = 0;
    for (let p = start; p < end; p++) value = value * 256 + bytes[p];
    valid(Number.isSafeInteger(value)); return value;
  };
  function walk(start, end, depth, parent = 0, unknown = false) {
    valid(depth <= 8); let at = start;
    while (at < end) {
      valid(++elements <= 20000);
      const id = vint(bytes, at, true), size = vint(bytes, at + id.width);
      // 未知长度 Cluster 由同级 Segment 子项结束，不把后续 Cluster 错当作递归嵌套。
      if (unknown && (parent === 0x1f43b675 && segmentChildren.includes(id.value) || [0x1a45dfa3, 0x18538067].includes(id.value))) return at;
      const payload = at + id.width + size.width;
      requireThat(!size.unknown || [0x18538067, 0x1f43b675].includes(id.value), 'UNSUPPORTED_MEDIA_TYPE');
      let next = size.unknown ? end : payload + size.value; valid(next <= end && next > at);
      if (id.value === 0x1a45dfa3) valid(parent === 0 && ++headers === 1);
      if (id.value === 0x18538067) valid(parent === 0 && ++segments === 1);
      if (segmentChildren.includes(id.value)) valid(parent === 0x18538067);
      if (id.value === 0x1549a966) valid(++infos === 1);
      if (id.value === 0x1654ae6b) valid(++tracks === 1);
      if (id.value === 0xae) { valid(parent === 0x1654ae6b); requireThat(++entries === 1, 'UNSUPPORTED_MEDIA_TYPE'); }
      if (id.value === 0x4282) { valid(parent === 0x1a45dfa3 && !docType); docType = ascii(bytes, payload, next - payload) === 'webm'; }
      if (parent === 0xae && id.value === 0xd7) { const number = uint(payload, next); valid(number > 0 && declaredTracks.size === 0); declaredTracks.add(number); }
      if (parent === 0xae && id.value === 0x83) requireThat(uint(payload, next) === 2, 'UNSUPPORTED_MEDIA_TYPE');
      requireThat(id.value !== 0x6d80, 'UNSUPPORTED_MEDIA_TYPE');
      if (id.value === 0x4489 && parent === 0x1549a966 && clearTiming) bytes.fill(0, payload, next);
      if (id.value === 0x1254c367 && clearTiming) bytes[at + 3] = 0x66;
      else if ([0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0x1f43b675, 0xa0].includes(id.value)) {
        const consumed = walk(payload, next, depth + 1, id.value, size.unknown);
        if (size.unknown) next = consumed; else valid(consumed === next);
      }
      if (id.value === 0xa3 || id.value === 0xa1) {
        valid(parent === (id.value === 0xa3 ? 0x1f43b675 : 0xa0));
        const track = vint(bytes, payload); valid(!track.unknown && track.value > 0 && next - payload > track.width + 3);
        blockTracks.add(track.value); blocks++;
      }
      at = next;
    }
    return at;
  }
  valid(walk(0, bytes.length, 0) === bytes.length);
  valid(headers === 1 && segments === 1 && infos === 1 && tracks === 1 && entries === 1 && docType && blocks > 0);
  valid(declaredTracks.size === 1 && blockTracks.size === 1 && declaredTracks.has([...blockTracks][0]));
  return bytes;
}
