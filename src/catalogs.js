import { EventEmitter } from 'node:events';

export const CATALOG_REFRESH_MS = 15 * 60 * 1000;

// Model catalogs are availability data, never a model-quality ranking.
export class CatalogService extends EventEmitter {
  constructor({ providers, store, discover, now = Date.now }) {
    super();
    this.providers = providers;
    this.store = store;
    this.discover = discover;
    this.now = now;
    this.refreshes = new Map();
    this.epochs = new Map();
  }
  validate(id) {
    if (!this.providers.some(item => item.id === id)) throw new Error('Unknown model provider.');
  }
  fresh(id) {
    const cached = this.store.data.catalogs[id];
    const timestamp = Date.parse(cached?.refreshedAt);
    const age = this.now() - timestamp;
    return Boolean(cached && !cached.error && Number.isFinite(timestamp) && age >= 0 && age < CATALOG_REFRESH_MS);
  }
  invalidate(id) {
    this.validate(id);
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    this.refreshes.delete(id);
    delete this.store.data.catalogs[id];
    this.emit('change', { providerId: id, catalog: null });
  }
  async refresh(id) {
    this.validate(id);
    if (this.refreshes.has(id)) return this.refreshes.get(id);
    const epoch = this.epochs.get(id) ?? 0;
    const unchanged = () => epoch === (this.epochs.get(id) ?? 0);
    const refresh = (async () => {
      const key = this.store.getKey(id);
      if (!key) throw new Error('Connect this provider with your API key first.');
      try {
        const models = await this.discover(id, key);
        if (!unchanged()) throw new Error('The provider connection changed. Refresh its catalog again.');
        this.store.data.catalogs[id] = { models, refreshedAt: new Date(this.now()).toISOString(), error: null };
        await this.store.persist();
        if (unchanged()) this.emit('change', { providerId: id, catalog: this.store.data.catalogs[id] });
        return models;
      } catch (error) {
        if (!unchanged()) throw error;
        const message = /^E[A-Z]+$/.test(error.code ?? '') ? 'Local catalog storage could not be updated. Check disk space and permissions.' : error.message;
        this.store.data.catalogs[id] = { ...(this.store.data.catalogs[id] ?? { models: [] }), error: message };
        await this.store.persist();
        if (unchanged()) this.emit('change', { providerId: id, catalog: this.store.data.catalogs[id] });
        throw error;
      }
    })();
    this.refreshes.set(id, refresh);
    try { return await refresh; }
    finally { if (this.refreshes.get(id) === refresh) this.refreshes.delete(id); }
  }
  async refreshConfigured() {
    return Promise.allSettled(this.providers.filter(item => this.store.configured(item.id)).map(item => this.refresh(item.id)));
  }
}
