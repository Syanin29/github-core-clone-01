// git.ts — the smart-HTTP git transport, implemented from the protocol up.
//
// Endpoints, all under /<owner>/<repo>.git:
//   GET  /info/refs?service=git-upload-pack|git-receive-pack   advertisement (v0 or v2)
//   POST /git-upload-pack                                      ls-refs / fetch (v2 or v0)
//   POST /git-receive-pack                                     push (pack + fast-forward report)
//
// Packfiles are written plain (no deltas) and read with OFS/REF delta support. A push that
// fails a check is reported per-ref as `ng` — never as an HTTP error — because a refused update
// is a successful exchange. A malformed body is answered 400 and the server stays up.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { NAME_RE, type Repo, type Store } from './store.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLines,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  writePack,
  type GitObject,
  type ObjectType,
} from './gitproto.ts';

const UPLOAD_CAPS = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow';
const RECEIVE_CAPS = 'symref=HEAD:refs/heads/main report-status side-band-64k delete-refs ofs-delta';

export function parseGitPath(pathname: string): { owner: string; repo: string; rest: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
  if (match === null) return null;
  const owner = match[1] as string;
  const repo = match[2] as string;
  const rest = match[3] as string;
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;
  return { owner, repo, rest };
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': String(body.length), 'X-GitHub-Request-Id': requestId });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  sendBuffer(res, status, 'application/json', Buffer.from(JSON.stringify(body), 'utf8'), requestId);
}

/** Wrap bytes into sideband packets (band 1 = data), chunked under the pkt-line limit. */
export function sidebandPackets(data: Buffer, band: number): Buffer[] {
  const out: Buffer[] = [];
  const maxChunk = 65515;
  for (let pos = 0; pos < data.length; pos += maxChunk) {
    const chunk = data.subarray(pos, Math.min(pos + maxChunk, data.length));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    out.push(pktLine(payload));
  }
  return out;
}

// --------------------------------------------------------------------------- advertisement

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headLine = headTip !== undefined ? `${headTip} HEAD\0${caps}\n` : null;
    if (headLine !== null) parts.push(pktLine(headLine));
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const commit = peelTagToCommit(repo, oid);
        if (commit !== null) parts.push(pktLine(`${commit} ${ref}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function peelTagToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(current);
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

function v2Advertisement(): Buffer {
  return encodePktLines(['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'flush']);
}

export function handleInfoRefs(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, service: string, requestId: string): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return;
  }
  const protocol = (req.headers['git-protocol'] ?? '') as string;
  if (service === 'git-upload-pack' && protocol === 'version=2') {
    sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement(), requestId);
    return;
  }
  sendBuffer(res, 200, `application/x-${service}-advertisement`, v0Advertisement(repo, service), requestId);
}

// --------------------------------------------------------------------------- fetch computation

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

interface FetchResult {
  objects: { oid: string; type: ObjectType; data: Buffer }[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Which objects a fetch sends: the depth-limited closure of the wants, minus the closure of the
 * haves (truncated at the request's shallow boundary commits, whose own trees are still sent).
 */
export function computeFetch(repo: Repo, plan: FetchPlan): FetchResult {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const depthLimit = plan.deepen ?? Number.POSITIVE_INFINITY;
  const wantSet = new Set<string>();
  const sentCommits = new Set<string>();
  const boundaryCommits = new Set<string>();

  const addClosure = (oid: string): void => {
    for (const id of collectReachable([oid], lookup)) wantSet.add(id);
  };

  const walkCommit = (oid: string, depth: number): void => {
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') return;
    if (sentCommits.has(oid)) return;
    sentCommits.add(oid);
    wantSet.add(oid);
    addClosure(parseCommit(obj.data).tree);
    if (depth >= depthLimit) {
      boundaryCommits.add(oid);
      return;
    }
    for (const parent of parseCommit(obj.data).parents) walkCommit(parent, depth + 1);
  };

  const walkWant = (oid: string): void => {
    const obj = lookup(oid);
    if (obj === undefined) return;
    if (obj.type === 'tag') {
      wantSet.add(oid);
      walkWant(parseTag(obj.data).object);
      return;
    }
    if (obj.type === 'commit') {
      walkCommit(oid, 1);
      return;
    }
    addClosure(oid);
  };
  for (const want of plan.wants) walkWant(want);

  // Base: full closure of the haves, stopping at the request's shallow boundaries.
  const baseSet = new Set<string>();
  const shallowSet = new Set(plan.shallow);
  const baseStack: string[] = [...plan.haves];
  const baseSeen = new Set<string>();
  while (baseStack.length > 0) {
    const oid = baseStack.pop() as string;
    if (baseSeen.has(oid) || oid === ZERO_OID) continue;
    baseSeen.add(oid);
    const obj = lookup(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      const parts = parseCommit(obj.data);
      for (const id of collectReachable([parts.tree], lookup)) baseSet.add(id);
      baseSet.add(oid);
      if (!shallowSet.has(oid)) {
        for (const parent of parts.parents) baseStack.push(parent);
      }
    } else if (obj.type === 'tag') {
      baseSet.add(oid);
      baseStack.push(parseTag(obj.data).object);
    } else {
      for (const id of collectReachable([oid], lookup)) baseSet.add(id);
    }
  }

  const send: { oid: string; type: ObjectType; data: Buffer }[] = [];
  for (const oid of wantSet) {
    if (baseSet.has(oid)) continue;
    const obj = lookup(oid);
    if (obj !== undefined) send.push({ oid, type: obj.type, data: obj.data });
  }
  send.sort((a, b) => (a.oid < b.oid ? -1 : 1));

  const sendSet = new Set(send.map((o) => o.oid));
  const shallow: string[] = [];
  for (const oid of boundaryCommits) {
    if (!sendSet.has(oid)) continue;
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((p) => lookup(p) !== undefined && !sendSet.has(p))) shallow.push(oid);
  }
  shallow.sort();
  const unshallow: string[] = [];
  for (const oid of plan.shallow) {
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((p) => sendSet.has(p))) unshallow.push(oid);
  }
  unshallow.sort();
  return { objects: send, shallow, unshallow };
}

// --------------------------------------------------------------------------- upload-pack

function lsRefsLines(repo: Repo, opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): string[] {
  const lines: string[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const headRef = 'HEAD';
  const matches = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  if (headTip !== undefined && matches(headRef)) {
    lines.push(opts.symrefs ? `${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}` : `${headTip} HEAD`);
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) {
    if (!matches(ref)) continue;
    const obj = repo.objects.get(oid);
    let line = `${oid} ${ref}`;
    if (opts.peel && obj !== undefined && obj.type === 'tag') {
      const commit = peelTagToCommit(repo, oid);
      if (commit !== null) line += ` peeled:${commit}`;
    }
    lines.push(line);
  }
  if (refs.length === 0 && opts.unborn) {
    lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
  }
  return lines;
}

function respondV2Fetch(res: ServerResponse, repo: Repo, plan: FetchPlan, requestId: string): void {
  const result = computeFetch(repo, plan);
  const parts: Buffer[] = [];
  if (plan.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM);
  }
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (result.objects.length > 0) {
    const pack = writePack(result.objects);
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack, 1));
  }
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts), requestId);
}

function respondV0Fetch(res: ServerResponse, repo: Repo, plan: FetchPlan, requestId: string): void {
  const result = computeFetch(repo, plan);
  const parts: Buffer[] = [];
  if (plan.haves.length > 0) parts.push(pktLine('NAK\n'));
  for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (result.objects.length > 0) {
    parts.push(...sidebandPackets(writePack(result.objects), 1));
  }
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts), requestId);
}

export function handleUploadPack(store: Store, res: ServerResponse, owner: string, repoName: string, body: Buffer, requestId: string): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return;
  }
  let packets;
  try {
    packets = decodePktLines(body).packets;
  } catch {
    sendBuffer(res, 400, 'text/plain', Buffer.from('Bad Request', 'utf8'), requestId);
    return;
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  if (lines.length === 0) {
    sendBuffer(res, 400, 'text/plain', Buffer.from('Bad Request', 'utf8'), requestId);
    return;
  }
  const first = (lines[0] as string).trim();
  if (first.startsWith('command=ls-refs')) {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const line of lines.slice(1)) {
      const text = line.trim();
      if (text === 'peel') peel = true;
      else if (text === 'symrefs') symrefs = true;
      else if (text === 'unborn') unborn = true;
      else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    }
    const out = lsRefsLines(repo, { peel, symrefs, unborn, prefixes });
    const parts = out.map((l) => pktLine(`${l}\n`));
    parts.push(PKT_FLUSH);
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts), requestId);
    return;
  }
  if (first.startsWith('command=fetch')) {
    const plan: FetchPlan = { wants: [], haves: [], shallow: [], deepen: null };
    for (const line of lines.slice(1)) {
      const text = line.trim();
      if (text.startsWith('want ')) {
        const oid = text.slice(5).split(' ')[0] as string;
        if (isObjectId(oid)) plan.wants.push(oid.toLowerCase());
      } else if (text.startsWith('have ')) {
        const oid = text.slice(5).trim();
        if (isObjectId(oid)) plan.haves.push(oid.toLowerCase());
      } else if (text.startsWith('shallow ')) {
        const oid = text.slice(8).trim();
        if (isObjectId(oid)) plan.shallow.push(oid.toLowerCase());
      } else if (text.startsWith('deepen ')) {
        const n = parseInt(text.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) plan.deepen = n;
      }
    }
    respondV2Fetch(res, repo, plan, requestId);
    return;
  }
  // v0 fetch: want / shallow / deepen / have / done lines in any order.
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], deepen: null };
  for (const line of lines) {
    const text = line.trim();
    const clean = text.includes('\0') ? (text.split('\0')[0] as string) : text;
    if (clean.startsWith('want ')) {
      const oid = clean.slice(5).split(' ')[0] as string;
      if (isObjectId(oid)) plan.wants.push(oid.toLowerCase());
    } else if (clean.startsWith('have ')) {
      const oid = clean.slice(5).trim();
      if (isObjectId(oid)) plan.haves.push(oid.toLowerCase());
    } else if (clean.startsWith('shallow ')) {
      const oid = clean.slice(8).trim();
      if (isObjectId(oid)) plan.shallow.push(oid.toLowerCase());
    } else if (clean.startsWith('deepen ')) {
      const n = parseInt(clean.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) plan.deepen = n;
    }
  }
  respondV0Fetch(res, repo, plan, requestId);
}

// --------------------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, res: ServerResponse, owner: string, repoName: string, body: Buffer, requestId: string): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return;
  }
  let decoded;
  try {
    decoded = decodePktLines(body, { allowTrailing: true });
  } catch {
    sendBuffer(res, 400, 'text/plain', Buffer.from('Bad Request', 'utf8'), requestId);
    return;
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).trim();
    if (nul >= 0) {
      const caps = text.slice(nul + 1).trim().split(/\s+/);
      if (caps.includes('side-band-64k')) sideband = true;
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match !== null) {
      commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    }
  }
  const packBytes = body.subarray(decoded.consumed);

  const report: string[] = [];
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }
  if (unpackError !== null) {
    report.push(`unpack ${unpackError}\n`);
  } else {
    report.push('unpack ok\n');
    for (const cmd of commands) {
      const outcome = applyPushCommand(store, repo, cmd);
      report.push(outcome === null ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${outcome}\n`);
    }
  }
  const reportBytes = encodePktLines(report.map((line) => line as string));
  let out: Buffer;
  if (sideband) {
    out = Buffer.concat([...sidebandPackets(reportBytes, 1), PKT_FLUSH]);
  } else {
    out = Buffer.concat([reportBytes, PKT_FLUSH]);
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', out, requestId);
}

/** Validate and apply one ref update. Returns null on success, else the ng reason. */
function applyPushCommand(store: Store, repo: Repo, cmd: PushCommand): string | null {
  const { oldOid, newOid, ref } = cmd;
  if (!/^refs\/(heads|tags)\/[A-Za-z0-9._\-/]+$/.test(ref)) return 'invalid ref';
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return 'remote ref does not exist';
    if (oldOid !== ZERO_OID && oldOid !== current) return 'non-fast-forward';
    repo.refs.delete(ref);
    return null;
  }
  const target = repo.objects.get(newOid);
  if (target === undefined) return 'object not found';
  const isBranch = ref.startsWith('refs/heads/');
  if (isBranch && target.type !== 'commit') return 'invalid object type';
  if (!isBranch && target.type !== 'commit' && target.type !== 'tag') return 'invalid object type';
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return 'already exists';
    repo.refs.set(ref, newOid);
    return null;
  }
  if (current === undefined) return 'remote ref does not exist';
  if (oldOid !== current) return 'non-fast-forward';
  if (isBranch && !isAncestor(oldOid, newOid, (oid) => repo.objects.get(oid))) return 'non-fast-forward';
  repo.refs.set(ref, newOid);
  return null;
}

export { flattenTree, hashObject };
