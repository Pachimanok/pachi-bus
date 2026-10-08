import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connectAppServer } from '../core.ts';

async function fixture(t: any, scenario = 'normal', events = {}) {
  const child = spawn(process.execPath, [import.meta.dirname + '/app-server-fixture.ts', scenario], { stdio: ['pipe', 'pipe', 'pipe'] });
  const client = await connectAppServer(child, import.meta.dirname, events);
  t.after(() => client.close());
  return client;
}

test('correlates out-of-order responses and early events by thread and turn', async t => {
  const c = await fixture(t);
  const [a, b] = await Promise.all([c.createSession(), c.createSession()]);
  assert.equal(a, 'thread-1');
  assert.equal(b, 'thread-2');
  const [ra, rb] = await Promise.all([c.sendMessage(a, 'one'), c.sendMessage(b, 'two')]);
  assert.equal(ra.response, 'Reply: one');
  assert.equal(rb.response, 'Reply: two');
  assert.equal((await c.sendMessage(a, 'again')).response, 'Reply: again');
});

test('resumes exactly the requested ID and permits messaging', async t => {
  const c = await fixture(t);
  assert.equal(await c.resumeSession('saved-thread'), 'saved-thread');
  assert.equal((await c.sendMessage('saved-thread', 'recall')).response, 'Reply: recall');
});

test('rejects a replacement ID instead of treating it as a resumed session', async t => {
  const c = await fixture(t, 'wrong-id');
  await assert.rejects(c.resumeSession('saved-thread'), /differs/);
});

test('fails a completed event with failed status', async t => {
  const c = await fixture(t, 'failed');
  await assert.rejects(c.sendMessage(await c.createSession(), 'one'), /failed/);
});

test('logs and explicitly declines command approval requests', async t => {
  const requests: any[] = [];
  const c = await fixture(t, 'approval', { serverRequest: (r: unknown) => requests.push(r) });
  await c.sendMessage(await c.createSession(), 'one');
  assert.equal(requests[0].method, 'item/commandExecution/requestApproval');
});

test('unsupported server requests fail rather than silently hanging', async t => {
  const c = await fixture(t, 'unsupported');
  await assert.rejects(c.sendMessage(await c.createSession(), 'one'), /Unexpected server request/);
});

test('rejects overlapping turns on a thread and close cancels pending work', async t => {
  const c = await fixture(t, 'hang');
  const id = await c.createSession();
  const pending = c.sendMessage(id, 'one');
  const rejected = assert.rejects(pending, /shutting down/);
  await assert.rejects(c.sendMessage(id, 'two'), /already active/);
  await c.close();
  await rejected;
  await assert.rejects(c.sendMessage(id, 'three'), /shutting down/);
});
