import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'Run with a desktop or xvfb-run.');

test('Build studio creates usable source, isolated browser execution and a real exported project', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inventor-build-e2e-'));
  const exportRoot = await mkdtemp(join(tmpdir(), 'inventor-export-e2e-'));
  const application = await electron.launch({ args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '.'], cwd: repository, env: { ...process.env, ARTIFICIAL_INVENTOR_DATA_DIR: directory } });
  try {
    const window = await application.firstWindow();
    await expect(window.locator('#build-demo')).toBeVisible();
    await window.locator('#build-demo').click();
    await expect(window.locator('#build-output')).toBeVisible();
    const projects = await window.evaluate(() => window.inventor.listProjects());
    expect(projects).toHaveLength(1);
    const project = projects[0];
    expect(project.verification.passed).toBe(true);
    expect(project.generator.kind).toBe('offline-example');
    expect(project.files.some(file => file.path === 'index.html')).toBe(true);
    await window.locator('#build-preview-run').click();
    const frame = window.frameLocator('#build-preview');
    await expect(frame.locator('body')).toContainText('Idea');
    const isolation = await window.locator('#build-preview').contentFrame().locator('body').evaluate(() => {
      let parentAccess = false;
      try { parentAccess = Boolean(parent.inventor); } catch {}
      return { bridge: Boolean(window.inventor), parentAccess };
    });
    expect(isolation).toEqual({ bridge: false, parentAccess: false });
    expect(await window.locator('#build-preview').contentFrame().locator('body').evaluate(async () => {
      try { await fetch('https://example.com/'); return 'unexpected network access'; }
      catch { return 'network blocked'; }
    })).toBe('network blocked');
    // Exercise the demo's real JavaScript rather than merely loading HTML.
    await frame.locator('input').first().fill('A measured prototype');
    await frame.getByRole('button', { name: 'Add idea', exact: true }).click();
    await expect(frame.locator('body')).toContainText('A measured prototype');
    await application.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, exportRoot);
    const exported = await window.evaluate(id => window.inventor.exportProject(id), project.id);
    expect(exported.canceled).toBe(false);
    expect(await readFile(join(exported.path, 'index.html'), 'utf8')).toBe(project.files.find(file => file.path === 'index.html').content);
    await window.locator('#build-preview-stop').click();
    await expect(window.locator('#build-preview')).toHaveCount(0);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(exportRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('streamed model generation can be cancelled and retried into a working code project', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inventor-stream-build-'));
  const application = await electron.launch({ args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '.'], cwd: repository, env: { ...process.env, ARTIFICIAL_INVENTOR_DATA_DIR: directory } });
  try {
    await application.evaluate(({ session, safeStorage }) => {
      safeStorage.isEncryptionAvailable = () => false;
      globalThis.buildFixture = { mode: 'stall', requests: 0 };
      session.fromPartition('provider-transport').fetch = async (url, options) => {
        if (url.endsWith('/tags')) return new Response(JSON.stringify({ models: [{ name: 'synthetic-code-model:pro' }] }), { headers: { 'content-type': 'application/json' } });
        if (!url.endsWith('/chat')) throw new Error('Unexpected test request');
        globalThis.buildFixture.requests++;
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify({ message: { thinking: 'Private reasoning never sent to the interface' }, done: false }) + '\n'));
          if (globalThis.buildFixture.mode === 'complete') {
            const project = { title: 'Counter prototype', summary: 'A working local counter', files: [
              { path: 'index.html', content: '<!doctype html><html><head><title>Counter</title></head><body><button id="increment" type="button">Increment</button><output id="count">0</output><script src="app.js"></script></body></html>' },
              { path: 'app.js', content: 'let count=0;document.getElementById("increment").addEventListener("click",()=>{document.getElementById("count").textContent=String(++count);});' }
            ] };
            controller.enqueue(encoder.encode(JSON.stringify({ message: { content: JSON.stringify(project) }, done: true }) + '\n'));
            controller.close();
          }
        } }), { headers: { 'content-type': 'application/x-ndjson' } });
      };
    });
    const window = await application.firstWindow();
    await expect(window.locator('#build-demo')).toBeVisible();
    await window.evaluate(async () => {
      await window.inventor.saveProviderKey({ providerId: 'ollama', key: 'fake-key-only-offline-tests' });
      await window.inventor.discoverModels('ollama');
      await window.inventor.selectModel({ providerId: 'ollama', model: 'synthetic-code-model:pro' });
    });
    // Read the selected model through the actual connections UI so Build studio
    // receives the same selection update as an operator's click.
    await window.locator('[data-page="models"]').click();
    await window.reload();
    await expect(window.locator('#build-model-name')).toContainText('synthetic-code-model:pro');
    const objective = 'Build a counter with an Increment button and visible count.';
    await window.locator('#build-objective').fill(objective);
    await window.locator('#build-generate').click();
    await expect(window.locator('#build-progress-stage')).toHaveText('Model is reasoning');
    expect(await window.locator('body').textContent()).not.toContain('Private reasoning never');
    await window.locator('#build-cancel').click();
    await expect(window.locator('#build-generate')).toBeEnabled();
    expect((await window.evaluate(() => window.inventor.getState())).buildDraft.status).toBe('cancelled');
    expect(await window.evaluate(() => window.inventor.listProjects())).toHaveLength(0);
    await window.reload();
    await expect(window.locator('#build-objective')).toHaveValue(objective);
    await expect(window.locator('#build-draft-note')).toBeVisible();
    expect(await application.evaluate(() => globalThis.buildFixture.requests)).toBe(1);
    await application.evaluate(() => { globalThis.buildFixture.mode = 'complete'; });
    await window.locator('#build-generate').click();
    await expect(window.locator('#build-output-title')).toHaveText('Counter prototype');
    const saved = (await window.evaluate(() => window.inventor.listProjects()))[0];
    expect(saved.generator.model).toBe('synthetic-code-model:pro');
    expect(saved.verification.passed).toBe(true);
    await window.locator('#build-preview-run').click();
    const frame = window.frameLocator('#build-preview');
    await frame.getByRole('button', { name: 'Increment', exact: true }).click();
    await expect(frame.locator('#count')).toHaveText('1');
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
