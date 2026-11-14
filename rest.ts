// rest.ts — the REST v3 API (GitHub's shape, this forge's store).
//
// Contract, everywhere: JSON in, JSON out; unknown routes are a JSON 404; a malformed JSON
// body is a 400; every reply carries X-GitHub-Request-Id. No token is a 401 except on
// GET /api/v3/ and GET /api/v3/meta, which are public. A repo name under a login that does
// not own it is a 404, never a 403 — the same name under another login is a different repo.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { SCENARIO_EPOCH_SEC } from './scenario.ts';
import { NAME_RE, type Issue, type PullRequest, type Repo, type Store, type StoreUser } from './store.ts';
import { hashObject, parseCommit, parseTree } from './gitproto.ts';

export interface RestContext {
  store: Store;
  user: StoreUser | null;
  baseUrl: string;
  requestId: string;
}

type Json = Record<string, unknown>;

function sendJson(ctx: RestContext, res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const data = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(data.length),
    'X-GitHub-Request-Id': ctx.requestId,
    'X-Oauth-Scopes': 'repo, read:org',
    ...extraHeaders,
  });
  res.end(data);
}

function notFound(ctx: RestContext, res: ServerResponse): void {
  sendJson(ctx, res, 404, { message: 'Not Found' });
}

function badRequest(ctx: RestContext, res: ServerResponse, message: string): void {
  sendJson(ctx, res, 400, { message });
}

function unprocessable(ctx: RestContext, res: ServerResponse, message: string): void {
  sendJson(ctx, res, 422, { message });
}

// --------------------------------------------------------------------------- shapes

function userShape(user: StoreUser): Json {
  return { login: user.login, id: user.id, node_id: `U_${user.id}`, name: user.name, email: user.email, type: 'User', site_admin: false };
}

function repoShape(ctx: RestContext, repo: Repo): Json {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: userShape({ id: repo.id, login: repo.owner, name: repo.owner, email: `${repo.owner}@example.invalid` }),
    description: repo.description,
    fork: false,
    created_at: ctx.store.stamp(repo.createdSeq),
    updated_at: ctx.store.stamp(repo.createdSeq),
    pushed_at: ctx.store.stamp(repo.createdSeq),
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueShape(ctx: RestContext, repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userShape(issue.user),
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000', description: '' })),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: ctx.store.stamp(issue.createdSeq),
    updated_at: ctx.store.stamp(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? ctx.store.stamp(issue.updatedSeq) : null,
    author_association: 'OWNER',
  };
}

function commentShape(ctx: RestContext, repo: Repo, issue: Issue, comment: { id: number; body: string; user: StoreUser; createdSeq: number }): Json {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userShape(comment.user),
    created_at: ctx.store.stamp(comment.createdSeq),
    updated_at: ctx.store.stamp(comment.createdSeq),
    author_association: 'OWNER',
  };
}

function pullShape(ctx: RestContext, repo: Repo, pr: PullRequest): Json {
  return {
    id: pr.id,
    node_id: `PR_${pr.id}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/pull/${pr.number}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user: userShape(pr.user),
    head: { label: `${repo.owner}:${pr.headRef}`, ref: pr.headRef, sha: pr.headSha },
    base: { label: `${repo.owner}:${pr.baseRef}`, ref: pr.baseRef, sha: pr.baseSha },
    merged: pr.merged,
    mergeable: pr.state === 'open' ? ctx.store.pullMergeable(repo, pr) === 'MERGEABLE' : null,
    merged_at: pr.mergedAtSeq === null ? null : ctx.store.stamp(pr.mergedAtSeq),
    merge_commit_sha: pr.mergeCommitSha,
    created_at: ctx.store.stamp(pr.createdSeq),
    updated_at: ctx.store.stamp(pr.updatedSeq),
    closed_at: pr.state === 'closed' ? ctx.store.stamp(pr.updatedSeq) : null,
    author_association: 'OWNER',
    draft: false,
  };
}

function commitShape(ctx: RestContext, repo: Repo, oid: string): Json | null {
  const obj = ctx.store.getObject(repo, oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parts = parseCommit(obj.data);
  const authorLine = parts.author || parts.committer;
  const name = authorLine.split(' <')[0] ?? '';
  const email = (authorLine.match(/<([^>]*)>/) ?? [])[1] ?? '';
  const epoch = parseInt((authorLine.match(/ (\d+) \+0000$/) ?? [])[1] ?? String(SCENARIO_EPOCH_SEC), 10);
  const date = new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    sha: oid,
    node_id: `C_${oid.slice(0, 12)}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/commit/${oid}`,
    commit: {
      message: parts.message,
      author: { name, email, date },
      committer: { name, email, date },
      tree: { sha: parts.tree },
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: { login: name, id: 0 },
    committer: { login: name, id: 0 },
    parents: parts.parents.map((sha) => ({ sha })),
  };
}

// --------------------------------------------------------------------------- pagination

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { pageItems: T[]; hasNext: boolean; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), hasNext: page < totalPages, totalPages };
}

function linkHeader(ctx: RestContext, req: IncomingMessage, query: URLSearchParams, page: number, perPage: number, hasNext: boolean, totalPages: number): string {
  if (!hasNext && page <= 1) return '';
  const build = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${ctx.baseUrl}${req.url?.split('?')[0] ?? ''}?${q.toString()}>`;
  };
  const links: string[] = [];
  if (hasNext) links.push(`${build(page + 1)}; rel="next"`);
  if (totalPages > 1) links.push(`${build(totalPages)}; rel="last"`);
  if (page > 1) links.push(`${build(1)}; rel="first"`);
  return links.join(', ');
}

// --------------------------------------------------------------------------- routing

export function handleRest(ctx: RestContext, req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams, body: unknown): void {
  const method = req.method ?? 'GET';
  const user = ctx.user;

  // Public roots.
  if (segments.length === 0 && method === 'GET') {
    sendJson(ctx, res, 200, {
      current_user_url: `${ctx.baseUrl}/api/v3/user`,
      rate_limit_url: `${ctx.baseUrl}/api/v3/rate_limit`,
      repository_url: `${ctx.baseUrl}/api/v3/repos/{owner}/{repo}`,
    });
    return;
  }
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    sendJson(ctx, res, 200, { installed_version: '1.0.0' });
    return;
  }

  if (user === null) {
    sendJson(ctx, res, 401, { message: 'Requires authentication' });
    return;
  }

  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    sendJson(ctx, res, 200, userShape(user));
    return;
  }

  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') return createRepo(ctx, req, res, user, body);
    if (method === 'GET') {
      const { page, perPage } = pageParams(query);
      const repos = ctx.store.listReposFor(user.login);
      const { pageItems, hasNext, totalPages } = paginate(repos, page, perPage);
      const link = linkHeader(ctx, req, query, page, perPage, hasNext, totalPages);
      sendJson(ctx, res, 200, pageItems.map((repo) => repoShape(ctx, repo)), link === '' ? {} : { Link: link });
      return;
    }
    return notFound(ctx, res);
  }

  if (segments.length >= 3 && segments[0] === 'repos') {
    return handleRepoRoute(ctx, req, res, segments, query, body);
  }

  return notFound(ctx, res);
}

function createRepo(ctx: RestContext, req: IncomingMessage, res: ServerResponse, user: StoreUser, body: unknown): void {
  const data = body as Json | null;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    badRequest(ctx, res, 'Invalid request body');
    return;
  }
  const name = typeof data.name === 'string' ? data.name : '';
  if (name === '' || !NAME_RE.test(name)) {
    unprocessable(ctx, res, 'Invalid repository name');
    return;
  }
  if (ctx.store.getRepo(user.login, name) !== undefined) {
    unprocessable(ctx, res, 'Repository already exists');
    return;
  }
  const repo = ctx.store.createRepo(user, name, {
    isPrivate: data.private === true,
    description: typeof data.description === 'string' ? data.description : '',
  });
  sendJson(ctx, res, 201, repoShape(ctx, repo));
}

/** Resolve the repo a route names, applying the visibility rule (foreign private = 404). */
function resolveRepo(ctx: RestContext, owner: string, name: string, forWrite: boolean): Repo | null {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return null;
  if (forWrite) {
    if (!ctx.store.canWrite(ctx.user, repo)) return null;
    return repo;
  }
  if (!ctx.store.canRead(ctx.user, repo)) return null;
  return repo;
}

function handleRepoRoute(ctx: RestContext, req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams, body: unknown): void {
  const method = req.method ?? 'GET';
  const owner = segments[1] as string;
  const name = segments[2] as string;
  const rest = segments.slice(3);
  const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const repo = resolveRepo(ctx, owner, name, isWrite);
  if (repo === null) {
    notFound(ctx, res);
    return;
  }

  // /repos/{owner}/{repo}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, res, 200, repoShape(ctx, repo));
      return;
    }
    if (method === 'PATCH') {
      const data = (body as Json | null) ?? {};
      if (typeof data.description === 'string') repo.description = data.description;
      sendJson(ctx, res, 200, repoShape(ctx, repo));
      return;
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(owner, name);
      sendJson(ctx, res, 204, null);
      return;
    }
    return notFound(ctx, res);
  }

  const head = rest[0] as string;
  if (head === 'branches') return handleBranches(ctx, req, res, repo, rest.slice(1), method);
  if (head === 'commits') return handleCommits(ctx, req, res, repo, query, method);
  if (head === 'git') return handleGitRefs(ctx, req, res, repo, rest.slice(1), method, body);
  if (head === 'contents') return handleContents(ctx, req, res, repo, rest.slice(1), query, method, body);
  if (head === 'labels') return handleLabels(ctx, req, res, repo, method, body);
  if (head === 'issues') return handleIssues(ctx, req, res, repo, rest.slice(1), query, method, body);
  if (head === 'pulls') return handlePulls(ctx, req, res, repo, rest.slice(1), query, method, body);
  return notFound(ctx, res);
}

// --------------------------------------------------------------------------- branches & commits

function handleBranches(ctx: RestContext, req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], method: string): void {
  if (method !== 'GET') return notFound(ctx, res);
  const branches = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length))
    .sort()
    .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) as string, url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${repo.refs.get(`refs/heads/${name}`) as string}` } }));
  if (rest.length === 0) {
    sendJson(ctx, res, 200, branches);
    return;
  }
  const name = decodeURIComponent(rest.join('/'));
  const found = branches.find((b) => b.name === name);
  if (found === undefined) {
    notFound(ctx, res);
    return;
  }
  sendJson(ctx, res, 200, found);
}

function handleCommits(ctx: RestContext, req: IncomingMessage, res: ServerResponse, repo: Repo, query: URLSearchParams, method: string): void {
  if (method !== 'GET') return notFound(ctx, res);
  const tip = ctx.store.resolveCommit(repo, query.get('sha') ?? undefined);
  if (tip === null) {
    sendJson(ctx, res, 200, []);
    return;
  }
  const { page, perPage } = pageParams(query);
  const chain = ctx.store.firstParentChain(repo, tip);
  const { pageItems, hasNext, totalPages } = paginate(chain, page, perPage);
  const link = linkHeader(ctx, req, query, page, perPage, hasNext, totalPages);
  const out: Json[] = [];
  for (const oid of pageItems) {
    const shape = commitShape(ctx, repo, oid);
    if (shape !== null) out.push(shape);
  }
  sendJson(ctx, res, 200, out, link === '' ? {} : { Link: link });
}

function handleGitRefs(ctx: RestContext, req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], method: string, body: unknown): void {
  if (rest.length >= 2 && rest[0] === 'refs' && rest[1] === 'heads' && method === 'GET') {
    const branch = decodeURIComponent(rest.slice(2).join('/'));
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) {
      notFound(ctx, res);
      return;
    }
    sendJson(ctx, res, 200, { ref: `refs/heads/${branch}`, object: { sha: oid, type: 'commit', url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}` } });
    return;
  }
  if (rest.length === 1 && rest[0] === 'refs' && method === 'POST') {
    const data = (body as Json | null) ?? {};
    const ref = typeof data.ref === 'string' ? data.ref : '';
    const sha = typeof data.sha === 'string' ? data.sha : '';
    if (!ref.startsWith('refs/heads/') || !/^[0-9a-f]{40}$/i.test(sha)) {
      unprocessable(ctx, res, 'Invalid ref or sha');
      return;
    }
    if (repo.refs.has(ref)) {
      unprocessable(ctx, res, 'Reference already exists');
      return;
    }
    const target = ctx.store.getObject(repo, sha);
    if (target === undefined || target.type !== 'commit') {
      unprocessable(ctx, res, 'Invalid sha');
      return;
    }
    repo.refs.set(ref, sha.toLowerCase());
    sendJson(ctx, res, 201, { ref, object: { sha: sha.toLowerCase(), type: 'commit', url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha.toLowerCase()}` } });
    return;
  }
  return notFound(ctx, res);
}

// --------------------------------------------------------------------------- contents

function treeAtRef(ctx: RestContext, repo: Repo, ref: string | undefined): { tree: string; commit: string } | null {
  const commit = ctx.store.resolveCommit(repo, ref);
  if (commit === null) return null;
  const obj = ctx.store.getObject(repo, commit);
  if (obj === undefined || obj.type !== 'commit') return null;
  return { tree: parseCommit(obj.data).tree, commit };
}

function handleContents(ctx: RestContext, req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], query: URLSearchParams, method: string, body: unknown): void {
  const path = rest.map((s) => decodeURIComponent(s)).join('/');
  const user = ctx.user as StoreUser;

  if (method === 'GET') {
    const at = treeAtRef(ctx, repo, query.get('ref') ?? undefined);
    if (at === null) {
      notFound(ctx, res);
      return;
    }
    if (path === '') {
      sendJson(ctx, res, 200, listDirectory(ctx, repo, at.tree, ''));
      return;
    }
    const flat = new Map<string, string>();
    const walk = (treeOid: string, prefix: string): void => {
      const obj = ctx.store.getObject(repo, treeOid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const p = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, p);
        else flat.set(p, entry.oid);
      }
    };
    walk(at.tree, '');
    const blobOid = flat.get(path);
    if (blobOid !== undefined) {
      const data = ctx.store.getObject(repo, blobOid)?.data ?? Buffer.alloc(0);
      sendJson(ctx, res, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop() as string,
        path,
        content: data.toString('base64'),
        sha: blobOid,
        url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      });
      return;
    }
    // A directory: any flat path under path + '/'.
    const children = new Set<string>();
    for (const p of flat.keys()) {
      if (p.startsWith(`${path}/`)) children.add(p.slice(path.length + 1).split('/')[0] as string);
    }
    // Also subdirectories that hold no files cannot exist (trees only hold files), so children is complete.
    if (children.size === 0) {
      notFound(ctx, res);
      return;
    }
    const entries: Json[] = [];
    for (const child of [...children].sort()) {
      const childPath = `${path}/${child}`;
      const childBlob = flat.get(childPath);
      if (childBlob !== undefined) {
        entries.push({ type: 'file', name: child, path: childPath, sha: childBlob, size: ctx.store.getObject(repo, childBlob)?.data.length ?? 0, url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}` });
      } else {
        // A subdirectory: its tree oid.
        const treeOid = findSubtree(ctx, repo, at.tree, childPath);
        entries.push({ type: 'dir', name: child, path: childPath, sha: treeOid ?? '', url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}` });
      }
    }
    sendJson(ctx, res, 200, entries);
    return;
  }

  if (method === 'PUT') {
    const data = (body as Json | null) ?? {};
    const message = typeof data.message === 'string' ? data.message : 'Update file';
    const contentB64 = typeof data.content === 'string' ? data.content : '';
    const branch = typeof data.branch === 'string' ? data.branch : repo.defaultBranch;
    const sha = typeof data.sha === 'string' ? data.sha : undefined;
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
      if (contentB64 !== '' && content.toString('base64').replace(/=+$/, '') !== contentB64.replace(/=+$/, '')) throw new Error('bad base64');
    } catch {
      badRequest(ctx, res, 'Invalid base64 content');
      return;
    }
    const branchRef = `refs/heads/${branch}`;
    let tip = repo.refs.get(branchRef);
    if (tip === undefined) {
      // A new branch starts at the default tip (or at nothing when the repo is unborn).
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined) {
        repo.refs.set(branchRef, defaultTip);
        tip = defaultTip;
      }
    }
    const currentBlob = tip === undefined ? undefined : currentBlobAt(ctx, repo, tip, path);
    if (sha !== undefined) {
      if (currentBlob === undefined || currentBlob !== sha.toLowerCase()) {
        sendJson(ctx, res, 409, { message: 'sha does not match' });
        return;
      }
    } else if (currentBlob !== undefined) {
      sendJson(ctx, res, 409, { message: 'sha is required to update a file' });
      return;
    }
    const parents = tip === undefined ? [] : [tip];
    const commitOid = ctx.store.createCommit(repo, { parents, changes: new Map([[path, content]]), message, author: user });
    repo.refs.set(branchRef, commitOid);
    const blobOid = hashObject('blob', content);
    const isCreate = currentBlob === undefined;
    sendJson(ctx, res, isCreate ? 201 : 200, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: path.split('/').pop() as string,
        path,
        content: contentB64,
        sha: blobOid,
        url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      },
      commit: { sha: commitOid },
    });
    return;
  }

  if (method === 'DELETE') {
    const data = (body as Json | null) ?? {};
    const message = typeof data.message === 'string' ? data.message : 'Delete file';
    const sha = typeof data.sha === 'string' ? data.sha : undefined;
    const branch = typeof data.branch === 'string' ? data.branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) {
      notFound(ctx, res);
      return;
    }
    const currentBlob = currentBlobAt(ctx, repo, tip, path);
    if (currentBlob === undefined) {
      notFound(ctx, res);
      return;
    }
    if (sha !== undefined && sha.toLowerCase() !== currentBlob) {
      sendJson(ctx, res, 409, { message: 'sha does not match' });
      return;
    }
    const commitOid = ctx.store.createCommit(repo, { parents: [tip], changes: new Map([[path, null]]), message, author: user });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    sendJson(ctx, res, 200, { commit: { sha: commitOid }, content: null });
    return;
  }

  return notFound(ctx, res);
}

function currentBlobAt(ctx: RestContext, repo: Repo, tip: string, path: string): string | undefined {
  const tree = ctx.store.commitTree(repo, tip);
  if (tree === null) return undefined;
  const flat = new Map<string, string>();
  const walk = (treeOid: string, prefix: string): void => {
    const obj = ctx.store.getObject(repo, treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const p = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, p);
      else flat.set(p, entry.oid);
    }
  };
  walk(tree, '');
  return flat.get(path);
}

function findSubtree(ctx: RestContext, repo: Repo, treeOid: string, path: string): string | null {
  const parts = path.split('/');
  let current = treeOid;
  for (const part of parts) {
    const obj = ctx.store.getObject(repo, current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

function listDirectory(ctx: RestContext, repo: Repo, treeOid: string, prefix: string): Json[] {
  const obj = ctx.store.getObject(repo, treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  const out: Json[] = [];
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', name: entry.name, path, sha: entry.oid, url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}` });
    } else {
      out.push({ type: 'file', name: entry.name, path, sha: entry.oid, size: ctx.store.getObject(repo, entry.oid)?.data.length ?? 0, url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}` });
    }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// --------------------------------------------------------------------------- labels

function handleLabels(ctx: RestContext, req: IncomingMessage, res: ServerResponse, repo: Repo, method: string, body: unknown): void {
  if (method === 'GET') {
    sendJson(ctx, res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
    return;
  }
  if (method === 'POST') {
    const data = (body as Json | null) ?? {};
    const name = typeof data.name === 'string' ? data.name : '';
    if (name === '') {
      unprocessable(ctx, res, 'Label name is required');
      return;
    }
    const color = typeof data.color === 'string' ? data.color.replace(/^#/, '') : '000000';
    repo.labels.set(name, { name, color });
    sendJson(ctx, res, 201, { name, color, description: '' });
    return;
  }
  return notFound(ctx, res);
}

// --------------------------------------------------------------------------- issues

function handleIssues(ctx: RestContext, req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], query: URLSearchParams, method: string, body: unknown): void {
  const user = ctx.user as StoreUser;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = (query.get('direction') ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page, perPage } = pageParams(query);
      const { pageItems, hasNext, totalPages } = paginate(issues, page, perPage);
      const link = linkHeader(ctx, req, query, page, perPage, hasNext, totalPages);
      sendJson(ctx, res, 200, pageItems.map((issue) => issueShape(ctx, repo, issue)), link === '' ? {} : { Link: link });
      return;
    }
    if (method === 'POST') {
      const data = (body as Json | null) ?? {};
      const title = typeof data.title === 'string' ? data.title : '';
      if (title === '') {
        unprocessable(ctx, res, 'Title is required');
        return;
      }
      const bodyText = typeof data.body === 'string' ? data.body : '';
      const labels = Array.isArray(data.labels) ? (data.labels as unknown[]).filter((l) => typeof l === 'string') as string[] : [];
      const created = ctx.store.createIssue(repo, user, title, bodyText, labels);
      if ('error' in created) {
        unprocessable(ctx, res, created.error);
        return;
      }
      sendJson(ctx, res, 201, issueShape(ctx, repo, created));
      return;
    }
    return notFound(ctx, res);
  }
  const number = parseInt(rest[0] as string, 10);
  if (!Number.isFinite(number)) return notFound(ctx, res);
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(ctx, res);
    return;
  }
  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(ctx, res, 200, issueShape(ctx, repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const data = (body as Json | null) ?? {};
      if (typeof data.state === 'string' && (data.state === 'open' || data.state === 'closed')) issue.state = data.state;
      if (typeof data.title === 'string') issue.title = data.title;
      if (typeof data.body === 'string') issue.body = data.body;
      issue.updatedSeq = ctx.store.tick();
      sendJson(ctx, res, 200, issueShape(ctx, repo, issue));
      return;
    }
    return notFound(ctx, res);
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      sendJson(ctx, res, 200, issue.comments.map((comment) => commentShape(ctx, repo, issue, comment)));
      return;
    }
    if (method === 'POST') {
      const data = (body as Json | null) ?? {};
      const bodyText = typeof data.body === 'string' ? data.body : '';
      if (bodyText === '') {
        unprocessable(ctx, res, 'Body is required');
        return;
      }
      const comment = { id: repo.nextCommentId, body: bodyText, user, createdSeq: ctx.store.tick() };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      sendJson(ctx, res, 201, commentShape(ctx, repo, issue, comment));
      return;
    }
    return notFound(ctx, res);
  }
  return notFound(ctx, res);
}

// --------------------------------------------------------------------------- pulls

function handlePulls(ctx: RestContext, req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], query: URLSearchParams, method: string, body: unknown): void {
  const user = ctx.user as StoreUser;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const { page, perPage } = pageParams(query);
      const { pageItems, hasNext, totalPages } = paginate(pulls, page, perPage);
      const link = linkHeader(ctx, req, query, page, perPage, hasNext, totalPages);
      sendJson(ctx, res, 200, pageItems.map((pr) => pullShape(ctx, repo, pr)), link === '' ? {} : { Link: link });
      return;
    }
    if (method === 'POST') {
      const data = (body as Json | null) ?? {};
      const title = typeof data.title === 'string' ? data.title : '';
      const head = typeof data.head === 'string' ? data.head : '';
      const base = typeof data.base === 'string' ? data.base : '';
      if (title === '' || head === '' || base === '') {
        unprocessable(ctx, res, 'title, head and base are required');
        return;
      }
      const created = ctx.store.createPullRequest(repo, user, title, typeof data.body === 'string' ? data.body : '', head, base);
      if ('error' in created) {
        unprocessable(ctx, res, created.error);
        return;
      }
      sendJson(ctx, res, 201, pullShape(ctx, repo, created));
      return;
    }
    return notFound(ctx, res);
  }
  const number = parseInt(rest[0] as string, 10);
  if (!Number.isFinite(number)) return notFound(ctx, res);
  const pr = repo.pulls.get(number);
  if (pr === undefined) {
    notFound(ctx, res);
    return;
  }
  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(ctx, res, 200, pullShape(ctx, repo, pr));
      return;
    }
    return notFound(ctx, res);
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const files = ctx.store.pullFiles(repo, pr);
    sendJson(ctx, res, 200, files.map((f) => ({
      sha: '',
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      blob_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/blob/${pr.headSha}/${f.filename}`,
      raw_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/raw/${pr.headSha}/${f.filename}`,
      contents_url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${f.filename}`,
    })));
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pr.state !== 'open') {
      sendJson(ctx, res, 409, { message: 'Pull request is not open' });
      return;
    }
    if (ctx.store.pullMergeable(repo, pr) === 'CONFLICTING') {
      sendJson(ctx, res, 405, { message: 'Merge conflict' });
      return;
    }
    const sha = ctx.store.mergePullRequest(repo, pr, user);
    if (sha === null) {
      sendJson(ctx, res, 405, { message: 'Merge conflict' });
      return;
    }
    sendJson(ctx, res, 200, { merged: true, sha, message: 'Pull request successfully merged' });
    return;
  }
  return notFound(ctx, res);
}
