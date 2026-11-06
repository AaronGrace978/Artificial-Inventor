import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'Electron desktop smoke requires a display; run with xvfb-run on Linux.');

test('real Electron app computes, preserves evidence, restricts IPC, and protects session-only keys', async ({}, testInfo) => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'artificial-inventor-desktop-'));
  const launch = () => electron.launch({
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '.'],
    cwd: repository,
    env: { ...process.env, ARTIFICIAL_INVENTOR_DATA_DIR: directory },
  });
  let application;
  try {
    application = await launch();
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.inventor));
    const initial = await window.evaluate(() => window.inventor.getState());
    expect(initial.runs).toEqual([]);
    expect(initial.ledgerIntegrity.valid).toBe(true);
    expect(initial.providers.some(provider => provider.id === 'ollama')).toBe(true);
    expect(initial.selectedModel).toBeNull();
    await expect(window.locator('#app-version')).toHaveText(initial.version);

    // Exercise the actual renderer -> preload -> IPC -> worker -> ledger path.
    await window.locator('input[name="budget"]').fill('20');
    await window.locator('#run-button').click();
    await expect(window.locator('#results-panel')).toBeVisible();
    await expect(window.locator('#result-evidence')).toContainText('E2');
    const completed = await window.evaluate(() => window.inventor.getState());
    expect(completed.runs).toHaveLength(1);
    const run = completed.runs[0];
    expect(run.candidates).toHaveLength(20);
    expect(run.summary.budgetUsed).toBe(20);
    expect(run.verification.physicalValidation).toBe('not-performed');
    expect(run.generator.kind).toBe('offline-seeded-search');
    expect(run.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(completed.ledgerIntegrity.valid).toBe(true);
    await window.screenshot({ path: testInfo.outputPath('desktop-research.png'), fullPage: true });

    const invalid = await window.evaluate(async () => {
      try { await window.inventor.runResearch({ budget: 100_000 }); return 'unexpected acceptance'; }
      catch (error) { return error.message; }
    });
    expect(invalid).toMatch(/budget/);

    // A second BrowserWindow has the same preload but is not an authorized sender.
    const unauthorized = await application.evaluate(async ({ BrowserWindow }, preloadPath) => {
      const primary = BrowserWindow.getAllWindows()[0];
      const stranger = new BrowserWindow({
        show: false,
        webPreferences: {
          // Electron 45 omits preload paths from getLastWebPreferences(). Use
          // the same known local preload explicitly, rather than a missing copy.
          preload: preloadPath,
          contextIsolation: true, sandbox: true, nodeIntegration: false,
        },
      });
      try {
        await stranger.loadURL(primary.webContents.getURL());
        return await stranger.webContents.executeJavaScript('window.inventor.getState().then(() => "unexpected acceptance", error => error.message)');
      } finally { stranger.destroy(); }
    }, join(repository, 'src', 'preload.cjs'));
    expect(unauthorized).toMatch(/not authorized/);

    // Simulate unavailable OS encryption inside this test process. No provider
    // request is issued: remove the fake key before relaunching the application.
    await application.evaluate(({ safeStorage }) => { safeStorage.isEncryptionAvailable = () => false; });
    const fakeKey = 'test-only-not-a-real-provider-api-key';
    const saved = await window.evaluate(key => window.inventor.saveProviderKey({ providerId: 'openai', key }), fakeKey);
    expect(saved.persisted).toBe(false);
    const keyedState = await window.evaluate(() => window.inventor.getState());
    expect(keyedState.credentialStorage).toBe('session-only');
    expect(keyedState.providers.find(provider => provider.id === 'openai').configured).toBe(true);
    expect(JSON.stringify(keyedState)).not.toContain(fakeKey);
    expect(await readFile(join(directory, 'settings.json'), 'utf8')).not.toContain(fakeKey);
    expect(await window.evaluate(() => Object.keys(window.inventor))).not.toContain('getKey');
    await window.evaluate(() => window.inventor.removeProviderKey('openai'));

    await application.close();
    application = await launch();
    const restartedWindow = await application.firstWindow();
    await restartedWindow.waitForFunction(() => Boolean(window.inventor));
    const restored = await restartedWindow.evaluate(() => window.inventor.getState());
    expect(restored.runs).toHaveLength(1);
    expect(restored.runs[0].id).toBe(run.id);
    expect(restored.runs[0].evidenceHash).toBe(run.evidenceHash);
    expect(restored.ledgerIntegrity.valid).toBe(true);
    expect(restored.providers.every(provider => !provider.configured)).toBe(true);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
