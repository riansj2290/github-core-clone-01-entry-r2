import { b64decode, b64encode, counterTimestamp, jsonBody, type HttpResult } from './util.ts';
import { hashObject, parseCommit, parseTree, storeObject } from './gitcore.ts';
import {
  DEFAULT_BRANCH,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_NAME,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// REST v3 under /api/v3. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors carry {message}. No auth token -> 401 (except
// the public root and meta endpoints).

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: Buffer.from(`Repository:${repo.databaseId}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === store.viewerLogin ? VIEWER_ID : 0, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    created_at: counterTimestamp(repo.createdSeq),
    updated_at: counterTimestamp(repo.createdSeq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.databaseId}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: store.viewerLogin, id: VIEWER_ID },
    comments: issue.comments.length,
    created_at: counterTimestamp(issue.createdSeq),
    updated_at: counterTimestamp(issue.createdSeq),
  };
}

export function pullJson(store: Store, repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: Buffer.from(`PullRequest:${repo.databaseId}:${pr.number}`, 'utf8').toString('base64'),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.head, sha: pr.headSha, label: `${store.viewerLogin}:${pr.head}` },
    base: { ref: pr.base, sha: pr.baseSha, label: `${store.viewerLogin}:${pr.base}` },
    user: { login: store.viewerLogin, id: VIEWER_ID },
    created_at: counterTimestamp(pr.createdSeq),
    updated_at: counterTimestamp(pr.createdSeq),
  };
}

function ok(value: unknown, status = 200, headers: Record<string, string> = {}): HttpResult {
  return { status, contentType: 'application/json', body: jsonBody(value), headers };
}

function err(status: number, message: string): HttpResult {
  return { status, contentType: 'application/json', body: jsonBody({ message }) };
}

function paginate<T>(
  items: T[],
  query: URLSearchParams,
  origin: string,
  path: string,
): { page: T[]; link: string | null } {
  const perPage = Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30);
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const url = (p: number): string => `${origin}${path}?per_page=${perPage}&page=${p}`;
  if (page < totalPages) links.push(`<${url(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`);
  if (totalPages > 1) {
    links.push(`<${url(1)}>; rel="first"`);
    links.push(`<${url(totalPages)}>; rel="last"`);
  }
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

function linkHeaders(link: string | null): Record<string, string> {
  return link ? { link } : {};
}

function parseJsonBody(body: Buffer): { value: unknown; error: HttpResult | null } {
  if (body.length === 0) return { value: {}, error: null };
  try {
    return { value: JSON.parse(body.toString('utf8')), error: null };
  } catch {
    return { value: null, error: err(400, 'malformed JSON body') };
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

export function handleRest(
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Buffer,
  origin: string,
  authed: boolean,
): HttpResult {
  const segments = path.split('/').filter((s) => s.length > 0);
  // Public endpoints.
  if (method === 'GET' && segments.length === 0) {
    return ok(
      {
        current_user_url: `${origin}/api/v3/user`,
        repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
        rate_limit_url: `${origin}/api/v3/rate_limit`,
      },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'meta') {
    return ok({ installed_version: '1.0.0' });
  }
  if (!authed) return err(401, 'Requires authentication');

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({
      login: store.viewerLogin,
      id: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
    });
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos();
      const { page, link } = paginate(repos.map((r) => repoJson(store, r)), query, origin, '/api/v3/user/repos');
      return ok(page, 200, linkHeaders(link));
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed.error) return parsed.error;
      const input = asObject(parsed.value);
      if (!input) return err(422, 'invalid request body');
      const name = typeof input.name === 'string' ? input.name : '';
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'invalid repository name');
      if (store.getRepo(store.viewerLogin, name)) return err(422, 'Repository already exists');
      const repo = store.createRepo(
        name,
        typeof input.description === 'string' ? input.description : '',
        input.private === true,
      );
      return ok(repoJson(store, repo), 201);
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = store.resolveOwner(segments[1]);
    if (!owner) return err(404, 'Not Found');
    const repo = store.getRepo(owner, segments[2]);
    if (!repo) return err(404, 'Not Found');
    const rest = segments.slice(3);
    return handleRepoRoute(store, repo, owner, method, rest, query, body, origin);
  }
  return err(404, 'Not Found');
}

function handleRepoRoute(
  store: Store,
  repo: Repo,
  owner: string,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: Buffer,
  origin: string,
): HttpResult {
  // GET/PATCH/DELETE /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return ok(repoJson(store, repo));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (parsed.error) return parsed.error;
      const input = asObject(parsed.value);
      if (!input) return err(422, 'invalid request body');
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      return ok(repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repo.name);
      return { status: 204, contentType: 'application/json', body: Buffer.alloc(0) };
    }
    return err(404, 'Not Found');
  }

  const [section, ...tail] = rest;

  // Branches.
  if (section === 'branches') {
    if (tail.length === 0 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: store.branchTip(repo, name) } }));
      return ok(branches);
    }
    if (tail.length === 1 && method === 'GET') {
      const tip = store.branchTip(repo, tail[0]);
      if (!tip) return err(404, 'Not Found');
      return ok({ name: tail[0], commit: { sha: tip } });
    }
    return err(404, 'Not Found');
  }

  // Git refs.
  if (section === 'git' && tail.length >= 1 && tail[0] === 'refs') {
    if (method === 'GET' && tail.length >= 3) {
      const ref = tail.join('/');
      const oid = repo.refs.get(ref);
      if (!oid) return err(404, 'Not Found');
      return ok({ ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
    }
    if (method === 'POST' && tail.length === 1) {
      const parsed = parseJsonBody(body);
      if (parsed.error) return parsed.error;
      const input = asObject(parsed.value);
      if (!input || typeof input.ref !== 'string' || typeof input.sha !== 'string') {
        return err(422, 'ref and sha are required');
      }
      if (!input.ref.startsWith('refs/')) return err(422, 'invalid ref');
      if (repo.refs.has(input.ref)) return err(422, 'Reference already exists');
      if (!repo.objects.has(input.sha)) return err(422, 'object not found');
      repo.refs.set(input.ref, input.sha);
      return ok({ ref: input.ref, object: { sha: input.sha, type: repo.objects.get(input.sha)?.type ?? 'commit' } }, 201);
    }
    return err(404, 'Not Found');
  }

  // Commits.
  if (section === 'commits' && tail.length === 0 && method === 'GET') {
    const shaParam = query.get('sha');
    let tip: string | null = null;
    if (shaParam) {
      tip = store.branchTip(repo, shaParam) ?? (repo.objects.has(shaParam) ? shaParam : null);
      if (!tip) return err(404, 'Not Found');
    } else {
      tip = store.branchTip(repo, repo.defaultBranch);
      if (!tip) return ok([]);
    }
    const commits = store.listCommits(repo, tip).map((c) => {
      const info = parseCommit(repo.objects.get(c.sha)?.data ?? Buffer.alloc(0));
      return {
        sha: c.sha,
        commit: {
          message: c.message,
          author: { name: info.author.split('<')[0].trim(), email: '', date: counterTimestamp(1) },
          committer: { name: info.committer.split('<')[0].trim(), email: '', date: counterTimestamp(1) },
          tree: { sha: info.tree },
        },
        parents: info.parents.map((p) => ({ sha: p })),
      };
    });
    return ok(commits);
  }

  // Contents.
  if (section === 'contents') {
    const contentPath = tail.join('/');
    if (method === 'GET') return getContents(store, repo, contentPath, query);
    if (method === 'PUT') return putContents(store, repo, contentPath, body, query);
    if (method === 'DELETE') return deleteContents(store, repo, contentPath, body);
    return err(404, 'Not Found');
  }

  // Labels.
  if (section === 'labels') {
    if (tail.length === 0 && method === 'GET') {
      return ok([...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
    }
    if (tail.length === 0 && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed.error) return parsed.error;
      const input = asObject(parsed.value);
      if (!input || typeof input.name !== 'string' || !input.name) return err(422, 'label name is required');
      const color = typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed';
      const existing = repo.labels.get(input.name);
      if (existing) return ok({ name: existing.name, color: existing.color }, 201);
      const label: Label = { name: input.name, color };
      repo.labels.set(label.name, label);
      return ok({ name: label.name, color: label.color }, 201);
    }
    return err(404, 'Not Found');
  }

  // Issues.
  if (section === 'issues') {
    return handleIssues(store, repo, method, tail, query, body);
  }

  // Pulls.
  if (section === 'pulls') {
    return handlePulls(store, repo, method, tail, query, body);
  }

  return err(404, 'Not Found');
}

function resolveContentsTip(store: Store, repo: Repo, query: URLSearchParams): string | null {
  const ref = query.get('ref');
  if (!ref) return store.branchTip(repo, repo.defaultBranch);
  return store.branchTip(repo, ref) ?? (repo.objects.has(ref) ? ref : null);
}

function getContents(store: Store, repo: Repo, contentPath: string, query: URLSearchParams): HttpResult {
  const tip = resolveContentsTip(store, repo, query);
  if (!tip) return err(404, 'Not Found');
  const blobOid = store.blobAtPath(repo, tip, contentPath);
  if (blobOid) {
    const bytes = store.blobBytes(repo, blobOid) ?? Buffer.alloc(0);
    return ok({
      type: 'file',
      encoding: 'base64',
      size: bytes.length,
      name: contentPath.split('/').pop(),
      path: contentPath,
      content: b64encode(bytes),
      sha: blobOid,
    });
  }
  const treeOid = store.treeAtPath(repo, tip, contentPath);
  if (!treeOid) return err(404, 'Not Found');
  const treeObj = repo.objects.get(treeOid);
  if (!treeObj || treeObj.type !== 'tree') return err(404, 'Not Found');
  const entries = parseTree(treeObj.data).map((e) => ({
    type: e.mode === '40000' ? 'dir' : 'file',
    name: e.name,
    path: contentPath ? `${contentPath}/${e.name}` : e.name,
    sha: e.oid,
    size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
  }));
  return ok(entries);
}

function putContents(store: Store, repo: Repo, contentPath: string, body: Buffer, query: URLSearchParams): HttpResult {
  const parsed = parseJsonBody(body);
  if (parsed.error) return parsed.error;
  const input = asObject(parsed.value);
  if (!input || typeof input.content !== 'string' || typeof input.message !== 'string') {
    return err(422, 'content and message are required');
  }
  const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
  let tip = store.branchTip(repo, branch);
  if (!tip && branch !== repo.defaultBranch) {
    // Branch does not exist yet: start it from the default branch tip.
    const defaultTip = store.branchTip(repo, repo.defaultBranch);
    if (defaultTip) repo.refs.set(`refs/heads/${branch}`, defaultTip);
  }
  tip = store.branchTip(repo, branch);
  const bytes = b64decode(input.content);
  const blobOid = storeObject(repo.objects, 'blob', bytes);
  const existing = tip ? store.blobAtPath(repo, tip, contentPath) : null;
  if (typeof input.sha === 'string') {
    if (!existing || existing !== input.sha) return err(409, 'sha does not match the current file');
  } else if (existing) {
    return err(422, 'file already exists');
  }
  const isUpdate = existing !== null;
  const commitOid = store.commitContents(repo, branch, input.message, contentPath, blobOid);
  return ok(
    {
      content: {
        name: contentPath.split('/').pop(),
        path: contentPath,
        sha: blobOid,
        size: bytes.length,
        encoding: 'base64',
        type: 'file',
      },
      commit: { sha: commitOid },
    },
    isUpdate ? 200 : 201,
  );
}

function deleteContents(store: Store, repo: Repo, contentPath: string, body: Buffer): HttpResult {
  const parsed = parseJsonBody(body);
  if (parsed.error) return parsed.error;
  const input = asObject(parsed.value);
  if (!input || typeof input.sha !== 'string' || typeof input.message !== 'string') {
    return err(422, 'sha and message are required');
  }
  const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
  const tip = store.branchTip(repo, branch);
  if (!tip) return err(404, 'Not Found');
  const existing = store.blobAtPath(repo, tip, contentPath);
  if (!existing) return err(404, 'Not Found');
  if (existing !== input.sha) return err(409, 'sha does not match the current file');
  const commitOid = store.commitContents(repo, branch, input.message, contentPath, null);
  return ok({ commit: { sha: commitOid } });
}

function handleIssues(
  store: Store,
  repo: Repo,
  method: string,
  tail: string[],
  query: URLSearchParams,
  body: Buffer,
): HttpResult {
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const perPage = Math.max(1, parseInt(query.get('per_page') ?? '100', 10) || 100);
      const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
      const slice = issues.slice((page - 1) * perPage, page * perPage);
      return ok(slice.map((i) => issueJson(store, repo, i)));
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed.error) return parsed.error;
      const input = asObject(parsed.value);
      if (!input || typeof input.title !== 'string' || !input.title) return err(422, 'title is required');
      const labelNames: string[] = Array.isArray(input.labels)
        ? input.labels.map((l) => (typeof l === 'string' ? l : typeof l === 'object' && l ? String((l as Record<string, unknown>).name ?? '') : '')).filter(Boolean)
        : [];
      const labels: Label[] = [];
      for (const name of labelNames) {
        const label = repo.labels.get(name);
        if (!label) return err(422, `unknown label: ${name}`);
        labels.push(label);
      }
      const issue = store.createIssue(repo, input.title, typeof input.body === 'string' ? input.body : '', labels);
      return ok(issueJson(store, repo, issue), 201);
    }
    return err(404, 'Not Found');
  }
  const num = parseInt(tail[0], 10);
  if (Number.isNaN(num)) return err(404, 'Not Found');
  const issue = repo.issues.get(num);
  if (!issue) return err(404, 'Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return ok(issueJson(store, repo, issue));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (parsed.error) return parsed.error;
      const input = asObject(parsed.value);
      if (!input) return err(422, 'invalid request body');
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (typeof input.state === 'string' && (input.state === 'open' || input.state === 'closed')) {
        issue.state = input.state;
      }
      return ok(issueJson(store, repo, issue));
    }
    return err(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') {
      return ok(issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: store.viewerLogin, id: VIEWER_ID } })));
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed.error) return parsed.error;
      const input = asObject(parsed.value);
      if (!input || typeof input.body !== 'string') return err(422, 'body is required');
      const comment = { id: repo.nextCommentId++, body: input.body, createdSeq: store.nextCreatedSeq() };
      issue.comments.push(comment);
      return ok({ id: comment.id, body: comment.body, user: { login: store.viewerLogin, id: VIEWER_ID } }, 201);
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

function handlePulls(
  store: Store,
  repo: Repo,
  method: string,
  tail: string[],
  query: URLSearchParams,
  body: Buffer,
): HttpResult {
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const perPage = Math.max(1, parseInt(query.get('per_page') ?? '100', 10) || 100);
      const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
      const slice = pulls.slice((page - 1) * perPage, page * perPage);
      return ok(slice.map((p) => pullJson(store, repo, p)));
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed.error) return parsed.error;
      const input = asObject(parsed.value);
      if (!input || typeof input.head !== 'string' || typeof input.base !== 'string' || typeof input.title !== 'string') {
        return err(422, 'head, base and title are required');
      }
      const headSha = store.branchTip(repo, input.head);
      const baseSha = store.branchTip(repo, input.base);
      if (!headSha || !baseSha) return err(422, 'head or base branch not found');
      const dup = [...repo.pulls.values()].find((p) => p.state === 'open' && p.head === input.head && p.base === input.base);
      if (dup) return err(422, 'a pull request already exists for this head and base');
      const pr = store.createPull(repo, input.title, typeof input.body === 'string' ? input.body : '', input.head, input.base, headSha, baseSha);
      return ok(pullJson(store, repo, pr), 201);
    }
    return err(404, 'Not Found');
  }
  const num = parseInt(tail[0], 10);
  if (Number.isNaN(num)) return err(404, 'Not Found');
  const pr = repo.pulls.get(num);
  if (!pr) return err(404, 'Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return ok(pullJson(store, repo, pr));
    return err(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const headTip = store.branchTip(repo, pr.head) ?? pr.headSha;
    const changes = store.diffTrees(repo, pr.baseSha, headTip);
    const files = changes.map((c) => {
      const baseBytes = store.blobBytes(repo, c.baseOid);
      const headBytes = store.blobBytes(repo, c.headOid);
      const { additions, deletions } = store.lineDiff(baseBytes, headBytes);
      return {
        filename: c.path,
        status: c.status,
        additions,
        deletions,
        changes: additions + deletions,
      };
    });
    return ok(files);
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pr.merged || pr.state === 'closed') return err(405, 'pull request is already merged or closed');
    const mergeSha = store.squashMerge(repo, pr);
    if (!mergeSha) return err(405, 'merge conflict');
    return ok({ sha: mergeSha, merged: true, message: `${pr.title} (#${pr.number})` });
  }
  return err(404, 'Not Found');
}
