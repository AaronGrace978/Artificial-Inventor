import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { UpdateManager } from '../src/updates.js';

test('updates download automatically but installation needs a downloaded release', async () => {
  const updater = new EventEmitter();
  let installed = false;
  updater.checkForUpdates = async () => { updater.emit('checking-for-update'); updater.emit('update-available', { version: '0.2.0' }); };
  updater.quitAndInstall = () => { installed = true; };
  const manager = new UpdateManager(updater, true);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  assert.throws(() => manager.install(), /No verified update/);
  await manager.check();
  assert.equal(manager.state.status, 'downloading');
  updater.emit('update-downloaded', { version: '0.2.0' });
  manager.install();
  assert.equal(installed, true);
});

test('development mode never contacts update services', async () => {
  const updater = new EventEmitter();
  updater.checkForUpdates = () => { throw new Error('must not run'); };
  const manager = new UpdateManager(updater, false);
  assert.equal((await manager.check()).status, 'development');
});
