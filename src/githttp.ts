import { pktFlush, pktLine, pktLineBuf, splitPktSections, ZERO_OID } from './util.ts';
import {
  isAncestor,
  parseCommit,
  peelToCommit,
  planShallowFetch,
  readPack,
  writePack,
  type GitObject,
} from './gitcore.ts';
import type { Repo, Store } from './store.ts';

// Smart HTTP: info/refs advertisements, upload-pack (v2 + v0), receive-pack.
// All responses are binary pkt-line streams; the only JSON is a 404/400 body.

export const AGENT = 'forge/1.0';
const UPLOAD_CAPS = `side-band-64k ofs-delta thin-pack multi_ack agent=${AGENT} symref=HEAD:refs/heads/main shallow`;
const RECEIVE_CAPS = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFound(message: string): GitResult {
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

function badRequest(message: string): GitResult {
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** Sorted ref names for advertisements (heads first, then tags). */
function sortedRefs(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The v0 advertisement for one service. */
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    let first = true;
    if (headTip) {
      parts.push(pktLine(`${headTip} HEAD\0${caps}\n`));
      first = false;
    }
    for (const ref of refs) {
      const oid = repo.refs.get(ref) as string;
      const prefix = first ? `\0${caps}` : '';
      first = false;
      parts.push(pktLine(`${oid} ${ref}${prefix}\n`));
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(repo.objects, oid);
        parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 advertisement (upload-pack only). */
function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

/** Wrap pack bytes in sideband band-1 packets, each <= 65516 bytes total. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    parts.push(pktLineBuf(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

/** Parse the pkt-lines of a receive-pack request until the flush; returns the
 * command lines and the offset where the pack bytes start. */
function parseReceiveCommands(body: Buffer): { commands: string[]; packStart: number } {
  const commands: string[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const lenHex = body.subarray(off, off + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len) || len < 4) {
      if (len === 0) {
        off += 4;
        break;
      }
      throw new Error('malformed pkt-line in receive-pack');
    }
    if (off + len > body.length) throw new Error('truncated pkt-line in receive-pack');
    const line = body.subarray(off + 4, off + len).toString('utf8');
    commands.push(line.split('\0')[0]);
    off += len;
  }
  return { commands, packStart: off };
}

/** Handle GET /:owner/:repo.git/info/refs?service=... */
export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string | null,
  gitProtocol: string | null,
): GitResult {
  const resolved = store.resolveOwner(owner);
  if (!resolved) return notFound('Not Found');
  const repo = store.getRepo(resolved, repoName);
  if (!repo) return notFound('Not Found');
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV2() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV0(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertiseV0(repo, 'git-receive-pack') };
  }
  return badRequest('unknown service');
}

/** Handle POST /:owner/:repo.git/git-upload-pack (ls-refs, fetch v2, fetch v0). */
export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer): GitResult {
  const resolved = store.resolveOwner(owner);
  if (!resolved) return notFound('Not Found');
  const repo = store.getRepo(resolved, repoName);
  if (!repo) return notFound('Not Found');
  let sections: string[][];
  try {
    sections = splitPktSections(body);
  } catch {
    return badRequest('malformed request');
  }
  const first = sections[0]?.[0] ?? '';
  if (first.startsWith('command=ls-refs')) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, sections) };
  }
  if (first.startsWith('command=fetch')) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV2(repo, sections) };
  }
  // v0 fetch: want/have/deepen lines in one section.
  try {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV0(repo, sections.flat()) };
  } catch {
    return badRequest('malformed request');
  }
}

function handleLsRefs(repo: Repo, sections: string[][]): Buffer {
  const args = sections[1] ?? [];
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const parts: Buffer[] = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (mainTip) {
    if (matches('HEAD')) {
      const attrs = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(pktLine(`${mainTip} HEAD${attrs}\n`));
    }
  } else if (unborn && matches('HEAD')) {
    parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    const oid = repo.refs.get(ref) as string;
    let line = `${oid} ${ref}`;
    const obj = repo.objects.get(oid);
    if (peel && obj && obj.type === 'tag') {
      line += ` peeled:${peelToCommit(repo.objects, oid)}`;
    }
    parts.push(pktLine(line + '\n'));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleFetchV2(repo: Repo, sections: string[][]): Buffer {
  const args = sections[1] ?? [];
  const wants: string[] = [];
  const haves: string[] = [];
  const prevShallow: string[] = [];
  let depth: number | null = null;
  for (const line of args) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) prevShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (!Number.isNaN(n)) depth = n;
    }
  }
  const plan = planShallowFetch(repo.objects, wants, haves, prevShallow, depth);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush()];
  if (plan.boundary.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const b of plan.boundary) parts.push(pktLine(`shallow ${b}\n`));
    for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(writePack(plan.send)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const prevShallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('want ')) {
      wants.push(trimmed.slice(5).split(' ')[0]);
    } else if (trimmed.startsWith('have ')) {
      haves.push(trimmed.slice(5).split(' ')[0]);
    } else if (trimmed.startsWith('shallow ')) {
      prevShallow.push(trimmed.slice(8).trim());
    } else if (trimmed.startsWith('deepen ')) {
      const n = parseInt(trimmed.slice(7).trim(), 10);
      if (!Number.isNaN(n)) depth = n;
    }
  }
  if (wants.length === 0) throw new Error('v0 fetch without wants');
  const plan = planShallowFetch(repo.objects, wants, haves, prevShallow, depth);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const b of plan.boundary) parts.push(pktLine(`shallow ${b}\n`));
  for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  parts.push(sidebandPack(writePack(plan.send)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Handle POST /:owner/:repo.git/git-receive-pack (push). */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResult {
  const resolved = store.resolveOwner(owner);
  if (!resolved) return notFound('Not Found');
  const repo = store.getRepo(resolved, repoName);
  if (!repo) return notFound('Not Found');
  let parsed: { commands: string[]; packStart: number };
  try {
    parsed = parseReceiveCommands(body);
  } catch {
    return badRequest('malformed request');
  }
  const commands = parsed.commands
    .map((line) => {
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(line);
      if (!m) return null;
      return { old: m[1], new: m[2], ref: m[3] };
    })
    .filter((c): c is { old: string; new: string; ref: string } => c !== null);

  // Unpack first: objects are stored even when a ref update is refused.
  let unpackOk = true;
  const packBytes = body.subarray(parsed.packStart);
  if (packBytes.length > 0) {
    try {
      const pack = readPack(packBytes);
      for (const [oid, obj] of pack.objects) {
        repo.objects.set(oid, obj);
      }
    } catch {
      unpackOk = false;
    }
  } else if (commands.some((c) => c.new !== '0000000000000000000000000000000000000000')) {
    unpackOk = false;
  }

  const report: string[] = [];
  if (unpackOk) {
    report.push('unpack ok\n');
    for (const cmd of commands) {
      report.push(applyPushCommand(repo, cmd) + '\n');
    }
  } else {
    report.push('unpack error\n');
    for (const cmd of commands) {
      report.push(`ng ${cmd.ref} unpacker error\n`);
    }
  }
  const parts: Buffer[] = [];
  for (const line of report) {
    parts.push(pktLineBuf(Buffer.concat([Buffer.from([1]), pktLine(line)])));
  }
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}

/** Apply one ref update; returns the `ok`/`ng` report line (without \n). */
function applyPushCommand(repo: Repo, cmd: { old: string; new: string; ref: string }): string {
  const ZERO = '0000000000000000000000000000000000000000';
  const current = repo.refs.get(cmd.ref) ?? null;
  const exists = current !== null;
  if (cmd.new === ZERO) {
    // Delete.
    if (!exists) return `ng ${cmd.ref} remote ref does not exist`;
    if (cmd.old !== ZERO && cmd.old !== current) return `ng ${cmd.ref} non-fast-forward`;
    repo.refs.delete(cmd.ref);
    return `ok ${cmd.ref}`;
  }
  // Create or update: the new tip must be in the store.
  if (!repo.objects.has(cmd.new)) return `ng ${cmd.ref} missing object`;
  if (cmd.old === ZERO) {
    if (exists) return `ng ${cmd.ref} remote ref already exists`;
    repo.refs.set(cmd.ref, cmd.new);
    return `ok ${cmd.ref}`;
  }
  if (!exists) return `ng ${cmd.ref} remote ref does not exist`;
  if (cmd.old !== current) return `ng ${cmd.ref} non-fast-forward`;
  if (cmd.new === current) return `ok ${cmd.ref}`;
  if (!isAncestor(repo.objects, current, cmd.new)) return `ng ${cmd.ref} non-fast-forward`;
  repo.refs.set(cmd.ref, cmd.new);
  return `ok ${cmd.ref}`;
}
