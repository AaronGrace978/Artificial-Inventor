import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewHandler, PREVIEW_CSP } from '../src/preview.js';
const id = '11111111-1111-4111-8111-111111111111';
const handler = createPreviewHandler(async value => {
  assert.equal(value, id);
  return { kind: 'web-app', files: [{ path: 'index.html', content: '<h1>Example</h1>' }, { path: 'main.js', content: 'document.title="Ready"' }] };
});
test('preview serves exact saved files with a no-network sandbox policy', async () => {
  const result = await handler({ url: `inventor-preview://p-${id}/index.html` });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), '<h1>Example</h1>');
  assert.match(result.headers.get('Content-Security-Policy'), /connect-src 'none'/);
  assert.match(PREVIEW_CSP, /sandbox allow-scripts/);
  assert.ok(!PREVIEW_CSP.includes('allow-same-origin'));
  assert.match((await handler({ url: `inventor-preview://p-${id}/main.js` })).headers.get('Content-Type'), /javascript/);
});
test('preview cannot read arbitrary paths, unsupported origins or absent artifacts', async () => {
  for (const url of ['file:///etc/passwd', 'inventor-preview://invalid/index.html', `inventor-preview://p-${id}/%00secret`, `inventor-preview://p-${id}/%2e%2e%2fsettings.json`, `inventor-preview://p-${id}/settings.json`]) assert.equal((await handler({ url })).status, 404);
});
