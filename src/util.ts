import { createHash } from 'node:crypto';

// Small shared helpers: hashing, base64, pkt-lines, deterministic counters.
// Nothing in here touches the wall clock or randomness: everything the suite
// can observe must be reproducible from the request sequence alone.

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function isZeroOid(oid: string): boolean {
  return oid === ZERO_OID;
}

export function b64encode(data: Buffer): string {
  return data.toString('base64');
}

export function b64decode(text: string): Buffer {
  return Buffer.from(text, 'base64');
}

export function isValidOid(oid: string): boolean {
  return /^[0-9a-f]{40}$/.test(oid);
}

/** Encode one git pkt-line for a text payload (the trailing \n belongs to the payload). */
export function pktLine(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** The 0000 flush pkt-line. */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** Encode one pkt-line around a raw binary payload (no UTF-8 re-encoding). */
export function pktLineBuf(payload: Buffer): Buffer {
  const len = payload.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

/** Decode a buffer of pkt-lines into an array of payloads (strings), skipping flushes. */
export function decodePktLines(buf: Buffer): string[] {
  const out: string[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) {
      throw new Error('malformed pkt-line length');
    }
    if (len === 0) {
      off += 4;
      continue;
    }
    if (len === 1) {
      // Delimiter packet (0001) between v2 command and argument sections.
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) {
      throw new Error('truncated pkt-line');
    }
    let line = buf.subarray(off + 4, off + len).toString('utf8');
    if (line.endsWith('\n')) line = line.slice(0, -1);
    out.push(line);
    off += len;
  }
  if (off !== buf.length) {
    throw new Error('trailing bytes after pkt-lines');
  }
  return out;
}

/** Split a pkt-line buffer into segments separated by flush packets. */
export function splitPktSections(buf: Buffer): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) {
      throw new Error('malformed pkt-line length');
    }
    if (len === 0 || len === 1) {
      // Flush (0000) or delimiter (0001) both end the current section.
      sections.push(current);
      current = [];
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) {
      throw new Error('truncated pkt-line');
    }
    let line = buf.subarray(off + 4, off + len).toString('utf8');
    if (line.endsWith('\n')) line = line.slice(0, -1);
    current.push(line);
    off += len;
  }
  if (off !== buf.length) {
    throw new Error('trailing bytes after pkt-lines');
  }
  if (current.length > 0) {
    sections.push(current);
  }
  return sections;
}

/** A monotonically increasing counter, used for ids and synthetic timestamps. */
export class Counter {
  private value: number;
  constructor(start = 1) {
    this.value = start;
  }
  next(): number {
    const v = this.value;
    this.value += 1;
    return v;
  }
  peek(): number {
    return this.value;
  }
}

/** Deterministic ISO timestamp from a counter value (never the wall clock). */
export function counterTimestamp(seq: number): string {
  const base = 1735689600; // 2025-01-01T00:00:00Z
  return new Date((base + seq) * 1000).toISOString();
}

export function jsonBody(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

/** One HTTP response: status, content type, body, plus extra headers. */
export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}
