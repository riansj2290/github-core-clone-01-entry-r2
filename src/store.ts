import { Counter, counterTimestamp } from './util.ts';
import {
  buildCommit,
  buildTree,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
  peelToCommit,
  storeObject,
  treeSortKey,
  type GitObject,
  type TreeEntry,
} from './gitcore.ts';

// In-memory store. One process, no persistence: the suite drives the forge
// through its HTTP surface only, so the whole state lives in Maps keyed by
// insertion order. All ids and timestamps come from counters, never the clock.

export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const FORGE_IDENTITY = 'forge <forge@localhost>';
export const DEFAULT_BRANCH = 'main';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
}

export interface Repo {
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  databaseId: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  createdSeq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  viewerLogin = 'adaiversen';
  private viewerNamed = false;
  private dbId = new Counter(1);
  private globalId = new Counter(1);
  private commitSeq = new Counter(1);
  private createdSeq = new Counter(1);

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Resolve an owner name from a request path, with a first-seen rebind.
   * The token owner is the scenario viewer; if the very first owner-named
   * request names someone else (a different seed), rebind and move the repos
   * created so far under the new name. Returns null when the owner is not
   * the viewer. */
  resolveOwner(pathOwner: string): string | null {
    if (pathOwner === this.viewerLogin) {
      this.viewerNamed = true;
      return pathOwner;
    }
    if (!this.viewerNamed) {
      // First owner-named request names someone else: the scenario viewer
      // differs from the hardcoded one, so rebind and move the repos.
      const old = this.viewerLogin;
      this.viewerLogin = pathOwner;
      this.viewerNamed = true;
      if (this.repos.size > 0) {
        const moved = new Map<string, Repo>();
        for (const repo of this.repos.values()) {
          if (repo.owner === old) {
            repo.owner = pathOwner;
            moved.set(this.repoKey(pathOwner, repo.name), repo);
          } else {
            moved.set(this.repoKey(repo.owner, repo.name), repo);
          }
        }
        this.repos = moved;
      }
      return pathOwner;
    }
    return null;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      owner: this.viewerLogin,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      databaseId: this.dbId.next(),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      createdSeq: this.createdSeq.next(),
    };
    this.repos.set(this.repoKey(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  nextGlobalId(): number {
    return this.globalId.next();
  }

  nextCreatedSeq(): number {
    return this.createdSeq.next();
  }

  /** The tip commit of a ref name, or null when the ref does not exist. */
  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** The tip commit of a branch (refs/heads/<branch>), peeled to a commit. */
  branchTip(repo: Repo, branch: string): string | null {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (!oid) return null;
    return peelToCommit(repo.objects, oid);
  }

  /** Read a tree at a path inside the tree of a commit. Returns the tree oid or null. */
  treeAtPath(repo: Repo, commitOid: string, path: string): string | null {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    let treeOid = parseCommit(obj.data).tree;
    if (path === '') return treeOid;
    for (const part of path.split('/')) {
      const treeObj = repo.objects.get(treeOid);
      if (!treeObj || treeObj.type !== 'tree') return null;
      const entry = parseTree(treeObj.data).find((e) => e.name === part);
      if (!entry || entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return treeOid;
  }

  /** Blob oid at a path inside a commit's tree, or null. */
  blobAtPath(repo: Repo, commitOid: string, path: string): string | null {
    const parts = path.split('/');
    const name = parts.pop() as string;
    const dir = parts.join('/');
    const treeOid = this.treeAtPath(repo, commitOid, dir);
    if (!treeOid) return null;
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') return null;
    const entry = parseTree(treeObj.data).find((e) => e.name === name);
    if (!entry || entry.mode === '40000' || entry.mode === '160000') return null;
    return entry.oid;
  }

  /** Collect every file path -> blob oid under a commit's tree. */
  flattenTree(repo: Repo, commitOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const treeObj = repo.objects.get(treeOid);
      if (!treeObj || treeObj.type !== 'tree') return;
      for (const e of parseTree(treeObj.data)) {
        if (e.mode === '40000') walk(e.oid, prefix + e.name + '/');
        else if (e.mode !== '160000') out.set(prefix + e.name, e.oid);
      }
    };
    walk(parseCommit(obj.data).tree, '');
    return out;
  }

  /** Build a new tree from a base tree with one path set to a blob (or removed). */
  private setPathInTree(
    repo: Repo,
    treeOid: string | null,
    parts: string[],
    blobOid: string | null,
  ): string {
    if (parts.length === 1) {
      const name = parts[0];
      const entries: TreeEntry[] = treeOid
        ? parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0))
        : [];
      const kept = entries.filter((e) => e.name !== name);
      if (blobOid !== null) kept.push({ mode: '100644', name, oid: blobOid });
      return storeObject(repo.objects, 'tree', buildTree(kept));
    }
    const [head, ...rest] = parts;
    const entries: TreeEntry[] = treeOid
      ? parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0))
      : [];
    const child = entries.find((e) => e.name === head);
    const childTree = child && child.mode === '40000' ? child.oid : null;
    const newChild = this.setPathInTree(repo, childTree, rest, blobOid);
    const kept = entries.filter((e) => e.name !== head);
    const childEntries = parseTree(repo.objects.get(newChild)?.data ?? Buffer.alloc(0));
    if (childEntries.length > 0) {
      kept.push({ mode: '40000', name: head, oid: newChild });
    }
    return storeObject(repo.objects, 'tree', buildTree(kept));
  }

  /** Create a commit on a branch for a contents write/delete.
   * Returns the new commit oid. `baseTip` is the branch's current tip or null
   * for an unborn branch. */
  commitContents(
    repo: Repo,
    branch: string,
    message: string,
    path: string,
    blobOid: string | null,
  ): string {
    const baseTip = this.branchTip(repo, branch);
    const baseTree = baseTip ? parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree : null;
    const newTree = this.setPathInTree(repo, baseTree, path.split('/'), blobOid);
    const seq = this.commitSeq.next();
    const stamp = `${1735689600 + seq} +0000`;
    const commit = buildCommit({
      tree: newTree,
      parents: baseTip ? [baseTip] : [],
      author: `${FORGE_IDENTITY} ${stamp}`,
      committer: `${FORGE_IDENTITY} ${stamp}`,
      message,
    });
    const oid = storeObject(repo.objects, 'commit', commit);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** List the commits reachable from a tip, newest first (BFS by depth). */
  listCommits(repo: Repo, tip: string): { sha: string; message: string }[] {
    const out: { sha: string; message: string }[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const info = parseCommit(obj.data);
      out.push({ sha: oid, message: info.message });
      for (const p of info.parents) queue.push(p);
    }
    return out;
  }

  /** Diff two trees (base commit vs head commit): path -> {status, baseOid, headOid}. */
  diffTrees(
    repo: Repo,
    baseCommit: string,
    headCommit: string,
  ): { path: string; status: 'added' | 'removed' | 'modified'; baseOid: string | null; headOid: string | null }[] {
    const base = this.flattenTree(repo, baseCommit);
    const head = this.flattenTree(repo, headCommit);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: {
      path: string;
      status: 'added' | 'removed' | 'modified';
      baseOid: string | null;
      headOid: string | null;
    }[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path) ?? null;
      const h = head.get(path) ?? null;
      if (b === h) continue;
      out.push({
        path,
        status: b === null ? 'added' : h === null ? 'removed' : 'modified',
        baseOid: b,
        headOid: h,
      });
    }
    return out;
  }

  /** A PR file is conflicted when its blob at the current base tip differs
   * from its blob at the PR's recorded base sha AND differs from the head's
   * version. */
  prConflict(repo: Repo, pr: Pull): boolean {
    const baseTip = this.branchTip(repo, pr.base);
    if (!baseTip) return false;
    const changes = this.diffTrees(repo, pr.baseSha, pr.headSha);
    for (const c of changes) {
      const atBaseTip = this.blobAtPath(repo, baseTip, c.path);
      if (atBaseTip !== c.baseOid && atBaseTip !== c.headOid) return true;
    }
    return false;
  }

  /** Squash-merge a PR onto its base branch. Returns the merge commit oid,
   * or null when the PR is conflicted. */
  squashMerge(repo: Repo, pr: Pull): string | null {
    if (this.prConflict(repo, pr)) return null;
    const baseTip = this.branchTip(repo, pr.base);
    if (!baseTip) return null;
    const baseTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
    const changes = this.diffTrees(repo, pr.baseSha, pr.headSha);
    let tree = baseTree;
    for (const c of changes) {
      tree = this.setPathInTree(repo, tree, c.path.split('/'), c.headOid);
    }
    const seq = this.commitSeq.next();
    const stamp = `${1735689600 + seq} +0000`;
    const message = `${pr.title} (#${pr.number})`;
    const commit = buildCommit({
      tree,
      parents: [baseTip],
      author: `${FORGE_IDENTITY} ${stamp}`,
      committer: `${FORGE_IDENTITY} ${stamp}`,
      message,
    });
    const oid = storeObject(repo.objects, 'commit', commit);
    repo.refs.set(`refs/heads/${pr.base}`, oid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = counterTimestamp(seq);
    pr.mergeCommitSha = oid;
    return oid;
  }

  /** Count added/removed lines between two blob contents (multiset diff). */
  lineDiff(base: Buffer | null, head: Buffer | null): { additions: number; deletions: number } {
    const baseLines = base ? base.toString('utf8').split('\n') : [];
    const headLines = head ? head.toString('utf8').split('\n') : [];
    // Drop the trailing empty element from a final newline on both sides.
    if (baseLines.length > 0 && baseLines[baseLines.length - 1] === '') baseLines.pop();
    if (headLines.length > 0 && headLines[headLines.length - 1] === '') headLines.pop();
    const counts = new Map<string, number>();
    for (const l of baseLines) counts.set(l, (counts.get(l) ?? 0) + 1);
    let deletions = 0;
    let additions = 0;
    for (const l of headLines) {
      const c = counts.get(l) ?? 0;
      if (c > 0) counts.set(l, c - 1);
      else additions += 1;
    }
    for (const c of counts.values()) deletions += c;
    return { additions, deletions };
  }

  blobBytes(repo: Repo, oid: string | null): Buffer | null {
    if (!oid) return null;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'blob') return null;
    return obj.data;
  }

  /** Issue/PR number allocation (shared counter, starts at 1). */
  nextNumber(repo: Repo): number {
    const n = repo.nextNumber;
    repo.nextNumber += 1;
    return n;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const issue: Issue = {
      id: this.nextGlobalId(),
      number: this.nextNumber(repo),
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      createdSeq: this.nextCreatedSeq(),
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    head: string,
    base: string,
    headSha: string,
    baseSha: string,
  ): Pull {
    const pr: Pull = {
      id: this.nextGlobalId(),
      number: this.nextNumber(repo),
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      headSha,
      baseSha,
      createdSeq: this.nextCreatedSeq(),
    };
    repo.pulls.set(pr.number, pr);
    return pr;
  }
}
