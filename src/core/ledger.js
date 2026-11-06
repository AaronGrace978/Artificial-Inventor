import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const ZERO_HASH = '0'.repeat(64);

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new Error('Evidence must contain plain JSON data with finite numbers.');
}
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
async function optionalRead(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Local hash-chain ledger with a separate durable tail checkpoint.
 * Detects ordinary record edits, missing rows, and tail truncation. An attacker
 * who can rewrite both files can replace history; export/anchor hashes externally
 * for independent provenance. This is not immutable storage or a trust boundary. */
export class EvidenceLedger {
  constructor(directory) {
    this.directory = resolve(directory);
    this.file = join(this.directory, 'evidence.jsonl');
    this.checkpoint = join(this.directory, 'evidence-head.json');
    this.lock = join(this.directory, 'evidence.lock');
  }

  async #inspect() {
    const [text, checkpointText] = await Promise.all([optionalRead(this.file), optionalRead(this.checkpoint)]);
    if (text === null && checkpointText === null) return { valid: true, count: 0, headHash: ZERO_HASH, records: [] };
    const fail = (reason, records = []) => ({ valid: false, reason, count: records.length, headHash: records.at(-1)?.hash ?? ZERO_HASH, records });
    if (text === null || checkpointText === null) return fail('Ledger or tail checkpoint is missing.');
    if (text && !text.endsWith('\n')) return fail('Ledger has an incomplete final record.');
    let checkpoint;
    try { checkpoint = JSON.parse(checkpointText); } catch { return fail('Tail checkpoint is invalid JSON.'); }
    const records = [];
    let previousHash = ZERO_HASH;
    for (const line of text.split('\n').filter(Boolean)) {
      let record;
      try { record = JSON.parse(line); } catch { return fail('Ledger contains an invalid JSON record.', records); }
      const { hash, ...body } = record;
      if (Object.keys(record).sort().join(',') !== 'hash,payload,previousHash,sequence,timestamp,type,version') return fail('Unexpected ledger record format.', records);
      if (body.version !== 1 || body.sequence !== records.length + 1 || body.previousHash !== previousHash) return fail('Ledger sequence or previous hash does not match.', records);
      try { if (hash !== digest(body)) return fail('Ledger record hash does not match its content.', records); }
      catch { return fail('Ledger record is not canonical JSON.', records); }
      records.push(record);
      previousHash = hash;
    }
    if (checkpoint.count !== records.length || checkpoint.headHash !== previousHash) return fail('Ledger differs from its tail checkpoint; possible truncation or interrupted write.', records);
    return { valid: true, count: records.length, headHash: previousHash, records };
  }

  async verify() {
    const { records: _, ...result } = await this.#inspect();
    return result;
  }

  async read() {
    const result = await this.#inspect();
    if (!result.valid) throw new Error(`Evidence integrity check failed: ${result.reason}`);
    return result.records;
  }

  async append(type, payload) {
    if (typeof type !== 'string' || !/^[a-z][a-z0-9.-]{0,79}$/.test(type)) throw new Error('Invalid evidence event type.');
    const encoded = canonical(payload); // Reject non-JSON, executable, or nonfinite content.
    if (Buffer.byteLength(encoded) > 5 * 1024 * 1024) throw new Error('Evidence event exceeds the 5 MiB limit.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let lockHandle;
    try { lockHandle = await open(this.lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Evidence ledger is locked by another operation or an interrupted write.'); throw error; }
    let temporaryCheckpoint;
    try {
      const state = await this.#inspect();
      if (!state.valid) throw new Error(`Evidence integrity check failed: ${state.reason}`);
      const body = { version: 1, sequence: state.count + 1, timestamp: new Date().toISOString(), type, previousHash: state.headHash, payload: JSON.parse(encoded) };
      const record = { ...body, hash: digest(body) };
      const handle = await open(this.file, 'a', 0o600);
      try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); } finally { await handle.close(); }
      temporaryCheckpoint = join(this.directory, `.evidence-head-${randomUUID()}.tmp`);
      const headHandle = await open(temporaryCheckpoint, 'wx', 0o600);
      try { await headHandle.writeFile(JSON.stringify({ count: record.sequence, headHash: record.hash })); await headHandle.sync(); } finally { await headHandle.close(); }
      await rename(temporaryCheckpoint, this.checkpoint);
      temporaryCheckpoint = undefined;
      return record;
    } finally {
      if (temporaryCheckpoint) await unlink(temporaryCheckpoint).catch(() => {});
      await lockHandle.close();
      await unlink(this.lock);
    }
  }
}
