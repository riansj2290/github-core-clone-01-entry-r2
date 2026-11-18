import { jsonBody, type HttpResult } from './util.ts';
import { VIEWER_ID, type Issue, type Pull, type Repo, type Store } from './store.ts';

// GraphQL v4 at /api/graphql. A small hand-rolled parser + executor for the
// fixed document set the suite sends: viewer/repository/node/__type queries,
// issue and pull-request connections with cursors, and the five mutations.
// Unknown fields and arguments are reported as errors naming them.

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition?: string; selection: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  variables: { name: string; defaultValue?: ValueNode }[];
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Record<string, { typeCondition: string; selection: SelectionNode[] }>;
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'var';
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ kind: 'var', value: input.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '.' && input[i + 1] === '.' && input[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of document');
    this.pos += 1;
    return t;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
  }
  private acceptPunct(value: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'punct' && t.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${t.value}`);
    return t.value;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: {} };
    while (this.pos < this.tokens.length) {
      const t = this.peek() as Token;
      if (t.kind === 'punct' && t.value === '{') {
        doc.operations.push({
          type: 'query',
          variables: [],
          selection: this.parseSelectionSet(),
        });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        this.next();
        const op: OperationNode = { type: t.value as 'query' | 'mutation', variables: [], selection: [] };
        const nameTok = this.peek();
        if (nameTok && nameTok.kind === 'name') op.name = this.next().value;
        if (this.acceptPunct('(')) {
          op.variables = this.parseVariableDefinitions();
        }
        op.selection = this.parseSelectionSet();
        doc.operations.push(op);
        continue;
      }
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        doc.fragments[name] = { typeCondition, selection: this.parseSelectionSet() };
        continue;
      }
      throw new Error(`unexpected token ${t.value}`);
    }
    return doc;
  }

  private parseVariableDefinitions(): { name: string; defaultValue?: ValueNode }[] {
    const defs: { name: string; defaultValue?: ValueNode }[] = [];
    while (!this.acceptPunct(')')) {
      const varTok = this.next();
      if (varTok.kind !== 'var') throw new Error('expected variable');
      this.expectPunct(':');
      // Type: name, possibly wrapped in [ ] and suffixed with !.
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.acceptPunct('=')) defaultValue = this.parseValue();
      defs.push({ name: varTok.value, defaultValue });
    }
    return defs;
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek() as Token;
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const next = this.peek() as Token;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value };
      }
      return { kind: 'inlineFragment', selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    // Directives: skip them.
    while (this.acceptPunct('@')) {
      this.expectName();
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
    let selection: SelectionNode[] | undefined;
    const next = this.peek();
    if (next && next.kind === 'punct' && next.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'var') return { kind: 'var', name: t.value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}

// --- Global ids and cursors ---

function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function issueCursor(repoDbId: number, number: number): string {
  return Buffer.from(`cursor:${repoDbId}:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:\d+:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

// --- Introspection tables ---

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// --- Executor ---

type GqlValue = Record<string, unknown> & { __type: string };

class GqlError extends Error {}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
  doc: DocumentNode;
}

function resolveValue(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'var': {
      if (node.name in ctx.variables) return ctx.variables[node.name];
      return undefined;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, ctx);
  return out;
}

function repoByDbId(store: Store, dbId: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.databaseId === dbId) return repo;
  }
  return undefined;
}

function findIssue(store: Store, repoDbId: number, number: number): { repo: Repo; issue: Issue } | null {
  const repo = repoByDbId(store, repoDbId);
  if (!repo) return null;
  const issue = repo.issues.get(number);
  if (!issue) return null;
  return { repo, issue };
}

function findPull(store: Store, repoDbId: number, number: number): { repo: Repo; pr: Pull } | null {
  const repo = repoByDbId(store, repoDbId);
  if (!repo) return null;
  const pr = repo.pulls.get(number);
  if (!pr) return null;
  return { repo, pr };
}

function issueValue(store: Store, repo: Repo, issue: Issue): GqlValue {
  return {
    __type: 'Issue',
    id: globalId('Issue', repo.databaseId, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state.toUpperCase(),
    body: issue.body,
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: '2025-01-01T00:00:00Z',
    author: { __type: 'User', login: store.viewerLogin, id: VIEWER_ID },
  };
}

function pullValue(store: Store, repo: Repo, pr: Pull): GqlValue {
  return {
    __type: 'PullRequest',
    id: globalId('PullRequest', repo.databaseId, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state.toUpperCase(),
    merged: pr.merged,
    headRefName: pr.head,
    baseRefName: pr.base,
    mergeable: store.prConflict(repo, pr) ? 'CONFLICTING' : 'MERGEABLE',
    createdAt: '2025-01-01T00:00:00Z',
    author: { __type: 'User', login: store.viewerLogin, id: VIEWER_ID },
    _repo: repo,
    _pr: pr,
  };
}

function repoValue(store: Store, repo: Repo): GqlValue {
  return {
    __type: 'Repository',
    id: globalId('Repository', repo.databaseId),
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __type: 'User', login: repo.owner, id: repo.owner === store.viewerLogin ? VIEWER_ID : 0 },
    defaultBranchRef: store.branchTip(repo, repo.defaultBranch)
      ? { __type: 'Ref', name: repo.defaultBranch }
      : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    url: `https://example.invalid/${repo.owner}/${repo.name}`,
    createdAt: '2025-01-01T00:00:00Z',
    _repo: repo,
  };
}

/** Paginate a list of items that carry a numeric `number`, cursor-style. */
function connectionPage<T extends { number: number }>(
  items: T[],
  first: number | undefined,
  after: string | null | undefined,
): { nodes: T[]; hasNextPage: boolean } {
  let start = 0;
  if (typeof after === 'string' && after) {
    const afterNum = decodeCursor(after);
    if (afterNum !== null) {
      const idx = items.findIndex((i) => i.number === afterNum);
      if (idx >= 0) start = idx + 1;
    }
  }
  const limit = first ?? items.length;
  const nodes = items.slice(start, start + limit);
  const hasNextPage = start + nodes.length < items.length;
  return { nodes, hasNextPage };
}

function resolveField(parent: GqlValue, field: FieldNode, ctx: ExecContext): unknown {
  const typeName = parent.__type;
  const args = argsOf(field, ctx);
  const store = ctx.store;

  if (field.name === '__typename') return typeName;

  const unknownField = (): never => {
    throw new GqlError(`Cannot query field "${field.name}" on type "${typeName}".`);
  };

  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') {
        return { __type: 'User', login: store.viewerLogin, id: VIEWER_ID };
      }
      if (field.name === 'repository') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const resolved = store.resolveOwner(owner);
        if (!resolved) return null;
        const repo = store.getRepo(resolved, name);
        return repo ? repoValue(store, repo) : null;
      }
      if (field.name === 'node') {
        const id = typeof args.id === 'string' ? args.id : '';
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = repoByDbId(store, parseInt(decoded.parts[0], 10));
          return repo ? repoValue(store, repo) : null;
        }
        if (decoded.kind === 'Issue') {
          const found = findIssue(store, parseInt(decoded.parts[0], 10), parseInt(decoded.parts[1], 10));
          return found ? issueValue(store, found.repo, found.issue) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const found = findPull(store, parseInt(decoded.parts[0], 10), parseInt(decoded.parts[1], 10));
          return found ? pullValue(store, found.repo, found.pr) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = typeof args.name === 'string' ? args.name : '';
        if (TYPE_FIELDS[name]) {
          return {
            __type: '__Type',
            name,
            kind: 'OBJECT',
            fields: TYPE_FIELDS[name].map((f) => ({ __type: '__Field', name: f })),
            enumValues: null,
          };
        }
        if (ENUM_VALUES[name]) {
          return {
            __type: '__Type',
            name,
            kind: 'ENUM',
            fields: null,
            enumValues: ENUM_VALUES[name].map((v) => ({ __type: '__EnumValue', name: v })),
          };
        }
        return null;
      }
      return unknownField();
    }
    case 'User': {
      if (field.name === 'login') return parent.login;
      if (field.name === 'id') return parent.id ?? VIEWER_ID;
      if (field.name === 'name') return parent.login === store.viewerLogin ? 'ada iversen' : null;
      if (field.name === 'email') return parent.login === store.viewerLogin ? 'adaiversen@example.invalid' : null;
      if (field.name === 'avatarUrl') return null;
      return unknownField();
    }
    case 'Repository': {
      const repo = parent._repo as Repo;
      switch (field.name) {
        case 'id': return parent.id;
        case 'databaseId': return parent.databaseId;
        case 'name': return parent.name;
        case 'nameWithOwner': return parent.nameWithOwner;
        case 'owner': return parent.owner;
        case 'defaultBranchRef': return parent.defaultBranchRef;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return parent.description;
        case 'url': return parent.url;
        case 'createdAt': return parent.createdAt;
        case 'issue': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const issue = repo.issues.get(number);
          return issue ? issueValue(store, repo, issue) : null;
        }
        case 'issues': {
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
          const direction = orderBy?.direction ?? 'DESC';
          let issues = [...repo.issues.values()];
          if (states) {
            const wanted = new Set(states.map((s) => s.toLowerCase()));
            issues = issues.filter((i) => wanted.has(i.state));
          }
          issues.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          const first = typeof args.first === 'number' ? args.first : undefined;
          const after = typeof args.after === 'string' ? args.after : null;
          const page = connectionPage(issues, first, after);
          const endCursor = page.nodes.length > 0
            ? issueCursor(repo.databaseId, page.nodes[page.nodes.length - 1].number)
            : null;
          return {
            __type: 'IssueConnection',
            nodes: page.nodes.map((i) => issueValue(store, repo, i)),
            pageInfo: { __type: 'PageInfo', hasNextPage: page.hasNextPage, endCursor },
            _repo: repo,
          };
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : undefined;
          const after = typeof args.after === 'string' ? args.after : null;
          const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
          const page = connectionPage(pulls, first, after);
          const endCursor = page.nodes.length > 0
            ? issueCursor(repo.databaseId, page.nodes[page.nodes.length - 1].number)
            : null;
          return {
            __type: 'PullRequestConnection',
            nodes: page.nodes.map((p) => pullValue(store, repo, p)),
            pageInfo: { __type: 'PageInfo', hasNextPage: page.hasNextPage, endCursor },
            _repo: repo,
          };
        }
        case 'pullRequest': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const pr = repo.pulls.get(number);
          return pr ? pullValue(store, repo, pr) : null;
        }
        default:
          return unknownField();
      }
    }
    case 'Issue': {
      if (field.name === 'id') return parent.id;
      if (field.name === 'number') return parent.number;
      if (field.name === 'title') return parent.title;
      if (field.name === 'state') return parent.state;
      if (field.name === 'body') return parent.body;
      if (field.name === 'url') return parent.url;
      if (field.name === 'createdAt') return parent.createdAt;
      if (field.name === 'author') return parent.author;
      return unknownField();
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return parent.nodes;
      if (field.name === 'pageInfo') return parent.pageInfo;
      if (field.name === 'totalCount') return (parent.nodes as unknown[]).length;
      return unknownField();
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return parent.nodes;
      if (field.name === 'pageInfo') return parent.pageInfo;
      return unknownField();
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return parent.hasNextPage;
      if (field.name === 'endCursor') return parent.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      return unknownField();
    }
    case 'PullRequest': {
      const repo = parent._repo as Repo;
      const pr = parent._pr as Pull;
      switch (field.name) {
        case 'id': return parent.id;
        case 'number': return parent.number;
        case 'title': return parent.title;
        case 'body': return parent.body;
        case 'state': return parent.state;
        case 'merged': return parent.merged;
        case 'headRefName': return parent.headRefName;
        case 'baseRefName': return parent.baseRefName;
        case 'mergeable': return parent.mergeable;
        case 'createdAt': return parent.createdAt;
        case 'author': return parent.author;
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : undefined;
          const headTip = store.branchTip(repo, pr.head) ?? pr.headSha;
          const changes = store.diffTrees(repo, pr.baseSha, headTip);
          const nodes = changes.map((c, idx) => ({
            __type: 'PullRequestChangedFile',
            path: c.path,
            number: idx,
          }));
          const page = connectionPage(nodes, first, typeof args.after === 'string' ? args.after : null);
          return {
            __type: 'PullRequestChangedFileConnection',
            nodes: page.nodes,
            pageInfo: { __type: 'PageInfo', hasNextPage: page.hasNextPage, endCursor: null },
          };
        }
        default:
          return unknownField();
      }
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return parent.path;
      return unknownField();
    }
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') return parent.nodes;
      if (field.name === 'pageInfo') return parent.pageInfo;
      return unknownField();
    }
    case 'Ref': {
      if (field.name === 'name') return parent.name;
      return unknownField();
    }
    case '__Type': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'kind') return parent.kind;
      if (field.name === 'fields') return parent.fields;
      if (field.name === 'enumValues') return parent.enumValues;
      if (field.name === 'description') return null;
      return unknownField();
    }
    case '__Field': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'description') return null;
      return unknownField();
    }
    case '__EnumValue': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'description') return null;
      return unknownField();
    }
    case 'Mutation': {
      return resolveMutation(parent, field, ctx);
    }
    default:
      return unknownField();
  }
}

function resolveMutation(parent: GqlValue, field: FieldNode, ctx: ExecContext): unknown {
  const store = ctx.store;
  const args = argsOf(field, ctx);
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeGlobalId(repoId);
      if (!decoded || decoded.kind !== 'Repository') throw new GqlError('unknown repository');
      const repo = repoByDbId(store, parseInt(decoded.parts[0], 10));
      if (!repo) throw new GqlError('unknown repository');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = store.createIssue(repo, title, body, []);
      return { __type: 'CreateIssuePayload', issue: issueValue(store, repo, issue) };
    }
    case 'closeIssue': {
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const decoded = decodeGlobalId(issueId);
      if (!decoded || decoded.kind !== 'Issue') throw new GqlError('unknown issue');
      const found = findIssue(store, parseInt(decoded.parts[0], 10), parseInt(decoded.parts[1], 10));
      if (!found) throw new GqlError('unknown issue');
      found.issue.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: issueValue(store, found.repo, found.issue) };
    }
    case 'createPullRequest': {
      const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeGlobalId(repoId);
      if (!decoded || decoded.kind !== 'Repository') throw new GqlError('unknown repository');
      const repo = repoByDbId(store, parseInt(decoded.parts[0], 10));
      if (!repo) throw new GqlError('unknown repository');
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const headSha = store.branchTip(repo, head);
      const baseSha = store.branchTip(repo, base);
      if (!headSha || !baseSha) throw new GqlError('head or base branch not found');
      const dup = [...repo.pulls.values()].find((p) => p.state === 'open' && p.head === head && p.base === base);
      if (dup) throw new GqlError('a pull request already exists for this head and base');
      const pr = store.createPull(repo, title, '', head, base, headSha, baseSha);
      return { __type: 'CreatePullRequestPayload', pullRequest: pullValue(store, repo, pr) };
    }
    case 'mergePullRequest': {
      const prId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const decoded = decodeGlobalId(prId);
      if (!decoded || decoded.kind !== 'PullRequest') throw new GqlError('unknown pull request');
      const found = findPull(store, parseInt(decoded.parts[0], 10), parseInt(decoded.parts[1], 10));
      if (!found) throw new GqlError('unknown pull request');
      const mergeSha = store.squashMerge(found.repo, found.pr);
      if (!mergeSha) throw new GqlError('merge conflict');
      return { __type: 'MergePullRequestPayload', pullRequest: pullValue(store, found.repo, found.pr) };
    }
    case 'addComment': {
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const decoded = decodeGlobalId(subjectId);
      if (!decoded || decoded.kind !== 'Issue') throw new GqlError('unknown subject');
      const found = findIssue(store, parseInt(decoded.parts[0], 10), parseInt(decoded.parts[1], 10));
      if (!found) throw new GqlError('unknown subject');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { id: found.repo.nextCommentId++, body, createdSeq: store.nextCreatedSeq() };
      found.issue.comments.push(comment);
      return {
        __type: 'AddCommentPayload',
        commentEdge: {
          __type: 'IssueCommentEdge',
          node: {
            __type: 'IssueComment',
            id: globalId('IssueComment', found.repo.databaseId, found.issue.number, comment.id),
            body,
          },
        },
      };
    }
    default:
      throw new GqlError(`Cannot query field "${field.name}" on type "Mutation".`);
  }
}

/** Resolve a payload object's fields (createIssue/closeIssue/... wrappers). */
function resolvePayloadField(parent: GqlValue, field: FieldNode, ctx: ExecContext): unknown {
  if (field.name === '__typename') return parent.__type;
  const known: Record<string, string[]> = {
    CreateIssuePayload: ['issue'],
    CloseIssuePayload: ['issue'],
    CreatePullRequestPayload: ['pullRequest'],
    MergePullRequestPayload: ['pullRequest'],
    AddCommentPayload: ['commentEdge'],
    IssueCommentEdge: ['node'],
    IssueComment: ['id', 'body'],
  };
  const allowed = known[parent.__type] ?? [];
  if (field.name === 'issue' && allowed.includes('issue')) return parent.issue;
  if (field.name === 'pullRequest' && allowed.includes('pullRequest')) return parent.pullRequest;
  if (field.name === 'commentEdge' && allowed.includes('commentEdge')) return parent.commentEdge;
  if (field.name === 'node' && allowed.includes('node')) return parent.node;
  if (field.name === 'id' && allowed.includes('id')) return parent.id;
  if (field.name === 'body' && allowed.includes('body')) return parent.body;
  throw new GqlError(`Cannot query field "${field.name}" on type "${parent.__type}".`);
}

function executeSelections(
  parent: GqlValue,
  selections: SelectionNode[],
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inlineFragment') {
      if (!sel.typeCondition || sel.typeCondition === parent.__type) {
        Object.assign(out, executeSelections(parent, sel.selection, ctx));
      }
      continue;
    }
    if (sel.kind === 'fragmentSpread') {
      const frag = ctx.doc.fragments[sel.name];
      if (frag && (!frag.typeCondition || frag.typeCondition === parent.__type)) {
        Object.assign(out, executeSelections(parent, frag.selection, ctx));
      }
      continue;
    }
    const field = sel;
    const responseName = field.alias ?? field.name;
    try {
      let value: unknown;
      if (parent.__type === 'CreateIssuePayload' || parent.__type === 'CloseIssuePayload' ||
        parent.__type === 'CreatePullRequestPayload' || parent.__type === 'MergePullRequestPayload' ||
        parent.__type === 'AddCommentPayload' || parent.__type === 'IssueCommentEdge' ||
        parent.__type === 'IssueComment') {
        value = resolvePayloadField(parent, field, ctx);
      } else {
        value = resolveField(parent, field, ctx);
      }
      out[responseName] = projectValue(value, field.selection, ctx);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.errors.push({ message });
      out[responseName] = null;
    }
  }
  return out;
}

function projectValue(value: unknown, selection: SelectionNode[] | undefined, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => projectValue(v, selection, ctx));
  if (typeof value === 'object') {
    const obj = value as GqlValue;
    if (!selection || selection.length === 0) return obj;
    if (!obj.__type) {
      // Plain object (e.g. pageInfo built inline already has __type; this is a fallback).
      return obj;
    }
    return executeSelections(obj, selection, ctx);
  }
  return value;
}

function executeOperation(
  store: Store,
  doc: DocumentNode,
  op: OperationNode,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const ctx: ExecContext = { store, variables: { ...variables }, errors: [], doc };
  for (const v of op.variables) {
    if (!(v.name in ctx.variables) && v.defaultValue) {
      ctx.variables[v.name] = resolveValue(v.defaultValue, ctx);
    }
  }
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlValue = { __type: rootType };
  try {
    const data = executeSelections(root, op.selection, ctx);
    const result: { data: Record<string, unknown> | null; errors?: { message: string }[] } = { data };
    if (ctx.errors.length > 0) result.errors = ctx.errors;
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { data: null, errors: [...ctx.errors, { message }] };
  }
}

function executeRequest(store: Store, body: unknown): unknown {
  const run = (single: unknown): unknown => {
    const req = single as Record<string, unknown>;
    const query = typeof req.query === 'string' ? req.query : '';
    const variables = (req.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof req.operationName === 'string' ? req.operationName : undefined;
    let doc: DocumentNode;
    try {
      doc = new Parser(lex(query)).parseDocument();
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
    let op: OperationNode | undefined;
    if (operationName) {
      op = doc.operations.find((o) => o.name === operationName);
    } else if (doc.operations.length === 1) {
      op = doc.operations[0];
    } else {
      op = doc.operations[0];
    }
    if (!op) return { data: null, errors: [{ message: 'unknown operation' }] };
    return executeOperation(store, doc, op, variables);
  };
  if (Array.isArray(body)) return body.map(run);
  return run(body);
}

export function handleGraphql(store: Store, body: Buffer, authed: boolean): HttpResult {
  if (!authed) {
    return { status: 401, contentType: 'application/json', body: jsonBody({ message: 'Requires authentication' }) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, contentType: 'application/json', body: jsonBody({ message: 'malformed JSON body' }) };
  }
  const result = executeRequest(store, parsed);
  return { status: 200, contentType: 'application/json', body: jsonBody(result) };
}
