import { jsonBody, type HttpResult } from './util.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';
import type { Store } from './store.ts';

// MCP at /mcp: JSON-RPC 2.0 Streamable HTTP, modern era (2026-07-28).
// server/discover is the entry point; tools/list returns exactly six tools
// in a fixed order; tools/call results carry both content (text JSON) and
// structuredContent. Auth is required on every POST.

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner of the repository' },
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner of the repository' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner of the repository' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner of the repository' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner of the repository' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner of the repository' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): HttpResult {
  return { status: 200, contentType: 'application/json', body: jsonBody({ jsonrpc: '2.0', id, result }) };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown, status = 200): HttpResult {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { status, contentType: 'application/json', body: jsonBody({ jsonrpc: '2.0', id, error }) };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

export function handleMcp(store: Store, body: Buffer, authed: boolean): HttpResult {
  if (!authed) {
    return {
      status: 401,
      contentType: 'application/json',
      body: jsonBody({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } }),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', undefined, 400);
  }
  const req = parsed as Record<string, unknown>;
  const id = 'id' in req ? req.id : null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;
  const meta = (params._meta ?? {}) as Record<string, unknown>;

  // A declared protocol version other than the supported one is rejected.
  if (method !== 'initialize' && typeof meta.protocolVersion === 'string' && meta.protocolVersion !== PROTOCOL_VERSION) {
    return rpcError(id, -32022, 'Unsupported protocol version', { supported: [PROTOCOL_VERSION] });
  }

  // Notifications carry no id and expect no JSON-RPC response.
  if (method.startsWith('notifications/') || id === undefined) {
    return { status: 202, contentType: 'application/json', body: Buffer.alloc(0) };
  }

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return rpcResult(id, {
      resultType: 'discover',
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible git forge: create repositories, issues and pull requests, and merge them.',
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null) {
        return rpcError(id, -32602, `Missing required argument: ${required}`);
      }
    }
    const result = callTool(store, name, args);
    return rpcResult(id, result);
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const ownerArg = typeof args.owner === 'string' ? args.owner : store.viewerLogin;
  const repoArg = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (!repoName) return toolError('name is required');
      if (store.getRepo(store.viewerLogin, repoName)) return toolError('Repository already exists');
      const repo = store.createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return toolResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const resolved = store.resolveOwner(ownerArg);
      if (!resolved) return toolError('Not Found');
      const repo = store.getRepo(resolved, repoArg);
      if (!repo) return toolError('Not Found');
      return toolResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const resolved = store.resolveOwner(ownerArg);
      if (!resolved) return toolError('Not Found');
      const repo = store.getRepo(resolved, repoArg);
      if (!repo) return toolError('Not Found');
      const title = typeof args.title === 'string' ? args.title : '';
      const body = typeof args.body === 'string' ? args.body : '';
      const issue = store.createIssue(repo, title, body, []);
      return toolResult(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const resolved = store.resolveOwner(ownerArg);
      if (!resolved) return toolError('Not Found');
      const repo = store.getRepo(resolved, repoArg);
      if (!repo) return toolError('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => a.createdSeq - b.createdSeq);
      return toolResult(issues.map((i) => issueJson(store, repo, i)));
    }
    case 'create_pull_request': {
      const resolved = store.resolveOwner(ownerArg);
      if (!resolved) return toolError('Not Found');
      const repo = store.getRepo(resolved, repoArg);
      if (!repo) return toolError('Not Found');
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      const headSha = store.branchTip(repo, head);
      const baseSha = store.branchTip(repo, base);
      if (!headSha || !baseSha) return toolError('head or base branch not found');
      const dup = [...repo.pulls.values()].find((p) => p.state === 'open' && p.head === head && p.base === base);
      if (dup) return toolError('a pull request already exists for this head and base');
      const pr = store.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base, headSha, baseSha);
      return toolResult(pullJson(store, repo, pr));
    }
    case 'merge_pull_request': {
      const resolved = store.resolveOwner(ownerArg);
      if (!resolved) return toolError('Not Found');
      const repo = store.getRepo(resolved, repoArg);
      if (!repo) return toolError('Not Found');
      const num = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
      const pr = repo.pulls.get(num);
      if (!pr) return toolError('Not Found');
      if (pr.merged || pr.state === 'closed') return toolError('pull request is already merged or closed');
      const mergeSha = store.squashMerge(repo, pr);
      if (!mergeSha) return toolError('merge conflict');
      return toolResult({ sha: mergeSha, merged: true, message: `${pr.title} (#${pr.number})`, number: pr.number });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}
