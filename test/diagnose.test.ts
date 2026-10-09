import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHealth, safeOrigin } from '../diagnose.ts';

test('health verifies behavior and sends the dedicated key without following redirects', async () => {
  let captured: RequestInit | undefined;
  const result = await checkHealth('local', 'http://127.0.0.1:8787', 'TEST_ONLY_VALUE', async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8787/health');
    captured = options;
    return Response.json({ status: 'ok' });
  });
  assert.equal(result.status, 'PASS');
  assert.equal(captured?.redirect, 'manual');
  assert.equal((captured?.headers as any).Authorization, 'Bearer TEST_ONLY_VALUE');
  assert.ok(!JSON.stringify(result).includes('TEST_ONLY_VALUE'));
});

test('failures omit credentials, backend bodies and raw errors', async () => {
  for (const status of [301, 401, 403, 502]) {
    const result = await checkHealth('remote', 'https://example.com', 'TEST_ONLY_VALUE', async () => new Response('PRIVATE_RESPONSE', { status }));
    assert.equal(result.status, 'FAIL');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_RESPONSE'));
  }
  const failure = await checkHealth('remote', 'https://example.com', undefined, async () => { throw new Error('PRIVATE_ERROR'); });
  assert.equal(failure.status, 'FAIL');
  assert.ok(!JSON.stringify(failure).includes('PRIVATE_ERROR'));
  const wrong = await checkHealth('local', 'http://localhost', undefined, async () => Response.json({ status: 'wrong' }));
  assert.equal(wrong.status, 'FAIL');
});

test('only an HTTPS origin without embedded credentials or paths is accepted', () => {
  assert.equal(safeOrigin('https://example.com/'), 'https://example.com');
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com/?key=secret']) {
    assert.throws(() => safeOrigin(url));
  }
});
