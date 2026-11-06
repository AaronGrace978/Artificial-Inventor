import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SPEC, validateSpec, validateCandidate, evaluateCandidate, numericFinConductance, createResearchRun } from '../src/core/research.js';
import { EvidenceLedger } from '../src/core/ledger.js';

const sample = { finHeightMm: 25, finThicknessMm: 1, baseThicknessMm: 5, finCount: 20 };

test('specification rejects ambiguity, unknown fields, invalid numbers, and unbounded budgets', () => {
  assert.deepEqual(validateSpec({}), DEFAULT_SPEC);
  for (const spec of [{ budget: 100000 }, { budget: 10.5 }, { heatLoadW: NaN }, { ambientC: 80 }, { maxBaseC: 20 }, { execute: 'do anything' }, { title: '' }]) {
    assert.throws(() => validateSpec(spec));
  }
});

test('candidate boundary checks reject impossible geometry, executable fields, and fabricated evidence', () => {
  assert.deepEqual(validateCandidate(sample), []);
  for (const candidate of [null, { ...sample, finCount: 2.5 }, { ...sample, finHeightMm: 90 }, { ...sample, finCount: 64, finThicknessMm: 5 }, { ...sample, evidenceLevel: 'E4' }, { ...sample, run: 'process.exit()' }]) {
    assert.equal(evaluateCandidate(candidate).status, 'rejected');
  }
});

test('analytical and finite-volume models agree and conserve energy under grid refinement', () => {
  for (const design of [sample, { finHeightMm: 35, finThicknessMm: 0.5, baseThicknessMm: 2, finCount: 10 }]) {
    const result = evaluateCandidate(design);
    assert.equal(result.verification.passed, true);
    assert.ok(result.verification.relativeError < 0.003);
    assert.ok(result.verification.energyBalanceRelativeError < 1e-6);
    assert.ok(result.predictedBaseC > DEFAULT_SPEC.ambientC);
    const coarse = numericFinConductance(design, DEFAULT_SPEC, 40);
    const fine = numericFinConductance(design, DEFAULT_SPEC, 80);
    const finer = numericFinConductance(design, DEFAULT_SPEC, 160);
    assert.ok(Math.abs(fine.conductance - finer.conductance) < Math.abs(coarse.conductance - fine.conductance));
  }
});

test('zero-length tip limit approaches h times exposed fin surface rather than inventing efficiency', () => {
  const result = evaluateCandidate({ ...sample, finHeightMm: 2 });
  assert.ok(result.finEfficiency > 0.99 && result.finEfficiency <= 1);
});

test('heat load scales temperature rise linearly and higher convection cools the model', () => {
  const ordinary = evaluateCandidate(sample);
  const hot = evaluateCandidate(sample, { heatLoadW: 40 });
  const windy = evaluateCandidate(sample, { convectionWm2K: 24 });
  assert.ok(Math.abs((hot.predictedBaseC - 25) - 2 * (ordinary.predictedBaseC - 25)) < 0.00002);
  assert.ok(windy.predictedBaseC < ordinary.predictedBaseC);
});

test('bounded runs reproduce candidates from seed, retain failures and compare a conventional baseline', () => {
  const proposals = [{ ...sample, finCount: 99 }, { ...sample, rationale: 'An unverified proposal' }];
  const a = createResearchRun({ budget: 40 }, { proposals });
  const b = createResearchRun({ budget: 40 }, { proposals });
  assert.deepEqual(a.candidates, b.candidates);
  assert.equal(a.candidates.length, 40);
  assert.equal(a.candidates[1].status, 'rejected');
  assert.equal(a.candidates[1].source, 'cloud-model-proposal');
  assert.ok(a.best);
  assert.ok(a.best.predictedBaseC <= a.baseline.predictedBaseC);
  assert.equal(a.summary.passed + a.summary.rejected, 40);
  assert.equal(a.verification.physicalValidation, 'not-performed');
  assert.equal(a.verification.evidenceLevel, 'E2');
  assert.equal(a.verification.sensitivity.length, 3);
});

test('infeasible studies do not claim a solution or empirical evidence', () => {
  const run = createResearchRun({ maxBaseC: 26, budget: 10 });
  assert.equal(run.best, null);
  assert.equal(run.status, 'no-feasible-design');
  assert.equal(run.verification.evidenceLevel, 'E0');
  assert.equal(run.candidates.length, 10);
  assert.equal(run.summary.passed, 0);
  assert.throws(() => createResearchRun({}, { proposals: Array(31).fill(sample) }));
  assert.throws(() => createResearchRun({ budget: 10 }, { proposals: Array(10).fill(sample) }), /budget/);
});

test('a rejected baseline cannot support a percentage improvement claim', () => {
  const run = createResearchRun({ maxMassG: 150, budget: 100 });
  assert.equal(run.baseline.status, 'rejected');
  assert.equal(run.summary.improvementPercent, null);
  assert.equal(run.summary.baselineFeasible, false);
});

async function withLedger(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'inventor-ledger-'));
  try { await fn(new EvidenceLedger(directory), directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('ledger persists full run artifacts with a hash chain and tail checkpoint', async () => withLedger(async (ledger) => {
  assert.deepEqual(await ledger.verify(), { valid: true, count: 0, headHash: '0'.repeat(64) });
  const run = createResearchRun({ budget: 10 });
  const first = await ledger.append('research.completed', run);
  const second = await ledger.append('human.review', { statement: 'Not physically tested' });
  assert.equal(second.previousHash, first.hash);
  assert.equal((await ledger.verify()).valid, true);
  assert.deepEqual((await ledger.read())[0].payload, run);
}));

test('ledger rejects edits to a candidate result and refuses further writes', async () => withLedger(async (ledger) => {
  await ledger.append('research.completed', { result: 1 });
  const text = await readFile(ledger.file, 'utf8');
  await writeFile(ledger.file, text.replace('"result":1', '"result":2'));
  assert.equal((await ledger.verify()).valid, false);
  await assert.rejects(ledger.read(), /integrity/);
  await assert.rejects(ledger.append('research.completed', { result: 3 }), /integrity/);
}));

test('ledger detects removed final records through the persisted tail checkpoint', async () => withLedger(async (ledger) => {
  await ledger.append('event.created', { n: 1 });
  await ledger.append('event.created', { n: 2 });
  const text = await readFile(ledger.file, 'utf8');
  await writeFile(ledger.file, `${text.split('\n')[0]}\n`);
  assert.match((await ledger.verify()).reason, /checkpoint/);
}));

test('ledger rejects non-JSON events and concurrent/interrupted writers fail closed', async () => withLedger(async (ledger) => {
  await assert.rejects(ledger.append('event.created', { n: Infinity }));
  await assert.rejects(ledger.append('event.created', { fn() {} }));
  await writeFile(ledger.lock, 'interrupted');
  await assert.rejects(ledger.append('event.created', { n: 1 }), /locked/);
}));
