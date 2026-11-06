import { Worker } from 'node:worker_threads';

// Fixed, trusted numerical code only. Model output is data, never code or tools.
export function runComputation(spec, proposals = []) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./run-worker.js', import.meta.url), {
      workerData: { spec, proposals },
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 }
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('The computation exceeded its 20-second limit.'));
    }, 20_000);
    worker.once('message', result => {
      clearTimeout(timer);
      if (result.ok) resolve(result.value);
      else reject(new Error(result.error));
    });
    worker.once('error', () => { clearTimeout(timer); reject(new Error('The isolated computation worker failed.')); });
    worker.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('The isolated computation worker stopped unexpectedly.'));
    });
  });
}
