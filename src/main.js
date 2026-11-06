import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, protocol } from 'electron';
import updaterPackage from 'electron-updater';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SettingsStore } from './settings.js';
import { UpdateManager } from './updates.js';
import { EvidenceLedger } from './core/ledger.js';
import { DEFAULT_SPEC, validateSpec } from './core/research.js';
import { listProviders, discoverModels, generateProposals, generateProject } from './providers/index.js';
import { runComputation } from './runner.js';
import { CatalogService, CATALOG_REFRESH_MS } from './catalogs.js';
import { ProjectStore } from './builds/store.js';
import { createDemoProject } from './builds/project.js';
import { createPreviewHandler } from './preview.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererURL = pathToFileURL(path.join(here, 'renderer/index.html')).href;
const APP_UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
let mainWindow, store, ledger, updates, providerSession, catalogs, projects;
let running = false;
let buildController = null;
let researchController = null;
const providers = listProviders();
const previewProjects = new Map();
protocol.registerSchemesAsPrivileged([{ scheme: 'inventor-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
// Test-only data isolation is unavailable in distributed applications.
if (!app.isPackaged && process.env.ARTIFICIAL_INVENTOR_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.ARTIFICIAL_INVENTOR_DATA_DIR));
}

// Never allow two processes to write the same evidence and settings store.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.whenReady().then(start).catch(() => {
    dialog.showErrorBox('Artificial Inventor could not start', 'Local application data could not be initialized. Preserve the settings and evidence files before troubleshooting.');
    app.quit();
  });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length && store) createWindow(); });

function provider(id) {
  if (typeof id !== 'string' || !providers.some(item => item.id === id)) throw new Error('Unknown model provider.');
  return id;
}
function register(name, handler) {
  ipcMain.handle(`inventor:${name}`, async (event, ...args) => {
    // Only the local, top-level application document may invoke capabilities.
    if (!mainWindow || event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== rendererURL) {
      return { ok: false, error: 'This document is not authorized.' };
    }
    try { return { ok: true, value: await handler(...args) }; }
    catch (error) {
      // No underlying network body, stack, filesystem path, or credential is sent to the renderer.
      const safe = /^E[A-Z]+$/.test(error.code ?? '') ? 'Local storage could not be read or written. Check file permissions and available disk space.'
        : typeof error.message === 'string' && error.message.length < 1500 ? error.message : 'The operation failed. Check your configuration.';
      return { ok: false, error: safe };
    }
  });
}
async function evidenceState() {
  const integrity = await ledger.verify();
  const records = integrity.valid ? await ledger.read() : [];
  return {
    integrity,
    runs: records.filter(record => record.type === 'research.completed').map(record => ({ ...record.payload.run, evidenceHash: record.hash })).reverse(),
    events: records.map(record => ({ type: record.type, timestamp: record.timestamp, hash: record.hash, ...(record.payload.message ? { message: record.payload.message } : {}), ...(record.payload.run?.id ? { runId: record.payload.run.id } : {}) })).reverse()
  };
}
async function start() {
  store = new SettingsStore(app.getPath('userData'), safeStorage);
  await store.load();
  if (store.data.buildDraft?.status === 'started') {
    store.data.buildDraft.status = 'interrupted';
    await store.persist();
  }
  ledger = new EvidenceLedger(path.join(app.getPath('userData'), 'evidence'));
  projects = new ProjectStore(path.join(app.getPath('userData'), 'projects'));
  protocol.handle('inventor-preview', createPreviewHandler(async id => previewProjects.get(id)));
  providerSession = session.fromPartition('provider-transport');
  providerSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  // Chromium networking honors OS trust and proxy configuration; this explicit
  // setting also supports the managed cloud's inherited HTTP proxy.
  const proxyURL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxyURL) await providerSession.setProxy({ proxyRules: proxyURL });
  catalogs = new CatalogService({ providers, store, discover: (id, key) => discoverModels(id, key, { fetchImpl: (url, options) => providerSession.fetch(url, options) }) });
  catalogs.on('change', value => mainWindow?.webContents.send('inventor:catalog-state', value));
  updates = new UpdateManager(updaterPackage.autoUpdater, app.isPackaged && process.platform === 'win32');
  updates.on('change', value => mainWindow?.webContents.send('inventor:update-state', value));
  // No browser-origin requests are necessary. All provider calls use fixed main-process adapters.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['file:', 'devtools:', 'inventor-preview:'].includes(new URL(details.url).protocol) }));
  register('state', async () => {
    const evidence = await evidenceState();
    return {
      version: app.getVersion(), electronVersion: process.versions.electron, defaultSpec: DEFAULT_SPEC,
      providers: providers.map(item => ({ ...item, configured: store.configured(item.id) })),
      selectedModel: store.data.selectedModel, modelCatalogs: store.data.catalogs,
      runs: evidence.runs.slice(0, 50), ledgerIntegrity: evidence.integrity, evidenceEvents: evidence.events,
      update: updates.state, running,
      credentialStorage: store.canEncrypt() ? 'os-encrypted' : 'session-only',
      catalogRefreshMinutes: CATALOG_REFRESH_MS / 60_000,
      buildDraft: store.data.buildDraft ?? null,
    };
  });
  register('evidence', evidenceState);
  register('projects', () => projects.list());
  register('build', async input => {
    if (buildController || running) throw new Error('Wait for the current operation to finish, or cancel it first.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A project goal is required.');
    const { objective, kind = 'web-app', demo = false, timeoutMs = 600_000 } = input;
    if (typeof objective !== 'string' || !objective.trim() || objective.length > 6000) throw new Error('Describe the project in 1–6000 characters.');
    if (!['web-app', 'code-project'].includes(kind) || typeof demo !== 'boolean') throw new Error('Choose a supported project type.');
    if (![180_000, 300_000, 600_000].includes(timeoutMs)) throw new Error('Choose a supported response time limit.');
    const controller = new AbortController();
    buildController = controller;
    const startedAt = Date.now();
    const jobId = randomUUID();
    const progress = value => mainWindow?.webContents.send('inventor:build-progress', { ...value, jobId, elapsedMs: Date.now() - startedAt });
    try {
      store.data.buildDraft = { objective, kind, timeoutMs, jobId, status: 'started', startedAt: new Date().toISOString() };
      await store.persist();
      progress({ status: 'waiting', message: demo ? 'Creating the local example project…' : 'Waiting for the selected cloud model. Your task is saved locally.' });
      let generated, generator;
      if (demo) {
        generated = createDemoProject();
        generator = { kind: 'offline-example', limitation: 'Demonstration project, not generated by a cloud model.' };
      } else {
        const selection = await requireSelectedModel(controller.signal);
        const result = await generateProject({ ...selection, key: store.getKey(selection.providerId), objective, kind, signal: controller.signal, onProgress: progress }, { timeoutMs, fetchImpl: (url, options) => providerSession.fetch(url, options) });
        generated = result.project;
        generator = { providerId: result.providerId, model: result.model, generatedAt: result.generatedAt };
      }
      if (controller.signal.aborted) throw new Error('Build cancelled. The task is saved for another attempt.');
      progress({ status: 'validating', message: 'Checking project paths, file limits, JSON and JavaScript syntax. No generated program runs in the main process.' });
      const project = await projects.save(generated, { objective, generator, kind: demo ? 'web-app' : kind });
      store.data.buildDraft.status = 'completed';
      store.data.buildDraft.projectId = project.id;
      await store.persist();
      progress({ status: 'complete', message: project.verification.passed ? 'Project saved. Implemented static checks passed; runtime behavior still needs testing.' : 'Project saved with validation failures. Review the reported problems before using it.' });
      return project;
    } catch (error) {
      if (store.data.buildDraft?.jobId === jobId) {
        store.data.buildDraft.status = controller.signal.aborted ? 'cancelled' : 'failed';
        await store.persist().catch(() => {});
      }
      progress({ status: controller.signal.aborted ? 'cancelled' : 'error', message: controller.signal.aborted ? 'Build cancelled. The task remains saved locally.' : 'Generation failed. The task remains saved locally for retry.' });
      throw error;
    } finally { buildController = null; }
  });
  register('cancel-build', () => { buildController?.abort(); return { cancelled: Boolean(buildController) }; });
  register('preview-project', async id => {
    const project = await projects.get(id);
    if (project.kind !== 'web-app') throw new Error('Only static browser projects have an in-app preview. Export other projects to their documented toolchain.');
    previewProjects.clear();
    previewProjects.set(project.id, project);
    return { url: `inventor-preview://p-${project.id}/index.html` };
  });
  register('export-project', async id => {
    await projects.get(id);
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose a folder for a new project directory', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, ...await projects.export(id, result.filePaths[0]) };
  });
  register('save-key', async input => {
    if (!input || typeof input !== 'object') throw new Error('Provider details are required.');
    const id = provider(input.providerId);
    const result = await store.saveKey(id, input.key);
    catalogs.invalidate(id);
    if (store.data.selectedModel?.providerId === id) store.data.selectedModel = null;
    await store.persist();
    return result;
  });
  register('remove-key', async id => {
    provider(id);
    catalogs.invalidate(id);
    return store.removeKey(id);
  });
  register('models', id => catalogs.refresh(provider(id)));
  register('select-model', async selection => {
    if (selection === null) { store.data.selectedModel = null; await store.persist(); return null; }
    if (!selection || typeof selection !== 'object') throw new Error('Select a provider and a model.');
    const id = provider(selection.providerId);
    if (!store.configured(id) || !store.data.catalogs[id]?.models.some(item => item.id === selection.model)) throw new Error('Refresh the provider catalog and select an available model.');
    store.data.selectedModel = { providerId: id, model: selection.model };
    await store.persist();
    return store.data.selectedModel;
  });
  register('research', async input => {
    if (running || buildController) throw new Error('Wait for the current operation to finish, or cancel it first.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A research specification is required.');
    const { useCloud = false, ...fields } = input;
    if (typeof useCloud !== 'boolean') throw new Error('Cloud proposal permission must be explicit.');
    const spec = validateSpec(fields);
    running = true;
    researchController = new AbortController();
    let started = false;
    try {
      await ledger.append('research.started', { spec, useCloud });
      started = true;
      let generation = null;
      if (useCloud) {
        const selection = await requireSelectedModel(researchController.signal);
        generation = await generateProposals({ ...selection, key: store.getKey(selection.providerId), spec, signal: researchController.signal, onProgress: value => mainWindow?.webContents.send('inventor:research-progress', value) }, { fetchImpl: (url, options) => providerSession.fetch(url, options) });
        await ledger.append('proposal.received', generation);
      }
      const run = await runComputation(spec, generation?.proposals ?? []);
      run.generator = generation ? { providerId: generation.providerId, model: generation.model, generatedAt: generation.generatedAt } : { kind: 'offline-seeded-search' };
      run.software = { app: app.getVersion(), electron: process.versions.electron, node: process.versions.node };
      const record = await ledger.append('research.completed', { run });
      return { ...run, evidenceHash: record.hash };
    } catch (error) {
      if (started) await ledger.append('research.failed', { message: error.message, spec }).catch(() => {});
      throw error;
    } finally { running = false; researchController = null; }
  });
  register('cancel-research', () => { researchController?.abort(); return { cancelled: Boolean(researchController) }; });
  register('export', async runId => {
    if (runId !== undefined && runId !== null && (typeof runId !== 'string' || runId.length > 100)) throw new Error('Invalid research identifier.');
    const records = await ledger.read();
    const selected = runId ? records.find(record => record.type === 'research.completed' && record.payload.run.id === runId) : null;
    if (runId && !selected) throw new Error('This research run was not found.');
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Export evidence package', defaultPath: `artificial-inventor-${selected ? 'run' : 'ledger'}.json`, filters: [{ name: 'JSON evidence', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    const evidence = { format: 'artificial-inventor-evidence-v1', exportedAt: new Date().toISOString(), integrity: await ledger.verify(), records, ...(selected ? { selectedRunId: runId } : {}), limitation: 'Local hash chain; independent external anchoring is required to establish stronger provenance. E2 is computational evidence only.' };
    await writeFile(result.filePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    return { canceled: false, path: result.filePath };
  });
  register('updates', () => updates.check());
  register('install-update', async () => {
    if (running || buildController) throw new Error('Finish or cancel the active task before installing an update.');
    await store.writes;
    return updates.install();
  });
  createWindow();
  // Catalog refresh discovers new IDs without silently changing a qualified model.
  void catalogs.refreshConfigured();
  void updates.check();
  setInterval(() => { void catalogs.refreshConfigured(); }, CATALOG_REFRESH_MS).unref();
  setInterval(() => { void updates.check(); }, APP_UPDATE_INTERVAL).unref();
}
async function requireSelectedModel(signal) {
  const selection = store.data.selectedModel && { ...store.data.selectedModel };
  if (!selection) throw new Error('Connect and select a cloud model first, or use the explicit offline example.');
  if (!catalogs.fresh(selection.providerId)) {
    const refresh = catalogs.refresh(selection.providerId);
    await new Promise((resolve, reject) => {
      const abort = () => reject(new Error('Model request cancelled. The task remains saved locally.'));
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      refresh.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
    });
  }
  if (signal?.aborted) throw new Error('Model request cancelled. The task remains saved locally.');
  if (!store.data.catalogs[selection.providerId]?.models.some(item => item.id === selection.model)) throw new Error('The selected model is no longer listed. Choose another model explicitly.');
  return selection;
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 980, minWidth: 1000, minHeight: 720,
    backgroundColor: '#0c1017', title: 'Artificial Inventor', autoHideMenuBar: true, icon: path.join(here, '../resources/icon.png'),
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
  void mainWindow.loadURL(rendererURL);
}
