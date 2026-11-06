const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then(result => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
});
contextBridge.exposeInMainWorld('inventor', Object.freeze({
  getState: () => invoke('inventor:state'),
  runResearch: spec => invoke('inventor:research', spec),
  cancelResearch: () => invoke('inventor:cancel-research'),
  buildProject: input => invoke('inventor:build', input),
  cancelBuild: () => invoke('inventor:cancel-build'),
  listProjects: () => invoke('inventor:projects'),
  previewProject: id => invoke('inventor:preview-project', id),
  exportProject: id => invoke('inventor:export-project', id),
  listEvidence: () => invoke('inventor:evidence'),
  exportEvidence: runId => invoke('inventor:export', runId),
  saveProviderKey: input => invoke('inventor:save-key', input),
  removeProviderKey: providerId => invoke('inventor:remove-key', providerId),
  discoverModels: providerId => invoke('inventor:models', providerId),
  selectModel: selection => invoke('inventor:select-model', selection),
  checkUpdates: () => invoke('inventor:updates'),
  installUpdate: () => invoke('inventor:install-update'),
  onBuildProgress: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('inventor:build-progress', listener);
    return () => ipcRenderer.removeListener('inventor:build-progress', listener);
  },
  onResearchProgress: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('inventor:research-progress', listener);
    return () => ipcRenderer.removeListener('inventor:research-progress', listener);
  },
  onCatalogChange: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('inventor:catalog-state', listener);
    return () => ipcRenderer.removeListener('inventor:catalog-state', listener);
  },
  onUpdate: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('inventor:update-state', listener);
    return () => ipcRenderer.removeListener('inventor:update-state', listener);
  }
}));
