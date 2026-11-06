import { EventEmitter } from 'node:events';

export class UpdateManager extends EventEmitter {
  constructor(updater, enabled) {
    super();
    this.updater = updater;
    this.enabled = enabled;
    this.state = { status: enabled ? 'idle' : 'development', message: enabled ? 'Automatic checks every six hours. Installation requires your restart.' : 'Updates run in the installed Windows application.' };
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on('checking-for-update', () => this.set('checking', 'Checking the stable release channel…'));
    updater.on('update-not-available', () => this.set('current', 'You are running the latest published release.'));
    updater.on('update-available', info => this.set('downloading', `Downloading version ${info.version}…`, { version: info.version }));
    updater.on('download-progress', info => this.set('downloading', `Downloading update: ${Math.round(info.percent)}%`, { percent: info.percent }));
    updater.on('update-downloaded', info => this.set('downloaded', `Version ${info.version} is ready. Restart to install.`, { version: info.version }));
    updater.on('error', () => this.set('error', 'Update check or download failed. Check your connection and the GitHub release assets.'));
  }
  set(status, message, details = {}) {
    this.state = { ...this.state, ...details, status, message };
    this.emit('change', this.state);
  }
  async check() {
    if (!this.enabled || ['checking', 'downloading', 'downloaded'].includes(this.state.status)) return this.state;
    try { await this.updater.checkForUpdates(); }
    catch { this.set('error', 'Update check failed. Check your connection and the GitHub release assets.'); }
    return this.state;
  }
  install() {
    if (!this.enabled || this.state.status !== 'downloaded') throw new Error('No verified update is ready to install.');
    this.updater.quitAndInstall(false, true);
  }
}
