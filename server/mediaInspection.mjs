import { Worker } from 'node:worker_threads';
import { COMPANION_LIMITS as LIMITS } from '../app/src/companion/contracts.ts';
import { fail, requireThat, checkBodySize } from './companionProtocol.mjs';

let activeWorkers = 0;
/** 堆限制不覆盖所有外部内存；另限输入、复制次数和并发，不排队持有媒体。 */
export async function inspectMedia(kind, bytes, { signal, mimeType, timeoutMs = 4000 } = {}) {
  requireThat(['jpeg', 'audio'].includes(kind), 'INVALID_REQUEST');
  requireThat(bytes instanceof Uint8Array && bytes.length > 0, 'INVALID_REQUEST');
  checkBodySize(bytes.length, kind === 'jpeg' ? LIMITS.maxJpegBytes : LIMITS.maxAudioBytes);
  if (signal?.aborted) throw fail('CANCELLED');
  requireThat(activeWorkers < 2, 'LIMIT_REACHED');
  activeWorkers++;
  let worker;
  try {
    // 精确大小的新 ArrayBuffer 可安全转移，避免复制 Node Buffer 池或泄漏相邻数据。
    const input = Uint8Array.from(bytes);
    worker = new Worker(new URL('./mediaWorker.mjs', import.meta.url), {
      workerData: { kind, bytes: input, mimeType }, transferList: [input.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      env: {}, execArgv: [], stdout: true, stderr: true,
    });
    worker.stdout.resume(); worker.stderr.resume();
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(fail('CANCELLED'));
      const timer = setTimeout(() => finish(fail('TIMEOUT')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      worker.once('message', result => result.ok ? finish(null, result.value) : finish(fail(result.code || 'INVALID_REQUEST')));
      worker.once('error', () => finish(fail('INVALID_REQUEST')));
      worker.once('exit', () => { if (!settled) finish(fail('INVALID_REQUEST')); });
    });
  } finally {
    await worker?.terminate(); activeWorkers--;
  }
}
