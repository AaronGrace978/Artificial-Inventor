const api = window.inventor;
const $ = (id) => document.getElementById(id);
const names = { research: 'Research lab', evidence: 'Evidence ledger', models: 'Model connections', governance: 'Controls & limits', settings: 'App & updates' };
let state = { providers: [], runs: [], selectedModel: null, modelCatalogs: {}, update: {} };
let runs = [];
let evidenceEvents = [];
let catalog = [];
let toastTimer;
let running = false;
let currentRun;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
function replace(id, children = []) { $(id).replaceChildren(...children); }
function number(value, digits = 1) { return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'; }
function date(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Unknown date' : parsed.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function message(error) { return error instanceof Error ? error.message : String(error || 'An unexpected error occurred.'); }
function toast(text, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 4500);
}
function showPage(page) {
  if (!Object.hasOwn(names, page)) return;
  document.querySelectorAll('.page').forEach((element) => element.classList.toggle('active', element.id === `page-${page}`));
  document.querySelectorAll('[data-page]').forEach((element) => {
    const active = element.dataset.page === page;
    element.classList.toggle('active', active);
    element.setAttribute('aria-current', active ? 'page' : 'false');
  });
  $('breadcrumb-page').textContent = names[page];
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (page === 'evidence' && api) refreshEvidence().catch((error) => toast(message(error), true));
}
function action(text, handler, className = 'button secondary') {
  const button = node('button', text, className);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await handler(); } catch (error) { toast(message(error), true); }
    finally { button.disabled = false; }
  });
  return button;
}
function addList(parent, items, heading) {
  if (!Array.isArray(items) || !items.length) return;
  const section = node('div');
  if (heading) section.append(node('h3', heading));
  const list = node('ul', null, 'simple-list');
  for (const item of items) list.append(node('li', typeof item === 'string' ? item : JSON.stringify(item)));
  section.append(list);
  parent.append(section);
}
function sortRuns(input) { return [...(Array.isArray(input) ? input : [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }
function renderRunCount() {
  $('metric-runs').textContent = String(runs.length);
  $('nav-run-count').textContent = String(runs.length);
}
function renderLatest(run) {
  if (!run) return;
  const best = run.best;
  const stats = node('div', null, 'mini-stat');
  const value = node('strong', best ? number(best.predictedBaseC) : 'No pass');
  if (best) value.append(node('small', '°C'));
  stats.append(value, node('span', best ? `${best.evidenceLevel || 'E2'} / COMPUTED` : 'E0 / REJECTED'));
  const caption = node('p', best ? `${run.summary?.passed ?? 0} candidates passed the declared constraints. Predicted base temperature, not a measurement.` : 'No design passed all constraints in this bounded search. The failed attempts remain in the evidence.', 'latest-caption');
  const metadata = node('div', `${date(run.createdAt)} · ${run.summary?.evaluated ?? 0} candidates`, 'latest-metadata');
  replace('latest-result', [stats, caption, metadata, action('Inspect result ↗', () => { showPage('research'); renderResults(run); $('results-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 'text-button')]);
  $('latest-result').className = '';
}
function summaryCard(value, label, detail) {
  const card = node('div');
  card.append(node('strong', value), node('span', label));
  if (detail) card.append(node('small', detail));
  return card;
}
function renderChart(run) {
  const entries = [];
  if (typeof run.baseline?.predictedBaseC === 'number') entries.push({ label: 'Baseline', candidate: run.baseline, baseline: true });
  if (run.best) entries.push({ label: 'Selected', candidate: run.best });
  for (const candidate of (run.candidates || []).filter((entry) => entry.status === 'passed' && entry.id !== run.best?.id && entry.id !== run.baseline?.id).sort((a, b) => a.predictedBaseC - b.predictedBaseC).slice(0, 3)) entries.push({ label: candidate.id ? candidate.id.replace('candidate-', 'Design ') : 'Candidate', candidate });
  if (!entries.length) return null;
  const chart = node('div', null, 'chart-container');
  const heading = node('div', null, 'chart-heading');
  const ambient = typeof run.spec?.ambientC === 'number' ? run.spec.ambientC : 0;
  heading.append(node('span', 'PREDICTED BASE TEMPERATURE'), node('span', `BARS: RISE ABOVE ${number(ambient)} °C AMBIENT`));
  chart.append(heading);
  const maxRise = Math.max(...entries.map(({ candidate }) => candidate.predictedBaseC - ambient), 0.001);
  for (const { label, candidate, baseline } of entries) {
    const row = node('div', null, 'chart-row');
    const track = node('div', null, 'chart-track');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 17');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bar.setAttribute('width', String(Math.max(0, Math.min(100, (candidate.predictedBaseC - ambient) / maxRise * 100))));
    bar.setAttribute('height', '17');
    bar.setAttribute('rx', '1');
    bar.setAttribute('class', baseline ? 'chart-fill baseline' : 'chart-fill');
    svg.append(bar);
    track.append(svg);
    row.append(node('span', label, 'chart-label'), track, node('span', `${number(candidate.predictedBaseC)} °C`, 'chart-number'));
    chart.append(row);
  }
  return chart;
}
function candidateTable(candidates) {
  const scroll = node('div', null, 'table-scroll');
  const table = node('table');
  const header = node('thead');
  const headerRow = node('tr');
  for (const text of ['Candidate', 'Fins', 'Fin H / T / Base (mm)', 'Base °C', 'Mass (g)', 'Evidence', 'Outcome / reasons']) headerRow.append(node('th', text));
  header.append(headerRow);
  const body = node('tbody');
  for (const [index, candidate] of candidates.entries()) {
    const row = node('tr');
    const design = candidate.design || {};
    const cells = [candidate.source || candidate.id || `Design ${index + 1}`, design.finCount ?? '—', `${number(design.finHeightMm)} / ${number(design.finThicknessMm)} / ${number(design.baseThicknessMm)}`, number(candidate.predictedBaseC), number(candidate.massG), candidate.evidenceLevel || 'E0', candidate.status === 'passed' ? 'Passed declared checks' : (candidate.checks || []).join(' ') || 'Rejected'];
    for (const [cellIndex, text] of cells.entries()) row.append(node('td', text, cellIndex === 6 && candidate.status !== 'passed' ? 'candidate-errors' : undefined));
    body.append(row);
  }
  table.append(header, body);
  scroll.append(table);
  return scroll;
}
function renderResults(run) {
  currentRun = run;
  $('results-panel').hidden = false;
  $('results-title').textContent = run.spec?.title || 'Experiment results';
  $('result-evidence').textContent = run.best ? `${run.best.evidenceLevel || 'E2'} · COMPUTED ONLY` : 'E0 · NO QUALIFYING DESIGN';
  const container = node('div');
  container.append(node('div', `${run.id || 'Run'} · ${date(run.createdAt)} · seed ${run.spec?.seed ?? '—'}`, 'results-metadata'));
  const summary = node('div', null, 'result-summary');
  summary.append(summaryCard(run.best ? `${number(run.best.predictedBaseC)} °C` : 'No pass', 'Best predicted base temperature', 'Analytical result; not measured'), summaryCard(`${run.summary?.passed ?? 0} / ${run.summary?.evaluated ?? 0}`, 'Candidates passing constraints', `${run.summary?.rejected ?? 0} rejected; all outcomes retained`), summaryCard(typeof run.summary?.improvementPercent === 'number' ? `${number(run.summary.improvementPercent)}%` : '—', 'Thermal-resistance improvement', 'Relative to the recorded baseline'));
  container.append(summary);
  if (run.summary?.claim) container.append(node('p', run.summary.claim, 'evidence-claim'));
  if (run.summary?.baselineComparison) container.append(node('p', run.summary.baselineComparison, 'field-help'));
  const verification = run.verification || {};
  const checksAgree = verification.numericalAgreement === true || verification.numericalAgreement?.passed === true || run.best?.verification?.passed === true;
  container.append(node('div', checksAgree ? 'Analytical and numerical calculations agree within the implemented tolerance. Both share physical assumptions; agreement checks the calculation, not reality.' : 'No qualifying result established. Inspect the rejected candidates and verification records before drawing a conclusion.', `result-callout${checksAgree ? '' : ' warn'}`));
  const chart = renderChart(run);
  if (chart) container.append(chart);
  const columns = node('div', null, 'results-split');
  const designSection = node('div');
  designSection.append(node('h3', 'Selected design & numerical checks'));
  if (run.best) {
    const design = run.best.design || {};
    const list = node('dl', null, 'design-dl');
    for (const [label, value] of [['Fin count', design.finCount], ['Fin height', `${number(design.finHeightMm)} mm`], ['Fin thickness', `${number(design.finThicknessMm)} mm`], ['Base thickness', `${number(design.baseThicknessMm)} mm`], ['Predicted mass', `${number(run.best.massG)} g`], ['Conductance disagreement', `${number((run.best.verification?.relativeError ?? NaN) * 100, 5)}%`], ['Mesh difference', `${number((run.best.verification?.meshRelativeError ?? NaN) * 100, 5)}%`], ['Energy-balance error', number(run.best.verification?.energyBalanceRelativeError, 8)]]) {
      const entry = node('div'); entry.append(node('dt', label), node('dd', value)); list.append(entry);
    }
    designSection.append(list);
  } else designSection.append(node('p', 'This search did not produce a design meeting every constraint.', 'field-help'));
  const assumptions = node('div');
  addList(assumptions, run.scope?.assumptions, 'Model assumptions');
  columns.append(designSection, assumptions);
  container.append(columns);
  if (Array.isArray(verification.sensitivity) && verification.sensitivity.length) {
    const details = node('details');
    details.append(node('summary', 'Sensitivity checks & discrepancy flags', 'details-toggle'));
    const list = node('ul', null, 'simple-list');
    for (const item of verification.sensitivity) list.append(node('li', `${item.scenario}: ${number(item.predictedBaseC)} °C · ${item.withinTemperatureLimit ? 'within' : 'outside'} declared temperature limit. ${item.evidence || ''}`));
    details.append(list);
    addList(details, verification.discrepancyFlags, 'Discrepancy flags');
    container.append(details);
  }
  const prospective = node('div', null, 'results-split');
  addList(prospective, run.falsificationPlan, 'What could falsify this result?');
  addList(prospective, run.scope?.limits, 'Limits & untested failure modes');
  container.append(prospective);
  const details = node('details');
  details.append(node('summary', `Inspect all ${run.candidates?.length ?? 0} candidate outcomes`, 'details-toggle'), candidateTable(run.candidates || []));
  container.append(details);
  if (run.improvementProposals?.length) {
    const proposals = node('details');
    proposals.append(node('summary', 'Suggested follow-up research (not deployed)', 'details-toggle'));
    addList(proposals, run.improvementProposals.map((item) => `${item.title}: ${item.rationale} ${item.authorization || ''}`));
    container.append(proposals);
  }
  const controls = node('div', null, 'results-actions');
  controls.append(action('Export this evidence ↗', () => exportEvidence(run.id)), node('span', 'E3 / E4 require prospective measurement and independent replication.', 'field-help'));
  container.append(controls);
  replace('results-content', [container]);
}
function renderIntegrity(integrity) {
  const banner = $('integrity-banner');
  banner.classList.toggle('warn', integrity?.valid !== true);
  const text = banner.querySelector('span:nth-child(2)');
  text.className = 'integrity-message';
  text.textContent = integrity?.valid === true ? `Ledger integrity verified · ${integrity.count ?? runs.length} records · hash chain consistent` : `Ledger integrity requires attention: ${integrity?.error || integrity?.reason || 'not yet verified'}`;
}
function renderEvidence() {
  const list = $('evidence-list');
  list.replaceChildren();
  if (evidenceEvents.length) {
    const lifecycle = node('section', null, 'panel lifecycle-panel');
    const head = node('div', null, 'panel-head');
    head.append(node('div', 'RESEARCH LIFECYCLE', 'section-kicker'), node('span', `${evidenceEvents.length} EVENTS`, 'pill muted'));
    lifecycle.append(head, node('h2', 'The complete path, including interruptions.'), node('p', 'Started runs, provider responses, completion checkpoints, and failures remain part of the evidence trail.', 'field-help'));
    const timeline = node('ol', null, 'event-timeline');
    const labels = { 'research.started': 'Research started', 'research.completed': 'Research completed', 'research.failed': 'Research failed', 'proposal.received': 'Model proposals received' };
    const ordered = [...evidenceEvents].reverse();
    for (const event of ordered.slice(0, 100)) {
      const entry = node('li', null, event.type === 'research.failed' ? 'event-item failed' : 'event-item');
      const eventHead = node('div', null, 'event-head');
      eventHead.append(node('strong', labels[event.type] || event.type), node('time', date(event.timestamp)));
      entry.append(eventHead);
      if (event.message) entry.append(node('p', event.message, 'event-message'));
      if (event.runId) entry.append(node('span', `Run ${event.runId}`, 'event-meta'));
      if (event.hash) entry.append(node('span', `Record ${String(event.hash).slice(0, 16)}…`, 'event-meta'));
      timeline.append(entry);
    }
    lifecycle.append(timeline);
    if (evidenceEvents.length > 100) lifecycle.append(node('p', 'Showing the latest 100 events. Export the evidence package for the full ledger.', 'field-help'));
    list.append(lifecycle);
  }
  if (!runs.length) {
    const empty = node('div', null, 'ledger-empty');
    empty.append(node('span', '▤', 'empty-icon'), node('h2', 'A record starts with a question.'), node('p', 'Your experiments, failed designs, and verification results will appear here.'), action('Start an experiment ↗', () => showPage('research'), 'button primary'));
    list.append(empty); return;
  }
  for (const run of runs) {
    const card = node('article', null, 'panel evidence-card');
    const head = node('div', null, 'panel-head');
    head.append(node('h2', run.spec?.title || 'Heat-sink research run'), node('span', run.best ? `${run.best.evidenceLevel || 'E2'} · COMPUTED` : 'E0 · NO PASS', 'pill'));
    card.append(head, node('div', `${date(run.createdAt)} · ${run.id || 'Unknown ID'}`, 'evidence-meta'), node('p', run.spec?.objective || 'Bounded heat-sink optimization'));
    card.append(node('p', `${run.summary?.evaluated ?? 0} evaluated · ${run.summary?.passed ?? 0} passed · ${run.summary?.rejected ?? 0} rejected${run.best ? ` · best prediction ${number(run.best.predictedBaseC)} °C` : ''}`, 'evidence-claim'));
    if (run.generator) card.append(node('div', run.generator.providerId ? `Proposal model: ${run.generator.providerId} / ${run.generator.model}` : 'Generator: offline seeded search', 'evidence-meta'));
    const controls = node('div', null, 'evidence-actions');
    controls.append(action('Inspect result ↗', () => { showPage('research'); renderResults(run); $('results-panel').scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 'text-button'), action('Export run ↗', () => exportEvidence(run.id), 'text-button'));
    card.append(controls);
    list.append(card);
  }
}
async function refreshEvidence() {
  const result = await api.listEvidence();
  runs = sortRuns(result.runs || []);
  evidenceEvents = Array.isArray(result.events) ? result.events : [];
  renderRunCount(); renderEvidence(); renderIntegrity(result.integrity || result.ledgerIntegrity);
  if (runs.length) renderLatest(runs[0]);
}
async function exportEvidence(id) {
  const result = await api.exportEvidence(id || null);
  if (!result?.canceled) toast('Evidence exported successfully.');
}
function provider() { return state.providers.find((entry) => entry.id === $('provider-select').value); }
function renderProviderStatus() {
  const entry = provider();
  $('provider-state').textContent = entry?.configured ? `${entry.name}: key available in the main process (${state.credentialStorage === 'session-only' ? 'this session only; OS encryption is unavailable' : 'OS-encrypted storage'}).` : 'No key saved for this provider.';
  $('remove-key').disabled = !entry?.configured;
  $('refresh-models').disabled = !entry?.configured;
}
function renderSelection() {
  const selected = state.selectedModel;
  const target = $('active-model');
  target.replaceChildren(node('div', '◇', 'model-orb'));
  if (selected) {
    const name = state.providers.find((entry) => entry.id === selected.providerId)?.name || selected.providerId;
    target.append(node('span', name, 'selected-model-provider'), node('h2', selected.model), node('p', 'Selected explicitly for optional cloud design proposals. Research runs always retain the actual model identifier.'), action('Use local calculations only', async () => { await api.selectModel(null); state.selectedModel = null; $('use-ai').checked = false; renderSelection(); renderCatalog(); toast('Cloud model unselected.'); }, 'text-button'));
    $('selected-model-hint').textContent = `${name} / ${selected.model}`;
  } else {
    target.append(node('h2', 'No model selected'), node('p', 'Local research works without a cloud connection. Select a model to add AI proposals.'));
    $('selected-model-hint').textContent = 'Optional · connect and select a model first';
    $('use-ai').checked = false;
  }
}
function renderCatalog() {
  const target = $('model-list');
  target.replaceChildren();
  const providerId = $('provider-select').value;
  const cached = state.modelCatalogs?.[providerId];
  if (!catalog.length) {
    target.append(node('p', cached?.error || 'No model catalog loaded. Save a key and refresh to discover provider-advertised models. Account access and compatibility may vary.', 'muted-text'));
    return;
  }
  if (cached?.error) target.append(node('p', `Last refresh failed: ${cached.error}. The catalog below is cached.`, 'ledger-warnings'));
  const search = node('input', null, 'search-models');
  search.type = 'search'; search.placeholder = `Filter ${catalog.length} available models…`; search.setAttribute('aria-label', 'Filter available models');
  const list = node('div');
  const count = node('p', null, 'field-help');
  target.append(search, count, list);
  const draw = () => {
    list.replaceChildren();
    const filter = search.value.trim().toLowerCase();
    const matches = catalog.filter((entry) => `${entry.id} ${entry.name || ''}`.toLowerCase().includes(filter));
    count.textContent = `${matches.length} models${cached?.refreshedAt ? ` · refreshed ${date(cached.refreshedAt)}` : ''}${matches.length > 100 ? ' · showing first 100; filter to narrow' : ''}`;
    for (const model of matches.slice(0, 100)) {
      const row = node('div', null, 'model-row');
      const label = node('div'); label.append(node('strong', model.name || model.id));
      if (model.name && model.name !== model.id) label.append(node('small', model.id));
      if (model.capabilitySource === 'unverified') label.append(node('small', 'Text-generation compatibility unverified'));
      const selected = state.selectedModel?.providerId === providerId && state.selectedModel?.model === model.id;
      const select = action(selected ? 'Selected ✓' : 'Select', async () => {
        const selection = { providerId, model: model.id };
        await api.selectModel(selection); state.selectedModel = selection;
        renderSelection(); renderCatalog(); toast(`Selected ${model.name || model.id}.`);
      }, selected ? 'button primary' : 'button secondary');
      select.disabled = selected;
      row.append(label, select); list.append(row);
    }
  };
  search.addEventListener('input', draw); draw();
}
function providerChanged() {
  $('provider-key').value = '';
  renderProviderStatus();
  const cached = state.modelCatalogs?.[$('provider-select').value];
  catalog = Array.isArray(cached?.models) ? cached.models : [];
  renderCatalog();
}
function renderProviders() {
  const selected = $('provider-select').value;
  $('provider-select').replaceChildren();
  for (const entry of state.providers || []) {
    const option = node('option', `${entry.name}${entry.configured ? ' · connected' : ''}`);
    option.value = entry.id; $('provider-select').append(option);
  }
  if (state.providers.some((entry) => entry.id === selected)) $('provider-select').value = selected;
  else if (state.selectedModel?.providerId) $('provider-select').value = state.selectedModel.providerId;
  providerChanged(); renderSelection();
}
function renderUpdates(update = {}) {
  state.update = update;
  const messages = { idle: 'Automatic updates are checked when the packaged app starts.', checking: 'Checking the release feed…', available: 'An application update is available. Downloading…', downloading: 'Downloading the application update…', downloaded: 'Update downloaded. Restart the application to install it.', 'not-available': 'You are running the latest published release.', error: 'The update check failed. You can retry.', disabled: 'Updates are available only in a packaged application.' };
  $('update-status').textContent = update.message || messages[update.status] || 'Updates use the stable GitHub release feed.';
  $('install-update').disabled = update.status !== 'downloaded' || running;
  $('check-updates').disabled = ['checking', 'downloading'].includes(update.status);
}
function applyState(next) {
  state = { ...state, ...next };
  if (Array.isArray(next.runs)) runs = sortRuns(next.runs);
  if (Array.isArray(next.evidenceEvents)) evidenceEvents = next.evidenceEvents;
  renderRunCount(); renderProviders(); renderUpdates(state.update);
  const version = state.version || state.appVersion || 'development';
  $('app-version').textContent = version;
  $('electron-version').textContent = state.electronVersion || 'Unknown';
  $('sidebar-version').textContent = `v${version} · Local workspace`;
  $('footer-version').textContent = `v${version}`;
  renderIntegrity(state.ledgerIntegrity);
  if (runs.length) renderLatest(runs[0]);
}

document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); showPage('research'); });
$('view-evidence').addEventListener('click', () => showPage('evidence'));
$('provider-select').addEventListener('change', providerChanged);
$('research-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (running || !api) return;
  if ($('use-ai').checked && !state.selectedModel) { showPage('models'); toast('Connect a provider and select a model first.', true); return; }
  const form = new FormData(event.currentTarget);
  const spec = { title: 'Heat-sink design study', objective: String(form.get('objective')).trim(), conductivityWmK: 205, seed: 42, useCloud: $('use-ai').checked };
  for (const key of ['heatLoadW', 'ambientC', 'convectionWm2K', 'budget', 'widthMm', 'depthMm', 'maxHeightMm', 'maxMassG', 'maxBaseC']) spec[key] = Number(form.get(key));
  running = true;
  document.body.classList.add('busy');
  $('run-button').disabled = true;
  $('run-button').textContent = spec.useCloud ? 'Requesting & checking…' : 'Computing & checking…';
  $('run-message').hidden = false;
  $('run-message').classList.remove('error');
  $('run-message').textContent = spec.useCloud ? 'Sending the specification to your selected provider, then checking bounded proposals. Model output cannot execute code.' : 'Evaluating constrained designs and checking numerical agreement. Every outcome will be recorded.';
  try {
    const run = await api.runResearch(spec);
    renderResults(run); renderLatest(run);
    await refreshEvidence();
    $('run-message').textContent = run.best ? `Run recorded. ${run.summary?.passed ?? 0} designs passed the declared checks. Predictions still require physical validation.` : 'Run recorded. No candidate passed every constraint; inspect the failed outcomes.';
    toast('Experiment completed and evidence recorded.');
    $('results-panel').scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch (error) {
    $('run-message').classList.add('error');
    $('run-message').textContent = message(error);
    toast(message(error), true);
  } finally {
    running = false; document.body.classList.remove('busy');
    $('run-button').disabled = false; $('run-button').replaceChildren(document.createTextNode('Run experiment '), node('span', '↗'));
    renderUpdates(state.update);
  }
});
$('provider-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const providerId = $('provider-select').value;
  const key = $('provider-key').value.trim();
  $('provider-key').value = '';
  if (!key) { toast('Enter the API key for this provider.', true); return; }
  $('save-key').disabled = true;
  try {
    await api.saveProviderKey({ providerId, key });
    applyState(await api.getState());
    toast('Connection saved. Refresh the catalog to verify access.');
  } catch (error) { toast(message(error), true); }
  finally { $('save-key').disabled = false; }
});
$('remove-key').addEventListener('click', async () => {
  const providerId = $('provider-select').value;
  try { await api.removeProviderKey(providerId); applyState(await api.getState()); toast('Provider key removed.'); }
  catch (error) { toast(message(error), true); }
});
$('refresh-models').addEventListener('click', async () => {
  const providerId = $('provider-select').value;
  $('refresh-models').disabled = true;
  $('provider-state').textContent = 'Fetching the live provider catalog…';
  try {
    const result = await api.discoverModels(providerId);
    catalog = Array.isArray(result) ? result : result.models || [];
    state.modelCatalogs = { ...state.modelCatalogs, [providerId]: { models: catalog, refreshedAt: new Date().toISOString() } };
    renderCatalog(); renderProviderStatus(); toast(`Discovered ${catalog.length} models.`);
  } catch (error) { $('provider-state').textContent = message(error); toast(message(error), true); }
  finally { $('refresh-models').disabled = false; }
});
$('export-all').addEventListener('click', () => exportEvidence().catch((error) => toast(message(error), true)));
$('refresh-evidence').addEventListener('click', () => refreshEvidence().catch((error) => toast(message(error), true)));
$('check-updates').addEventListener('click', async () => {
  $('check-updates').disabled = true;
  try { const result = await api.checkUpdates(); if (result) renderUpdates(result); }
  catch (error) { renderUpdates({ status: 'error', message: message(error) }); }
  finally { if (state.update.status !== 'checking' && state.update.status !== 'downloading') $('check-updates').disabled = false; }
});
$('install-update').addEventListener('click', async () => {
  if (running) return;
  try { await api.installUpdate(); } catch (error) { toast(message(error), true); }
});

async function initialize() {
  if (!api) {
    $('run-button').disabled = true;
    $('run-message').hidden = false;
    $('run-message').classList.add('error');
    $('run-message').textContent = 'The desktop bridge is unavailable. Launch this workspace through Electron to run experiments.';
    renderUpdates({ status: 'disabled', message: 'Launch through Electron to access application updates.' });
    return;
  }
  try {
    if (typeof api.onUpdate === 'function') api.onUpdate(renderUpdates);
    applyState(await api.getState());
    await refreshEvidence();
  } catch (error) { toast(`Could not initialize workspace: ${message(error)}`, true); }
}
initialize();
