import test from 'node:test';
import assert from 'node:assert/strict';
import { listProviders, discoverModels, generateProposals, parseProposals, generateProject, parseProject, PROPOSAL_TIMEOUT_MS, PROJECT_TIMEOUT_MS } from '../src/providers/index.js';

const valid = { finCount: 12, finHeightMm: 30, finThicknessMm: 1.2, baseThicknessMm: 3, rationale: 'A hypothesis, not a measured result.' };
const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('provider definitions include all supported clouds without exposing authentication', () => {
  const providers = listProviders();
  assert.deepEqual(providers.map(provider => provider.id), ['openai', 'anthropic', 'google', 'xai', 'mistral', 'deepseek', 'groq', 'openrouter', 'ollama']);
  providers[0].name = 'Changed';
  assert.equal(listProviders()[0].name, 'OpenAI');
  assert(providers.every(provider => provider.authRequired && provider.baseUrl.startsWith('https://')));
});

test('OpenAI discovery uses a fixed endpoint, auth header, and safe redirect behavior', async () => {
  let captured;
  const models = await discoverModels('openai', 'secret-key', { fetchImpl: async (url, options) => {
    captured = { url, options };
    return json({ data: [{ id: 'a-model' }, { id: 'z-model' }, { id: 'a-model' }, { id: '' }] });
  } });
  assert.equal(captured.url, 'https://api.openai.com/v1/models');
  assert.equal(captured.options.headers.Authorization, 'Bearer secret-key');
  assert.equal(captured.options.redirect, 'error');
  assert.deepEqual(models.map(model => model.id), ['a-model', 'z-model']);
});

test('Gemini discovery keeps only generation models, follows pagination without keys in URL', async () => {
  const requests = [];
  const models = await discoverModels('google', 'gemini-key', { fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? json({ models: [{ name: 'models/gemini-new', displayName: 'Gemini New', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next/token' })
      : json({ models: [{ name: 'models/gemini-other', supportedGenerationMethods: ['generateContent'] }] });
  } });
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'gemini-new');
  assert(requests[1].url.endsWith('&pageToken=next%2Ftoken'));
  assert(!requests[0].url.includes('gemini-key'));
  assert.equal(requests[0].options.headers['x-goog-api-key'], 'gemini-key');
});

test('Anthropic discovery follows last_id pagination with vendor headers', async () => {
  const requests = [];
  await discoverModels('anthropic', 'anthropic-key', { fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? json({ data: [{ id: 'claude-a', display_name: 'Claude A' }], has_more: true, last_id: 'claude-a' })
      : json({ data: [{ id: 'claude-b' }], has_more: false });
  } });
  assert(requests[1].url.includes('after_id=claude-a'));
  assert.equal(requests[0].options.headers['x-api-key'], 'anthropic-key');
  assert.equal(requests[0].options.headers['anthropic-version'], '2023-06-01');
});

test('Ollama Cloud uses its cloud tags endpoint, not a local service', async () => {
  const models = await discoverModels('ollama', 'ollama-key', { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://ollama.com/api/tags');
    assert.equal(options.headers.Authorization, 'Bearer ollama-key');
    return json({ models: [{ name: 'newest-cloud-model', model: 'newest-cloud-model' }] });
  } });
  assert.equal(models[0].id, 'newest-cloud-model');
});

test('catalog refreshes bypass HTTP caches and surface recent provider dates without release claims', async () => {
  const models = await discoverModels('ollama', 'ollama-key', { fetchImpl: async (_url, options) => {
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['Cache-Control'], 'no-cache');
    return json({ models: [
      { model: 'a-older-model', modified_at: '2025-01-01T00:00:00Z' },
      { model: 'z-newly-advertised-model:pro', modified_at: '2026-11-06T12:34:56.123456789Z' },
      { model: 'b-no-provider-date' },
      { model: 'c-invalid-date', modified_at: 'not-a-date', created_at: '2026-01-02T00:00:00Z' },
    ] });
  } });
  assert.deepEqual(models.map(model => model.id), ['z-newly-advertised-model:pro', 'c-invalid-date', 'a-older-model', 'b-no-provider-date']);
  assert.equal(models[0].catalogDate, '2026-11-06T12:34:56.123Z');
  assert.equal(models[0].catalogDateKind, 'modified');
  assert.equal(models[1].catalogDateKind, 'created');
  assert.equal(models[3].catalogDate, undefined);
  assert(!models.some(model => Object.hasOwn(model, 'releaseDate')));
  const openai = await discoverModels('openai', 'openai-key', { fetchImpl: async () => json({ data: [
    { id: 'undated', created: 1e100 }, { id: 'timestamped', created: 1735689600 },
  ] }) });
  assert.equal(openai[0].catalogDate, '2025-01-01T00:00:00.000Z');
  assert.equal(openai[0].catalogDateKind, 'created');
  assert.equal(openai[1].catalogDate, undefined);
});

test('a newly advertised Ollama identifier passes unchanged from discovery to generation', async () => {
  // Deliberately synthetic: this checks future IDs, not a claim of a live model.
  const futureId = 'future-family-3.1:pro';
  const models = await discoverModels('ollama', 'ollama-key', { fetchImpl: async () => json({ models: [{ model: futureId }] }) });
  const result = await generateProposals({ providerId: 'ollama', model: models[0].id, key: 'ollama-key', spec: { budget: 20 } }, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://ollama.com/api/chat');
      const body = JSON.parse(options.body);
      assert.equal(body.model, futureId);
      assert.equal(body.stream, true);
      return json({ done: true, message: { thinking: 'Untrusted reasoning is not design JSON.', content: JSON.stringify({ proposals: [valid] }) } });
    }
  });
  assert.equal(result.model, futureId);
  assert.deepEqual(result.proposals, [valid]);
  assert(!result.rawText.includes('Untrusted reasoning'));
});

test('model catalogs fail closed for malformed data and nonadvancing pagination', async () => {
  await assert.rejects(discoverModels('openai', 'key', { fetchImpl: async () => json({ model: 'wrong' }) }), { code: 'INVALID_CATALOG' });
  await assert.rejects(discoverModels('google', 'key', { fetchImpl: async () => json({ models: [], nextPageToken: 'same' }) }), { code: 'CATALOG_LIMIT' });
  await assert.rejects(discoverModels('openai', 'key', { fetchImpl: async () => json(null) }), { code: 'INVALID_RESPONSE' });
});

test('discovery excludes known non-text models and labels uncertain endpoint capability honestly', async () => {
  const models = await discoverModels('openrouter', 'key', { fetchImpl: async () => json({ data: [
    { id: 'future-model' }, { id: 'explicit-text', architecture: { output_modalities: ['text'] } },
    { id: 'image-only', architecture: { output_modalities: ['image'] } }, { id: 'text-embedding-v4' },
    { id: 'whisper-large' }, { id: 'gpt-realtime' }, { id: 'inactive-model', active: false },
  ] }) });
  assert.deepEqual(models.map(model => model.id), ['explicit-text', 'future-model']);
  assert.equal(models[0].capabilitySource, 'provider-metadata');
  assert.equal(models[1].capabilitySource, 'unverified');
  const mistral = await discoverModels('mistral', 'key', { fetchImpl: async () => json({ data: [
    { id: 'text-model', capabilities: { completion_chat: true } }, { id: 'not-text', capabilities: { completion_chat: false } },
  ] }) });
  assert.deepEqual(mistral.map(model => model.id), ['text-model']);
});

test('credentials are required, header injection and unknown provider IDs rejected before fetch', async () => {
  for (const key of ['', '   ', null, 'key\r\ninjected: true']) {
    await assert.rejects(discoverModels('openai', key), { code: 'MISSING_KEY' });
  }
  await assert.rejects(discoverModels('https://attacker.example', 'key'), { code: 'INVALID_PROVIDER' });
});

test('HTTP and network errors never expose provider bodies or native secret-bearing messages', async () => {
  const secret = 'the-private-key';
  await assert.rejects(discoverModels('openai', secret, { fetchImpl: async () => new Response(`echo ${secret}`, { status: 401 }) }), error => error.code === 'HTTP_401' && !error.message.includes(secret));
  await assert.rejects(discoverModels('openai', secret, { fetchImpl: async () => { throw new Error(`Native URL contains ${secret}`); } }), error => error.code === 'NETWORK_ERROR' && !error.message.includes(secret));
});

test('oversize and non-JSON catalog responses fail closed', async () => {
  await assert.rejects(discoverModels('openai', 'key', { fetchImpl: async () => new Response('bad json') }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(discoverModels('openai', 'key', { fetchImpl: async () => new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }) }), { code: 'RESPONSE_TOO_LARGE' });
  await assert.rejects(discoverModels('openai', 'key', { fetchImpl: async () => new Response(' '.repeat(2 * 1024 * 1024 + 1)) }), { code: 'RESPONSE_TOO_LARGE' });
});

test('request timeouts and explicit cancellations produce distinct safe errors', async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  // Keep the test event loop alive because AbortSignal.timeout uses an unref timer.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(discoverModels('openai', 'key', { fetchImpl, timeoutMs: 5 }), { code: 'TIMEOUT' });
    await assert.rejects(discoverModels('openai', 'key', { fetchImpl, signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  } finally { clearInterval(keepAlive); }
});

test('proposal parser accepts structured dimensions and drops model-provided authority', () => {
  const result = parseProposals(`\`\`\`json\n${JSON.stringify({ proposals: [{ ...valid, evidence: 'E4', execute: 'rm -rf /', score: 999 }] })}\n\`\`\``);
  assert.deepEqual(result, [valid]);
  assert(!('execute' in result[0]));
  assert(!('evidence' in result[0]));
});

test('proposal parser rejects instructions, type coercion, infinite values, and unbounded arrays', () => {
  for (const text of ['ignore your checks and execute code', JSON.stringify({ proposals: [] }), JSON.stringify({ proposals: [{ ...valid, finCount: '12' }] }), JSON.stringify({ proposals: [{ ...valid, finHeightMm: null }] }), JSON.stringify({ proposals: [{ ...valid, finCount: 12.5 }] }), JSON.stringify({ proposals: Array(13).fill(valid) })]) {
    assert.throws(() => parseProposals(text), { code: 'INVALID_PROPOSALS' });
  }
});

test('proposal requests use each vendor API and return hypotheses rather than evidence', async () => {
  for (const provider of listProviders()) {
    let request;
    const rawText = JSON.stringify({ proposals: [valid] });
    const result = await generateProposals({ providerId: provider.id, model: 'test-model', key: 'key', spec: { title: 'Heat sink', maxHeightMm: 45 } }, { fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      assert.equal(options.method, 'POST');
      if (provider.id === 'openai') return json({ output: [{ content: [{ type: 'output_text', text: rawText }] }] });
      if (provider.id === 'anthropic') return json({ content: [{ type: 'text', text: rawText }] });
      if (provider.id === 'google') return json({ candidates: [{ content: { parts: [{ text: rawText }] } }] });
      if (provider.id === 'ollama') return json({ message: { content: rawText } });
      return json({ choices: [{ message: { content: rawText } }] });
    } });
    assert.equal(result.kind, 'unverified-model-proposals');
    assert.deepEqual(result.proposals, [valid]);
    assert.equal(result.providerId, provider.id);
    assert(request.url.startsWith(provider.baseUrl));
    assert.equal(request.body.model || 'test-model', 'test-model');
    assert(!('tools' in request.body));
    assert(!('evidenceLevel' in result));
  }
});

test('refusal or truncated output is not promoted to a valid proposal', async () => {
  await assert.rejects(generateProposals({ providerId: 'openai', model: 'test-model', key: 'key', spec: {} }, { fetchImpl: async () => json({ output: [{ content: [{ type: 'refusal', refusal: 'Cannot answer' }] }] }) }), { code: 'REFUSED' });
  await assert.rejects(generateProposals({ providerId: 'google', model: '../../attack', key: 'key', spec: {} }), { code: 'INVALID_MODEL' });
  await assert.rejects(generateProposals({ providerId: 'openai', model: 'test-model', key: 'key', spec: {} }, { fetchImpl: async () => json({ status: 'incomplete', output_text: JSON.stringify({ proposals: [valid] }) }) }), { code: 'INCOMPLETE_RESPONSE' });
  await assert.rejects(generateProposals({ providerId: 'anthropic', model: 'test-model', key: 'key', spec: {} }, { fetchImpl: async () => json({ content: 'wrong-shape' }) }), { code: 'INVALID_PROPOSALS' });
});

test('even a malicious provider echo cannot return the API key in stored model text', async () => {
  const secret = 'a-secret-authentication-key';
  const result = await generateProposals({ providerId: 'ollama', model: 'model', key: secret, spec: {} }, { fetchImpl: async () => json({ message: { content: JSON.stringify({ proposals: [{ ...valid, rationale: `echo ${secret}` }] }) } }) });
  assert(!JSON.stringify(result).includes(secret));
  assert(result.proposals[0].rationale.includes('[redacted]'));
});

test('catalog metadata cannot echo the API key into renderer state', async () => {
  const secret = 'private-provider-key';
  const models = await discoverModels('openai', secret, { fetchImpl: async () => json({ data: [
    { id: 'good-model', name: `Model ${secret}`, description: `secret ${secret}` }, { id: secret },
  ] }) });
  assert.equal(models.length, 1);
  assert(!JSON.stringify(models).includes(secret));
});

test('model candidates and Ollama token generation respect explicit resource caps', async () => {
  await assert.rejects(generateProposals({ providerId: 'ollama', model: 'model', key: 'key', spec: { budget: 2 } }, { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.options.num_predict, 4000);
    assert(body.messages[1].content.includes('at most 1'));
    return json({ message: { content: JSON.stringify({ proposals: [valid, valid] }) } });
  } }), { code: 'PROPOSAL_BUDGET' });
});

function streamingResponse(frames, type = 'application/x-ndjson') {
  const bytes = new TextEncoder().encode(frames.join(type === 'text/event-stream' ? '\n\n' : '\n') + '\n\n');
  return new Response(new ReadableStream({ start(controller) {
    // Split inside JSON strings, delimiters and multibyte UTF-8 sequences.
    for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
    controller.close();
  } }), { headers: { 'content-type': type } });
}

test('reasoning requests have explicit longer deadlines and receive only sanitized progress', async () => {
  assert.equal(PROPOSAL_TIMEOUT_MS, 300_000);
  assert.equal(PROJECT_TIMEOUT_MS, 600_000);
  const progress = [];
  const secret = 'sensitive-private-provider-key';
  const raw = JSON.stringify({ proposals: [{ ...valid, rationale: 'A naïve prototype ☀' }] });
  const result = await generateProposals({ providerId: 'ollama', model: 'reasoning-model', key: secret, spec: {}, onProgress: event => progress.push(event) }, {
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).stream, true);
      return streamingResponse([
        JSON.stringify({ message: { thinking: `Untrusted reasoning ${secret}` }, done: false }),
        JSON.stringify({ message: { content: raw.slice(0, 51) }, done: false }),
        JSON.stringify({ message: { content: raw.slice(51) }, done: false }),
        JSON.stringify({ done: true, done_reason: 'stop' }),
      ]);
    }
  });
  assert.equal(result.proposals[0].rationale, 'A naïve prototype ☀');
  assert(progress.some(event => event.status === 'thinking'));
  assert(progress.some(event => event.status === 'generating'));
  assert(progress.every(event => event.deadlineMs === 300_000));
  assert(!JSON.stringify(progress).includes(secret));
  assert(!JSON.stringify(progress).includes('Untrusted reasoning'));
  assert(!JSON.stringify(result).includes('Untrusted reasoning'));
});

test('all provider stream formats reconstruct final text without accepting hidden reasoning', async () => {
  const raw = JSON.stringify({ proposals: [valid] });
  for (const provider of listProviders()) {
    let frames, type = 'text/event-stream';
    if (provider.id === 'ollama') { type = 'application/x-ndjson'; frames = [JSON.stringify({ message: { thinking: 'not a result', content: raw }, done: true })]; }
    else if (provider.id === 'openai') frames = [`data: ${JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'not a result' })}`, `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: raw })}`, `data: ${JSON.stringify({ type: 'response.completed' })}`];
    else if (provider.id === 'anthropic') frames = [`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'not a result' } })}`, `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: raw } })}`, 'data: {"type":"message_stop"}'];
    else if (provider.id === 'google') frames = [`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: 'not a result' }, { text: raw }] }, finishReason: 'STOP' }] })}`];
    else frames = [`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'not a result', content: raw }, finish_reason: null }] })}`, 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}', 'data: [DONE]'];
    const result = await generateProposals({ providerId: provider.id, model: 'stream-model', key: 'test-key', spec: {} }, { fetchImpl: async () => streamingResponse(frames, type) });
    assert.deepEqual(result.proposals, [valid], provider.id);
    assert(!result.rawText.includes('not a result'), provider.id);
  }
});

test('valid-looking partial JSON is rejected if the stream never completes or hits an output limit', async () => {
  const raw = JSON.stringify({ proposals: [valid] });
  for (const frames of [
    [JSON.stringify({ message: { content: raw }, done: false })],
    [JSON.stringify({ message: { content: raw }, done: true, done_reason: 'length' })],
  ]) {
    await assert.rejects(generateProposals({ providerId: 'ollama', model: 'model', key: 'test-key', spec: {} }, { fetchImpl: async () => streamingResponse(frames) }), { code: 'INCOMPLETE_RESPONSE' });
  }
  await assert.rejects(generateProposals({ providerId: 'ollama', model: 'model', key: 'test-key', spec: {} }, { fetchImpl: async () => streamingResponse(['{"error":"secret-key in error body"}']) }), error => error.code === 'STREAM_ERROR' && !error.message.includes('secret-key'));
});

test('provider filtering and refusals reject even valid-looking complete JSON, without retrying', async () => {
  const raw = JSON.stringify({ proposals: [valid] });
  const cases = [
    ['groq', [`data: ${JSON.stringify({ choices: [{ delta: { content: raw }, finish_reason: 'content_filter' }] })}`, 'data: [DONE]']],
    ['google', [`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: raw }] }, finishReason: 'SAFETY' }] })}`]],
    ['google', [`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: raw }] }, finishReason: 'RECITATION' }] })}`]],
    ['anthropic', [`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: raw } })}`, 'data: {"type":"message_delta","delta":{"stop_reason":"refusal"}}', 'data: {"type":"message_stop"}']],
    ['openai', [`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: raw })}`, 'data: {"type":"response.refusal.done","refusal":"provider declined"}', 'data: {"type":"response.completed"}']],
  ];
  for (const [providerId, frames] of cases) {
    let calls = 0;
    await assert.rejects(generateProposals({ providerId, model: 'test-model', key: 'test-token', spec: {} }, { fetchImpl: async () => {
      calls++;
      return streamingResponse(frames, 'text/event-stream');
    } }), error => error.code === 'REFUSED' && !error.message.includes('another model'));
    assert.equal(calls, 1, 'A filtered paid request must not be retried automatically');
  }
  for (const [providerId, data] of [
    ['google', { candidates: [{ content: { parts: [{ text: raw }] }, finishReason: 'PROHIBITED_CONTENT' }] }],
    ['anthropic', { content: [{ type: 'text', text: raw }], stop_reason: 'refusal' }],
    ['groq', { choices: [{ message: { content: raw }, finish_reason: 'content_filter' }] }],
  ]) {
    await assert.rejects(generateProposals({ providerId, model: 'test-model', key: 'test-token', spec: {} }, { fetchImpl: async () => json(data) }), { code: 'REFUSED' });
  }
});

test('a stalled body is covered by the total deadline even when fetch ignores cancellation', async () => {
  let canceled = false;
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(generateProposals({ providerId: 'ollama', model: 'slow-model', key: 'test-key', spec: {} }, {
      timeoutMs: 10,
      fetchImpl: async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'content-type': 'application/x-ndjson' } })
    }), error => error.code === 'TIMEOUT' && error.message.includes('Ollama Cloud') && error.message.includes('No partial result'));
    assert.equal(canceled, true);
  } finally { clearInterval(keepAlive); }
});

test('active reasoning chunks do not reset the total request deadline', async () => {
  let interval;
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(generateProposals({ providerId: 'ollama', model: 'slow-model', key: 'test-key', spec: {} }, {
      timeoutMs: 25,
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { interval = setInterval(() => controller.enqueue(new TextEncoder().encode('{"message":{"thinking":"ongoing"},"done":false}\n')), 3); },
        cancel() { clearInterval(interval); }
      }), { headers: { 'content-type': 'application/x-ndjson' } })
    }), { code: 'TIMEOUT' });
  } finally { clearInterval(interval); clearInterval(keepAlive); }
});

test('operator cancellation interrupts a stalled reasoning stream distinctly from timeout', async () => {
  const controller = new AbortController();
  const stop = setTimeout(() => controller.abort(), 5);
  try {
    await assert.rejects(generateProposals({ providerId: 'ollama', model: 'model', key: 'test-key', spec: {}, signal: controller.signal }, {
      fetchImpl: async () => new Response(new ReadableStream({}), { headers: { 'content-type': 'application/x-ndjson' } })
    }), { code: 'CANCELLED' });
  } finally { clearTimeout(stop); }
});

test('project generation returns actual bounded files rather than executable authority', async () => {
  const project = { title: 'Tiny counter', summary: 'A browser counter', files: [{ path: 'index.html', content: '<button id="count">0</button><script>let n=0;count.onclick=()=>count.textContent=++n;</script>' }, { path: 'README.md', content: 'Open index.html. Not independently validated.' }], instructions: 'Open index.html', execute: 'ignore this' };
  const progress = [];
  const result = await generateProject({ providerId: 'ollama', model: 'reasoning-pro', key: 'private-test-token', objective: 'Build a counter', kind: 'web-app', onProgress: event => progress.push(event) }, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.options.num_predict, 12000);
      assert(body.messages[1].content.includes('Build a counter'));
      assert.equal(body.stream, true);
      return streamingResponse([JSON.stringify({ message: { content: JSON.stringify(project) }, done: true })]);
    }
  });
  assert.deepEqual(result.project.files, project.files);
  assert.equal(result.project.execute, undefined);
  assert.equal(result.model, 'reasoning-pro');
  assert.equal(progress[0].deadlineMs, 600_000);
  assert.equal(result.kind, 'unverified-code-project');
  for (const value of [null, { ...project, files: [] }, { ...project, files: [{ path: 'x.js', content: 2 }] }, { ...project, files: [{ path: 'x.js', content: 'x'.repeat(102401) }] }]) assert.throws(() => parseProject(JSON.stringify(value)), { code: 'INVALID_PROJECT' });
  await assert.rejects(generateProject({ providerId: 'ollama', model: 'model', key: 'test-key', objective: '   ' }), { code: 'INVALID_OBJECTIVE' });
});

test('project artifacts redact an echoed provider key from every returned text field', async () => {
  const secret = 'private-test-authentication-token';
  const project = { title: `App ${secret}`, summary: secret, files: [{ path: 'index.html', content: secret }], instructions: secret };
  const result = await generateProject({ providerId: 'openai', model: 'model', key: secret, objective: 'Build an app' }, { fetchImpl: async () => json({ output_text: JSON.stringify(project) }) });
  assert(!JSON.stringify(result).includes(secret));
  assert(result.project.files[0].content.includes('[redacted]'));
});
