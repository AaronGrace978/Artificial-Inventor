import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogService, CATALOG_REFRESH_MS } from '../src/catalogs.js';

function setup(discover) {
  const store = { data: { catalogs: {}, selectedModel: { providerId: 'ollama', model: 'prior-model' } }, getKey: () => 'test-key', configured: () => true, persist: async () => {} };
  const service = new CatalogService({ providers: [{ id: 'ollama' }], store, discover, now: () => Date.parse('2026-11-06T12:00:00Z') });
  return { store, service };
}

test('background refresh notifies subscribers with newly advertised models without changing selection', async () => {
  let models = [{ id: 'prior-model' }];
  const { service, store } = setup(async () => models);
  const notices = [];
  service.on('change', event => notices.push(event));
  await service.refreshConfigured();
  models = [...models, { id: 'synthetic-future-model:pro' }];
  await service.refreshConfigured();
  assert.deepEqual(notices.at(-1).catalog.models, models);
  assert.equal(notices.at(-1).providerId, 'ollama');
  assert.equal(store.data.selectedModel.model, 'prior-model');
  assert.equal(service.fresh('ollama'), true);
});

test('catalog freshness expires in fifteen minutes and invalid or future timestamps cannot bypass refresh', () => {
  const { store, service } = setup(async () => []);
  for (const timestamp of [undefined, 'invalid', '2026-11-06T12:01:00Z', '2026-11-06T11:45:00Z']) {
    store.data.catalogs.ollama = { models: [], refreshedAt: timestamp };
    assert.equal(service.fresh('ollama'), false);
  }
  store.data.catalogs.ollama.refreshedAt = '2026-11-06T11:59:00Z';
  assert.equal(service.fresh('ollama'), true);
  assert.equal(CATALOG_REFRESH_MS, 15 * 60_000);
});

test('failed refresh preserves prior models, marks them stale, and notifies the UI', async () => {
  const { store, service } = setup(async () => { throw new Error('Provider offline'); });
  store.data.catalogs.ollama = { models: [{ id: 'prior-model' }], refreshedAt: '2026-11-06T11:59:00Z' };
  let notice;
  service.on('change', event => { notice = event; });
  await assert.rejects(service.refresh('ollama'), /Provider offline/);
  assert.equal(notice.catalog.models[0].id, 'prior-model');
  assert.equal(notice.catalog.error, 'Provider offline');
  assert.equal(service.fresh('ollama'), false);
});

test('changing credentials discards an in-flight catalog from the old account', async () => {
  let finish;
  const { store, service } = setup(() => new Promise(resolve => { finish = resolve; }));
  const pending = service.refresh('ollama');
  service.invalidate('ollama');
  finish([{ id: 'old-account-model' }]);
  await assert.rejects(pending, /connection changed/);
  assert.equal(store.data.catalogs.ollama, undefined);
});

test('simultaneous refreshes share a single provider request', async () => {
  let finish, calls = 0;
  const { service } = setup(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = service.refresh('ollama');
  const second = service.refresh('ollama');
  finish([{ id: 'same-model' }]);
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
});
