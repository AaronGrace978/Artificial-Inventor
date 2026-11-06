const $ = id => document.getElementById(id);
let api, navigate, notify;
let projects = [], activeProject, selectedModel, modelProviders = [];
let building = false, buildStarted = 0, elapsedTimer, deadline = 600_000;
let formPristine = true, draftChecked = false;

function element(tag, text, className) {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = String(text);
  if (className) value.className = className;
  return value;
}
const errorMessage = error => error instanceof Error ? error.message : String(error || 'The operation failed.');
function elapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function updateElapsed() {
  if (building) $('build-elapsed').textContent = `${elapsed(Date.now() - buildStarted)} / ${elapsed(deadline)}`;
}
function setProgress(progress = {}) {
  $('build-progress').hidden = false;
  $('build-progress').classList.toggle('error', progress.status === 'error');
  const titles = { waiting: 'Waiting for the model', thinking: 'Model is reasoning', generating: 'Generating project files', receiving: 'Receiving model output', validating: 'Checking project files', complete: 'Project saved', cancelled: 'Request cancelled', error: 'Project could not be generated' };
  $('build-progress-stage').textContent = titles[progress.status] || 'Working';
  $('build-progress-detail').textContent = progress.message || (progress.receivedChars ? `${Number(progress.receivedChars).toLocaleString()} characters received. Waiting for the complete project.` : 'The provider has not returned a complete response yet.');
  updateElapsed();
}
function setBusy(value) {
  building = value;
  $('build-generate').disabled = value;
  $('build-demo').disabled = value;
  $('build-cancel').disabled = !value;
  $('build-kind').disabled = value;
  $('build-timeout').disabled = value;
  $('build-objective').disabled = value;
  $('build-generate').textContent = value ? 'Generating…' : 'Generate project ↗';
  clearInterval(elapsedTimer);
  if (value) { buildStarted = Date.now(); updateElapsed(); elapsedTimer = setInterval(updateElapsed, 1000); }
}
export function updateBuildSelection(state) {
  if (!draftChecked && Object.hasOwn(state, 'buildDraft')) {
    draftChecked = true;
    const draft = state.buildDraft;
    if (formPristine && !building && draft && ['started', 'interrupted', 'failed', 'cancelled'].includes(draft.status) && typeof draft.objective === 'string') {
      $('build-objective').value = draft.objective.slice(0, 6000);
      if (['web-app', 'code-project'].includes(draft.kind)) $('build-kind').value = draft.kind;
      if ([180000, 300000, 600000].includes(draft.timeoutMs)) $('build-timeout').value = String(draft.timeoutMs);
      $('build-draft-note').textContent = 'Your previous unfinished task was restored. Review it, then choose Generate project to try again. No request was sent automatically.';
      $('build-draft-note').hidden = false;
    }
  }
  selectedModel = state.selectedModel;
  modelProviders = state.providers || [];
  if (!selectedModel) {
    $('build-model-name').textContent = 'No cloud model selected';
    $('build-model-detail').textContent = 'Connect a model for generation, or try the offline demo.';
    return;
  }
  const provider = modelProviders.find(item => item.id === selectedModel.providerId);
  $('build-model-name').textContent = `${provider?.name || selectedModel.providerId} / ${selectedModel.model}`;
  $('build-model-detail').textContent = 'Generation uses this exact model; provider latency and charges vary.';
}
function stopPreview() {
  $('build-preview-host').replaceChildren(element('p', 'Inspect the source, then run a web preview or export the project.', 'muted-text'));
  $('build-preview-stop').disabled = true;
}
function showFile(file) {
  $('build-file-name').textContent = file.path;
  $('build-code').value = file.content;
  for (const button of $('build-files').querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.path === file.path);
    button.setAttribute('aria-current', button.dataset.path === file.path ? 'true' : 'false');
  }
}
function displayProject(project) {
  activeProject = project;
  stopPreview();
  $('build-output').hidden = false;
  $('build-output-title').textContent = project.title || 'Generated project';
  $('build-summary').textContent = project.summary || '';
  const checks = project.verification?.checks || [];
  $('build-check-badge').textContent = project.verification?.passed ? 'DECLARED CHECKS PASSED' : 'REVIEW CHECK RESULTS';
  $('build-check-badge').classList.toggle('warn', project.verification?.passed === false);
  const validation = $('build-validation'); validation.replaceChildren();
  for (const check of checks) {
    const row = element('div', undefined, check.passed ? 'build-check passed' : 'build-check failed');
    row.append(element('span', check.passed ? '✓' : '!'), element('span', `${check.path ? `${check.path}: ` : ''}${check.message || check.kind || 'Check result'}`));
    validation.append(row);
  }
  for (const limitation of project.verification?.limitations || project.limitations || []) validation.append(element('p', limitation, 'field-help'));
  const fileList = $('build-files'); fileList.replaceChildren();
  for (const file of project.files || []) {
    const button = element('button', file.path, 'build-file'); button.type = 'button'; button.dataset.path = file.path;
    button.addEventListener('click', () => showFile(file)); fileList.append(button);
  }
  if (project.files?.length) showFile(project.files[0]);
  else { $('build-code').value = ''; $('build-file-name').textContent = 'No source files'; }
  const web = project.kind === 'web-app' && project.files?.some(file => file.path === 'index.html');
  $('build-preview-run').disabled = !web;
  $('build-preview-note').textContent = web ? 'Starting the preview executes this project’s browser code in an isolated frame. Network and app access are blocked.' : 'This code project is available for inspection and export. Native, server, and other language runtimes are not executed in the preview.';
  const instructions = $('build-instructions'); instructions.replaceChildren();
  if (project.instructions) instructions.append(element('h3', 'Project instructions'), element('pre', Array.isArray(project.instructions) ? project.instructions.join('\n') : project.instructions));
  if (project.generator) instructions.append(element('p', project.generator.model ? `Generated with ${project.generator.providerId} / ${project.generator.model}. Generated code requires review and testing.` : 'Offline example project. This example does not demonstrate live model generation.', 'field-help'));
  renderHistory();
}
function renderHistory() {
  const list = $('build-history'); list.replaceChildren();
  if (!projects.length) { list.append(element('p', 'No projects yet. Try the offline demo to inspect a working example.', 'muted-text')); return; }
  for (const project of projects.slice(0, 30)) {
    const button = element('button', undefined, `build-history-item${activeProject?.id === project.id ? ' active' : ''}`); button.type = 'button';
    button.append(element('strong', project.title || 'Generated project'), element('span', `${project.files?.length ?? project.fileCount ?? '—'} files · ${project.kind === 'web-app' ? 'Web app' : 'Code project'}`));
    if (project.createdAt) button.append(element('small', new Date(project.createdAt).toLocaleString()));
    button.addEventListener('click', () => { displayProject(project); $('build-output').scrollIntoView({ block: 'start', behavior: 'smooth' }); });
    list.append(button);
  }
}
async function refreshProjects() {
  if (typeof api?.listProjects !== 'function') return;
  const result = await api.listProjects();
  projects = Array.isArray(result) ? result : result.projects || [];
  projects.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  renderHistory();
}
async function generate(demo) {
  if (building) return;
  if (typeof api?.buildProject !== 'function') { notify('The build service is unavailable. Restart the updated desktop application.', true); return; }
  if (!demo && !selectedModel) { navigate('models'); notify('Connect a provider and select a model, then return to Build studio.', true); return; }
  const objective = $('build-objective').value.trim();
  if (!demo && !objective) { $('build-objective').focus(); return; }
  deadline = Number($('build-timeout').value);
  formPristine = false;
  $('build-draft-note').hidden = true;
  setBusy(true);
  setProgress({ status: demo ? 'validating' : 'waiting', message: demo ? 'Preparing the offline example and checking its source files.' : `Request sent to ${selectedModel.model}. Waiting for output; you may cancel at any time.` });
  try {
    const project = await api.buildProject({ objective: objective || 'Offline example web application', kind: demo ? 'web-app' : $('build-kind').value, timeoutMs: deadline, demo });
    projects = [project, ...projects.filter(item => item.id !== project.id)];
    displayProject(project);
    setProgress({ status: 'complete', message: `${project.files?.length || 0} source files saved. Inspect validation results before running or exporting the project.` });
    notify('Project files generated and saved.');
    $('build-output').scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch (error) {
    const cancelled = /cancelled|canceled/i.test(errorMessage(error));
    setProgress({ status: cancelled ? 'cancelled' : 'error', message: errorMessage(error) });
    if (!cancelled) notify(errorMessage(error), true);
  } finally { setBusy(false); }
}
export async function initializeBuildStudio({ api: bridge, showPage, toast }) {
  api = bridge; navigate = showPage; notify = toast;
  for (const id of ['build-objective', 'build-kind', 'build-timeout']) $(id).addEventListener('input', () => { formPristine = false; $('build-draft-note').hidden = true; });
  $('build-connect').addEventListener('click', () => navigate('models'));
  $('build-form').addEventListener('submit', event => { event.preventDefault(); void generate(false); });
  $('build-demo').addEventListener('click', () => { void generate(true); });
  $('build-cancel').addEventListener('click', async () => {
    if (!building) return;
    $('build-cancel').disabled = true;
    try { await api.cancelBuild(); setProgress({ status: 'cancelled', message: 'Cancellation requested. Waiting for the provider request to stop.' }); }
    catch (error) { notify(errorMessage(error), true); $('build-cancel').disabled = false; }
  });
  $('build-select-code').addEventListener('click', () => { $('build-code').focus(); $('build-code').select(); notify('Source selected. Press Ctrl+C (or ⌘C) to copy.'); });
  $('build-export').addEventListener('click', async () => {
    if (!activeProject) return;
    $('build-export').disabled = true;
    try { const result = await api.exportProject(activeProject.id); if (!result?.canceled) notify(result?.path ? `Project exported to ${result.path}` : 'Project exported.'); }
    catch (error) { notify(errorMessage(error), true); }
    finally { $('build-export').disabled = false; }
  });
  $('build-preview-run').addEventListener('click', async () => {
    if (!activeProject) return;
    $('build-preview-run').disabled = true;
    try {
      const preview = await api.previewProject(activeProject.id);
      const url = new URL(preview.url);
      if (url.protocol !== 'inventor-preview:') throw new Error('The preview returned an unsupported destination.');
      const iframe = element('iframe'); iframe.id = 'build-preview'; iframe.title = `${activeProject.title || 'Generated application'} isolated preview`;
      iframe.setAttribute('sandbox', 'allow-scripts allow-forms'); iframe.setAttribute('referrerpolicy', 'no-referrer'); iframe.src = url.href;
      $('build-preview-host').replaceChildren(iframe); $('build-preview-stop').disabled = false;
    } catch (error) { notify(errorMessage(error), true); }
    finally { $('build-preview-run').disabled = false; }
  });
  $('build-preview-stop').addEventListener('click', stopPreview);
  if (typeof api?.onBuildProgress === 'function') api.onBuildProgress(progress => { if (building) setProgress(progress); });
  if (!api) { $('build-generate').disabled = true; $('build-demo').disabled = true; return; }
  try { await refreshProjects(); } catch (error) { notify(`Could not load saved projects: ${errorMessage(error)}`, true); }
}
