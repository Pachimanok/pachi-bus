// Deterministic protocol simulator. Never starts Codex or accesses a model.
import { createInterface } from 'node:readline';
const scenario = process.argv[2];
const emit = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
let initialized = false;
let threads = 0;
let turns = 0;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  const response = (result: unknown) => emit({ id: m.id, result });
  if (m.method === 'initialize') { response({}); return; }
  if (m.method === 'initialized') { initialized = true; return; }
  if (m.method && !initialized) { emit({ id: m.id, error: { code: -32000, message: 'Not initialized' } }); return; }
  if (m.method === 'thread/start') {
    const id = `thread-${++threads}`;
    setTimeout(() => response({ thread: { id } }), threads === 1 ? 30 : 0);
  }
  if (m.method === 'thread/resume') {
    response({ thread: { id: scenario === 'wrong-id' ? 'other' : m.params.threadId } });
  }
  if (m.method === 'turn/start') {
    if (scenario === 'hang') { response({ turn: { id: 'hanging' } }); return; }
    if (scenario === 'approval' || scenario === 'unsupported') {
      emit({ id: 'server-request', method: scenario === 'approval' ? 'item/commandExecution/requestApproval' : 'unknown/request', params: {} });
    }
    const threadId = m.params.threadId;
    const id = `turn-${++turns}`;
    const item = { type: 'agentMessage', id: `item-${turns}`, text: `Reply: ${m.params.input[0].text}` };
    // Unrelated notification, then matching events BEFORE the request response.
    emit({ method: 'item/completed', params: { threadId: 'unrelated', turnId: id, item: { ...item, text: 'WRONG' } } });
    emit({ method: 'item/agentMessage/delta', params: { threadId, turnId: id, delta: 'must not duplicate' } });
    emit({ method: 'item/completed', params: { threadId, turnId: id, item } });
    const turn = { id, status: scenario === 'failed' ? 'failed' : 'completed', items: [] };
    emit({ method: 'turn/completed', params: { threadId, turn } });
    setTimeout(() => response({ turn: { id } }), 20);
  }
  if (m.id === 'server-request') {
    if (scenario === 'approval' && m.result?.decision !== 'decline') process.exit(2);
    if (scenario === 'unsupported' && m.error?.code !== -32601) process.exit(3);
  }
}).on('close', () => process.exit(0));
