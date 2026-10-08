import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

export type Bus = {
  createSession(): Promise<string>;
  resumeSession(threadId: string): Promise<string>;
  sendMessage(threadId: string, text: string): Promise<{ threadId: string; turnId: string; response: string; status: string }>;
};
type Job = { jobId: string; threadId: string; status: 'running' | 'completed' | 'failed';
  response?: string; turnId?: string; error?: string; expiresAt: number };
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const digest = (text: string) => createHash('sha256').update(text).digest();
const validId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);
export type AccessEvent = { method: string; route: string; status: number | 'received' };

function diagnosticRoute(rawUrl: string) {
  try {
    const path = new URL(rawUrl, 'http://localhost').pathname;
    if (path === '/health' || path === '/sessions') return path;
    if (/^\/sessions\/[^/]+\/(resume|messages)$/.test(path)) {
      return `/sessions/{threadId}/${path.endsWith('/resume') ? 'resume' : 'messages'}`;
    }
    if (/^\/jobs\/[^/]+$/.test(path)) return '/jobs/{jobId}';
  } catch { /* Invalid URLs are never printed. */ }
  return '[unknown route]';
}

export function createApi(bus: Bus, apiKey: string, onAccess?: (event: AccessEvent) => void) {
  if (apiKey.length < 32) throw new Error('PACHIBUS_API_KEY must contain at least 32 characters');
  const expected = digest(`Bearer ${apiKey}`);
  const sessions = new Set<string>();
  const busy = new Set<string>();
  const jobs = new Map<string, Job>();
  function reply(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  }
  async function body(req: IncomingMessage) {
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      throw new HttpError(415, 'Content-Type must be application/json');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16_384) throw new HttpError(413, 'Request body too large');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(400, 'Invalid JSON'); }
  }
  return createServer(async (req, res) => {
    // Record arrival before authentication, without printing headers, bodies, IDs or query strings.
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(req.method ?? '')
      ? req.method! : '[other method]';
    const route = diagnosticRoute(req.url ?? '/');
    const record = (status: AccessEvent['status']) => {
      try { onAccess?.({ method, route, status }); } catch { /* Logging cannot break an HTTP request. */ }
    };
    record('received');
    res.once('finish', () => record(res.statusCode));
    try {
      if (!timingSafeEqual(expected, digest(req.headers.authorization ?? ''))) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        reply(res, 401, { error: 'Unauthorized' });
        return;
      }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') {
        reply(res, 200, { status: 'ok' }); return;
      }
      if (req.method === 'POST' && path === '/sessions') {
        const threadId = await bus.createSession();
        sessions.add(threadId);
        reply(res, 201, { threadId }); return;
      }
      const session = /^\/sessions\/([^/]+)\/(resume|messages)$/.exec(path);
      if (session && req.method === 'POST') {
        const [, threadId, operation] = session;
        if (!validId(threadId)) throw new HttpError(400, 'Invalid thread ID');
        if (busy.has(threadId)) throw new HttpError(409, 'A message is still running on this thread');
        if (operation === 'resume') {
          busy.add(threadId);
          try {
            const resumed = await bus.resumeSession(threadId);
            if (resumed !== threadId) throw new HttpError(502, 'Resumed thread ID mismatch');
            sessions.add(threadId);
            reply(res, 200, { threadId }); return;
          } finally { busy.delete(threadId); }
        }
        if (!sessions.has(threadId)) throw new HttpError(409, 'Resume this thread before sending a message');
        const input = await body(req);
        if (!input || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 8000) {
          throw new HttpError(400, 'message must be a nonempty string of at most 8000 characters');
        }
        // Check again after reading the body: another request may have acquired this thread.
        if (busy.has(threadId)) throw new HttpError(409, 'A message is still running on this thread');
        const now = Date.now();
        for (const [id, job] of jobs) if (job.status !== 'running' && job.expiresAt < now) jobs.delete(id);
        if (jobs.size >= 128) throw new HttpError(429, 'Job capacity reached; retry after completed jobs expire');
        const job: Job = { jobId: randomUUID(), threadId, status: 'running', expiresAt: now + 3_600_000 };
        jobs.set(job.jobId, job);
        busy.add(threadId);
        reply(res, 202, { jobId: job.jobId, threadId, status: job.status });
        // Capture every rejection; HTTP acceptance does not mean the model turn succeeded.
        Promise.resolve().then(() => bus.sendMessage(threadId, input.message)).then(result => {
          if (result.threadId !== threadId || result.status !== 'completed') throw new Error('Invalid turn result');
          job.status = 'completed'; job.turnId = result.turnId; job.response = result.response;
        }).catch(() => {
          job.status = 'failed';
          job.error = 'Codex turn failed. Check the local PachiBus terminal; do not resend automatically.';
          // Never return raw backend errors that might contain credentials or local paths.
        }).finally(() => { busy.delete(threadId); job.expiresAt = Date.now() + 3_600_000; });
        return;
      }
      const jobRoute = /^\/jobs\/([^/]+)$/.exec(path);
      if (req.method === 'GET' && jobRoute) {
        const job = jobs.get(jobRoute[1]);
        if (!job || job.expiresAt < Date.now()) throw new HttpError(404, 'Job not found or expired');
        if (job.status === 'running') res.setHeader('Retry-After', '2');
        const { expiresAt, ...result } = job;
        reply(res, 200, result); return;
      }
      throw new HttpError(404, 'Route not found');
    } catch (error) {
      if (!res.headersSent) reply(res, error instanceof HttpError ? error.status : 502,
        { error: error instanceof HttpError ? error.message : 'Codex operation failed; check the local terminal' });
      else res.end();
    }
  });
}
