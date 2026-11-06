import test from 'node:test';
import assert from 'node:assert/strict';
import { listProviders, discoverModels, generateProposals, parseProposals } from '../src/providers/index.js';

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
  await assert.rejects(generateProposals({ providerId: 'openai', model: 'test-model', key: 'key', spec: {} }, { fetchImpl: async () => json({ output: [{ content: [{ type: 'refusal', refusal: 'Cannot answer' }] }] }) }), { code: 'INVALID_PROPOSALS' });
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
