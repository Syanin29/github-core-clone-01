// mcp.ts — the Model Context Protocol endpoint (streamable HTTP, modern era 2026-07-28).
//
// POST /mcp, one JSON-RPC 2.0 request per body, one JSON body back. server/discover answers
// first (no handshake or session); tools/list is a frozen constant so two calls are
// byte-identical. Every tool returns BOTH content (text JSON) and structuredContent.
// Auth: no bearer token is HTTP 401 before any method is dispatched. A non-JSON body is
// HTTP 400 with JSON-RPC -32700. Unknown tools are -32601; missing arguments are -32602.

import type { ServerResponse } from 'node:http';
import { type Repo, type Store, type StoreUser } from './store.ts';

export interface McpContext {
  store: Store;
  user: StoreUser | null;
  baseUrl: string;
  requestId: string;
}

const SERVER_NAME = 'github-core-clone-01-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Readonly<Record<string, { type: string; description: string }>>; required: readonly string[] };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The login of the repository owner.' },
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, "owner/repo".' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'The state of the issues to list: open, closed, or all.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The name of the branch containing the changes.' },
        base: { type: 'string', description: 'The name of the branch to merge into.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository using a squash merge.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

function sendJson(ctx: McpContext, res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(data.length),
    'X-GitHub-Request-Id': ctx.requestId,
  });
  res.end(data);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

/** Normalize the ways a caller can name a repo: owner/repo, owner_login, or full_name. */
function resolveRepoName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = '';
  let repo = '';
  if (typeof args.owner === 'string') owner = args.owner;
  else if (typeof args.owner_login === 'string') owner = args.owner_login;
  if (typeof args.repo === 'string') repo = args.repo;
  if (typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (owner === '') owner = parts[0] ?? '';
    if (repo === '') repo = parts[1] ?? '';
  }
  return { owner, repo };
}

function lookupRepo(ctx: McpContext, args: Record<string, unknown>): Repo | { error: string } {
  const { owner, repo } = resolveRepoName(args);
  if (owner === '' || repo === '') return { error: 'owner and repo are required' };
  const found = ctx.store.getRepo(owner, repo);
  if (found === undefined) return { error: `Repository not found: ${owner}/${repo}` };
  if (!ctx.store.canRead(ctx.user, found)) return { error: `Repository not found: ${owner}/${repo}` };
  return found;
}

function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const user = ctx.user as StoreUser;
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return toolError('name is required');
      if (ctx.store.getRepo(user.login, repoName) !== undefined) return toolError(`Repository already exists: ${user.login}/${repoName}`);
      const repo = ctx.store.createRepo(user, repoName, {
        isPrivate: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        private: repo.isPrivate,
        description: repo.description,
        default_branch: repo.defaultBranch,
        html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}`,
        url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
      });
    }
    case 'get_repo': {
      const found = lookupRepo(ctx, args);
      if ('error' in found) return toolError(found.error);
      return toolResult({
        id: found.id,
        name: found.name,
        full_name: `${found.owner}/${found.name}`,
        private: found.isPrivate,
        description: found.description,
        default_branch: found.defaultBranch,
        owner: { login: found.owner },
        html_url: `${ctx.baseUrl}/${found.owner}/${found.name}`,
        url: `${ctx.baseUrl}/api/v3/repos/${found.owner}/${found.name}`,
      });
    }
    case 'create_issue': {
      const found = lookupRepo(ctx, args);
      if ('error' in found) return toolError(found.error);
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return toolError('title is required');
      const created = ctx.store.createIssue(found, user, title, typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return toolError(created.error);
      return toolResult({
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        html_url: `${ctx.baseUrl}/${found.owner}/${found.name}/issues/${created.number}`,
        url: `${ctx.baseUrl}/api/v3/repos/${found.owner}/${found.name}/issues/${created.number}`,
      });
    }
    case 'list_issues': {
      const found = lookupRepo(ctx, args);
      if ('error' in found) return toolError(found.error);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      let issues = [...found.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return toolResult({
        issues: issues.map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((label) => ({ name: label })),
        })),
      });
    }
    case 'create_pull_request': {
      const found = lookupRepo(ctx, args);
      if ('error' in found) return toolError(found.error);
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (title === '' || head === '' || base === '') return toolError('title, head and base are required');
      const created = ctx.store.createPullRequest(found, user, title, typeof args.body === 'string' ? args.body : '', head, base);
      if ('error' in created) return toolError(created.error);
      return toolResult({
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        head: { ref: created.headRef, sha: created.headSha },
        base: { ref: created.baseRef, sha: created.baseSha },
        html_url: `${ctx.baseUrl}/${found.owner}/${found.name}/pull/${created.number}`,
        url: `${ctx.baseUrl}/api/v3/repos/${found.owner}/${found.name}/pulls/${created.number}`,
      });
    }
    case 'merge_pull_request': {
      const found = lookupRepo(ctx, args);
      if ('error' in found) return toolError(found.error);
      const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
      if (!Number.isFinite(number)) return toolError('pull_number is required');
      const pr = found.pulls.get(number);
      if (pr === undefined) return toolError(`Pull request not found: #${number}`);
      if (pr.state !== 'open') return toolError('Pull request is not open');
      const sha = ctx.store.mergePullRequest(found, pr, user);
      if (sha === null) return toolError('Merge conflict');
      return toolResult({ merged: true, number: pr.number, sha, message: 'Pull request successfully merged' });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

const REQUIRED_ARGS: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

export function handleMcp(ctx: McpContext, res: ServerResponse, body: unknown, bodyIsJson: boolean): void {
  // Auth is checked before any method is dispatched.
  if (ctx.user === null) {
    const id = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).id ?? null : null;
    sendJson(ctx, res, 401, rpcError(id, -32000, 'Requires authentication'));
    return;
  }
  if (!bodyIsJson || body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(ctx, res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const request = body as Record<string, unknown>;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and expect no response body beyond an empty acknowledgement.
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    sendJson(ctx, res, 200, {});
    return;
  }
  if (method === '') {
    sendJson(ctx, res, 200, rpcError(id, -32600, 'Invalid Request'));
    return;
  }
  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    sendJson(ctx, res, 200, rpcResult(id, {
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: { listChanged: false } },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    }));
    return;
  }
  if (method === 'initialize') {
    sendJson(ctx, res, 200, rpcResult(id, {
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return;
  }
  if (method === 'ping') {
    sendJson(ctx, res, 200, rpcResult(id, {}));
    return;
  }
  if (method === 'tools/list') {
    sendJson(ctx, res, 200, rpcResult(id, { tools: TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.find((t) => t.name === toolName);
    if (known === undefined) {
      sendJson(ctx, res, 200, rpcError(id, -32601, `Method not found: ${toolName}`));
      return;
    }
    for (const required of REQUIRED_ARGS[toolName] ?? []) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        sendJson(ctx, res, 200, rpcError(id, -32602, `Missing required argument: ${required}`));
        return;
      }
    }
    const result = callTool(ctx, toolName, args);
    sendJson(ctx, res, 200, rpcResult(id, result));
    return;
  }
  sendJson(ctx, res, 200, rpcError(id, -32601, `Method not found: ${method}`));
}
