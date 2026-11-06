import { parse } from 'acorn';
import path from 'node:path';

export const PROJECT_LIMITS = Object.freeze({ files: 30, fileBytes: 100 * 1024, totalBytes: 500 * 1024 });
const WEB_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.md', '.txt', '.svg']);
const CODE_EXTENSIONS = new Set([...WEB_EXTENSIONS, '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.toml', '.yaml', '.yml', '.sh', '.sql']);
const text = (value, name, maximum, required = true) => {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > maximum) throw new Error(`${name} must be text${required ? ' containing at least one character' : ''} of at most ${maximum} characters.`);
  return value.trim();
};

export function validateProjectPath(value) {
  if (typeof value !== 'string' || !value || value.length > 180 || value.includes('\\') || value.startsWith('/')) throw new Error('Project paths must be short relative POSIX paths.');
  const parts = value.split('/');
  for (const part of parts) {
    if (!part || part.length > 80 || !/^[A-Za-z0-9_][A-Za-z0-9_. -]*$/.test(part) || /[. ]$/.test(part)) throw new Error('Project paths contain an invalid or nonportable component.');
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(part.split('.')[0].trimEnd())) throw new Error('Project paths cannot use Windows device names.');
  }
  return value;
}

/** Structured source artifacts only. No command or model-supplied authority is accepted. */
export function validateProject(input, { kind = 'web-app' } = {}) {
  if (!['web-app', 'code-project'].includes(kind)) throw new Error('Choose a web app or code project.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The model must return a project object.');
  const title = text(input.title, 'Project title', 120);
  const summary = text(input.summary, 'Project summary', 2000);
  const instructions = text(input.instructions, 'Project instructions', 6000, false);
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > PROJECT_LIMITS.files) throw new Error(`A project must contain 1–${PROJECT_LIMITS.files} files.`);
  const extensions = kind === 'web-app' ? WEB_EXTENSIONS : CODE_EXTENSIONS;
  const seen = new Set();
  let bytes = 0;
  const files = input.files.map(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('Every project file must be an object.');
    const filePath = validateProjectPath(file.path);
    if (!extensions.has(path.posix.extname(filePath).toLowerCase())) throw new Error(`Unsupported source file extension: ${filePath}`);
    if (seen.has(filePath.toLowerCase())) throw new Error('Project file names must be unique, including on case-insensitive systems.');
    seen.add(filePath.toLowerCase());
    if (typeof file.content !== 'string') throw new Error('Every project file needs text content.');
    const size = Buffer.byteLength(file.content, 'utf8');
    if (size > PROJECT_LIMITS.fileBytes) throw new Error(`File exceeds the ${PROJECT_LIMITS.fileBytes / 1024} KiB limit: ${filePath}`);
    bytes += size;
    return { path: filePath, content: file.content };
  });
  if (bytes > PROJECT_LIMITS.totalBytes) throw new Error(`Project exceeds the ${PROJECT_LIMITS.totalBytes / 1024} KiB limit.`);
  for (const file of files) {
    const parts = file.path.toLowerCase().split('/');
    for (let index = 1; index < parts.length; index++) if (seen.has(parts.slice(0, index).join('/'))) throw new Error('A project path cannot be both a file and a directory.');
  }
  if (kind === 'web-app' && !files.some(file => file.path === 'index.html')) throw new Error('A browser app requires index.html at the project root.');
  return { title, summary, instructions, files };
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
  return result;
}
function localReference(reference, source) {
  const clean = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
  const target = path.posix.normalize(clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(source), clean));
  validateProjectPath(target);
  return target;
}
function checkReference(reference, source, files, checks) {
  if (!reference || reference.startsWith('#') || reference.startsWith('data:')) return;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) {
    checks.push({ kind: 'resource', path: source, passed: false, message: `External resource is unavailable in the isolated preview: ${reference.slice(0, 150)}` });
    return;
  }
  let target;
  try {
    target = localReference(reference, source);
  } catch {
    checks.push({ kind: 'resource', path: source, passed: false, message: 'A resource reference escapes the project or has an invalid path.' });
    return;
  }
  checks.push({ kind: 'resource', path: source, passed: files.has(target), message: files.has(target) ? `Local resource found: ${target}` : `Missing local resource: ${target}` });
}
function syntaxCheck(content, sourceType, filePath, checks) {
  try {
    let program, parsedType = sourceType;
    if (sourceType === 'auto') {
      try { program = parse(content, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true }); parsedType = 'script'; }
      catch { program = parse(content, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); parsedType = 'module'; }
    } else program = parse(content, { ecmaVersion: 'latest', sourceType, allowHashBang: true });
    checks.push({ kind: 'syntax', path: filePath, passed: true, message: `JavaScript ${parsedType} syntax parsed without executing code.` });
    return program;
  } catch (error) {
    checks.push({ kind: 'syntax', path: filePath, passed: false, message: `JavaScript syntax error: ${String(error.message).slice(0, 250)}` });
    return null;
  }
}

/** Syntax and packaged-resource checks, never a claim of functional correctness. */
export function verifyProject(input, { kind = 'web-app' } = {}) {
  const project = validateProject(input, { kind });
  const files = new Map(project.files.map(file => [file.path, file]));
  const checks = [{ kind: 'structure', passed: true, message: `${files.size} bounded source files with portable relative paths.` }];
  const modules = new Set();
  const classicScripts = new Set();
  let packageIsModule = false;
  try { packageIsModule = JSON.parse(files.get('package.json')?.content ?? '{}').type === 'module'; } catch { /* JSON check below records the invalid file. */ }
  for (const file of project.files.filter(file => file.path.toLowerCase().endsWith('.html'))) {
    for (const match of file.content.matchAll(/<(script|link|img|iframe|audio|video|source)\b[^>]*>/gi)) {
      const attrs = attributes(match[0]);
      const tag = match[1].toLowerCase();
      const ref = tag === 'link' ? (attrs.rel?.toLowerCase().split(/\s+/).includes('stylesheet') ? attrs.href : null) : attrs.src;
      if (kind === 'web-app' && ref) checkReference(ref, file.path, files, checks);
      if (tag === 'script' && ref && !/^(?:[a-z]+:|\/\/)/i.test(ref)) {
        try {
          const target = localReference(ref, file.path);
          if (attrs.type === 'module') modules.add(target);
          else if (!attrs.type || ['text/javascript', 'application/javascript'].includes(attrs.type)) classicScripts.add(target);
        } catch { /* Resource check above records the invalid reference. */ }
      }
    }
    for (const match of file.content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const attrs = attributes(match[1]);
      if (!attrs.src && (!attrs.type || ['module', 'text/javascript', 'application/javascript'].includes(attrs.type))) syntaxCheck(match[2], attrs.type === 'module' ? 'module' : 'script', file.path, checks);
    }
  }
  for (const file of project.files) {
    const extension = path.posix.extname(file.path).toLowerCase();
    if (['.js', '.mjs'].includes(extension)) {
      const sourceType = classicScripts.has(file.path) ? 'script' : extension === '.mjs' || modules.has(file.path) || packageIsModule ? 'module' : 'auto';
      const program = syntaxCheck(file.content, sourceType, file.path, checks);
      if (kind === 'web-app' && program) for (const statement of program.body) {
        if (statement.source?.value && ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(statement.type)) {
          const ref = statement.source.value;
          if (!ref.startsWith('.') && !ref.startsWith('/')) checks.push({ kind: 'resource', path: file.path, passed: false, message: 'Browser imports must use included local files; packages are not installed in preview.' });
          else checkReference(ref, file.path, files, checks);
        }
      }
    } else if (extension === '.json') {
      try { JSON.parse(file.content); checks.push({ kind: 'json', path: file.path, passed: true, message: 'JSON parsed successfully.' }); }
      catch { checks.push({ kind: 'json', path: file.path, passed: false, message: 'File contains invalid JSON.' }); }
    } else if (extension === '.css' && kind === 'web-app') {
      for (const match of file.content.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)) checkReference(match[1], file.path, files, checks);
      for (const match of file.content.matchAll(/@import\s+["']([^"']+)["']/gi)) checkReference(match[1], file.path, files, checks);
    }
  }
  const languages = project.files.filter(file => !WEB_EXTENSIONS.has(path.posix.extname(file.path).toLowerCase())).map(file => file.path);
  return {
    passed: checks.every(check => check.passed), checks,
    validationScope: 'structure-and-supported-source-syntax', functionalValidation: 'not-performed', unvalidatedFiles: languages,
    limitations: [
      'These checks parse supported source files and inspect common local resource references. They do not execute generated programs or prove functional correctness.',
      'Browser preview is isolated from application credentials and files; network requests, installed packages, and server processes are unavailable.',
      'HTML and CSS are not fully validated. Dynamic imports, computed resource paths, and browser behavior need functional testing.',
      ...(languages.length ? [`No compiler or runtime validation was performed for these source files: ${languages.join(', ')}.`] : []),
      'Generated test code is an artifact, not evidence that its tests ran or passed. Review source before running it outside the isolated preview.'
    ]
  };
}

export function createDemoProject() {
  return {
    title: 'Idea Board', summary: 'A usable browser task board for tracking invention ideas through proposal, prototype, and testing stages.',
    instructions: 'Open index.html in the isolated preview or a browser. Add an idea, move it through stages, and remove it when finished. Data lasts for this page session; no server or packages are required.',
    files: [
      { path: 'index.html', content: '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Idea Board</title><link rel="stylesheet" href="styles.css"></head><body><main><header><span class="eyebrow">FROM IDEA TO EXPERIMENT</span><h1>Idea Board</h1><p>Give your next invention a small, testable next step.</p></header><form id="idea-form"><label for="idea">Your idea</label><div class="entry"><input id="idea" maxlength="140" placeholder="A self-watering planter, for example" required><button>Add idea</button></div></form><p id="status" aria-live="polite"></p><section id="board" class="board" aria-label="Idea stages"></section><footer>Local page session · no accounts · no network</footer></main><script src="app.js"></script></body></html>\n' },
      { path: 'styles.css', content: ':root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101915;color:#e5f3eb}*{box-sizing:border-box}body{margin:0;padding:36px}main{max-width:1050px;margin:auto}.eyebrow{font-size:11px;letter-spacing:.2em;color:#8cd5af}h1{font-size:48px;margin:12px 0}header p,footer{color:#9db2a5}form{margin:36px 0 12px}label{display:block;margin-bottom:10px}.entry{display:flex;gap:10px}input{min-width:0;flex:1;background:#16251d;border:1px solid #385443;color:inherit;border-radius:8px;padding:13px;font:inherit}button{border:0;border-radius:8px;background:#a6e8c1;color:#13291d;padding:12px 18px;font:inherit;cursor:pointer}.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin:28px 0}article{background:#15221b;border:1px solid #304b3b;border-radius:14px;padding:18px;min-height:260px}h2{font-size:16px;margin:0 0 18px}.card{background:#203329;border-radius:10px;padding:14px;margin-top:12px}.card p{overflow-wrap:anywhere}.card button{padding:6px 9px;font-size:12px;margin:3px}.remove{background:#36493e;color:#dcecdf}.empty{font-size:13px;color:#819c8c}footer{font-size:12px;margin-top:30px}@media(max-width:700px){body{padding:20px}.board{grid-template-columns:1fr}.entry{flex-direction:column}h1{font-size:36px}}\n' },
      { path: 'app.js', content: "const stages = ['Proposed', 'Prototyping', 'Testing'];\nconst ideas = [];\nconst form = document.getElementById('idea-form');\nconst input = document.getElementById('idea');\nconst board = document.getElementById('board');\nconst status = document.getElementById('status');\nfunction draw() {\n  board.replaceChildren();\n  stages.forEach((stage, index) => {\n    const column = document.createElement('article');\n    const heading = document.createElement('h2');\n    const items = ideas.filter(idea => idea.stage === index);\n    heading.textContent = stage + ' · ' + items.length;\n    column.append(heading);\n    if (!items.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No ideas in this stage yet.'; column.append(empty); }\n    items.forEach(idea => {\n      const card = document.createElement('div'); card.className = 'card';\n      const title = document.createElement('p'); title.textContent = idea.text; card.append(title);\n      if (index < stages.length - 1) { const next = document.createElement('button'); next.textContent = 'Move to ' + stages[index + 1]; next.addEventListener('click', () => { idea.stage++; draw(); }); card.append(next); }\n      const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.className = 'remove';\n      remove.addEventListener('click', () => { ideas.splice(ideas.indexOf(idea), 1); draw(); }); card.append(remove); column.append(card);\n    });\n    board.append(column);\n  });\n  status.textContent = ideas.length + (ideas.length === 1 ? ' idea' : ' ideas') + ' in your research pipeline';\n}\nform.addEventListener('submit', event => { event.preventDefault(); const value = input.value.trim(); if (!value) return; ideas.push({ text: value, stage: 0 }); input.value = ''; draw(); input.focus(); });\ndraw();\n" }
    ]
  };
}
