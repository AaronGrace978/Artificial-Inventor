import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'Run with a desktop or xvfb-run.');

test('newly advertised Ollama models appear without reopening the page and their exact IDs reach generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inventor-catalog-'));
  const application = await electron.launch({
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '.'], cwd: repository,
    env: { ...process.env, ARTIFICIAL_INVENTOR_DATA_DIR: directory }
  });
  try {
    // Mock only the remote transport. This exercises the actual provider adapter,
    // catalog service, preload notification, UI, selection and research worker.
    await application.evaluate(({ session, safeStorage }) => {
      safeStorage.isEncryptionAvailable = () => false;
      globalThis.catalogTest = { models: [{ name: 'synthetic-prior:cloud', modified_at: '2026-01-01T00:00:00Z' }], model: null, catalogCalls: 0 };
      session.fromPartition('provider-transport').fetch = async (url, options) => {
        if (url === 'https://ollama.com/api/tags') {
          globalThis.catalogTest.catalogCalls++;
          return new Response(JSON.stringify({ models: globalThis.catalogTest.models }), { headers: { 'content-type': 'application/json' } });
        }
        if (url === 'https://ollama.com/api/chat') {
          globalThis.catalogTest.model = JSON.parse(options.body).model;
          return new Response(JSON.stringify({ done: true, message: { content: JSON.stringify({ proposals: [{ finCount: 20, finHeightMm: 25, finThicknessMm: 1, baseThicknessMm: 5 }] }) } }), { headers: { 'content-type': 'application/json' } });
        }
        throw new Error('Unexpected network request in desktop test');
      };
    });
    const window = await application.firstWindow();
    await expect(window.locator('#app-version')).not.toHaveText('—');
    await window.locator('[data-page="models"]').click();
    await window.locator('#provider-select').selectOption('ollama');
    await window.locator('#provider-key').fill('fake-key-for-offline-contract-test');
    await window.locator('#save-key').click();
    await expect(window.locator('.model-row')).toHaveCount(1);
    await expect(window.locator('.model-row')).toContainText('synthetic-prior:cloud');
    await window.locator('.model-row button').click();
    await expect(window.locator('#active-model')).toContainText('synthetic-prior:cloud');
    await window.getByRole('searchbox', { name: 'Filter available models' }).fill('future');
    await expect(window.locator('.model-row')).toHaveCount(0);
    await application.evaluate(() => {
      globalThis.catalogTest.models.push({ name: 'synthetic-future:pro-next', modified_at: '2026-11-06T12:00:00Z' });
    });
    await window.evaluate(() => window.inventor.discoverModels('ollama'));
    await expect(window.locator('.model-row')).toContainText('synthetic-future:pro-next');
    await expect(window.getByRole('searchbox')).toHaveValue('future');
    // Discovery does not silently substitute a model that was selected earlier.
    await expect(window.locator('#active-model')).toContainText('synthetic-prior:cloud');
    await window.locator('.model-row button').click();
    const run = await window.evaluate(() => window.inventor.runResearch({ budget: 10, useCloud: true }));
    expect(run.generator.model).toBe('synthetic-future:pro-next');
    expect(run.candidates.some(item => item.source === 'cloud-model-proposal')).toBe(true);
    expect(await application.evaluate(() => globalThis.catalogTest.model)).toBe('synthetic-future:pro-next');
    await window.evaluate(() => window.inventor.removeProviderKey('ollama'));
    await expect(window.locator('.model-row')).toHaveCount(0);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
