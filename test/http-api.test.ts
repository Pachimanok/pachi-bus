import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApi, type Bus, type AccessEvent } from '../http-api.ts';
import { actionSchema } from '../action-schema.ts';
import { connectAppServer } from '../core.ts';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

async function fixture(t: any, overrides: Partial<Bus> = {}, onAccess?: (event: AccessEvent) => void) {
  const key = randomBytes(32).toString('hex');
  const bus: Bus = {
    createSession: async () => 'thread-1', resumeSession: async id => id,
    sendMessage: async (id, text) => ({ threadId: id, turnId: 'turn-1', status: 'completed', response: `Reply: ${text}` }),
    ...overrides,
  };
  const server = createApi(bus, key, onAccess);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const address = server.address() as { port: number };
  const call = async (path: string, method = 'GET', body?: unknown, authenticated = true) => {
    const r = await fetch(`http://127.0.0.1:${address.port}${path}`, { method,
      headers: { ...(authenticated ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  return { call };
}

test('all endpoints require bearer authentication', async t => {
  let created = false;
  const { call } = await fixture(t, { createSession: async () => { created = true; return 'id'; } });
  assert.equal((await call('/health', 'GET', undefined, false)).status, 401);
  assert.equal((await call('/sessions', 'POST', undefined, false)).status, 401);
  assert.equal(created, false);
  assert.equal((await call('/health')).status, 200);
});

test('diagnostics record arrival and status without credentials, queries, bodies or IDs', async t => {
  const events: AccessEvent[] = [];
  const { call } = await fixture(t, {}, event => events.push(event));
  await call('/health?private=DO_NOT_LOG', 'GET', undefined, false);
  assert.deepEqual(events, [
    { method: 'GET', route: '/health', status: 'received' },
    { method: 'GET', route: '/health', status: 401 },
  ]);
  await call('/sessions', 'POST');
  await call('/sessions/thread-1/messages?private=DO_NOT_LOG', 'POST', { message: 'PRIVATE_BODY' });
  await call('/jobs/PRIVATE_JOB_ID');
  await call('/PRIVATE_PATH');
  const encoded = JSON.stringify(events);
  for (const secret of ['DO_NOT_LOG', 'PRIVATE_BODY', 'PRIVATE_JOB_ID', 'PRIVATE_PATH', 'thread-1']) {
    assert.ok(!encoded.includes(secret));
  }
  assert.ok(events.some(e => e.route === '/sessions/{threadId}/messages' && e.status === 202));
  assert.ok(events.some(e => e.route === '/jobs/{jobId}' && e.status === 404));
});

test('create, submit, poll, and continue on the same thread', async t => {
  const { call } = await fixture(t);
  const session = await call('/sessions', 'POST');
  assert.equal(session.status, 201);
  for (const text of ['first', 'second']) {
    const accepted = await call(`/sessions/${session.body.threadId}/messages`, 'POST', { message: text });
    assert.equal(accepted.status, 202);
    const result = await call(`/jobs/${accepted.body.jobId}`);
    assert.equal(result.body.status, 'completed');
    assert.equal(result.body.response, `Reply: ${text}`);
    assert.equal(result.body.threadId, session.body.threadId);
  }
});

test('pending turns return immediately and block concurrent sends', async t => {
  let finish!: (value: any) => void;
  const { call } = await fixture(t, { sendMessage: () => new Promise(resolve => { finish = resolve; }) });
  await call('/sessions', 'POST');
  const job = await call('/sessions/thread-1/messages', 'POST', { message: 'one' });
  assert.equal((await call(`/jobs/${job.body.jobId}`)).body.status, 'running');
  assert.equal((await call('/sessions/thread-1/messages', 'POST', { message: 'two' })).status, 409);
  assert.equal((await call('/sessions/thread-1/resume', 'POST')).status, 409);
  finish({ threadId: 'thread-1', turnId: 'turn-1', status: 'completed', response: 'done' });
  assert.equal((await call(`/jobs/${job.body.jobId}`)).body.response, 'done');
});

test('backend errors are failed jobs and do not leak raw diagnostics', async t => {
  const { call } = await fixture(t, { sendMessage: async () => { throw new Error('PRIVATE_BACKEND_DETAIL'); } });
  await call('/sessions', 'POST');
  const job = await call('/sessions/thread-1/messages', 'POST', { message: 'one' });
  const result = await call(`/jobs/${job.body.jobId}`);
  assert.equal(result.body.status, 'failed');
  assert.ok(!JSON.stringify(result.body).includes('PRIVATE_BACKEND_DETAIL'));
});

test('explicitly resume a persisted thread before using it', async t => {
  const { call } = await fixture(t);
  assert.equal((await call('/sessions/saved/messages', 'POST', { message: 'one' })).status, 409);
  assert.equal((await call('/sessions/saved/resume', 'POST')).body.threadId, 'saved');
  assert.equal((await call('/sessions/saved/messages', 'POST', { message: 'recall' })).status, 202);
});

test('reject empty/oversized messages and unknown jobs', async t => {
  const { call } = await fixture(t);
  await call('/sessions', 'POST');
  assert.equal((await call('/sessions/thread-1/messages', 'POST', { message: ' ' })).status, 400);
  assert.equal((await call('/sessions/thread-1/messages', 'POST', { message: 'x'.repeat(9000) })).status, 400);
  assert.equal((await call('/sessions/thread-1/messages', 'POST', { message: 'x'.repeat(17000) })).status, 413);
  assert.equal((await call('/jobs/missing')).status, 404);
});

test('schema exposes all Actions with global bearer security', () => {
  const schema = actionSchema('https://pachibus.example.com');
  assert.equal(schema.servers[0].url, 'https://pachibus.example.com');
  assert.deepEqual(schema.security, [{ PachiBusKey: [] }]);
  assert.equal(Object.keys(schema.paths).length, 5);
  assert.throws(() => actionSchema('http://localhost:8787'));
  assert.throws(() => actionSchema('https://user:password@example.com'));
});

test('HTTP to core to stdio and back, with two messages on one thread', async t => {
  const child = spawn(process.execPath, [import.meta.dirname + '/app-server-fixture.ts', 'normal'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const bus = await connectAppServer(child, import.meta.dirname);
  t.after(() => bus.close());
  const { call } = await fixture(t, bus);
  const created = await call('/sessions', 'POST');
  assert.equal(created.status, 201);
  for (const text of ['first', 'second']) {
    const accepted = await call(`/sessions/${created.body.threadId}/messages`, 'POST', { message: text });
    assert.equal(accepted.status, 202);
    let result;
    for (let attempt = 0; attempt < 50; attempt++) {
      result = await call(`/jobs/${accepted.body.jobId}`);
      if (result.body.status !== 'running') break;
      await delay(10);
    }
    assert.equal(result!.body.status, 'completed');
    assert.equal(result!.body.threadId, created.body.threadId);
    assert.equal(result!.body.response, `Reply: ${text}`);
  }
});
