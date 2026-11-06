import { parentPort, workerData } from 'node:worker_threads';
import { verifyProject } from './project.js';
try { parentPort.postMessage({ ok: true, value: verifyProject(workerData.project, { kind: workerData.kind }) }); }
catch (error) { parentPort.postMessage({ ok: false, error: error.message }); }
