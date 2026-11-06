import test from 'node:test';
import assert from 'node:assert/strict';
import { runComputation } from '../src/runner.js';
import { createResearchRun } from '../src/core/research.js';

test('worker completes a real reproducible computation with model proposals treated as data', async () => {
  const spec = { budget: 15, seed: 17 };
  const proposals = [{ finCount: 18, finHeightMm: 25, finThicknessMm: 1, baseThicknessMm: 3, rationale: 'Unverified model proposal' }];
  const result = await runComputation(spec, proposals);
  const reference = createResearchRun(spec, { proposals });
  assert.equal(result.status, 'completed');
  assert.equal(result.candidates.length, 15);
  assert.equal(result.candidates[1].source, 'cloud-model-proposal');
  assert.deepEqual(result.candidates, reference.candidates);
  assert.deepEqual(result.best, reference.best);
  assert.equal(result.verification.evidenceLevel, 'E2');
  assert.equal(result.verification.physicalValidation, 'not-performed');
});

test('worker propagates invalid specification and unsafe proposal failures to its caller', async () => {
  await assert.rejects(runComputation({ budget: 10_000 }), /budget/);
  await assert.rejects(runComputation({ budget: 10 }, Array(31).fill({})), /30 model proposals/);
  const result = await runComputation({ budget: 10 }, [{ finCount: 20, finHeightMm: 25, finThicknessMm: 1, baseThicknessMm: 5, evidenceLevel: 'E4', code: 'process.exit()' }]);
  assert.equal(result.candidates[1].status, 'rejected');
  assert.equal(result.candidates[1].evidenceLevel, 'E0');
  assert.ok(result.candidates[1].checks.some(message => message.includes('Unknown candidate field')));
});
