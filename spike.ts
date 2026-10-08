import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, symlink, access, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

// Node 24 runs this TypeScript directly. No packages or build step required.
const root = resolve(import.meta.dirname);
const state = join(root, '.spike-state');
const localHome = join(state, 'codex-home');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !['--resume', '--check-protocol'].includes(args[0]))) {
  throw new Error('Usage: node spike.ts [--resume | --check-protocol]');
}
const resume = args[0] === '--resume';
await mkdir(localHome, { recursive: true });
await mkdir(join(state, 'tmp'), { recursive: true });
const childEnv = { ...process.env, RUST_LOG: 'warn', CODEX_HOME: localHome,
  TMPDIR: join(state, 'tmp'), XDG_CACHE_HOME: join(state, 'cache'),
  XDG_DATA_HOME: join(state, 'data'), XDG_STATE_HOME: join(state, 'state') };
const version = execFileSync('codex', ['--version'], { env: childEnv, encoding: 'utf8' }).trim();
console.log(`Codex: ${version}`);
// Validate the selected operation against schemas from THIS installed binary.
if (resume || args[0] === '--check-protocol') {
  const out = join(root, '.spike-schema');
  execFileSync('codex', ['app-server', 'generate-json-schema', '--out', out], { env: childEnv });
  const schema = JSON.parse(await readFile(join(out, 'ClientRequest.json'), 'utf8'));
  for (const method of ['initialize', 'thread/start', 'thread/resume', 'turn/start']) {
    const found = schema.oneOf.find((s: any) => s.properties?.method?.enum?.includes(method));
    if (!found) throw new Error(`${version} does not advertise ${method}`);
    if (method === 'thread/resume') {
      const definition = schema.definitions[found.properties.params.$ref.split('/').at(-1)];
      if (definition?.properties?.threadId?.type !== 'string') {
        throw new Error('Unsupported thread/resume schema: expected string threadId');
      }
    }
  }
  console.log('Protocolo confirmado: initialize, thread/start, thread/resume, turn/start');
  if (args[0] === '--check-protocol') process.exit(0); // No server, auth or inference.
}
let savedThreadId: string | undefined;
if (resume) {
  savedThreadId = (await readFile(join(state, 'thread-id.txt'), 'utf8')).trim();
  if (!savedThreadId) throw new Error('No saved thread ID. Run npm run spike first.');
}
const existingAuth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
const localAuth = join(localHome, 'auth.json');
try {
  await access(localAuth);
} catch {
  await access(existingAuth); // Fail clearly if existing authentication is unavailable.
  await symlink(existingAuth, localAuth); // Read-only reuse; never copy or print credentials.
}

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: any };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
const pending = new Map<number | string, Pending>();
const completions = new Map<string, any>();
const messages = new Map<string, Map<string, string>>();
const waiters = new Map<string, Pending>();
const transcript: any = { version, mode: resume ? 'resume' : 'new', turns: [], serverRequests: [], errors: [] };
let nextId = 1;
let fatal: Error | undefined;
let stopping = false;
const key = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);
const child = spawn('codex', ['app-server', '--stdio', '--disable', 'unbounded_connection_retries', '--disable', 'apps'], {
  cwd: root,
  env: childEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
});
transcript.appServerPid = child.pid;
const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
child.stderr.on('data', data => process.stderr.write(data));
function fail(error: Error) {
  fatal ??= error;
  for (const map of [pending, waiters]) {
    for (const p of map.values()) { clearTimeout(p.timer); p.reject(error); }
    map.clear();
  }
}
child.on('error', fail);
child.on('exit', (code, signal) => {
  if (!stopping) fail(new Error(`App Server exited: code=${code}, signal=${signal}`));
});
function send(message: Message) {
  child.stdin.write(JSON.stringify(message) + '\n', error => { if (error) fail(error); });
}
function request(method: string, params: any): Promise<any> {
  if (fatal) return Promise.reject(fatal);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Request timeout: ${method}`)); }, 60_000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}
createInterface({ input: child.stdout }).on('line', line => {
  try {
    const m: Message = JSON.parse(line);
    if (m.method && m.id !== undefined) {
      console.log(`Server request: ${m.method} (id=${m.id})`);
      transcript.serverRequests.push({ method: m.method, id: m.id });
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(m.method)) {
        send({ id: m.id, result: { decision: 'decline' } });
      } else {
        send({ id: m.id, error: { code: -32601, message: 'Unsupported server request in conversation-only spike' } });
        fail(new Error(`Unexpected server request: ${m.method}`));
      }
      return;
    }
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      if (!p) throw new Error(`Response with unknown id: ${m.id}`);
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      return;
    }
    const p = m.params;
    if (m.method === 'item/completed' && p.item.type === 'agentMessage') {
      const k = key(p.threadId, p.turnId);
      if (!messages.has(k)) messages.set(k, new Map());
      messages.get(k)!.set(p.item.id, p.item.text);
    }
    if (m.method === 'turn/completed') {
      const k = key(p.threadId, p.turn.id);
      completions.set(k, p.turn); // Buffer even if this arrives before turn/start's response.
      const waiter = waiters.get(k);
      if (waiter) { clearTimeout(waiter.timer); waiters.delete(k); waiter.resolve(p.turn); }
    }
    if (m.method === 'error') {
      transcript.errors.push(p);
      console.error('Server event error:', JSON.stringify(p));
    }
  } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
});
function completed(threadId: string, turnId: string): Promise<any> {
  if (fatal) return Promise.reject(fatal);
  const k = key(threadId, turnId);
  if (completions.has(k)) return Promise.resolve(completions.get(k));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(k); reject(new Error(`Turn timeout: ${turnId}`)); }, 180_000);
    waiters.set(k, { resolve, reject, timer });
  });
}
async function turn(threadId: string, text: string, number: number) {
  console.log(`Mensaje ${number}: ${text}`);
  const started = await request('turn/start', { threadId, input: [{ type: 'text', text }] });
  const turnId = started.turn.id;
  const entry: any = { threadId, turnId, message: text, response: null, status: 'inProgress' };
  transcript.turns.push(entry);
  const finished = await completed(threadId, turnId);
  entry.status = finished.status;
  if (finished.error) entry.error = finished.error;
  if (finished.status !== 'completed') throw new Error(`Turn ${turnId}: ${JSON.stringify(finished)}`);
  const collected = messages.get(key(threadId, turnId));
  const response = collected?.size ? [...collected.values()].join('\n') :
    finished.items.filter((i: any) => i.type === 'agentMessage').map((i: any) => i.text).join('\n');
  if (!response) throw new Error(`No agent message for turn ${turnId}`);
  entry.response = response;
  console.log(`Respuesta ${number}: ${response}`);
  return response;
}
try {
  await request('initialize', { clientInfo: { name: 'pachibus_spike', version: '0.1.0' } });
  send({ method: 'initialized' });
  console.log(`App Server iniciado (PID ${child.pid}, stdio)`);
  const { thread } = resume
    ? await request('thread/resume', { threadId: savedThreadId, cwd: root, sandbox: 'read-only', approvalPolicy: 'never' })
    : await request('thread/start', {
      cwd: root, sandbox: 'read-only', approvalPolicy: 'never',
      developerInstructions: 'Esta es una prueba conversacional. Respondé solo con texto; no uses herramientas, no ejecutes comandos ni modifiques archivos.',
    });
  if (resume && thread.id !== savedThreadId) throw new Error('Resumed thread ID differs from saved ID');
  transcript.threadId = thread.id;
  if (!resume) await writeFile(join(state, 'thread-id.txt'), thread.id + '\n');
  console.log(`Thread ID: ${thread.id}`);
  if (resume) console.log('Thread reanudado en un proceso nuevo; no se reenvía el código.');
  else await turn(thread.id, 'Estamos probando PachiBus. Recordá que el código secreto de esta sesión es MATE-1847. Respondé confirmando que lo recordaste.', 1);
  const response = await turn(thread.id, '¿Cuál era el código secreto que te indiqué antes?', resume ? 3 : 2);
  const pass = response.includes('MATE-1847');
  transcript.result = pass ? 'PASS' : 'FAIL';
  console.log(`Verificación: ${transcript.result}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  transcript.result = 'FAIL';
  transcript.error = error instanceof Error ? error.message : String(error);
  console.error(`Verificación: FAIL — ${transcript.error}`);
  process.exitCode = 1;
} finally {
  await writeFile(join(state, resume ? 'last-resume.json' : 'last-run.json'), JSON.stringify(transcript, null, 2) + '\n');
  stopping = true;
  fail(new Error('Client shutting down'));
  child.stdin.end();
  // Give the server time to flush persisted history on EOF before escalating.
  const termTimer = setTimeout(() => child.kill('SIGTERM'), 5000);
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await closed;
  clearTimeout(termTimer);
  clearTimeout(killTimer);
  console.log('App Server cerrado.');
}
