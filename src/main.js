import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from 'electron';
import updaterPackage from 'electron-updater';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { SettingsStore } from './settings.js';
import { UpdateManager } from './updates.js';
import { EvidenceLedger } from './core/ledger.js';
import { DEFAULT_SPEC, validateSpec } from './core/research.js';
import { listProviders, discoverModels, generateProposals } from './providers/index.js';
import { runComputation } from './runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererURL = pathToFileURL(path.join(here, 'renderer/index.html')).href;
const CATALOG_TTL = 6 * 60 * 60 * 1000;
let mainWindow, store, ledger, updates, providerSession;
let running = false;
const refreshes = new Map();
const credentialEpochs = new Map();
const providers = listProviders();
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
async function refreshCatalog(id) {
  provider(id);
  if (refreshes.has(id)) return refreshes.get(id);
  const epoch = credentialEpochs.get(id) ?? 0;
  const refresh = (async () => {
    const key = store.getKey(id);
    if (!key) throw new Error('Connect this provider with your API key first.');
    try {
      const models = await discoverModels(id, key, { fetchImpl: (url, options) => providerSession.fetch(url, options) });
      if (epoch !== (credentialEpochs.get(id) ?? 0)) throw new Error('The provider connection changed. Refresh its catalog again.');
      store.data.catalogs[id] = { models, refreshedAt: new Date().toISOString(), error: null };
      await store.persist();
      return models;
    } catch (error) {
      if (epoch !== (credentialEpochs.get(id) ?? 0)) throw error;
      store.data.catalogs[id] = { ...(store.data.catalogs[id] ?? { models: [] }), error: error.message };
      await store.persist();
      throw error;
    }
  })();
  refreshes.set(id, refresh);
  try { return await refresh; } finally { if (refreshes.get(id) === refresh) refreshes.delete(id); }
}
async function refreshConfigured() {
  await Promise.allSettled(providers.filter(item => store.configured(item.id)).map(item => refreshCatalog(item.id)));
}
async function start() {
  store = new SettingsStore(app.getPath('userData'), safeStorage);
  await store.load();
  ledger = new EvidenceLedger(path.join(app.getPath('userData'), 'evidence'));
  providerSession = session.fromPartition('provider-transport');
  providerSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  // Chromium networking honors OS trust and proxy configuration; this explicit
  // setting also supports the managed cloud's inherited HTTP proxy.
  const proxyURL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxyURL) await providerSession.setProxy({ proxyRules: proxyURL });
  updates = new UpdateManager(updaterPackage.autoUpdater, app.isPackaged && process.platform === 'win32');
  updates.on('change', value => mainWindow?.webContents.send('inventor:update-state', value));
  // No browser-origin requests are necessary. All provider calls use fixed main-process adapters.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file://') && !details.url.startsWith('devtools://') }));
  register('state', async () => {
    const evidence = await evidenceState();
    return {
      version: app.getVersion(), electronVersion: process.versions.electron, defaultSpec: DEFAULT_SPEC,
      providers: providers.map(item => ({ ...item, configured: store.configured(item.id) })),
      selectedModel: store.data.selectedModel, modelCatalogs: store.data.catalogs,
      runs: evidence.runs.slice(0, 50), ledgerIntegrity: evidence.integrity, evidenceEvents: evidence.events,
      update: updates.state, running,
      credentialStorage: store.canEncrypt() ? 'os-encrypted' : 'session-only',
    };
  });
  register('evidence', evidenceState);
  register('save-key', async input => {
    if (!input || typeof input !== 'object') throw new Error('Provider details are required.');
    const id = provider(input.providerId);
    const result = await store.saveKey(id, input.key);
    credentialEpochs.set(id, (credentialEpochs.get(id) ?? 0) + 1);
    refreshes.delete(id);
    delete store.data.catalogs[id];
    if (store.data.selectedModel?.providerId === id) store.data.selectedModel = null;
    await store.persist();
    return result;
  });
  register('remove-key', async id => {
    provider(id);
    credentialEpochs.set(id, (credentialEpochs.get(id) ?? 0) + 1);
    refreshes.delete(id);
    return store.removeKey(id);
  });
  register('models', refreshCatalog);
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
    if (running) throw new Error('A research run is already in progress.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A research specification is required.');
    const { useCloud = false, ...fields } = input;
    if (typeof useCloud !== 'boolean') throw new Error('Cloud proposal permission must be explicit.');
    const spec = validateSpec(fields);
    running = true;
    let started = false;
    try {
      await ledger.append('research.started', { spec, useCloud });
      started = true;
      let generation = null;
      if (useCloud) {
        const selection = store.data.selectedModel;
        if (!selection) throw new Error('Connect and select a cloud model first, or run the offline search.');
        const catalog = store.data.catalogs[selection.providerId];
        if (!catalog || catalog.error || Date.now() - Date.parse(catalog.refreshedAt) > CATALOG_TTL) await refreshCatalog(selection.providerId);
        if (!store.data.catalogs[selection.providerId].models.some(item => item.id === selection.model)) throw new Error('The selected model is no longer listed. Choose another model explicitly.');
        generation = await generateProposals({ ...selection, key: store.getKey(selection.providerId), spec }, { fetchImpl: (url, options) => providerSession.fetch(url, options) });
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
    } finally { running = false; }
  });
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
  register('install-update', () => updates.install());
  createWindow();
  // Catalog refresh discovers new IDs without silently changing a qualified model.
  void refreshConfigured();
  void updates.check();
  setInterval(() => { void refreshConfigured(); void updates.check(); }, CATALOG_TTL).unref();
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
