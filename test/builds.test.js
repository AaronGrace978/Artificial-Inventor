import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDemoProject, validateProject, validateProjectPath, verifyProject, PROJECT_LIMITS } from '../src/builds/project.js';
import { ProjectStore } from '../src/builds/store.js';

test('offline demo is a real multi-file app with valid JavaScript and packaged resources', () => {
  const project = validateProject(createDemoProject());
  assert.equal(project.files.length, 3);
  const verification = verifyProject(project);
  assert.equal(verification.passed, true);
  assert.ok(verification.checks.some(check => check.kind === 'syntax' && check.passed));
  assert.equal(verification.checks.filter(check => check.kind === 'resource').length, 2);
  assert.match(verification.limitations.join(' '), /do not execute/);
});

test('source paths reject traversal, Windows special names, separators, and case collisions', () => {
  for (const value of ['../escape.js', '/absolute.js', 'C:/drive.js', '\\\\server\\x.js', 'a/../b.js', 'a//b.js', '.env', 'x.js ', 'foo./a.js', 'CON.js', 'CON .txt', 'LPT1 .js', 'aux/a.js', 'COM1.txt', 'a.js:stream', 'a/\0x.js', 'a/\nx.js', 'a/%2e%2e/x.js', 'Ｘ.js']) assert.throws(() => validateProjectPath(value), undefined, value);
  const demo = createDemoProject();
  assert.throws(() => validateProject({ ...demo, files: [...demo.files, { path: 'APP.JS', content: '' }] }), /unique/);
  assert.throws(() => validateProject({ ...demo, files: [...demo.files, { path: 'app.js/other.js', content: '' }] }), /both a file and a directory/);
});

test('artifact validation enforces file, byte and metadata bounds and web entry point', () => {
  const demo = createDemoProject();
  assert.throws(() => validateProject({ ...demo, files: demo.files.slice(1) }), /index.html/);
  assert.throws(() => validateProject({ ...demo, files: Array.from({ length: 31 }, (_, index) => ({ path: `${index}.js`, content: '' })) }), /1–30/);
  assert.throws(() => validateProject({ ...demo, files: [{ path: 'index.html', content: 'x'.repeat(PROJECT_LIMITS.fileBytes + 1) }] }), /100 KiB/);
  assert.throws(() => validateProject({ ...demo, files: Array.from({ length: 6 }, (_, index) => ({ path: index ? `${index}.js` : 'index.html', content: 'x'.repeat(PROJECT_LIMITS.fileBytes) })) }), /500 KiB/);
  assert.throws(() => validateProject({ ...demo, files: [{ path: 'index.html', content: 3 }] }), /text content/);
});

test('verification detects broken JavaScript, JSON, local links and remote dependencies', () => {
  const project = { title: 'Broken app', summary: 'Failures are visible', files: [
    { path: 'index.html', content: '<script src="missing.js"></script><link rel="stylesheet" href="https://example.com/styles.css">' },
    { path: 'app.js', content: 'function broken( {' }, { path: 'config.json', content: '{oops}' }
  ] };
  const result = verifyProject(project);
  assert.equal(result.passed, false);
  assert.ok(result.checks.filter(check => !check.passed).length >= 4);
});

test('ES module dependencies are checked without executing generated side effects', () => {
  const project = { title: 'Modules', summary: 'Parse only', files: [
    { path: 'index.html', content: '<script type="module" src="app.mjs"></script>' },
    { path: 'app.mjs', content: 'import { value } from "./helper.mjs"; throw new Error("must not execute");' },
    { path: 'helper.mjs', content: 'export const value = 1;' }
  ] };
  assert.equal(verifyProject(project).passed, true);
  project.files[1].content = 'import missing from "not-installed-package";';
  assert.equal(verifyProject(project).passed, false);
  project.files[0].content = '<script src="helper.mjs"></script>';
  assert.equal(verifyProject(project).passed, false, 'ES module syntax cannot pass as a classic script');
});

test('other-language projects remain exportable and their validation limits are explicit', () => {
  const project = { title: 'Python artifact', summary: 'Not executed', files: [{ path: 'main.py', content: 'print("prototype")' }] };
  const result = verifyProject(project, { kind: 'code-project' });
  assert.equal(result.passed, true);
  assert.ok(result.limitations.some(item => item.includes('No compiler or runtime validation') && item.includes('main.py')));
});

test('compact ES module syntax, package type and query-bearing HTML module references parse correctly', () => {
  const compact = { title: 'Compact module', summary: 'Module syntax', files: [{ path: 'main.js', content: 'export{}' }] };
  assert.equal(verifyProject(compact, { kind: 'code-project' }).passed, true);
  compact.files = [{ path: 'package.json', content: '{"type":"module"}' }, { path: 'main.js', content: 'await Promise.resolve();' }];
  assert.equal(verifyProject(compact, { kind: 'code-project' }).passed, true);
  compact.files = [{ path: 'index.html', content: '<script type="module" src="app.js?v=1#entry"></script>' }, { path: 'app.js', content: 'await Promise.resolve();' }];
  assert.equal(verifyProject(compact).passed, true);
});

test('project store persists source and hashes, excludes credential fields, and detects edited source', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inventor-builds-'));
  try {
    const store = new ProjectStore(path.join(directory, 'store'));
    const record = await store.save(createDemoProject(), { objective: 'Build an idea board', generator: { providerId: 'example', model: 'test-model', key: 'must-not-save' } });
    assert.equal(record.verification.passed, true);
    assert.equal(record.generator.key, undefined);
    assert.equal((await store.list())[0].id, record.id);
    assert.equal((await store.get(record.id)).files.length, 3);
    const file = path.join(directory, 'store', `${record.id}.json`);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.files[0].content += '<!-- edited -->';
    await writeFile(file, JSON.stringify(saved));
    await assert.rejects(store.get(record.id), /artifact hashes/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('export creates exclusive child folders and preserves existing user files and prior exports', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inventor-export-'));
  try {
    const store = new ProjectStore(path.join(directory, 'store'));
    const record = await store.save(createDemoProject());
    const root = path.join(directory, 'chosen'); await mkdir(root);
    await writeFile(path.join(root, 'app.js'), 'USER FILE');
    const first = await store.export(record.id, root);
    const second = await store.export(record.id, root);
    assert.notEqual(first.path, second.path);
    assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'USER FILE');
    assert.equal(await readFile(path.join(first.path, 'app.js'), 'utf8'), record.files.find(file => file.path === 'app.js').content);
    assert.ok((await readdir(first.path)).includes('.artificial-inventor.json'));
    await assert.rejects(store.export('../outside', root), /identifier/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('saved-project symlinks are refused before source is loaded', async context => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inventor-link-'));
  try {
    const store = new ProjectStore(path.join(directory, 'store')); await mkdir(store.directory);
    const outside = path.join(directory, 'outside.json'); await writeFile(outside, '{}');
    const id = '00000000-0000-4000-8000-000000000001';
    try { await symlink(outside, path.join(store.directory, `${id}.json`)); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { context.skip('This OS account cannot create symlinks.'); return; } throw error; }
    await assert.rejects(store.get(id), /regular file/);
    assert.equal(await readFile(outside, 'utf8'), '{}');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
