import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, symlink, access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';


export type Events = {
  stderr?: (text: string) => void;
  serverRequest?: (request: { method: string; id: string | number }) => void;
  error?: (params: unknown) => void;
};

// Local runtime state and authentication stay outside versioned files.
export async function prepareRuntime(root: string, checkProtocol = false) {
  root = resolve(root);
  const state = join(root, '.spike-state');
  const localHome = join(state, 'codex-home');
  await mkdir(localHome, { recursive: true });
  await mkdir(join(state, 'tmp'), { recursive: true });
  const childEnv: NodeJS.ProcessEnv = { ...process.env, RUST_LOG: 'warn', CODEX_HOME: localHome,
    TMPDIR: join(state, 'tmp'), XDG_CACHE_HOME: join(state, 'cache'),
    XDG_DATA_HOME: join(state, 'data'), XDG_STATE_HOME: join(state, 'state') };
  // The HTTP credential belongs to PachiBus, not to the child agent environment.
  delete childEnv.PACHIBUS_API_KEY;
  const version = execFileSync('codex', ['--version'], { env: childEnv, encoding: 'utf8' }).trim();

  // Validate the selected operation against schemas from THIS installed binary.
  if (checkProtocol) {
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
  }

  return { root, state, localHome, childEnv, version };
}

export async function startPachiBus(root: string, events: Events = {}) {
  root = resolve(root);
  const runtime = await prepareRuntime(root, true);
  const { localHome, childEnv } = runtime;
  const existingAuth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  const localAuth = join(localHome, 'auth.json');
  try {
    await access(localAuth);
  } catch {
    await access(existingAuth); // Fail clearly if existing authentication is unavailable.
    await symlink(existingAuth, localAuth); // Read-only reuse; never copy or print credentials.
  }


  const child = spawn('codex', ['app-server', '--stdio', '--disable', 'unbounded_connection_retries', '--disable', 'apps'], {
    cwd: root, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = await connectAppServer(child, root, events);
  return { ...client, version: runtime.version };
}

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: any };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

// Also accepts a spawned fixture process for transport tests, without network or credentials.
export async function connectAppServer(child: ChildProcessWithoutNullStreams, root: string, events: Events = {}) {
  const sessions = new Set<string>();
  const activeThreads = new Set<string>();
  const pending = new Map<number | string, Pending>();
  const completions = new Map<string, any>();
  const messages = new Map<string, Map<string, string>>();
  const waiters = new Map<string, Pending>();
  let nextId = 1;
  let fatal: Error | undefined;
  let stopping = false;
  const key = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stderr.on('data', data => events.stderr?.(data.toString()));
  child.stdin.on('error', fail);
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
      const timer = setTimeout(() => { fail(new Error(`Request timeout: ${method}`)); }, 60_000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const m: Message = JSON.parse(line);
      if (m.method && m.id !== undefined) {
        events.serverRequest?.({ method: m.method, id: m.id });
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
      if (m.method === 'item/completed' && activeThreads.has(p.threadId) && p.item.type === 'agentMessage') {
        const k = key(p.threadId, p.turnId);
        if (!messages.has(k)) messages.set(k, new Map());
        messages.get(k)!.set(p.item.id, p.item.text);
      }
      if (m.method === 'turn/completed' && activeThreads.has(p.threadId)) {
        const k = key(p.threadId, p.turn.id);
        completions.set(k, p.turn); // Buffer even if this arrives before turn/start's response.
        const waiter = waiters.get(k);
        if (waiter) { clearTimeout(waiter.timer); waiters.delete(k); waiter.resolve(p.turn); }
      }
      if (m.method === 'error') {
        events.error?.(p);
      }
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  function completed(threadId: string, turnId: string): Promise<any> {
    if (fatal) return Promise.reject(fatal);
    const k = key(threadId, turnId);
    if (completions.has(k)) return Promise.resolve(completions.get(k));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { fail(new Error(`Turn timeout: ${turnId}`)); }, 180_000);
      waiters.set(k, { resolve, reject, timer });
    });
  }
  async function sendMessage(threadId: string, text: string) {
    if (activeThreads.has(threadId)) throw new Error(`A turn is already active for ${threadId}`);
    if (!sessions.has(threadId)) throw new Error(`Create or resume thread ${threadId} before sending`);
    activeThreads.add(threadId);
    let turnId: string | undefined;
    try {
      const started = await request('turn/start', { threadId, input: [{ type: 'text', text }] });
      turnId = started.turn.id;

      const finished = await completed(threadId, turnId);
      if (finished.status !== 'completed') throw new Error(`Turn ${turnId}: ${JSON.stringify(finished)}`);
      const collected = messages.get(key(threadId, turnId));
      const response = collected?.size ? [...collected.values()].join('\n') :
        finished.items.filter((i: any) => i.type === 'agentMessage').map((i: any) => i.text).join('\n');
      if (!response) throw new Error(`No agent message for turn ${turnId}`);
      return { threadId, turnId, response, status: finished.status };
    } finally {
      activeThreads.delete(threadId);
      if (turnId) {
        const k = key(threadId, turnId);
        completions.delete(k);
        messages.delete(k);
      }
    }
  }
  async function createSession() {
    const { thread } = await request('thread/start', {
      cwd: root, sandbox: 'read-only', approvalPolicy: 'never',
      developerInstructions: 'Esta es una prueba conversacional. Respondé solo con texto; no uses herramientas, no ejecutes comandos ni modifiques archivos.',
    });
    sessions.add(thread.id);
    return thread.id as string;
  }
  async function resumeSession(threadId: string) {
    const { thread } = await request('thread/resume', {
      threadId, cwd: root, sandbox: 'read-only', approvalPolicy: 'never',
    });
    if (thread.id !== threadId) throw new Error('Resumed thread ID differs from saved ID');
    sessions.add(thread.id);
    return thread.id as string;
  }
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    return closePromise ??= (async () => {
      stopping = true;
      fail(new Error('Client shutting down'));
      child.stdin.end();
      const termTimer = setTimeout(() => child.kill('SIGTERM'), 5000);
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await closed;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
    })();
  }
  try {
    await request('initialize', { clientInfo: { name: 'pachibus', version: '0.2.0' } });
    send({ method: 'initialized' });
  } catch (error) {
    await close();
    throw error;
  }
  return { pid: child.pid, createSession, resumeSession, sendMessage, close };
}
