import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWithHarness, BUILD_REQUEST_LIMIT } from '../src/builds/harness.js';
import { createVisualizerDemo } from '../src/builds/visualizer-demo.js';
import { verifyProject } from '../src/builds/project.js';

const plan = { title: 'Counter', summary: 'A small counter', instructions: 'Run preview', files: [{ path: 'app.js', purpose: 'Increment #count when #increment is clicked.' }, { path: 'index.html', purpose: 'A button #increment and output #count, with app.js.' }], smokeTests: [{ name: 'Increment changes count', actions: [{ type: 'click', selector: '#increment' }], expect: { selector: '#count', textIncludes: '1' } }] };
const html = '<button id="increment">Increment</button><output id="count">0</output><script src="app.js"></script>';
const js = 'let count=0;document.getElementById("increment").onclick=()=>document.getElementById("count").textContent=String(++count);';
const input = { providerId: 'ollama', model: 'test-model', key: 'test-key', objective: 'Build a counter' };

test('build harness plans, writes raw files, independently checks and repairs broken source', async () => {
  const responses = [JSON.stringify(plan), 'const broken = ;', html, js];
  const prompts = [], checkpoints = [], progress = [];
  const result = await buildWithHarness({ ...input, onCheckpoint: value => checkpoints.push(value), onProgress: value => progress.push(value) }, {
    generate: async request => { prompts.push(request.prompt); return responses.shift(); }
  });
  assert.equal(result.verification.passed, true);
  assert.equal(result.trace.requests, 4);
  assert.equal(result.trace.repairs, 1);
  assert.equal(result.project.files[0].content, js);
  assert.match(prompts[3], /JavaScript syntax error/);
  assert.equal(checkpoints[1].files.length, 1);
  assert.equal(checkpoints.at(-1).files.length, 2);
  assert(progress.some(value => value.status === 'repairing'));
});

test('explicit resume retains completed files and never retries a failed paid request automatically', async () => {
  let checkpoint, calls = 0;
  await assert.rejects(buildWithHarness({ ...input, onCheckpoint: value => { checkpoint = value; } }, { generate: async () => {
    calls++;
    if (calls === 1) return JSON.stringify(plan);
    if (calls === 2) return js;
    throw new Error('Provider disconnected');
  } }), /Provider disconnected/);
  assert.equal(calls, 3);
  assert.equal(checkpoint.files.length, 1);
  const prompts = [];
  const resumed = await buildWithHarness({ ...input, checkpoint }, { generate: async value => { prompts.push(value.prompt); return html; } });
  assert.equal(resumed.verification.passed, true);
  assert.equal(resumed.trace.requests, 1);
  assert.match(prompts[0], /Write only the complete raw source for index.html/);
  assert.equal(resumed.project.files[0].content, js);
});

test('cancellation preserves completed files and a global deadline bounds all steps', async () => {
  const controller = new AbortController();
  let checkpoint, calls = 0;
  await assert.rejects(buildWithHarness({ ...input, signal: controller.signal, onCheckpoint: value => { checkpoint = value; if (value.files.length) controller.abort(); } }, { generate: async () => ++calls === 1 ? JSON.stringify(plan) : js }), /Build cancelled/);
  assert.equal(checkpoint.files.length, 1);
  assert.equal(calls, 2);
});

test('bad plans and checkpoints are rejected before any source request or execution', async () => {
  for (const files of [[{ path: '../escape.js', purpose: 'bad' }], [{ path: 'CON.js', purpose: 'bad' }], [{ path: 'index.html', purpose: 'entry' }, { path: 'INDEX.HTML', purpose: 'collision' }]]) {
    let calls = 0;
    await assert.rejects(buildWithHarness(input, { generate: async () => { calls++; return JSON.stringify({ ...plan, files }); } }));
    assert.equal(calls, 1);
  }
  await assert.rejects(buildWithHarness({ ...input, checkpoint: { version: 1, mode: 'build', kind: 'web-app', plan, files: [{ path: 'unplanned.js', content: js }], repairs: 0 } }, { generate: () => { throw new Error('Must not call provider'); } }), /invalid source file/);
});

test('the repair loop terminates at the explicit request budget and retains failed outcomes', async () => {
  const files = Array.from({ length: 6 }, (_, i) => ({ path: i ? `part${i}.js` : 'index.html', purpose: 'A project part' }));
  let calls = 0;
  const result = await buildWithHarness(input, {
    generate: async () => ++calls === 1 ? JSON.stringify({ ...plan, files }) : '<p>Source</p>',
    verify: async () => ({ passed: false, checks: [{ path: 'index.html', passed: false, message: 'A real unresolved failure' }], functionalValidation: 'not-performed' })
  });
  assert.equal(calls, BUILD_REQUEST_LIMIT);
  assert.equal(result.trace.repairs, 2);
  assert.equal(result.verification.passed, false);
});

test('visualizer is a complete offline browser artifact with checks and interactive/export controls', () => {
  const project = createVisualizerDemo();
  const result = verifyProject(project);
  assert.equal(result.passed, true);
  const markup = project.files.find(file => file.path === 'index.html').content;
  for (const control of ['height', 'reach', 'shade', 'finish', 'rotation', 'exploded', 'labels', 'wireframe', 'export']) assert(markup.includes(`id="${control}"`));
  assert.match(project.instructions, /not photorealistic/);
});


test('the total deadline covers verification as well as each model request', async () => {
  const responses = [JSON.stringify(plan), js, html];
  await assert.rejects(buildWithHarness({ ...input, timeoutMs: 5 }, {
    generate: async () => responses.shift(),
    verify: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { passed: true, checks: [] }; }
  }), /total build time expired/);
});
