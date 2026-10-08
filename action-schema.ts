import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function actionSchema(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Provide an HTTPS origin without credentials, port, path, query or fragment');
  }
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const response = (description: string, name: string) => ({ description,
    content: { 'application/json': { schema: ref(name) } } });
  const errors = { '401': response('Invalid or missing API key', 'Error'),
    '409': response('Thread must be resumed or a message is already running', 'Error'),
    '502': response('Codex operation failed', 'Error') };
  const threadId = { name: 'threadId', in: 'path', required: true,
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } };
  return {
    openapi: '3.1.0',
    info: { title: 'PachiBus', version: '0.3.0', description: 'Private, text-only bridge to a persistent Codex thread.' },
    servers: [{ url: url.origin }],
    security: [{ PachiBusKey: [] }],
    paths: {
      '/health': { get: { operationId: 'checkPachiBus', summary: 'Check that PachiBus is reachable',
        responses: { '200': response('API is reachable; this does not test model inference', 'Health'), '401': errors['401'] } } },
      '/sessions': { post: { operationId: 'createCodexSession', summary: 'Create a new Codex thread',
        description: 'Save the returned threadId. Create a new session only at the user request.',
        'x-openai-isConsequential': true, responses: { '201': response('Created thread', 'Session'), ...errors } } },
      '/sessions/{threadId}/resume': { post: { operationId: 'resumeCodexSession', summary: 'Resume an existing Codex thread',
        description: 'Use the exact saved threadId after a PachiBus restart. Never create a replacement thread on failure.',
        'x-openai-isConsequential': true, parameters: [threadId],
        responses: { '200': response('Resumed thread with identical ID', 'Session'), ...errors } } },
      '/sessions/{threadId}/messages': { post: { operationId: 'sendCodexMessage', summary: 'Send text to an existing Codex thread',
        description: 'Returns a jobId immediately, not the model response. Poll getCodexResult with that jobId. Do not send this message again while its result is pending.',
        'x-openai-isConsequential': true, parameters: [threadId],
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 8000 } },
          required: ['message'], additionalProperties: false,
        } } } }, responses: { '202': response('Accepted job; inference is still running', 'Job'), ...errors,
          '400': response('Invalid message', 'Error'), '413': response('Request too large', 'Error'),
          '429': response('Job capacity reached', 'Error') } } },
      '/jobs/{jobId}': { get: { operationId: 'getCodexResult', summary: 'Get the status and response of a submitted message',
        description: 'running: wait briefly before querying again. completed: show response. failed: report error, do not automatically resend. Jobs expire after one hour or a server restart.',
        parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': response('Job status and response if completed', 'Job'), '401': errors['401'],
          '404': response('Unknown or expired job; do not assume the message never ran', 'Error') } } },
    },
    components: {
      securitySchemes: { PachiBusKey: { type: 'http', scheme: 'bearer', description: 'Dedicated PachiBus API key, not a Codex credential' } },
      schemas: {
        Health: { type: 'object', properties: { status: { type: 'string', enum: ['ok'] } }, required: ['status'] },
        Session: { type: 'object', properties: { threadId: { type: 'string' } }, required: ['threadId'] },
        Job: { type: 'object', properties: {
          jobId: { type: 'string' }, threadId: { type: 'string' },
          status: { type: 'string', enum: ['running', 'completed', 'failed'] },
          turnId: { type: 'string' }, response: { type: 'string' }, error: { type: 'string' },
        }, required: ['jobId', 'threadId', 'status'] },
        Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
      },
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: npm run --silent action:schema -- https://YOUR-TUNNEL-HOST');
  console.log(JSON.stringify(actionSchema(process.argv[2]), null, 2));
}
