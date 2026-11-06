import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, readFile, readdir, rename, open, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateProject } from './project.js';
import { verifyProjectInWorker } from './verify.js';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = content => createHash('sha256').update(content).digest('hex');
const generatorFields = new Set(['providerId', 'model', 'kind', 'generatedAt']);

function provenance(input = {}) {
  return Object.fromEntries(Object.entries(input && typeof input === 'object' ? input : {}).filter(([key, value]) => generatorFields.has(key) && typeof value === 'string' && value.length <= 500));
}

export class ProjectStore {
  constructor(directory) { this.directory = path.resolve(directory); }
  async save(input, { objective = '', generator = {}, buildReport, kind = 'web-app' } = {}) {
    if (typeof objective !== 'string' || objective.length > 6000) throw new Error('Build objective must be at most 6000 characters.');
    const project = validateProject(input, { kind });
    const record = { ...project, id: randomUUID(), createdAt: new Date().toISOString(), version: 1, kind, objective,
      generator: provenance(generator), ...(buildReport ? { buildReport } : {}), verification: await verifyProjectInWorker(project, kind),
      artifacts: project.files.map(file => ({ path: file.path, sha256: hash(file.content), bytes: Buffer.byteLength(file.content, 'utf8') })) };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `${record.id}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path.join(this.directory, `${record.id}.json`));
    return record;
  }
  async get(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid project identifier.');
    const file = path.join(this.directory, `${id}.json`);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('Saved project is not a supported regular file.');
    const record = JSON.parse(await readFile(file, 'utf8'));
    if (record.id !== id || record.version !== 1 || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) || typeof record.objective !== 'string' || record.objective.length > 6000) throw new Error('Saved project has an unsupported format.');
    const project = validateProject(record, { kind: record.kind });
    if (!Array.isArray(record.artifacts) || project.files.some(file => !record.artifacts.some(artifact => artifact && artifact.path === file.path && artifact.sha256 === hash(file.content)))) throw new Error('Saved project content does not match its artifact hashes.');
    return { ...project, id, createdAt: record.createdAt, version: 1, kind: record.kind, objective: record.objective,
      artifacts: project.files.map(file => ({ path: file.path, sha256: hash(file.content), bytes: Buffer.byteLength(file.content, 'utf8') })),
      generator: provenance(record.generator), ...(record.buildReport ? { buildReport: record.buildReport } : {}), verification: await verifyProjectInWorker(project, record.kind) };
  }
  async list({ limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid project listing limit.');
    let entries;
    try { entries = await readdir(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const candidates = [];
    for (const entry of entries.filter(name => name.endsWith('.json') && ID.test(name.slice(0, -5)))) {
      const info = await lstat(path.join(this.directory, entry));
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('Saved project is not a supported regular file.');
      candidates.push({ id: entry.slice(0, -5), modified: info.mtimeMs });
    }
    const records = [];
    for (const entry of candidates.sort((a, b) => b.modified - a.modified).slice(0, limit)) records.push(await this.get(entry.id));
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async export(id, destination) {
    const record = await this.get(id);
    if (typeof destination !== 'string' || !destination) throw new Error('Choose an export directory.');
    // The chosen root may itself be a user-approved symlink; resolve it once.
    // These checks prevent ordinary traversal and clobbering. They do not form
    // a security boundary against an attacker controlling the same OS account,
    // who can race directory replacements between filesystem operations.
    const root = await realpath(destination);
    if (!(await lstat(root)).isDirectory()) throw new Error('Choose an existing export directory.');
    const output = path.join(root, `artificial-inventor-${record.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`);
    await mkdir(output, { mode: 0o700 }); // exclusive child: never reuse an existing project folder
    for (const file of record.files) {
      const parts = file.path.split('/');
      let directory = output;
      for (const part of parts.slice(0, -1)) {
        directory = path.join(directory, part);
        try { await mkdir(directory, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Export stopped because a generated directory was replaced or is invalid.');
      }
      const handle = await open(path.join(directory, parts.at(-1)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.writeFile(file.content); } finally { await handle.close(); }
    }
    const manifest = await open(path.join(output, '.artificial-inventor.json'), 'wx', 0o600);
    try { await manifest.writeFile(JSON.stringify({ ...record, files: undefined }, null, 2)); } finally { await manifest.close(); }
    return { path: output, fileCount: record.files.length, id: record.id };
  }
}
