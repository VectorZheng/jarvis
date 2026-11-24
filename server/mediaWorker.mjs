import { parentPort, workerData } from 'node:worker_threads';
import { COMPANION_LIMITS as LIMITS } from '../app/src/companion/contracts.ts';
import { sniffAudio, wavDuration, mp3Duration, mp4Duration, webmTimingBuffer } from './audioContainers.mjs';
import { requireThat } from './companionProtocol.mjs';

// 资料：https://unpkg.com/jpeg-js@0.4.4/README.md
// https://unpkg.com/music-metadata@12.7.0/README.md
// 解析器不解码音频波形；返回的是经字节结构交叉验证的容器时长，不是语音识别成功。
try {
  const bytes = Buffer.from(workerData.bytes.buffer, workerData.bytes.byteOffset, workerData.bytes.byteLength);
  if (workerData.kind === 'jpeg') {
    const { default: jpeg } = await import('jpeg-js');
    const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false, tolerantDecoding: false, maxResolutionInMP: LIMITS.maxImageLongestEdge ** 2 / 1000000, maxMemoryUsageInMB: 32 });
    requireThat(image.width >= 1 && image.height >= 1 && image.width <= LIMITS.maxImageLongestEdge && image.height <= LIMITS.maxImageLongestEdge, 'INVALID_REQUEST');
    parentPort.postMessage({ ok: true, value: { width: image.width, height: image.height } });
  } else {
    const container = sniffAudio(bytes, workerData.mimeType);
    let duration;
    if (container === 'wav') duration = wavDuration(bytes);
    if (container === 'mp3') duration = mp3Duration(bytes);
    if (container === 'mp4') duration = mp4Duration(bytes);
    if (container === 'webm') webmTimingBuffer(bytes, false);
    const { parseBuffer } = await import('music-metadata');
    const options = { duration: true, skipCovers: true, skipPostHeaders: false, maxMemoryAllocation: 2 * 1024 * 1024, maxMetadataEntries: 2000 };
    const result = await parseBuffer(bytes, { mimeType: workerData.mimeType, size: bytes.length }, options);
    const format = result.format;
    requireThat(!result.quality?.warnings?.length && !format.hasVideo && format.sampleRate > 0 && format.numberOfChannels > 0, 'INVALID_REQUEST');
    if (container === 'webm') {
      requireThat(format.trackInfo?.length === 1 && format.trackInfo[0].audio && !format.trackInfo[0].video, 'UNSUPPORTED_MEDIA_TYPE');
      const scanned = await parseBuffer(webmTimingBuffer(bytes), { mimeType: 'audio/webm', size: bytes.length }, options);
      requireThat(!scanned.quality?.warnings?.length && !scanned.format.hasVideo, 'INVALID_REQUEST');
      duration = scanned.format.duration;
    }
    requireThat(Number.isFinite(duration) && duration > 0 && duration * 1000 <= LIMITS.maxAudioDurationMs, 'INVALID_REQUEST');
    // 编码延迟/末包填充允许小误差，但不能用短声明掩盖完整采样表或块时间线。
    if (format.duration !== undefined) requireThat(Number.isFinite(format.duration) && format.duration > 0 && format.duration * 1000 <= LIMITS.maxAudioDurationMs && Math.abs(format.duration - duration) <= 0.25, 'INVALID_REQUEST');
    parentPort.postMessage({ ok: true, value: { durationMs: duration * 1000, container } });
  }
} catch (error) {
  parentPort.postMessage({ ok: false, code: ['INVALID_REQUEST', 'UNSUPPORTED_MEDIA_TYPE'].includes(error?.code) ? error.code : 'INVALID_REQUEST' });
}
