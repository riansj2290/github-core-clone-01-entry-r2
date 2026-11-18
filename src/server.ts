import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Counter, jsonBody, type HttpResult } from './util.ts';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

// HTTP server: reads the whole body, routes to the git/REST/GraphQL/MCP
// handlers, and stamps every response with a deterministic request id.
// The server never crashes on a bad request: handler errors become 500s.

const MAX_BODY = 100 * 1024 * 1024;

function hasToken(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  return auth.startsWith('Bearer ') && auth.slice(7).trim().length > 0;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function notFound(): HttpResult {
  return { status: 404, contentType: 'application/json', body: jsonBody({ message: 'Not Found' }) };
}

export function createApp(): ReturnType<typeof createServer> {
  const store = new Store();
  const requestIds = new Counter(1);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = `req-${requestIds.next()}`;
    const send = (result: HttpResult): void => {
      res.writeHead(result.status, {
        'content-type': result.contentType,
        'x-github-request-id': requestId,
        ...(result.headers ?? {}),
      });
      res.end(result.body);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const authed = hasToken(req);

      if (method === 'GET' && path === '/healthz') {
        send({ status: 200, contentType: 'application/json', body: jsonBody({ ok: true }) });
        return;
      }

      // Git smart HTTP: /:owner/:repo.git/{info/refs,git-upload-pack,git-receive-pack}
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch) {
        if (!authed) {
          send({ status: 401, contentType: 'application/json', body: jsonBody({ message: 'Requires authentication' }) });
          return;
        }
        const [, owner, repoName, action] = gitMatch;
        if (action === 'info/refs' && method === 'GET') {
          const service = url.searchParams.get('service');
          const gitProtocol = req.headers['git-protocol'] ?? null;
          send(handleInfoRefs(store, owner, repoName, service, gitProtocol));
          return;
        }
        if (action === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(req);
          send(handleUploadPack(store, owner, repoName, body));
          return;
        }
        if (action === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          send(handleReceivePack(store, owner, repoName, body));
          return;
        }
        send(notFound());
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const restPath = path.slice('/api/v3'.length) || '/';
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
        send(handleRest(store, method, restPath, url.searchParams, body, origin, authed));
        return;
      }

      // GraphQL v4.
      if (path === '/api/graphql' && method === 'POST') {
        const body = await readBody(req);
        send(handleGraphql(store, body, authed));
        return;
      }

      // MCP.
      if (path === '/mcp' && method === 'POST') {
        const body = await readBody(req);
        send(handleMcp(store, body, authed));
        return;
      }

      send(notFound());
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Internal Server Error';
      if (!res.headersSent) {
        res.writeHead(500, {
          'content-type': 'application/json',
          'x-github-request-id': requestId,
        });
        res.end(jsonBody({ message }));
      }
    }
  });

  return server;
}
