import { prepareRuntime, startPachiBus } from './core.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = import.meta.dirname;
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !['--resume', '--check-protocol'].includes(args[0]))) {
  throw new Error('Usage: node spike.ts [--resume | --check-protocol]');
}
if (args[0] === '--check-protocol') {
  const { version } = await prepareRuntime(root, true);
  console.log(`Codex: ${version}`);
  console.log('Protocolo confirmado: initialize, thread/start, thread/resume, turn/start');
  process.exit(0);
}
const resume = args[0] === '--resume';
const state = join(root, '.spike-state');
const savedId = resume ? (await readFile(join(state, 'thread-id.txt'), 'utf8')).trim() : undefined;
if (resume && !savedId) throw new Error('No saved thread ID. Run npm run spike first.');
const transcript: any = { mode: resume ? 'resume' : 'new', turns: [], serverRequests: [], errors: [] };
let client: Awaited<ReturnType<typeof startPachiBus>> | undefined;
async function turn(threadId: string, message: string, number: number) {
  console.log(`Mensaje ${number}: ${message}`);
  const entry: any = { threadId, message, response: null, status: 'inProgress' };
  transcript.turns.push(entry);
  try {
    const result = await client!.sendMessage(threadId, message);
    Object.assign(entry, result);
    console.log(`Respuesta ${number}: ${result.response}`);
    return result.response;
  } catch (error) {
    entry.status = 'failed';
    throw error;
  }
}
try {
  client = await startPachiBus(root, {
    stderr: text => process.stderr.write(text),
    serverRequest: request => { transcript.serverRequests.push(request); console.log(`Server request: ${request.method}`); },
    error: params => { transcript.errors.push(params); console.error('Server event error:', JSON.stringify(params)); },
  });
  transcript.version = client.version;
  transcript.appServerPid = client.pid;
  console.log(`Codex: ${client.version}`);
  console.log(`App Server iniciado (PID ${client.pid}, stdio)`);
  const threadId = resume ? await client.resumeSession(savedId!) : await client.createSession();
  transcript.threadId = threadId;
  if (!resume) await writeFile(join(state, 'thread-id.txt'), threadId + '\n');
  console.log(`Thread ID: ${threadId}`);
  if (resume) console.log('Thread reanudado en un proceso nuevo; no se reenvía el código.');
  else await turn(threadId, 'Estamos probando PachiBus. Recordá que el código secreto de esta sesión es MATE-1847. Respondé confirmando que lo recordaste.', 1);
  const response = await turn(threadId, '¿Cuál era el código secreto que te indiqué antes?', resume ? 3 : 2);
  transcript.result = response.includes('MATE-1847') ? 'PASS' : 'FAIL';
  console.log(`Verificación: ${transcript.result}`);
  if (transcript.result !== 'PASS') process.exitCode = 1;
} catch (error) {
  transcript.result = 'FAIL';
  transcript.error = error instanceof Error ? error.message : String(error);
  console.error(`Verificación: FAIL — ${transcript.error}`);
  process.exitCode = 1;
} finally {
  // Closing must happen even if writing diagnostic evidence fails.
  try {
    await writeFile(join(state, resume ? 'last-resume.json' : 'last-run.json'), JSON.stringify(transcript, null, 2) + '\n');
  } finally {
    await client?.close();
    if (client) console.log('App Server cerrado.');
  }
}
