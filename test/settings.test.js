import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SettingsStore } from '../src/settings.js';

test('credentials remain session-only when OS encryption is unavailable or insecure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inventor-settings-'));
  try {
    for (const encryption of [
      { isEncryptionAvailable: () => false },
      { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }
    ]) {
      const store = new SettingsStore(directory, encryption);
      await store.load();
      assert.equal((await store.saveKey('openai', 'sensitive-value')).persisted, false);
      assert.equal(store.getKey('openai'), 'sensitive-value');
      assert.ok(!(await readFile(store.file, 'utf8')).includes('sensitive-value'));
      const restart = new SettingsStore(directory, encryption);
      await restart.load();
      assert.equal(restart.getKey('openai'), null);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('encrypted credentials round trip and removing a key removes its model selection', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inventor-settings-'));
  const encryption = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text.split('').reverse().join('')), decryptString: data => data.toString().split('').reverse().join('') };
  try {
    const store = new SettingsStore(directory, encryption);
    await store.saveKey('openai', 'sensitive-value');
    store.data.selectedModel = { providerId: 'openai', model: 'example' };
    await store.persist();
    const restart = new SettingsStore(directory, encryption);
    await restart.load();
    assert.equal(restart.getKey('openai'), 'sensitive-value');
    assert.ok(!(await readFile(store.file, 'utf8')).includes('sensitive-value'));
    await restart.removeKey('openai');
    assert.equal(restart.configured('openai'), false);
    assert.equal(restart.data.selectedModel, null);
    await assert.rejects(restart.saveKey('openai', 'abc\nxyz'), /valid API key/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
