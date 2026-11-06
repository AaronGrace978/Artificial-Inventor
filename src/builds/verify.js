import { Worker } from 'node:worker_threads';

// Parses generated source using fixed trusted code. It never runs that source.
export function verifyProjectInWorker(project, kind) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./verify-worker.js', import.meta.url), {
      workerData: { project, kind }, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 }
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Source validation exceeded its ten-second limit.'));
    }, 10_000);
    worker.once('message', result => {
      clearTimeout(timer);
      if (result.ok) resolve(result.value);
      else reject(new Error(result.error));
    });
    worker.once('error', () => { clearTimeout(timer); reject(new Error('The isolated source validator failed.')); });
    worker.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('The isolated source validator stopped unexpectedly.'));
    });
  });
}
