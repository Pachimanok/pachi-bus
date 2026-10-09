import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Check = { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string };

export function safeOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid HTTPS origin');
  return url.origin;
}

export async function checkHealth(name: string, origin: string, key: string | undefined,
  request: typeof fetch = fetch): Promise<Check> {
  try {
    const response = await request(`${origin}/health`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) return { name, status: 'FAIL', detail: `HTTP ${response.status}; no response body recorded` };
    const data = await response.json();
    return data?.status === 'ok'
      ? { name, status: 'PASS', detail: 'HTTP 200 and status=ok; model inference not tested' }
      : { name, status: 'FAIL', detail: 'Unexpected health response; body omitted' };
  } catch {
    return { name, status: 'FAIL', detail: 'Connection, TLS, timeout or JSON failure; raw error omitted' };
  }
}

async function diagnose() {
  const root = import.meta.dirname;
  const state = join(root, '.spike-state');
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== '--local-only')) throw new Error('Usage: npm run diagnose [-- --local-only]');
  const checks: Check[] = [];
  let version = 'unavailable';
  try { version = execFileSync('codex', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { /* Missing CLI is reported below without dumping subprocess output. */ }
  checks.push({ name: 'Codex CLI', status: version === 'unavailable' ? 'FAIL' : 'PASS', detail: version });
  checks.push({ name: 'Node.js', status: Number(process.versions.node.split('.')[0]) >= 24 ? 'PASS' : 'FAIL', detail: process.version });
  let key = process.env.PACHIBUS_API_KEY;
  let keySource = key ? 'environment' : 'absent';
  if (!key) {
    try { key = (await readFile(join(state, 'pachibus-api-key'), 'utf8')).trim(); keySource = 'local ignored file'; }
    catch { /* No secret file content or error is printed. */ }
  }
  const usableKey = !!key && key.length >= 32;
  checks.push({ name: 'API authentication', status: usableKey ? 'PASS' : 'FAIL', detail: usableKey ? `Available via ${keySource}; value omitted` : 'Missing or invalid dedicated API key' });
  const port = Number(process.env.PACHIBUS_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PACHIBUS_PORT');
  checks.push(await checkHealth('Local API', `http://127.0.0.1:${port}`, usableKey ? key : undefined));
  let remoteOrigin: string | undefined;
  try {
    const schema = JSON.parse(await readFile(join(state, 'action-openapi.json'), 'utf8'));
    remoteOrigin = safeOrigin(schema.servers[0].url);
    checks.push({ name: 'Action configuration', status: 'PASS', detail: `Configured origin: ${remoteOrigin}; GPT configuration not inspected` });
  } catch {
    checks.push({ name: 'Action configuration', status: 'FAIL', detail: 'Missing or invalid .spike-state/action-openapi.json; regenerate with the current tunnel origin' });
  }
  checks.push(remoteOrigin && args[0] !== '--local-only'
    ? await checkHealth('HTTPS tunnel', remoteOrigin, usableKey ? key : undefined)
    : { name: 'HTTPS tunnel', status: 'SKIP', detail: args[0] === '--local-only' ? 'Explicitly disabled' : 'No valid configured origin' });
  const report = { generatedAt: new Date().toISOString(), checks,
    result: checks.some(c => c.status === 'FAIL') ? 'FAIL' : 'PASS',
    limitations: ['No model inference or GPT Action executed', 'Tunnel result uses the local schema; verify that the GPT uses the same URL',
      'No changes to services, policies, global config or credentials'], };
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'diagnostic-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  for (const c of checks) console.log(`${c.status} | ${c.name} | ${c.detail}`);
  console.log(`Resultado: ${report.result}. Informe: .spike-state/diagnostic-report.json`);
  console.log('Este diagnóstico no demuestra el recorrido completo GPT → Codex.');
  if (report.result !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await diagnose();
}
