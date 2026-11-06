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
      globalThis.buildFixture = { mode: 'stall', requests: 0, budgets: [] };
      session.fromPartition('provider-transport').fetch = async (url, options) => {
        if (url.endsWith('/tags')) return new Response(JSON.stringify({ models: [{ name: 'synthetic-code-model:pro' }] }), { headers: { 'content-type': 'application/json' } });
        if (!url.endsWith('/chat')) throw new Error('Unexpected test request');
        globalThis.buildFixture.requests++;
        globalThis.buildFixture.budgets.push(JSON.parse(options.body).options.num_predict);
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify({ message: { thinking: 'Private reasoning never sent to the interface' }, done: false }) + '\n'));
          if (globalThis.buildFixture.mode === 'limited') {
            controller.enqueue(encoder.encode(JSON.stringify({ done: true, done_reason: 'length' }) + '\n'));
            controller.close();
          }
          if (['complete', 'checkpoint'].includes(globalThis.buildFixture.mode)) {
            const request = JSON.parse(options.body).messages.at(-1).content;
            const script = 'let count=0;document.getElementById("increment").addEventListener("click",()=>{document.getElementById("count").textContent=String(++count);});';
            const html = '<!doctype html><html><head><title>Counter</title></head><body><button id="increment" type="button">Increment</button><output id="count">0</output><script src="app.js"></script></body></html>';
            const plan = { title: 'Counter prototype', summary: 'A working local counter', files: [{ path: 'app.js', purpose: 'Wire #increment to increment output #count' }, { path: 'index.html', purpose: 'Button #increment, output #count, app.js script' }], smokeTests: [{ name: 'Increment works', actions: [{ type: 'click', selector: '#increment' }], expect: { selector: '#count', textIncludes: '1' } }] };
            if (globalThis.buildFixture.mode === 'checkpoint' && request.startsWith('Write only the complete raw source for index.html')) return;
            const content = request.startsWith('Return only a JSON object:') ? JSON.stringify(plan)
              : request.startsWith('Write only the complete raw source for app.js') ? 'let count=0;document.getElementById("increment").onclick=()=>document.getElementById("count").textContent=String(count);'
              : request.startsWith('Return only the complete corrected raw source for app.js') ? script : html;
            controller.enqueue(encoder.encode(JSON.stringify({ message: { content }, done: true }) + '\n'));
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
    await window.locator('#build-output-limit').selectOption('12000');
    await window.locator('#build-generate').click();
    await expect(window.locator('#build-output-limit')).toBeDisabled();
    await expect(window.locator('#build-progress-detail')).toContainText('reasoning');
    expect(await window.locator('body').textContent()).not.toContain('Private reasoning never');
    await window.locator('#build-cancel').click();
    await expect(window.locator('#build-generate')).toBeEnabled();
    expect((await window.evaluate(() => window.inventor.getState())).buildDraft.status).toBe('cancelled');
    expect(await window.evaluate(() => window.inventor.listProjects())).toHaveLength(0);
    await window.reload();
    await expect(window.locator('#build-objective')).toHaveValue(objective);
    await expect(window.locator('#build-draft-note')).toBeVisible();
    expect(await application.evaluate(() => globalThis.buildFixture.requests)).toBe(1);
    await expect(window.locator('#build-output-limit')).toHaveValue('12000');
    await application.evaluate(() => { globalThis.buildFixture.mode = 'limited'; });
    await window.locator('#build-generate').click();
    await expect(window.locator('#build-progress-stage')).toHaveText('Project could not be generated');
    await expect(window.locator('#build-progress-detail')).toContainText('output token limit');
    await expect(window.locator('#build-generate')).toBeEnabled();
    expect(await application.evaluate(() => globalThis.buildFixture.requests)).toBe(2);
    expect(await window.evaluate(() => window.inventor.listProjects())).toHaveLength(0);
    await window.reload();
    await expect(window.locator('#build-objective')).toHaveValue(objective);
    await expect(window.locator('#build-output-limit')).toHaveValue('12000');
    expect((await window.evaluate(() => window.inventor.getState())).buildDraft.status).toBe('failed');
    await window.locator('#build-output-limit').selectOption('64000');
    await application.evaluate(() => { globalThis.buildFixture.mode = 'checkpoint'; });
    await window.locator('#build-generate').click();
    await expect(window.locator('#build-progress-detail')).toContainText('Writing index.html');
    await window.locator('#build-cancel').click();
    await expect(window.locator('#build-generate')).toBeEnabled();
    const interrupted = (await window.evaluate(() => window.inventor.getState())).buildDraft;
    expect(interrupted.checkpoint.files).toHaveLength(1);
    expect(interrupted.checkpoint.files[0].path).toBe('app.js');
    await window.reload();
    await expect(window.locator('#build-resume')).toBeVisible();
    await expect(window.locator('#build-output-limit')).toHaveValue('64000');
    await application.evaluate(() => { globalThis.buildFixture.mode = 'complete'; });
    await window.locator('#build-resume').click();
    await expect(window.locator('#build-output-title')).toHaveText('Counter prototype');
    const saved = (await window.evaluate(() => window.inventor.listProjects()))[0];
    expect(await application.evaluate(() => globalThis.buildFixture.budgets)).toEqual([12000, 12000, 64000, 64000, 64000, 64000, 64000]);
    expect(saved.generator.model).toBe('synthetic-code-model:pro');
    expect(saved.verification.passed).toBe(true);
    expect(saved.buildReport.checksPassed).toBe(true);
    expect(saved.buildReport.repairs).toBe(1);
    expect(saved.buildReport.functionalValidation).toBe('browser-interaction-smoke');
    await window.locator('#build-preview-run').click();
    const frame = window.frameLocator('#build-preview');
    await frame.getByRole('button', { name: 'Increment', exact: true }).click();
    await expect(frame.locator('#count')).toHaveText('1');
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});


test('product visualizer changes actual geometry, finish and assembly in isolated preview', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inventor-visualizer-e2e-'));
  const application = await electron.launch({ args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '.'], cwd: repository, env: { ...process.env, ARTIFICIAL_INVENTOR_DATA_DIR: directory } });
  try {
    const window = await application.firstWindow();
    await window.locator('#build-kind').selectOption('product-visualizer');
    await window.locator('#build-demo').click();
    await expect(window.locator('#build-output-title')).toHaveText('Forma · Product concept studio');
    await window.locator('#build-preview-run').click();
    const frame = window.frameLocator('#build-preview');
    await expect(frame.locator('#model-status')).toContainText('ASSEMBLED');
    const before = await frame.locator('#product').innerHTML();
    await frame.locator('#height').fill('420');
    await expect(frame.locator('#spec-height')).toHaveText('420 mm');
    expect(await frame.locator('#product').innerHTML()).not.toBe(before);
    await frame.locator('#finish').selectOption('graphite');
    await expect(frame.locator('#spec-finish')).toHaveText('Soft graphite');
    await frame.locator('#exploded').check();
    await expect(frame.locator('#view-label')).toContainText('EXPLODED');
    await frame.locator('#wireframe').check();
    await expect(frame.locator('#view-label')).toContainText('WIREFRAME');
    await frame.locator('#reset').click();
    await expect(frame.locator('#spec-height')).toHaveText('340 mm');
    await expect(frame.locator('#view-label')).toHaveText('ASSEMBLED / ISOMETRIC');
    await expect(frame.locator('#export')).toBeEnabled();
    const visualPath = join(directory, 'product.svg');
    await application.evaluate(({ dialog }, filePath) => { globalThis.visualSaveCount = 0; dialog.showSaveDialog = async () => { globalThis.visualSaveCount++; return { canceled: false, filePath }; }; }, visualPath);
    await frame.locator('body').evaluate(() => parent.postMessage({ type: 'inventor:svg', token: 'unsolicited', svg: '<svg></svg>' }, '*'));
    await window.evaluate(() => window.postMessage({ type: 'inventor:svg', token: 'forged', svg: '<svg></svg>' }, '*'));
    await window.locator('#build-visual-export').click();
    await expect.poll(async () => { try { return await readFile(visualPath, 'utf8'); } catch { return ''; } }).toContain('<svg');
    const illustration = await readFile(visualPath, 'utf8');
    expect(illustration).toContain('Task lamp');
    expect(illustration).toContain('<polygon');
    expect(await application.evaluate(() => globalThis.visualSaveCount)).toBe(1);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
