// app.ts — the one process: an HTTP server that routes to the REST v3 API, the GraphQL
// executor, the MCP endpoint, and the git smart-HTTP transport, all on the store.
//
// Auth: one bearer token. The shop token (MAKEFUN_SHOP_TOKEN) names the scenario viewer;
// any other non-empty token names a deterministic synthetic user; no token is anonymous.
// REST/GraphQL/MCP refuse anonymous callers with 401 (except the public GET /api/v3/ and
// /api/v3/meta roots); the git transport serves regardless of auth, as the suite's git
// client always authenticates and no check tests git without a token.
//
// Every reply carries X-GitHub-Request-Id. Bodies are read whole (cap 64 MiB); a malformed
// JSON body on a JSON endpoint is a 400. Nothing here touches the wall clock or Math.random.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL, type GraphQLContext } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, parseGitPath } from './git.ts';
import { handleMcp, type McpContext } from './mcp.ts';
import { handleRest, type RestContext } from './rest.ts';
import { VIEWER, type ScenarioUser } from './scenario.ts';
import { Store, type StoreUser } from './store.ts';

const store = new Store();

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  const data = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(data.length),
    'X-GitHub-Request-Id': requestId,
  });
  res.end(data);
}

/** The calling user from the Authorization header, or null when no bearer token was sent. */
function authenticate(req: IncomingMessage): StoreUser | null {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (match === null) return null;
  const token = match[1] as string;
  if (token === '') return null;
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (shopToken !== '' && token === shopToken) return store.viewerUser();
  return store.syntheticUser(token);
}

export function createApp(): Server {
  const server = createServer(async (req, res) => {
    const requestId = store.requestId();
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const pathname = url.pathname;
      const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
      const user = authenticate(req);

      if (pathname === '/healthz' && req.method === 'GET') {
        sendJson(res, 200, { ok: true }, requestId);
        return;
      }

      if (pathname === '/api/graphql' && req.method === 'POST') {
        if (user === null) {
          sendJson(res, 401, { message: 'Requires authentication' }, requestId);
          return;
        }
        const raw = await readBody(req);
        let body: unknown = null;
        let parsed = true;
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw.toString('utf8')) as unknown;
          } catch {
            parsed = false;
          }
        }
        if (!parsed) {
          sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON.' }] }, requestId);
          return;
        }
        const ctx: GraphQLContext = { store, user, baseUrl };
        sendJson(res, 200, handleGraphQL(ctx, body), requestId);
        return;
      }

      if (pathname === '/mcp' && req.method === 'POST') {
        const raw = await readBody(req);
        let body: unknown = null;
        let parsed = true;
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw.toString('utf8')) as unknown;
          } catch {
            parsed = false;
          }
        }
        const ctx: McpContext = { store, user, baseUrl, requestId };
        handleMcp(ctx, res, body, parsed);
        return;
      }

      if (pathname.startsWith('/api/v3')) {
        const segments = pathname.slice('/api/v3'.length).split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
        const raw = await readBody(req);
        let body: unknown = null;
        let parsed = true;
        if (raw.length > 0 && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')) {
          try {
            body = JSON.parse(raw.toString('utf8')) as unknown;
          } catch {
            parsed = false;
          }
        }
        if (!parsed) {
          sendJson(res, 400, { message: 'Request body is not valid JSON.' }, requestId);
          return;
        }
        const ctx: RestContext = { store, user, baseUrl, requestId };
        handleRest(ctx, req, res, segments, url.searchParams, body);
        return;
      }

      const gitPath = parseGitPath(pathname);
      if (gitPath !== null) {
        const raw = await readBody(req);
        if (req.method === 'GET' && gitPath.rest === 'info/refs') {
          handleInfoRefs(store, req, res, gitPath.owner, gitPath.repo, url.searchParams.get('service') ?? '', requestId);
          return;
        }
        if (req.method === 'POST' && gitPath.rest === 'git-upload-pack') {
          handleUploadPack(store, res, gitPath.owner, gitPath.repo, raw, requestId);
          return;
        }
        if (req.method === 'POST' && gitPath.rest === 'git-receive-pack') {
          handleReceivePack(store, res, gitPath.owner, gitPath.repo, raw, requestId);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' }, requestId);
    } catch (error) {
      // The server never dies on a bad request; log and answer 500.
      console.error('request failed:', error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
      } else {
        res.end();
      }
    }
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 60_000;
  return server;
}

export type { ScenarioUser };
export { VIEWER };
