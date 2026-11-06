import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// The renderer can write credentials, but can never read them back.
export class SettingsStore {
  constructor(directory, encryption) {
    this.directory = directory;
    this.file = path.join(directory, 'settings.json');
    this.encryption = encryption;
    this.data = { schema: 1, encryptedKeys: {}, selectedModel: null, catalogs: {} };
    this.sessionKeys = new Map();
    this.writes = Promise.resolve();
  }
  async load() {
    try {
      const text = await readFile(this.file, 'utf8');
      if (text.length > 4_000_000) throw new Error('Settings file exceeds its size limit.');
      const value = JSON.parse(text);
      if (value.schema !== 1 || !value.encryptedKeys || !value.catalogs) throw new Error('Unsupported settings format.');
      this.data = value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Settings could not be read. Preserve the file and inspect it before restarting.');
    }
  }
  async persist() {
    const write = async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      await rename(temp, this.file);
    };
    this.writes = this.writes.catch(() => {}).then(write);
    return this.writes;
  }
  canEncrypt() {
    return this.encryption.isEncryptionAvailable() &&
      this.encryption.getSelectedStorageBackend?.() !== 'basic_text';
  }
  async saveKey(providerId, key) {
    if (typeof key !== 'string' || key.length < 1 || key.length > 4096 || /[\r\n\0]/.test(key)) throw new Error('Enter a valid API key.');
    if (this.canEncrypt()) {
      this.data.encryptedKeys[providerId] = this.encryption.encryptString(key).toString('base64');
      this.sessionKeys.delete(providerId);
      await this.persist();
      return { persisted: true, message: 'Key encrypted with the operating system credential service.' };
    }
    this.sessionKeys.set(providerId, key);
    delete this.data.encryptedKeys[providerId];
    await this.persist();
    return { persisted: false, message: 'Secure OS storage is unavailable. Key kept in memory for this session only.' };
  }
  getKey(providerId) {
    if (this.sessionKeys.has(providerId)) return this.sessionKeys.get(providerId);
    const ciphertext = this.data.encryptedKeys[providerId];
    if (!ciphertext) return null;
    if (!this.canEncrypt()) throw new Error('Unlock the operating system credential service or reconnect this provider.');
    try { return this.encryption.decryptString(Buffer.from(ciphertext, 'base64')); }
    catch { throw new Error('This key cannot be decrypted on this machine. Reconnect the provider.'); }
  }
  async removeKey(providerId) {
    this.sessionKeys.delete(providerId);
    delete this.data.encryptedKeys[providerId];
    delete this.data.catalogs[providerId];
    if (this.data.selectedModel?.providerId === providerId) this.data.selectedModel = null;
    await this.persist();
  }
  configured(providerId) {
    return this.sessionKeys.has(providerId) || Boolean(this.data.encryptedKeys[providerId]);
  }
}
