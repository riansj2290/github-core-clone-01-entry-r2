import { deflateSync, inflateSync } from 'node:zlib';
import { sha1Hex, ZERO_OID } from './util.ts';

// Git object model, pack codec, reachability and shallow-clone math.
// The server is a pure object store: objects only arrive in packs (or are
// built by the REST contents/merge paths in store.ts) and are never mutated.

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function storeObject(objects: Map<string, GitObject>, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) {
    objects.set(oid, { type, data });
  }
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) throw new Error('malformed tree: missing mode');
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp);
    if (nul < 0) throw new Error('malformed tree: missing name');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git's sort key for a tree entry: directories compare as name + '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? entry.name + '/' : entry.name;
}

/** Build a tree object from entries, sorted git-style. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object into its fields. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep < 0 ? text : text.slice(0, sep);
  const message = sep < 0 ? '' : text.slice(sep + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

/** Build a commit object from its fields (message included verbatim). */
export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const p of info.parents) lines.push(`parent ${p}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(lines.join('\n') + '\n\n' + info.message, 'utf8');
}

export interface TagInfo {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep < 0 ? text : text.slice(0, sep);
  const message = sep < 0 ? '' : text.slice(sep + 2);
  const info: TagInfo = { object: '', type: 'tag', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) info.tag = line.slice(4);
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Follow a tag chain to the commit it ultimately points at (or itself if not a tag). */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string {
  let cur = oid;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const obj = objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

/** All objects reachable from `root` (commit/tag/tree), in a stable order. */
export function reachableObjects(
  objects: Map<string, GitObject>,
  root: string,
): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack: string[] = [root];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      for (const p of info.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/** Is `ancestor` reachable from `tip` by walking parents (inclusive)? */
export function isAncestor(
  objects: Map<string, GitObject>,
  ancestor: string,
  tip: string,
): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

/** BFS distances from the wanted tips over parent edges (commits only). */
export function commitDistances(
  objects: Map<string, GitObject>,
  wants: string[],
): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const w of wants) {
    if (!dist.has(w)) {
      dist.set(w, 0);
      queue.push(w);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++];
    const d = dist.get(oid) as number;
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!dist.has(p)) {
        dist.set(p, d + 1);
        queue.push(p);
      }
    }
  }
  return dist;
}

/** Objects reachable from `root` without following commit parents:
 * a commit contributes itself and its tree closure; a tag contributes
 * itself and its target's closure; a tree contributes its entries. */
export function closureWithoutParents(
  objects: Map<string, GitObject>,
  root: string,
  out: Map<string, GitObject> = new Map(),
): Map<string, GitObject> {
  const obj = objects.get(root);
  if (!obj || out.has(root)) return out;
  out.set(root, obj);
  if (obj.type === 'commit') {
    closureWithoutParents(objects, parseCommit(obj.data).tree, out);
  } else if (obj.type === 'tree') {
    for (const e of parseTree(obj.data)) {
      if (e.mode !== '160000') closureWithoutParents(objects, e.oid, out);
    }
  } else if (obj.type === 'tag') {
    closureWithoutParents(objects, parseTag(obj.data).object, out);
  }
  return out;
}

export interface ShallowPlan {
  included: string[];
  boundary: string[];
  unshallow: string[];
  send: Map<string, GitObject>;
}

/**
 * Work out what a shallow/deepening fetch must send.
 * included = BFS from wants with distance < depth (depth unset = whole history).
 * boundary = included commits at distance depth-1 that still have parents.
 * unshallow = previous shallow boundaries that are included but no longer boundaries.
 * send = closure of included commits minus the closure from haves, where the
 * have-walk stops at previous shallow boundaries (boundary commit and its
 * tree/blobs are included, its parents are not).
 */
export function planShallowFetch(
  objects: Map<string, GitObject>,
  wants: string[],
  haves: string[],
  prevShallow: string[],
  depth: number | null,
): ShallowPlan {
  const dist = commitDistances(objects, wants);
  const included: string[] = [];
  const boundary: string[] = [];
  for (const [oid, d] of dist) {
    if (depth === null || d < depth) {
      included.push(oid);
      if (depth !== null && d === depth - 1) {
        const obj = objects.get(oid);
        if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) {
          boundary.push(oid);
        }
      }
    }
  }
  included.sort();
  boundary.sort();
  const boundarySet = new Set(boundary);
  const unshallow = prevShallow.filter((s) => included.includes(s) && !boundarySet.has(s)).sort();

  // Closure of included commits: the commit itself plus its tree closure.
  // Parents are NOT followed here: a shallow fetch must not carry history
  // beyond the depth boundary, and the full-history case is covered because
  // every ancestor is itself an included commit.
  const wanted = new Map<string, GitObject>();
  for (const c of included) {
    closureWithoutParents(objects, c, wanted);
  }

  // Exclusion set: closure from haves, stopping at previous shallow boundaries.
  const excluded = new Set<string>();
  const prevSet = new Set(prevShallow);
  const stack: string[] = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (excluded.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    excluded.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      excluded.add(info.tree);
      const treeObj = objects.get(info.tree);
      if (treeObj && treeObj.type === 'tree') {
        for (const [tOid] of reachableObjects(objects, info.tree)) excluded.add(tOid);
      }
      if (!prevSet.has(oid)) {
        for (const p of info.parents) stack.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const [tOid] of reachableObjects(objects, oid)) excluded.add(tOid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }

  const send = new Map<string, GitObject>();
  for (const [oid, obj] of wanted) {
    if (!excluded.has(oid)) send.set(oid, obj);
  }
  return { included, boundary, unshallow, send };
}

const PACK_TYPE = { commit: 1, tree: 2, blob: 3, tag: 4 } as const;
const PACK_TYPE_NAME: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Serialize objects into a pack v2 with plain (non-delta) entries, trailer included. */
export function writePack(objects: Map<string, GitObject>): Buffer {
  const entries = [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  parts.push(head);
  for (const [, obj] of entries) {
    const typeCode = PACK_TYPE[obj.type];
    const size = obj.data.length;
    // Varint header: first byte holds type in bits 4-6 and low 4 size bits.
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const soFar = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(soFar), 'hex');
  return Buffer.concat([soFar, trailer]);
}

export interface ParsedPack {
  objects: Map<string, GitObject>;
}

/** Parse a pack v2 containing only plain entries (deltas are rejected). */
export function readPack(buf: Buffer): ParsedPack {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error('unsupported pack version');
  const count = buf.readUInt32BE(8);
  const expectedTrailer = buf.subarray(buf.length - 20).toString('hex');
  const actualTrailer = sha1Hex(buf.subarray(0, buf.length - 20));
  if (expectedTrailer !== actualTrailer) throw new Error('pack checksum mismatch');

  const objects = new Map<string, GitObject>();
  let off = 12;
  const baseByOffset = new Map<number, string>();
  const pendingDeltas: { offset: number; type: number; base: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    const start = off;
    let b = buf[off++];
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOid = '';
    if (typeCode === 6) {
      // ofs-delta: negative offset varint
      let offsetByte = buf[off++];
      let baseOff = offsetByte & 0x7f;
      while (offsetByte & 0x80) {
        offsetByte = buf[off++];
        baseOff = ((baseOff + 1) << 7) | (offsetByte & 0x7f);
      }
      const base = baseByOffset.get(start - baseOff);
      if (!base) throw new Error('delta base not found');
      baseOid = base;
    } else if (typeCode === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const end = zlibStreamEnd(buf, off, buf.length - 20);
    const inflated = inflateSync(buf.subarray(off, end));
    if (inflated.length !== size) throw new Error('pack object size mismatch');
    off = end;
    if (typeCode >= 1 && typeCode <= 4) {
      const type = PACK_TYPE_NAME[typeCode];
      const oid = hashObject(type, inflated);
      objects.set(oid, { type, data: inflated });
      baseByOffset.set(start, oid);
    } else if (typeCode === 6 || typeCode === 7) {
      pendingDeltas.push({ offset: start, type: typeCode, base: baseOid, data: inflated });
    } else {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
  }
  if (pendingDeltas.length > 0) {
    // Deltas are not expected from the suite client; resolve them only if the
    // base object is already known, otherwise fail the unpack loudly.
    for (const d of pendingDeltas) {
      const base = objects.get(d.base);
      if (!base) throw new Error('delta pack not supported');
      const resolved = applyDelta(base.data, d.data);
      const type = base.type;
      const oid = hashObject(type, resolved);
      objects.set(oid, { type, data: resolved });
    }
  }
  return { objects };
}

/** Find the end of the zlib stream starting at `off` (exclusive upper bound `limit`).
 * inflateSync ignores trailing bytes and throws on a truncated stream, so
 * "inflateSync(off..end) succeeds" is monotone in end: binary-search the
 * smallest end that succeeds. */
function zlibStreamEnd(buf: Buffer, off: number, limit: number): number {
  let lo = off + 1;
  let hi = limit;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(off, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

/** Apply a git delta to a base buffer. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (true) {
      const b = delta[pos++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) return value;
    }
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      outLen += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  if (outLen !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(out);
}
