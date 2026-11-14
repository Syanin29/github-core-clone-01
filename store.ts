// store.ts — the forge's whole state, in memory, deterministic.
//
// Everything the entry returns is derived from this store and from two counters: a global
// sequence (ids, request ids, timestamps) and a per-repo number sequence shared by issues and
// pull requests. No wall clock, no randomness: two runs that see the same requests produce the
// same state export, byte for byte.

import { createHash } from 'node:crypto';
import { SCENARIO_EPOCH_SEC, VIEWER, type ScenarioUser } from './scenario.ts';
import {
  buildCommit,
  buildTree,
  buildTag,
  collectReachable,
  diffTrees,
  flattenTree,
  firstParentChain,
  hashObject,
  isAncestor,
  lineDiff,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from './gitproto.ts';

export interface StoreUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: StoreUser;
  createdSeq: number;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: StoreUser;
  createdSeq: number;
  updatedSeq: number;
  comments: IssueComment[];
}

export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAtSeq: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  user: StoreUser;
  createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  /** Full ref name (refs/heads/main, refs/tags/v1) -> commit/tag oid. */
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  /** Shared by issues and pull requests, like GitHub's. */
  nextNumber: number;
  nextCommentId: number;
}

export interface UserContext {
  login: string;
  user: StoreUser;
}

/** A name the URL may carry for a repo: starts alnum, then alnum . _ - (GitHub's shape). */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export class Store {
  /** Global sequence: ids, timestamps, request ids all come from here, in order. */
  seq = 0;
  private nextRepoId = 5000;
  private repos = new Map<string, Repo>();
  /** Synthetic users minted for foreign tokens, keyed by the token's sha-1 prefix. */
  private syntheticUsers = new Map<string, StoreUser>();

  /** Advance the global sequence and return the new value (ids, timestamps, request ids). */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** An ISO timestamp derived from the deterministic tick, never the wall clock. */
  stamp(seq: number): string {
    return new Date((SCENARIO_EPOCH_SEC + seq) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** A request id for the X-GitHub-Request-Id header, deterministic per call order. */
  requestId(): string {
    return `req-${this.tick()}`;
  }

  // --------------------------------------------------------------------- users

  viewerUser(): StoreUser {
    return { id: VIEWER.id, login: VIEWER.login, name: VIEWER.name, email: VIEWER.email };
  }

  /** A deterministic user for a non-shop token: the same token always maps to the same login. */
  syntheticUser(token: string): StoreUser {
    const key = createHash('sha1').update(token).digest('hex').slice(0, 12);
    const found = this.syntheticUsers.get(key);
    if (found !== undefined) return found;
    const user: StoreUser = { id: 2000 + this.syntheticUsers.size, login: `user-${key}`, name: `user-${key}`, email: `user-${key}@example.invalid` };
    this.syntheticUsers.set(key, user);
    return user;
  }

  // --------------------------------------------------------------------- repos

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: StoreUser, name: string, opts: { isPrivate?: boolean; description?: string } = {}): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      owner: owner.login,
      name,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: 'main',
      createdSeq: this.tick(),
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    for (const label of ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']) {
      repo.labels.set(label, { name: label, color: '000000' });
    }
    this.repos.set(this.repoKey(owner.login, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** Every repo in the store, in creation order (used by the GraphQL node() resolver). */
  listAllRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /** The requesting user's repos, in creation order. */
  listReposFor(login: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === login).sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /** Can `user` see this repo? Public repos are world-readable; private ones are owner-only. */
  canRead(user: StoreUser | null, repo: Repo): boolean {
    if (user === null) return false;
    return !repo.isPrivate || repo.owner === user.login;
  }

  canWrite(user: StoreUser | null, repo: Repo): boolean {
    if (user === null) return false;
    return repo.owner === user.login;
  }

  // --------------------------------------------------------------------- git objects

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid.toLowerCase());
  }

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Resolve a branch name, a full ref, or a raw oid to the commit it points at. */
  resolveCommit(repo: Repo, ref: string | undefined): string | null {
    if (ref === undefined || ref === '') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip ?? null;
    }
    if (/^[0-9a-f]{40}$/i.test(ref)) {
      const obj = this.getObject(repo, ref);
      return obj !== undefined && obj.type === 'commit' ? ref.toLowerCase() : null;
    }
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      if (oid === undefined) return null;
      return this.peelToCommit(repo, oid);
    }
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return this.peelToCommit(repo, branch);
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return this.peelToCommit(repo, tag);
    return null;
  }

  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let i = 0; i < 16; i += 1) {
      const obj = this.getObject(repo, current);
      if (obj === undefined) return null;
      if (obj.type === 'commit') return current;
      if (obj.type === 'tag') {
        current = parseTag(obj.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** Build a commit on top of `parents` with the given file changes, storing every new object. */
  createCommit(
    repo: Repo,
    opts: { parents: string[]; changes: Map<string, Buffer | null>; message: string; author: StoreUser },
  ): string {
    const seq = this.tick();
    const baseTree =
      opts.parents.length > 0
        ? (() => {
            const parent = this.getObject(repo, opts.parents[0] as string);
            return parent !== undefined && parent.type === 'commit' ? parseCommit(parent.data).tree : null;
          })()
        : null;
    const tree = this.treeWithChanges(repo, baseTree, opts.changes);
    const stamp = `${SCENARIO_EPOCH_SEC + seq} +0000`;
    const authorLine = `${opts.author.name} <${opts.author.email}> ${stamp}`;
    const data = buildCommit(tree, opts.parents, authorLine, authorLine, opts.message);
    return this.putObject(repo, 'commit', data);
  }

  /** Apply file changes (content or null = delete) to a tree, building the new trees bottom-up. */
  treeWithChanges(repo: Repo, baseTree: string | null, changes: Map<string, Buffer | null>): string {
    const flat = baseTree === null ? new Map<string, string>() : flattenTree(baseTree, (oid) => this.getObject(repo, oid));
    for (const [path, content] of changes) {
      if (content === null) flat.delete(path);
      else flat.set(path, this.putObject(repo, 'blob', content));
    }
    // Rebuild nested trees from the flat map.
    const buildDir = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const direct = new Map<string, string>();
      const subdirs = new Map<string, string[]>();
      for (const [path, oid] of flat) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) direct.set(rest, oid);
        else {
          const dir = rest.slice(0, slash);
          const list = subdirs.get(dir) ?? [];
          list.push(path);
          subdirs.set(dir, list);
        }
      }
      for (const [name, oid] of [...direct.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        entries.push({ mode: '100644', name, oid });
      }
      for (const name of [...subdirs.keys()].sort()) {
        entries.push({ mode: '40000', name, oid: buildDir(prefix === '' ? name : `${prefix}/${name}`) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return buildDir('');
  }

  /** Apply a set of path->blob changes on top of an existing tree and return the new tree oid. */
  applyChangesToTree(repo: Repo, baseTree: string, changes: Map<string, Buffer | null>): string {
    return this.treeWithChanges(repo, baseTree, changes);
  }

  commitTree(repo: Repo, commitOid: string): string | null {
    const obj = this.getObject(repo, commitOid);
    if (obj === undefined || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  // --------------------------------------------------------------------- issues & PRs

  createIssue(repo: Repo, user: StoreUser, title: string, body: string, labels: string[]): Issue | { error: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: `Label does not exist: ${label}` };
    }
    const seq = this.tick();
    const issue: Issue = {
      number: repo.nextNumber,
      id: this.tick(),
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      user,
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPullRequest(
    repo: Repo,
    user: StoreUser,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): PullRequest | { error: string } {
    const headTip = repo.refs.get(`refs/heads/${headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
    if (headTip === undefined) return { error: `Head branch does not exist: ${headRef}` };
    if (baseTip === undefined) return { error: `Base branch does not exist: ${baseRef}` };
    const seq = this.tick();
    const pr: PullRequest = {
      number: repo.nextNumber,
      id: this.tick(),
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAtSeq: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha: headTip,
      baseSha: baseTip,
      user,
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pr.number, pr);
    return pr;
  }

  /** The file diff between a pull request's base tip and its head tip. */
  pullFiles(repo: Repo, pr: PullRequest): { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] {
    const baseTree = this.commitTree(repo, pr.baseSha);
    const headTree = this.commitTree(repo, pr.headSha);
    const changes = diffTrees(baseTree, headTree, (oid) => this.getObject(repo, oid));
    return changes.map((change) => {
      const oldData = change.oldOid === null ? null : (this.getObject(repo, change.oldOid)?.data ?? null);
      const newData = change.newOid === null ? null : (this.getObject(repo, change.newOid)?.data ?? null);
      const counts = lineDiff(oldData, newData);
      return { filename: change.path, status: change.status, additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions };
    });
  }

  /** 'MERGEABLE' when the head applies cleanly onto the current base tip, else 'CONFLICTING'. */
  pullMergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
    if (pr.state !== 'open') return 'MERGEABLE';
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (baseTip === undefined) return 'CONFLICTING';
    const headTree = this.commitTree(repo, pr.headSha);
    const baseTree = this.commitTree(repo, baseTip);
    const baseAtPrTime = this.commitTree(repo, pr.baseSha);
    const ancestor = mergeBase(pr.headSha, baseTip, (oid) => this.getObject(repo, oid));
    const ancestorTree = ancestor === null ? null : this.commitTree(repo, ancestor);
    const headChanges = diffTrees(ancestorTree, headTree, (oid) => this.getObject(repo, oid));
    const baseChanges = diffTrees(ancestorTree, baseTree, (oid) => this.getObject(repo, oid));
    const baseByPath = new Map(baseChanges.map((c) => [c.path, c]));
    for (const change of headChanges) {
      const onBase = baseByPath.get(change.path);
      if (onBase === undefined) continue;
      // Both sides changed this path: a conflict unless the base ended up identical to the head.
      if (onBase.newOid !== change.newOid) return 'CONFLICTING';
    }
    void baseAtPrTime;
    return 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request onto its base branch: one commit whose parent is the base tip and
   * whose tree is the base tree plus the head's changes. Returns the merge commit oid, or null
   * when the merge conflicts.
   */
  mergePullRequest(repo: Repo, pr: PullRequest, user: StoreUser): string | null {
    if (pr.state !== 'open') return null;
    if (this.pullMergeable(repo, pr) === 'CONFLICTING') return null;
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (baseTip === undefined) return null;
    const baseTree = this.commitTree(repo, baseTip);
    if (baseTree === null) return null;
    const ancestor = mergeBase(pr.headSha, baseTip, (oid) => this.getObject(repo, oid));
    const ancestorTree = ancestor === null ? null : this.commitTree(repo, ancestor);
    const headTree = this.commitTree(repo, pr.headSha);
    const headChanges = diffTrees(ancestorTree, headTree, (oid) => this.getObject(repo, oid));
    const changes = new Map<string, Buffer | null>();
    for (const change of headChanges) {
      if (change.newOid === null) changes.set(change.path, null);
      else {
        const data = this.getObject(repo, change.newOid)?.data;
        if (data === undefined) return null;
        changes.set(change.path, data);
      }
    }
    const newTree = this.applyChangesToTree(repo, baseTree, changes);
    const seq = this.tick();
    const stamp = `${SCENARIO_EPOCH_SEC + seq} +0000`;
    const authorLine = `${user.name} <${user.email}> ${stamp}`;
    const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}\n\n${pr.title}`;
    const commit = this.putObject(repo, 'commit', buildCommit(newTree, [baseTip], authorLine, authorLine, message));
    repo.refs.set(`refs/heads/${pr.baseRef}`, commit);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAtSeq = seq;
    pr.mergeCommitSha = commit;
    pr.updatedSeq = seq;
    return commit;
  }

  /** Create an annotated tag object pointing at `target`. */
  createTag(repo: Repo, user: StoreUser, name: string, target: string, message: string): string {
    const targetObj = this.getObject(repo, target);
    const type: ObjectType = targetObj?.type ?? 'commit';
    const seq = this.tick();
    const stamp = `${SCENARIO_EPOCH_SEC + seq} +0000`;
    const tagger = `${user.name} <${user.email}> ${stamp}`;
    return this.putObject(repo, 'tag', buildTag(target, type, name, tagger, message));
  }

  // --------------------------------------------------------------------- reachability helpers

  reachableFrom(repo: Repo, roots: readonly string[]): Set<string> {
    return collectReachable(roots, (oid) => this.getObject(repo, oid));
  }

  /** Objects reachable from `roots`, as full objects, sorted by oid (for pack writing). */
  reachableObjects(repo: Repo, roots: readonly string[]): { oid: string; type: ObjectType; data: Buffer }[] {
    const ids = this.reachableFrom(repo, roots);
    const out: { oid: string; type: ObjectType; data: Buffer }[] = [];
    for (const oid of ids) {
      const obj = this.getObject(repo, oid);
      if (obj !== undefined) out.push({ oid, type: obj.type, data: obj.data });
    }
    out.sort((a, b) => (a.oid < b.oid ? -1 : 1));
    return out;
  }

  isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
    return isAncestor(ancestor, oid, (id) => this.getObject(repo, id));
  }

  firstParentChain(repo: Repo, tip: string): string[] {
    return firstParentChain(tip, (id) => this.getObject(repo, id));
  }
}

// --------------------------------------------------------------------------- global ids

/** An opaque, stable global id: base64 of "gh:<type>:<key>" — never the plain number. */
export function globalId(type: string, key: string): string {
  return Buffer.from(`gh:${type}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const match = /^gh:([^:]+):(.+)$/.exec(decoded);
    if (match === null) return null;
    return { type: match[1] as string, key: match[2] as string };
  } catch {
    return null;
  }
}

/** A cursor for issue pagination: base64 of "cursor:<repoId>:<lastNumber>". */
export function issueCursor(repoId: number, number: number): string {
  return Buffer.from(`cursor:${repoId}:${number}`, 'utf8').toString('base64');
}

export function parseIssueCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:\d+:(\d+)$/.exec(decoded);
    return match === null ? null : parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

export type { ScenarioUser };
