import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { createPreviewHandler } from '../preview.js';

// Fixed automation in an unprivileged renderer. Model-provided JavaScript is
// never evaluated by the main process; declarative checks have bounded actions.
async function inspect(tests) {
  const wait = () => new Promise(resolve => setTimeout(resolve, 100));
  await wait();
  const checks = [];
  const body = document.body;
  checks.push({ kind: 'browser', path: 'index.html', passed: Boolean(body && (body.innerText.trim() || body.querySelector('svg,canvas,img'))), message: 'Browser document renders visible content or a graphic.' });
  for (const test of tests) {
    try {
      for (const action of test.actions) {
        const element = document.querySelector(action.selector);
        if (!element) throw new Error('An action target was not found.');
        if (action.type === 'click') element.click();
        else {
          element.value = action.value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await wait();
      }
      const target = document.querySelector(test.expect.selector);
      const passed = Boolean(target && (target.textContent || '').includes(test.expect.textIncludes));
      checks.push({ kind: 'interaction', path: 'index.html', passed, message: `${test.name}: ${passed ? 'expected visible text found' : 'expected visible text not found'}.` });
    } catch {
      checks.push({ kind: 'interaction', path: 'index.html', passed: false, message: `${test.name}: an action or selector failed.` });
    }
  }
  return checks;
}

/** Isolated, offline browser smoke run. Not a correctness or containment proof. */
export async function checkInBrowser(project, tests = [], signal) {
  const partition = session.fromPartition(`build-check-${randomUUID()}`);
  const id = randomUUID();
  const checks = [];
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.on('will-download', event => event.preventDefault());
  partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['inventor-preview:', 'devtools:'].includes(new URL(details.url).protocol) }));
  partition.protocol.handle('inventor-preview', createPreviewHandler(async candidate => candidate === id ? { ...project, id, kind: 'web-app' } : null));
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => event.preventDefault());
  window.webContents.on('console-message', (event, level, message, _line, source) => {
    const severity = event.level ?? level;
    if (severity !== 'error' && severity !== 3) return;
    const text = String(event.message ?? message ?? 'Browser error').slice(0, 300);
    let path = 'index.html';
    try { const candidate = decodeURIComponent(new URL(event.sourceId ?? source).pathname).slice(1); if (project.files.some(file => file.path === candidate)) path = candidate; } catch {}
    if (checks.length < 20) checks.push({ kind: 'browser-error', path, passed: false, message: text });
  });
  let timer, abort;
  try {
    const failure = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Browser check exceeded its six-second limit.')), 6000);
      abort = () => reject(new Error('Browser check cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      window.webContents.once('render-process-gone', () => reject(new Error('The isolated preview renderer stopped.')));
    });
    const run = async () => {
      await window.loadURL(`inventor-preview://p-${id}/index.html`);
      return window.webContents.executeJavaScript(`(${inspect.toString()})(${JSON.stringify(tests)})`);
    };
    checks.push(...await Promise.race([run(), failure]));
  } catch (error) {
    checks.push({ kind: 'browser', path: 'index.html', passed: false, message: error.message === 'Browser check exceeded its six-second limit.' ? error.message : 'The isolated browser check could not complete.' });
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    if (!window.isDestroyed()) window.destroy();
    partition.protocol.unhandle('inventor-preview');
  }
  return checks;
}
