// graphql.ts — a small GraphQL executor for the shapes the suite and the github-mcp-server send.
//
// Supported: query/mutation operations with aliases, variables, inline enum lists and input
// objects, null variables, inline fragments, batched arrays. Introspection covers __type
// (fields / enumValues). Unknown fields are HTTP 200 with an errors array naming the field —
// a GraphQL-level failure is never an HTTP error (except 401, enforced by the router).
//
// Global ids are base64 of "gh:<type>:<key>" (see store.ts): opaque, stable, decodable by node()
// and the mutations. Cursors are base64 of "cursor:<repoId>:<lastNumber>".

import { VIEWER } from './scenario.ts';
import {
  globalId,
  issueCursor,
  parseGlobalId,
  parseIssueCursor,
  type Repo,
  type Store,
  type StoreUser,
} from './store.ts';

// --------------------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, Value>;
  selections: Selection[] | null;
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, Value | undefined>;
  selections: Selection[];
}

class Tokenizer {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos] as string)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  peek(): string | null {
    this.skipIgnored();
    if (this.pos >= this.text.length) return null;
    if (this.text.startsWith('...', this.pos)) return '...';
    const ch = this.text[this.pos] as string;
    if ('{}()[]:!=$@'.includes(ch)) return ch;
    if (ch === '"') return '"';
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (match !== null) return match[0];
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
    if (num !== null) return num[0];
    throw new Error(`graphql: unexpected character ${JSON.stringify(ch)}`);
  }

  next(): string {
    const token = this.peek();
    if (token === null) throw new Error('graphql: unexpected end of document');
    if (token === '...') {
      this.pos += 3;
      return token;
    }
    if (token === '"') {
      // A string literal: consume it whole and return its decoded value.
      this.pos += 1;
      let out = '';
      for (;;) {
        if (this.pos >= this.text.length) throw new Error('graphql: unterminated string');
        const ch = this.text[this.pos] as string;
        if (ch === '"') {
          this.pos += 1;
          return JSON.stringify(out);
        }
        if (ch === '\\') {
          const esc = this.text[this.pos + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(this.text.slice(this.pos + 2, this.pos + 6), 16));
            this.pos += 6;
          } else {
            out += map[esc] ?? esc;
            this.pos += 2;
          }
          continue;
        }
        out += ch;
        this.pos += 1;
      }
    }
    this.pos += token.length;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`graphql: expected ${JSON.stringify(token)}, got ${JSON.stringify(got)}`);
  }
}

function parseDocument(text: string): Operation[] {
  const tz = new Tokenizer(text);
  const operations: Operation[] = [];
  for (;;) {
    const token = tz.peek();
    if (token === null) break;
    let kind: 'query' | 'mutation' = 'query';
    if (token === 'query' || token === 'mutation') {
      kind = tz.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    const next = tz.peek();
    if (next !== null && next !== '(' && next !== '{' && /^[A-Za-z_]/.test(next)) {
      name = tz.next();
    }
    const variables: Record<string, Value | undefined> = {};
    if (tz.peek() === '(') {
      tz.next();
      while (tz.peek() !== ')') {
        tz.expect('$');
        const varName = tz.next();
        tz.expect(':');
        // Skip the type: names, brackets, ! — until ',' or ')' at depth 0.
        let depth = 0;
        for (;;) {
          const t = tz.peek();
          if (t === null) throw new Error('graphql: unterminated variable definitions');
          if (depth === 0 && (t === ',' || t === ')')) break;
          if (t === '[') depth += 1;
          if (t === ']') depth -= 1;
          if (t === '=') {
            tz.next();
            variables[varName] = parseValue(tz);
            break;
          }
          tz.next();
        }
        if (variables[varName] === undefined && !(varName in variables)) variables[varName] = undefined;
        if (tz.peek() === ',') tz.next();
      }
      tz.expect(')');
    }
    const selections = parseSelectionSet(tz);
    operations.push({ kind, name, variables, selections });
  }
  return operations;
}

function parseSelectionSet(tz: Tokenizer): Selection[] {
  tz.expect('{');
  const selections: Selection[] = [];
  while (tz.peek() !== '}') {
    if (tz.peek() === '...') {
      tz.next();
      const next = tz.peek();
      if (next === 'on') {
        tz.next();
        const typeCondition = tz.next();
        selections.push({ kind: 'fragment', typeCondition, selections: parseSelectionSet(tz) });
      } else if (next === '{') {
        selections.push({ kind: 'fragment', typeCondition: null, selections: parseSelectionSet(tz) });
      } else {
        throw new Error('graphql: named fragments are not supported');
      }
      continue;
    }
    const first = tz.next();
    let alias: string | null = null;
    let name = first;
    if (tz.peek() === ':') {
      tz.next();
      alias = first;
      name = tz.next();
    }
    const args: Record<string, Value> = {};
    if (tz.peek() === '(') {
      tz.next();
      while (tz.peek() !== ')') {
        const argName = tz.next();
        tz.expect(':');
        args[argName] = parseValue(tz);
        if (tz.peek() === ',') tz.next();
      }
      tz.expect(')');
    }
    // Directives: parsed and ignored.
    while (tz.peek() === '@') {
      tz.next();
      tz.next();
      if (tz.peek() === '(') {
        tz.next();
        let depth = 1;
        while (depth > 0) {
          const t = tz.next();
          if (t === '(' || t === '[' || t === '{') depth += 1;
          if (t === ')' || t === ']' || t === '}') depth -= 1;
        }
      }
    }
    const subSelections = tz.peek() === '{' ? parseSelectionSet(tz) : null;
    selections.push({ kind: 'field', name, alias, args, selections: subSelections });
  }
  tz.expect('}');
  return selections;
}

function parseValue(tz: Tokenizer): Value {
  const token = tz.peek();
  if (token === null) throw new Error('graphql: expected a value');
  if (token === '$') {
    tz.next();
    return { kind: 'variable', name: tz.next() };
  }
  if (token === '[') {
    tz.next();
    const values: Value[] = [];
    while (tz.peek() !== ']') {
      values.push(parseValue(tz));
      if (tz.peek() === ',') tz.next();
    }
    tz.expect(']');
    return { kind: 'list', values };
  }
  if (token === '{') {
    tz.next();
    const fields: Record<string, Value> = {};
    while (tz.peek() !== '}') {
      const name = tz.next();
      tz.expect(':');
      fields[name] = parseValue(tz);
      if (tz.peek() === ',') tz.next();
    }
    tz.expect('}');
    return { kind: 'object', fields };
  }
  if (token.startsWith('"')) {
    const raw = tz.next();
    return { kind: 'string', value: JSON.parse(raw) as string };
  }
  if (/^-?\d+$/.test(token)) {
    tz.next();
    return { kind: 'int', value: parseInt(token, 10) };
  }
  if (/^-?\d+\.\d+/.test(token)) {
    tz.next();
    return { kind: 'float', value: parseFloat(token) };
  }
  tz.next();
  if (token === 'true') return { kind: 'boolean', value: true };
  if (token === 'false') return { kind: 'boolean', value: false };
  if (token === 'null') return { kind: 'null' };
  return { kind: 'enum', value: token };
}

// --------------------------------------------------------------------------- execution

export interface GraphQLContext {
  store: Store;
  user: StoreUser;
  baseUrl: string;
}

type Resolver = (parent: GqlObject, args: Record<string, unknown>, ctx: GraphQLContext) => unknown;
type GqlObject = Record<string, unknown> & { __typename: string };

const FIELD_LISTS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'headRefOid', 'baseRefOid'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'private', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email', 'url'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  Ref: ['name', 'prefix'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

function userObject(user: StoreUser): GqlObject {
  return { __typename: 'User', login: user.login, id: user.id, name: user.name, email: user.email };
}

function ownerObject(login: string): GqlObject {
  if (login === VIEWER.login) return userObject({ id: VIEWER.id, login: VIEWER.login, name: VIEWER.name, email: VIEWER.email });
  const hash = [...login].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return { __typename: 'User', login, id: 3000 + (hash % 900), name: login, email: `${login}@example.invalid` };
}

function repoObject(ctx: GraphQLContext, repo: Repo): GqlObject {
  return { __typename: 'Repository', __repo: repo, id: globalId('Repository', String(repo.id)) };
}

function issueObject(ctx: GraphQLContext, repo: Repo, issue: import('./store.ts').Issue): GqlObject {
  return { __typename: 'Issue', __repo: repo, __issue: issue, id: globalId('Issue', `${repo.id}:${issue.number}`) };
}

function pullObject(ctx: GraphQLContext, repo: Repo, pr: import('./store.ts').PullRequest): GqlObject {
  return { __typename: 'PullRequest', __repo: repo, __pr: pr, id: globalId('PullRequest', `${repo.id}:${pr.number}`) };
}

function commentObject(ctx: GraphQLContext, repo: Repo, issue: import('./store.ts').Issue, comment: import('./store.ts').IssueComment): GqlObject {
  return { __typename: 'IssueComment', __repo: repo, __issue: issue, __comment: comment, id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`) };
}

function pageInfoObject(hasNextPage: boolean, endCursor: string | null, hasPreviousPage: boolean, startCursor: string | null): GqlObject {
  return { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage, startCursor };
}

const resolvers: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_parent, _args, ctx) => userObject(ctx.user),
    repository: (_parent, args, ctx) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (repo === undefined) return null;
      if (!ctx.store.canRead(ctx.user, repo)) return null;
      return repoObject(ctx, repo);
    },
    node: (_parent, args, ctx) => {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (parsed === null) return null;
      if (parsed.type === 'Repository') {
        const repo = ctx.store.listAllRepos().find((r) => String(r.id) === parsed.key);
        if (repo === undefined || !ctx.store.canRead(ctx.user, repo)) return null;
        return repoObject(ctx, repo);
      }
      if (parsed.type === 'Issue') {
        const [repoId, number] = parsed.key.split(':');
        const repo = findRepoById(ctx, Number(repoId));
        if (repo === undefined) return null;
        const issue = repo.issues.get(Number(number));
        return issue === undefined ? null : issueObject(ctx, repo, issue);
      }
      if (parsed.type === 'PullRequest') {
        const [repoId, number] = parsed.key.split(':');
        const repo = findRepoById(ctx, Number(repoId));
        if (repo === undefined) return null;
        const pr = repo.pulls.get(Number(number));
        return pr === undefined ? null : pullObject(ctx, repo, pr);
      }
      return null;
    },
    __type: (_parent, args) => {
      const name = String(args.name ?? '');
      if (FIELD_LISTS[name] !== undefined) {
        return {
          __typename: '__Type',
          name,
          kind: 'OBJECT',
          fields: FIELD_LISTS[name]?.map((f) => ({ __typename: '__Field', name: f })) ?? null,
          enumValues: null,
        };
      }
      if (ENUM_VALUES[name] !== undefined) {
        return {
          __typename: '__Type',
          name,
          kind: 'ENUM',
          fields: null,
          enumValues: ENUM_VALUES[name]?.map((v) => ({ __typename: '__EnumValue', name: v })) ?? null,
        };
      }
      return null;
    },
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoById(ctx, Number((parseGlobalId(String(input.repositoryId ?? ''))?.key ?? '') || '0'));
      if (repo === undefined) throw new Error('Repository not found');
      const created = ctx.store.createIssue(repo, ctx.user, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      if ('error' in created) throw new Error(created.error);
      return { __typename: 'CreateIssuePayload', issue: issueObject(ctx, repo, created) };
    },
    closeIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      if (parsed === null || parsed.type !== 'Issue') throw new Error('Issue not found');
      const [repoId, number] = parsed.key.split(':');
      const repo = findRepoById(ctx, Number(repoId));
      const issue = repo?.issues.get(Number(number));
      if (issue === undefined) throw new Error('Issue not found');
      issue.state = 'closed';
      issue.updatedSeq = ctx.store.tick();
      return { __typename: 'CloseIssuePayload', issue: issueObject(ctx, repo as Repo, issue) };
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoById(ctx, Number((parseGlobalId(String(input.repositoryId ?? ''))?.key ?? '') || '0'));
      if (repo === undefined) throw new Error('Repository not found');
      const created = ctx.store.createPullRequest(
        repo,
        ctx.user,
        String(input.title ?? ''),
        typeof input.body === 'string' ? input.body : '',
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in created) throw new Error(created.error);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(ctx, repo, created) };
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      if (parsed === null || parsed.type !== 'PullRequest') throw new Error('Pull request not found');
      const [repoId, number] = parsed.key.split(':');
      const repo = findRepoById(ctx, Number(repoId));
      const pr = repo?.pulls.get(Number(number));
      if (pr === undefined || repo === undefined) throw new Error('Pull request not found');
      if (pr.state !== 'open') throw new Error('Pull request is not open');
      const sha = ctx.store.mergePullRequest(repo, pr, ctx.user);
      if (sha === null) throw new Error('Merge conflict');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(ctx, repo, pr) };
    },
    addComment: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      if (parsed === null || parsed.type !== 'Issue') throw new Error('Subject not found');
      const [repoId, number] = parsed.key.split(':');
      const repo = findRepoById(ctx, Number(repoId));
      const issue = repo?.issues.get(Number(number));
      if (issue === undefined || repo === undefined) throw new Error('Issue not found');
      const comment = { id: repo.nextCommentId, body: String(input.body ?? ''), user: ctx.user, createdSeq: ctx.store.tick() };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node: commentObject(ctx, repo, issue, comment) } };
    },
  },
  Repository: {
    id: (parent) => parent.id,
    databaseId: (parent) => (parent.__repo as Repo).id,
    name: (parent) => (parent.__repo as Repo).name,
    nameWithOwner: (parent) => `${(parent.__repo as Repo).owner}/${(parent.__repo as Repo).name}`,
    owner: (parent) => ownerObject((parent.__repo as Repo).owner),
    defaultBranchRef: (parent) => {
      const repo = parent.__repo as Repo;
      if (!repo.refs.has(`refs/heads/${repo.defaultBranch}`)) return null;
      return { __typename: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (parent) => (parent.__repo as Repo).description,
    private: (parent) => (parent.__repo as Repo).isPrivate,
    url: (parent, _args, ctx) => `${ctx.baseUrl}/${(parent.__repo as Repo).owner}/${(parent.__repo as Repo).name}`,
    createdAt: (parent, _args, ctx) => ctx.store.stamp((parent.__repo as Repo).createdSeq),
    updatedAt: (parent, _args, ctx) => ctx.store.stamp((parent.__repo as Repo).createdSeq),
    issue: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueObject(ctx, repo, issue);
    },
    issues: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      let issues = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (states !== undefined) {
        const wanted = new Set(states.map((s) => s.toLowerCase()));
        issues = issues.filter((i) => wanted.has(i.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
      issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
      const after = typeof args.after === 'string' ? parseIssueCursor(args.after) : null;
      if (after !== null) {
        issues = direction === 'DESC' ? issues.filter((i) => i.number < after) : issues.filter((i) => i.number > after);
      }
      const first = typeof args.first === 'number' ? args.first : issues.length;
      const page = issues.slice(0, first);
      const hasNext = issues.length > page.length;
      const endCursor = page.length > 0 ? issueCursor(repo.id, (page[page.length - 1] as import('./store.ts').Issue).number) : null;
      const startCursor = page.length > 0 ? issueCursor(repo.id, (page[0] as import('./store.ts').Issue).number) : null;
      return {
        __typename: 'IssueConnection',
        nodes: page.map((issue) => issueObject(ctx, repo, issue)),
        pageInfo: pageInfoObject(hasNext, endCursor, false, startCursor),
        totalCount: repo.issues.size,
      };
    },
    pullRequest: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      const pr = repo.pulls.get(Number(args.number));
      return pr === undefined ? null : pullObject(ctx, repo, pr);
    },
    pullRequests: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      let pulls = [...repo.pulls.values()].filter((p) => p.state === 'open');
      pulls.sort((a, b) => a.number - b.number);
      const first = typeof args.first === 'number' ? args.first : pulls.length;
      const page = pulls.slice(0, first);
      const hasNext = pulls.length > page.length;
      return {
        __typename: 'PullRequestConnection',
        nodes: page.map((pr) => pullObject(ctx, repo, pr)),
        pageInfo: pageInfoObject(hasNext, null, false, null),
        totalCount: pulls.length,
      };
    },
  },
  Issue: {
    id: (parent) => parent.id,
    databaseId: (parent) => (parent.__issue as import('./store.ts').Issue).id,
    number: (parent) => (parent.__issue as import('./store.ts').Issue).number,
    title: (parent) => (parent.__issue as import('./store.ts').Issue).title,
    body: (parent) => (parent.__issue as import('./store.ts').Issue).body,
    state: (parent) => ((parent.__issue as import('./store.ts').Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    url: (parent, _args, ctx) => `${ctx.baseUrl}/${(parent.__repo as Repo).owner}/${(parent.__repo as Repo).name}/issues/${(parent.__issue as import('./store.ts').Issue).number}`,
    createdAt: (parent, _args, ctx) => ctx.store.stamp((parent.__issue as import('./store.ts').Issue).createdSeq),
    updatedAt: (parent, _args, ctx) => ctx.store.stamp((parent.__issue as import('./store.ts').Issue).updatedSeq),
    author: (parent) => userObject((parent.__issue as import('./store.ts').Issue).user),
    labels: (parent, _args, ctx) => ({
      __typename: 'LabelConnection',
      nodes: (parent.__issue as import('./store.ts').Issue).labels.map((name) => ({ __typename: 'Label', name })),
    }),
    comments: (parent, args, ctx) => {
      const issue = parent.__issue as import('./store.ts').Issue;
      const repo = parent.__repo as Repo;
      const first = typeof args.first === 'number' ? args.first : issue.comments.length;
      return {
        __typename: 'IssueCommentConnection',
        nodes: issue.comments.slice(0, first).map((c) => commentObject(ctx, repo, issue, c)),
        pageInfo: pageInfoObject(issue.comments.length > first, null, false, null),
        totalCount: issue.comments.length,
      };
    },
  },
  PullRequest: {
    id: (parent) => parent.id,
    databaseId: (parent) => (parent.__pr as import('./store.ts').PullRequest).id,
    number: (parent) => (parent.__pr as import('./store.ts').PullRequest).number,
    title: (parent) => (parent.__pr as import('./store.ts').PullRequest).title,
    body: (parent) => (parent.__pr as import('./store.ts').PullRequest).body,
    state: (parent) => {
      const pr = parent.__pr as import('./store.ts').PullRequest;
      if (pr.merged) return 'MERGED';
      return pr.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    headRefName: (parent) => (parent.__pr as import('./store.ts').PullRequest).headRef,
    baseRefName: (parent) => (parent.__pr as import('./store.ts').PullRequest).baseRef,
    mergeable: (parent, _args, ctx) => ctx.store.pullMergeable(parent.__repo as Repo, parent.__pr as import('./store.ts').PullRequest),
    merged: (parent) => (parent.__pr as import('./store.ts').PullRequest).merged,
    url: (parent, _args, ctx) => `${ctx.baseUrl}/${(parent.__repo as Repo).owner}/${(parent.__repo as Repo).name}/pull/${(parent.__pr as import('./store.ts').PullRequest).number}`,
    createdAt: (parent, _args, ctx) => ctx.store.stamp((parent.__pr as import('./store.ts').PullRequest).createdSeq),
    updatedAt: (parent, _args, ctx) => ctx.store.stamp((parent.__pr as import('./store.ts').PullRequest).updatedSeq),
    author: (parent) => userObject((parent.__pr as import('./store.ts').PullRequest).user),
    headRefOid: (parent) => (parent.__pr as import('./store.ts').PullRequest).headSha,
    baseRefOid: (parent) => (parent.__pr as import('./store.ts').PullRequest).baseSha,
    files: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      const pr = parent.__pr as import('./store.ts').PullRequest;
      const files = ctx.store.pullFiles(repo, pr);
      const first = typeof args.first === 'number' ? args.first : files.length;
      const page = files.slice(0, first);
      return {
        __typename: 'PullRequestFileConnection',
        nodes: page.map((f) => ({ __typename: 'PullRequestFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() })),
        pageInfo: pageInfoObject(files.length > page.length, null, false, null),
        totalCount: files.length,
      };
    },
  },
  User: {
    id: (parent) => parent.id,
    login: (parent) => parent.login,
    name: (parent) => parent.name,
    email: (parent) => parent.email,
    url: (parent, _args, ctx) => `${ctx.baseUrl}/${String(parent.login)}`,
  },
  Ref: {
    name: (parent) => parent.name,
    prefix: () => 'refs/heads/',
  },
  IssueConnection: {
    nodes: (parent) => parent.nodes,
    pageInfo: (parent) => parent.pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  PullRequestConnection: {
    nodes: (parent) => parent.nodes,
    pageInfo: (parent) => parent.pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  PullRequestFileConnection: {
    nodes: (parent) => parent.nodes,
    pageInfo: (parent) => parent.pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  IssueCommentConnection: {
    nodes: (parent) => parent.nodes,
    pageInfo: (parent) => parent.pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  LabelConnection: {
    nodes: (parent) => parent.nodes,
  },
  Label: {
    name: (parent) => parent.name,
  },
  IssueComment: {
    id: (parent) => parent.id,
    databaseId: (parent) => (parent.__comment as import('./store.ts').IssueComment).id,
    body: (parent) => (parent.__comment as import('./store.ts').IssueComment).body,
    author: (parent) => userObject((parent.__comment as import('./store.ts').IssueComment).user),
    createdAt: (parent, _args, ctx) => ctx.store.stamp((parent.__comment as import('./store.ts').IssueComment).createdSeq),
    updatedAt: (parent, _args, ctx) => ctx.store.stamp((parent.__comment as import('./store.ts').IssueComment).createdSeq),
  },
  IssueCommentEdge: {
    node: (parent) => parent.node,
  },
  PullRequestFile: {
    path: (parent) => parent.path,
    additions: (parent) => parent.additions,
    deletions: (parent) => parent.deletions,
    changeType: (parent) => parent.changeType,
  },
  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage,
    endCursor: (parent) => parent.endCursor,
    hasPreviousPage: (parent) => parent.hasPreviousPage,
    startCursor: (parent) => parent.startCursor,
  },
  __Type: {
    name: (parent) => parent.name,
    kind: (parent) => parent.kind,
    fields: (parent) => parent.fields,
    enumValues: (parent) => parent.enumValues,
    description: () => null,
  },
  __Field: {
    name: (parent) => parent.name,
    description: () => null,
  },
  __EnumValue: {
    name: (parent) => parent.name,
    description: () => null,
  },
  CreateIssuePayload: { issue: (parent) => parent.issue },
  CloseIssuePayload: { issue: (parent) => parent.issue },
  CreatePullRequestPayload: { pullRequest: (parent) => parent.pullRequest },
  MergePullRequestPayload: { pullRequest: (parent) => parent.pullRequest },
  AddCommentPayload: { commentEdge: (parent) => parent.commentEdge },
};

function findRepoById(ctx: GraphQLContext, id: number): Repo | undefined {
  return ctx.store.listAllRepos().find((r) => r.id === id);
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': {
      const v = variables[value.name];
      return v === undefined ? null : v;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value.fields)) out[key] = resolveValue(v, variables);
      return out;
    }
  }
}

interface ExecError {
  message: string;
}

function executeSelections(
  selections: Selection[],
  parent: GqlObject,
  parentType: string,
  variables: Record<string, unknown>,
  ctx: GraphQLContext,
  errors: ExecError[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
      const sub = executeSelections(selection.selections, parent, parentType, variables, ctx, errors);
      Object.assign(out, sub);
      continue;
    }
    const key = selection.alias ?? selection.name;
    const fieldResolvers = resolvers[parentType];
    const resolver = fieldResolvers?.[selection.name];
    if (resolver === undefined) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of Object.entries(selection.args)) {
      args[argName] = resolveValue(argValue, variables);
    }
    let value: unknown;
    try {
      value = resolver(parent, args, ctx);
    } catch (error) {
      errors.push({ message: error instanceof Error ? error.message : 'Field resolution failed' });
      out[key] = null;
      continue;
    }
    if (selection.selections !== null) {
      if (value === null || value === undefined) {
        out[key] = null;
      } else if (Array.isArray(value)) {
        out[key] = value.map((item) => {
          if (item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
            const obj = item as GqlObject;
            return executeSelections(selection.selections as Selection[], obj, obj.__typename, variables, ctx, errors);
          }
          return item;
        });
      } else if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
        const obj = value as GqlObject;
        out[key] = executeSelections(selection.selections, obj, obj.__typename, variables, ctx, errors);
      } else {
        errors.push({ message: `Field "${selection.name}" on type "${parentType}" does not return an object.` });
        out[key] = null;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function executeOperation(operation: Operation, requestVariables: Record<string, unknown>, ctx: GraphQLContext): { data?: Record<string, unknown>; errors?: ExecError[] } {
  const variables: Record<string, unknown> = { ...requestVariables };
  for (const [name, defaultValue] of Object.entries(operation.variables)) {
    if (variables[name] === undefined && defaultValue !== undefined) {
      variables[name] = resolveValue(defaultValue, {});
    }
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  const errors: ExecError[] = [];
  const data = executeSelections(operation.selections, root, rootType, variables, ctx, errors);
  const result: { data?: Record<string, unknown>; errors?: ExecError[] } = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}

/** Execute one GraphQL request body (a single operation or a batched array). */
export function handleGraphQL(ctx: GraphQLContext, body: unknown): unknown {
  const runOne = (item: unknown): { data?: Record<string, unknown>; errors?: ExecError[] } => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { errors: [{ message: 'Request body must be a JSON object with a query string.' }] };
    }
    const query = (item as Record<string, unknown>).query;
    if (typeof query !== 'string') {
      return { errors: [{ message: 'Request body must include a query string.' }] };
    }
    const variables = ((item as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
    let operations: Operation[];
    try {
      operations = parseDocument(query);
    } catch (error) {
      return { errors: [{ message: error instanceof Error ? error.message : 'Failed to parse the query.' }] };
    }
    if (operations.length === 0) {
      return { errors: [{ message: 'The document contains no operations.' }] };
    }
    const operationName = (item as Record<string, unknown>).operationName;
    let operation = operations[0] as Operation;
    if (typeof operationName === 'string') {
      const named = operations.find((op) => op.name === operationName);
      if (named !== undefined) operation = named;
    }
    return executeOperation(operation, variables, ctx);
  };
  if (Array.isArray(body)) return body.map((item) => runOne(item));
  return runOne(body);
}
