import { parentPort, workerData } from 'node:worker_threads';
import { createResearchRun } from './core/research.js';
try { parentPort.postMessage({ ok: true, value: createResearchRun(workerData.spec, { proposals: workerData.proposals }) }); }
catch (error) { parentPort.postMessage({ ok: false, error: error.message }); }
