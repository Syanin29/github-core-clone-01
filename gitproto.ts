// gitproto.ts — the git object model and the smart-HTTP wire, implemented on node:zlib and
// node:crypto only. No git binary anywhere.
//
// Object model: blobs, trees, commits and annotated tags, each identified by the SHA-1 of
// "<type> <size>\0" + content. Packfiles are version 2, plain objects only (no deltas — the
// suite's client resolves deltas when a server sends them, and never requires them).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const PKT_LINE_MAX = 65520;

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of an object: SHA-1 of "<type> <byte length>\0" + content. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

// --------------------------------------------------------------------------- pkt-line

/** Encode one pkt-line (4 hex length bytes, length includes the 4). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const out = Buffer.alloc(len);
  out.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  body.copy(out, 4);
  return out;
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function encodePktLines(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

export type GitPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush'; raw: Buffer }
  | { kind: 'delim'; raw: Buffer }
  | { kind: 'response-end'; raw: Buffer };

/**
 * Decode a whole buffer of pkt-lines. Throws on a malformed line (a caller that must survive
 * garbage catches and answers 400 instead). `allowTrailing` lets a caller keep the bytes after
 * the flush packet (receive-pack's pack follows its command flush unframed).
 */
export function decodePktLines(
  bytes: Buffer,
  options: { allowTrailing?: boolean } = {},
): { packets: GitPacket[]; consumed: number } {
  const packets: GitPacket[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    if (pos + 4 > bytes.length) throw new Error('pkt-line: truncated length prefix');
    const head = bytes.subarray(pos, pos + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', raw: bytes.subarray(pos, pos + 4) });
      pos += 4;
      if (options.allowTrailing) return { packets, consumed: pos };
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', raw: bytes.subarray(pos, pos + 4) });
      pos += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'response-end', raw: bytes.subarray(pos, pos + 4) });
      pos += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || len > PKT_LINE_MAX) throw new Error(`pkt-line: bad length ${JSON.stringify(head)}`);
    if (pos + len > bytes.length) throw new Error('pkt-line: truncated packet');
    packets.push({ kind: 'data', payload: bytes.subarray(pos + 4, pos + len), raw: bytes.subarray(pos, pos + len) });
    pos += len;
  }
  return { packets, consumed: pos };
}

// --------------------------------------------------------------------------- objects

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) throw new Error('tree: entry has no mode');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree: entry has no oid');
    const mode = data.subarray(pos, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries, in git-canonical order (names sorted, directories as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  extra: string[];
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    else if (line !== '') extra.push(line);
  }
  return { tree, parents, author, committer, message, extra };
}

/** Build a commit object: "tree …\nparent …\nauthor …\ncommitter …\n\n<message>". */
export function buildCommit(tree: string, parents: readonly string[], author: string, committer: string, message: string): Buffer {
  let out = `tree ${tree}\n`;
  for (const parent of parents) out += `parent ${parent}\n`;
  out += `author ${author}\ncommitter ${committer}\n\n${message}`;
  return Buffer.from(out, 'utf8');
}

export interface TagParts {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(object: string, type: string, tag: string, tagger: string, message: string): Buffer {
  return Buffer.from(`object ${object}\ntype ${type}\ntag ${tag}\ntagger ${tagger}\n\n${message}`, 'utf8');
}

// --------------------------------------------------------------------------- reachability

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `roots`: commits walk parents and trees, tags walk their target,
 * trees walk entries. A missing object stops that branch (the caller decides whether that is an
 * error); the walk never loops.
 */
export function collectReachable(roots: readonly string[], lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const obj = lookup(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const parts = parseCommit(obj.data);
      stack.push(parts.tree);
      for (const parent of parts.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `oid` (or equal to it), following commit parents. */
export function isAncestor(ancestor: string, oid: string, lookup: ObjectLookup): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === ancestor) return true;
    if (seen.has(current) || current === ZERO_OID) continue;
    seen.add(current);
    const obj = lookup(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** The newest common commit of two tips (first-parent-aware BFS), or null when they share none. */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const cur = stackA.pop() as string;
    if (ancestorsA.has(cur) || cur === ZERO_OID) continue;
    ancestorsA.add(cur);
    const obj = lookup(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stackA.push(parent);
  }
  // Breadth-first from b so the first common commit is the newest one.
  const seenB = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (ancestorsA.has(cur)) return cur;
    if (seenB.has(cur) || cur === ZERO_OID) continue;
    seenB.add(cur);
    const obj = lookup(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

/** The first-parent chain from a tip, newest first. */
export function firstParentChain(tip: string, lookup: ObjectLookup): string[] {
  const out: string[] = [];
  let cur = tip;
  const seen = new Set<string>();
  while (cur !== ZERO_OID && !seen.has(cur)) {
    seen.add(cur);
    const obj = lookup(cur);
    if (obj === undefined || obj.type !== 'commit') break;
    out.push(cur);
    const parents = parseCommit(obj.data).parents;
    cur = parents[0] ?? ZERO_OID;
  }
  return out;
}

// --------------------------------------------------------------------------- packfile

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function encodeObjectHeader(type: ObjectType, size: number): Buffer {
  const typeCode = TYPE_CODES[type];
  const bytes: number[] = [];
  let first = (size & 0x0f) | (typeCode << 4);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** Build a version-2 packfile from plain objects (no deltas). Entries are sorted by oid. */
export function writePack(objects: readonly (GitObject & { oid: string })[]): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const obj of sorted) {
    parts.push(encodeObjectHeader(obj.type, obj.data.length));
    // Level 1: the pack only has to decompress to the right bytes (the client verifies the
    // SHA-1 of the inflated object, never the compressed size), so trade ratio for speed.
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

interface PackEntry {
  type: ObjectType;
  data: Buffer;
  oid: string;
}

/**
 * Read a version-2/3 packfile, resolving OFS_DELTA and REF_DELTA entries. Verifies the trailer
 * checksum and every object's recomputed id. Throws on any structural problem.
 *
 * A deflate stream's end is found by binary search: Node's inflateSync ignores trailing bytes,
 * so the smallest prefix that inflates to the declared size is exactly the stream.
 */
export function readPack(pack: Buffer, resolveBase?: ObjectLookup): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack: too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack: bad signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack: version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const expected = sha1Hex(pack.subarray(0, pack.length - 20));
  if (trailer.toString('hex') !== expected) throw new Error('pack: trailer checksum mismatch');

  // Pass 1: parse the entries in file order, recording raw deltas for pass 2.
  interface RawEntry {
    offset: number;
    type: ObjectType | 'ofs-delta' | 'ref-delta';
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  let pos = 12;
  const end = pack.length - 20;
  for (let i = 0; i < count; i += 1) {
    if (pos >= end) throw new Error('pack: truncated entries');
    const entryOffset = pos;
    let byte = pack[pos] as number;
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (pos >= end) throw new Error('pack: truncated size varint');
      byte = pack[pos] as number;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    let type: ObjectType | 'ofs-delta' | 'ref-delta';
    if (typeCode === 6) {
      type = 'ofs-delta';
      if (pos >= end) throw new Error('pack: truncated ofs-delta offset');
      byte = pack[pos] as number;
      pos += 1;
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        if (pos >= end) throw new Error('pack: truncated ofs-delta offset');
        byte = pack[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - offset;
    } else if (typeCode === 7) {
      type = 'ref-delta';
      if (pos + 20 > end) throw new Error('pack: truncated ref-delta base');
      baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else {
      const resolved = CODE_TYPES[typeCode];
      if (resolved === undefined) throw new Error(`pack: unknown type code ${typeCode}`);
      type = resolved;
    }
    const { data, consumed } = inflateAt(pack, pos, end, size);
    pos += consumed;
    raw.push({ offset: entryOffset, type, size, data, baseOffset, baseOid });
  }
  if (pos !== end) throw new Error('pack: trailing bytes after the last entry');

  // Pass 2: resolve deltas and verify ids.
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, RawEntry>();
  for (const entry of raw) byOffset.set(entry.offset, entry);
  const resolve = (entry: RawEntry, depth: number): GitObject => {
    if (depth > 64) throw new Error('pack: delta chain too deep');
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      const oid = hashObject(entry.type, entry.data);
      return { type: entry.type, data: entry.data, oid } as GitObject & { oid: string };
    }
    let base: GitObject | undefined;
    if (entry.type === 'ofs-delta') {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('pack: ofs-delta base not in pack');
      base = resolve(baseEntry, depth + 1);
    } else {
      const baseOid = entry.baseOid as string;
      base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (base === undefined) throw new Error(`pack: ref-delta base ${baseOid} not available`);
    }
    const data = applyDelta(base.data, entry.data);
    const oid = hashObject(base.type, data);
    return { type: base.type, data, oid } as GitObject & { oid: string };
  };
  for (const entry of raw) {
    const resolved = resolve(entry, 0);
    const oid = hashObject(resolved.type, resolved.data);
    if (objects.has(oid) && !objects.get(oid)?.data.equals(resolved.data)) throw new Error('pack: conflicting object ids');
    objects.set(oid, { type: resolved.type, data: resolved.data });
  }
  if (objects.size !== count) throw new Error(`pack: declared ${count} objects, resolved ${objects.size}`);
  return objects;
}

/**
 * Inflate the deflate stream at `start`, returning the bytes and how many input bytes it used.
 * One inflateSync call with `{ info: true }` reports the exact stream length in
 * `engine.bytesWritten` (Node 22.15+); the binary search below is the fallback for older runtimes.
 */
function inflateAt(pack: Buffer, start: number, end: number, declaredSize: number): { data: Buffer; consumed: number } {
  try {
    const result = inflateSync(pack.subarray(start, end), { info: true }) as unknown as {
      buffer: Buffer;
      engine?: { bytesWritten?: number };
    };
    const consumed = result.engine?.bytesWritten;
    if (typeof consumed === 'number' && consumed > 0 && consumed <= end - start && result.buffer.length === declaredSize) {
      return { data: result.buffer, consumed };
    }
  } catch {
    // Fall through to the binary search.
  }
  // Exponential probe, then binary search for the smallest prefix that inflates to the size.
  let lo = 0;
  let hi = end - start;
  const probe = (len: number): Buffer | null => {
    try {
      const out = inflateSync(pack.subarray(start, start + len));
      return out.length === declaredSize ? out : null;
    } catch {
      return null;
    }
  };
  let guess = 16;
  let found: Buffer | null = null;
  while (guess < hi) {
    const out = probe(guess);
    if (out !== null) {
      found = out;
      hi = guess;
      break;
    }
    lo = guess;
    guess *= 2;
  }
  if (found === null) {
    const out = probe(hi);
    if (out === null) throw new Error('pack: object does not inflate to its declared size');
    found = out;
  }
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (probe(mid) !== null) hi = mid;
    else lo = mid;
  }
  const data = probe(hi);
  if (data === null) throw new Error('pack: object does not inflate to its declared size');
  return { data, consumed: hi };
}

/** Apply a git delta (base + delta instructions) to produce the result bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta: truncated varint');
      const byte = delta[pos] as number;
      pos += 1;
      out |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) return out;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta: base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          if (pos >= delta.length) throw new Error('delta: truncated copy offset');
          offset |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          if (pos >= delta.length) throw new Error('delta: truncated copy size');
          size |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta: copy out of range');
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      if (pos + op > delta.length) throw new Error('delta: truncated insert');
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta: zero opcode');
    }
  }
  if (produced !== targetSize) throw new Error('delta: target size mismatch');
  return Buffer.concat(out);
}

// --------------------------------------------------------------------------- trees & diffs

/** The flat path -> blob oid map of a tree (recursive). */
export function flattenTree(treeOid: string, lookup: ObjectLookup): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** The file-level diff between two trees (base -> head), sorted by path. */
export function diffTrees(baseTree: string | null, headTree: string | null, lookup: ObjectLookup): FileChange[] {
  const base = baseTree === null ? new Map<string, string>() : flattenTree(baseTree, lookup);
  const head = headTree === null ? new Map<string, string>() : flattenTree(headTree, lookup);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldOid = base.get(path) ?? null;
    const newOid = head.get(path) ?? null;
    if (oldOid === newOid) continue;
    if (oldOid === null) changes.push({ path, status: 'added', oldOid, newOid });
    else if (newOid === null) changes.push({ path, status: 'removed', oldOid, newOid });
    else changes.push({ path, status: 'modified', oldOid, newOid });
  }
  return changes;
}

/** Added/removed line counts between two blobs (a small LCS over lines; files here are small). */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  if (oldData !== null && oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newData !== null && newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  // LCS lengths via one rolling row; files in this suite are a few KB at most.
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    cur[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      cur[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const common = prev[m] as number;
  return { additions: m - common, deletions: n - common };
}
