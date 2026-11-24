import { COMPANION_LIMITS } from '../companion/contracts';
import { CompanionFailure, fail, requireTrue, SerialQueue } from '../companion/core';
import type { VoicePorts } from './controller';
import type { AudioClip } from './transcription';

export type WebRecordingEnvironment = {
  getUserMedia(): Promise<MediaStream>;
  createRecorder(stream: MediaStream, mimeType: string): MediaRecorder;
  supports(mimeType: string): boolean;
  now(): number;
};
const browser: WebRecordingEnvironment = {
  getUserMedia: () => {
    requireTrue(typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia, 'UNSUPPORTED');
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  },
  createRecorder: (stream, mimeType) => new MediaRecorder(stream, { mimeType }),
  supports: mimeType => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType),
  now: () => performance.now(),
};

/** 自持有浏览器音轨，取消未决权限或准备阶段也能释放麦克风，不依赖 SDK 内部私有字段。 */
export function createWebRecorder(environment: WebRecordingEnvironment = browser): VoicePorts['recorder'] {
  const queue = new SerialQueue();
  let epoch = 0;
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let completed: Promise<AudioClip> | null = null;
  let endTime: number | null = null;
  const releaseTracks = () => { stream?.getTracks().forEach(track => track.stop()); stream = null; };
  const stopMedia = () => { if (recorder && recorder.state !== 'inactive') recorder.stop(); };
  return {
    start: (signal, onStopped) => {
      const generation = ++epoch;
      return queue.run(async () => {
      if (signal.aborted || generation !== epoch) fail('CANCELLED');
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(environment.supports);
      requireTrue(mimeType, 'UNSUPPORTED_MEDIA_TYPE');
      const obtained = await environment.getUserMedia();
      if (signal.aborted || generation !== epoch) { obtained.getTracks().forEach(track => track.stop()); fail('CANCELLED'); }
      stream = obtained;
      try {
        const media = environment.createRecorder(obtained, mimeType);
        const release = () => { obtained.getTracks().forEach(track => track.stop()); if (stream === obtained) stream = null; };
        const stop = () => { if (media.state !== 'inactive') media.stop(); };
        recorder = media; endTime = null;
        const started = environment.now(); const chunks: Blob[] = []; let bytes = 0;
        let error: CompanionFailure | null = null;
        completed = new Promise<AudioClip>((resolve, reject) => {
          media.ondataavailable = event => {
            bytes += event.data.size;
            if (bytes > COMPANION_LIMITS.maxAudioBytes) { error = new CompanionFailure('PAYLOAD_TOO_LARGE'); stop(); release(); }
            else chunks.push(event.data);
          };
          media.onerror = () => { error = new CompanionFailure('PERMISSION_DENIED'); stop(); release(); reject(error); if (generation === epoch && !signal.aborted) onStopped?.(error.detail); };
          media.onstop = () => {
            release();
            if (signal.aborted || generation !== epoch) { reject(new CompanionFailure('CANCELLED')); return; }
            if (error) { reject(error); onStopped?.(error.detail); return; }
            const actualMime = media.mimeType || mimeType;
            const extension = actualMime.split(';')[0] === 'audio/mp4' ? 'mp4' : 'webm';
            const durationMs = Math.round((endTime ?? environment.now()) - started);
            const blob = new Blob(chunks, { type: actualMime });
            void blob.arrayBuffer().then(buffer => resolve({ bytes: new Uint8Array(buffer), filename: `recording.${extension}`, mimeType: actualMime, durationMs }), reject);
            onStopped?.();
          };
        });
        void completed.catch(() => undefined);
        media.start(250);
      } catch (error) { releaseTracks(); recorder = null; throw error; }
      });
    },
    stop: () => queue.run(async () => {
      requireTrue(completed && recorder, 'INVALID_REQUEST');
      endTime = environment.now(); stopMedia();
      try { return await completed; } finally { releaseTracks(); recorder = null; completed = null; }
    }),
    cancel: () => {
      epoch++;
      try { stopMedia(); } finally { releaseTracks(); }
      return queue.run(async () => { recorder = null; completed = null; endTime = null; });
    },
  };
}
