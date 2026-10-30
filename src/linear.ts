// Minimal Linear GraphQL client. Linear is the shared task queue: commands, sub-tasks, handoffs and evidence all live there.
import { PROJECT_ID } from "../api/lib/console-state.js";
import { STATUS_TITLE } from "../api/lib/engine-status.js";
import { LEDGER_TITLE, ledgerFromContent } from "./budget.ts";

type Fetch = typeof fetch;

export type StateType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled" | "duplicate";

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  priority: number;
  stateType: StateType;
  stateName: string;
  labels: string[];
  assignee: string | null;
  parentId: string | null;
  childIds: string[];
  createdAt: string;
}

export interface TaskStore {
  listOpenAndRecent(teamKey: string): Promise<Issue[]>;
  getComments(issueId: string): Promise<{ body: string; createdAt: string }[]>;
  /** Fresh labels for one issue; used for the final claim check. Optional so simple stores can skip it. */
  getLabels?(issueId: string): Promise<string[]>;
  createIssue(input: { teamKey: string; title: string; description: string; parentId?: string; priority?: number }): Promise<Issue>;
  comment(issueId: string, body: string): Promise<void>;
  setState(issueId: string, teamKey: string, type: StateType): Promise<void>;
  /** Replaces the engine status document the dashboard reads. Optional so simple stores can skip it. */
  publishStatus?(content: string): Promise<void>;
  /**
   * The durable spend ledger's JSON value: `null` when the document doesn't exist yet, `"unreadable"` when it has no
   * parseable ledger. Throws when Linear can't be read.
   */
  readLedger?(): Promise<unknown>;
  saveLedger?(content: string): Promise<void>;
}

interface TeamInfo {
  id: string;
  states: { id: string; type: StateType; position: number }[];
}

/** Document pages findDoc reads (50 each) before giving up on an incomplete list. */
const DOC_PAGES = 4;
const ISSUE_FIELDS = `
  id identifier title description url priority createdAt
  state { type name }
  labels { nodes { name } }
  assignee { name }
  parent { id }
  children { nodes { id } }
`;

function toIssue(n: any): Issue {
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description ?? "",
    url: n.url,
    priority: n.priority ?? 0,
    stateType: n.state?.type,
    stateName: n.state?.name ?? "",
    labels: (n.labels?.nodes ?? []).map((l: any) => l.name),
    assignee: n.assignee?.name ?? null,
    parentId: n.parent?.id ?? null,
    childIds: (n.children?.nodes ?? []).map((c: any) => c.id),
    createdAt: n.createdAt,
  };
}

export class LinearStore implements TaskStore {
  private teamCache = new Map<string, TeamInfo>();
  private docIds = new Map<string, string>();
  private readonly apiKey: string;
  private readonly f: Fetch;

  constructor(apiKey: string, f: Fetch = fetch) {
    this.apiKey = apiKey;
    this.f = f;
  }

  private async gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.f("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || j.errors) throw new Error(`Linear ${res.status}: ${JSON.stringify(j.errors ?? j).slice(0, 400)}`);
    return j.data as T;
  }

  private async team(teamKey: string): Promise<TeamInfo> {
    const hit = this.teamCache.get(teamKey);
    if (hit) return hit;
    const d = await this.gql(
      `query($key:String!){ teams(filter:{key:{eq:$key}}){ nodes { id states { nodes { id type position } } } } }`,
      { key: teamKey },
    );
    const t = d.teams.nodes[0];
    if (!t) throw new Error(`Linear team ${teamKey} not found`);
    const v: TeamInfo = { id: t.id, states: t.states.nodes };
    this.teamCache.set(teamKey, v);
    return v;
  }

  async listOpenAndRecent(teamKey: string): Promise<Issue[]> {
    const since = new Date(Date.now() - 14 * 864e5).toISOString();
    const d = await this.gql(
      `query($key:String!,$since:DateTimeOrDuration!){
        issues(first:250, orderBy:updatedAt, filter:{ team:{ key:{ eq:$key } }, or:[
          { state:{ type:{ in:["triage","backlog","unstarted","started"] } } },
          { completedAt:{ gte:$since } },
          { canceledAt:{ gte:$since } } ] }){ nodes { ${ISSUE_FIELDS} } } }`,
      { key: teamKey, since },
    );
    return d.issues.nodes.map(toIssue);
  }

  async getLabels(issueId: string) {
    const d = await this.gql(`query($id:String!){ issue(id:$id){ labels { nodes { name } } } }`, { id: issueId });
    return (d.issue.labels?.nodes ?? []).map((l: any) => l.name as string);
  }

  async getComments(issueId: string) {
    // Page through every comment: claim ownership depends on the earliest claim, which may not be on page one.
    const out: { body: string; createdAt: string }[] = [];
    let after: string | null = null;
    for (let page = 0; page < 50; page++) {
      const d: any = await this.gql(
        `query($id:String!,$after:String){ issue(id:$id){ comments(first:100, after:$after){ nodes { body createdAt } pageInfo { hasNextPage endCursor } } } }`,
        { id: issueId, after },
      );
      const c = d.issue.comments;
      out.push(...c.nodes);
      if (!c.pageInfo?.hasNextPage) return out;
      after = c.pageInfo.endCursor;
    }
    throw new Error(`issue ${issueId} has more comments than ACP will page through; refusing to guess the earliest claim`);
  }

  async createIssue(input: { teamKey: string; title: string; description: string; parentId?: string; priority?: number }) {
    const t = await this.team(input.teamKey);
    const d = await this.gql(
      `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue { ${ISSUE_FIELDS} } } }`,
      {
        input: {
          teamId: t.id,
          title: input.title,
          description: input.description,
          ...(input.parentId ? { parentId: input.parentId } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
        },
      },
    );
    return toIssue(d.issueCreate.issue);
  }

  async comment(issueId: string, body: string) {
    await this.gql(`mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success } }`, { input: { issueId, body } });
  }

  async setState(issueId: string, teamKey: string, type: StateType) {
    const t = await this.team(teamKey);
    const state = t.states.filter((s) => s.type === type).sort((a, b) => a.position - b.position)[0];
    if (!state) throw new Error(`No ${type} state in team ${teamKey}`);
    await this.gql(`mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id,input:$input){ success } }`, {
      id: issueId,
      input: { stateId: state.id },
    });
  }

  publishStatus(content: string) {
    return this.upsertDoc(STATUS_TITLE, content);
  }

  async readLedger(): Promise<unknown> {
    const doc = await this.findDoc(LEDGER_TITLE);
    if (!doc) return null;
    return ledgerFromContent(doc.content ?? "") ?? "unreadable";
  }

  saveLedger(content: string) {
    return this.upsertDoc(LEDGER_TITLE, content);
  }

  /**
   * The engine's own document with this title in the fixed project (the oldest, if someone duplicated it). Follows
   * document pages up to DOC_PAGES and answers only from the whole list: a malformed page, a missing cursor or a list
   * still incomplete at the cap throws. So a ledger on an unread page reads as unreadable (paid calls blocked), is
   * never mistaken for absent and duplicated by a create, and "oldest" is never chosen from part of the list.
   */
  private async findDoc(title: string): Promise<{ id: string; content?: string } | null> {
    const docs: { id: string; title?: string; content?: string; createdAt?: string }[] = [];
    let after: string | null = null;
    let more: unknown = true;
    for (let page = 0; page < DOC_PAGES && more === true; page++) {
      const d: { project?: { documents?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: string | null } } } } = await this.gql(
        `query($p:String!,$after:String){ project(id:$p){ documents(first:50, after:$after){ nodes { id title content createdAt } pageInfo { hasNextPage endCursor } } } }`,
        { p: PROJECT_ID, after },
      );
      const list = d.project?.documents;
      if (!list || !Array.isArray(list.nodes)) throw new Error("Linear returned an unreadable document list");
      docs.push(...list.nodes.filter((n: { title?: string }) => n?.title === title));
      more = list.pageInfo?.hasNextPage;
      after = list.pageInfo?.endCursor ?? null;
      if (more === true && (typeof after !== "string" || !after)) break;
    }
    if (more !== false) throw new Error(`the project's document list could not be read in full, so "${title}" may exist unseen`);
    docs.sort((a: { createdAt?: string }, b: { createdAt?: string }) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
    if (docs[0]) this.docIds.set(title, docs[0].id);
    return docs[0] ?? null;
  }

  private async upsertDoc(title: string, content: string) {
    const id = this.docIds.get(title) ?? (await this.findDoc(title))?.id;
    if (id) {
      const d = await this.gql(`mutation($id:String!,$input:DocumentUpdateInput!){ documentUpdate(id:$id,input:$input){ success } }`, {
        id,
        input: { content },
      });
      if (!d.documentUpdate?.success) throw new Error(`Linear did not update "${title}"`);
      return;
    }
    const d = await this.gql(`mutation($input:DocumentCreateInput!){ documentCreate(input:$input){ success document { id } } }`, {
      input: { projectId: PROJECT_ID, title, content },
    });
    if (!d.documentCreate?.success || !d.documentCreate.document?.id) throw new Error(`Linear did not create "${title}"`);
    this.docIds.set(title, d.documentCreate.document.id);
  }
}

/** Wraps a store so writes are logged, not performed. Reads still hit Linear. */
export class DryRunStore implements TaskStore {
  readonly log: string[] = [];
  private n = 0;
  private readonly inner: TaskStore;
  /** Only present when the wrapped store has it, so callers keep the issue-snapshot fallback otherwise. */
  readonly getLabels?: (issueId: string) => Promise<string[]>;
  constructor(inner: TaskStore) {
    this.inner = inner;
    if (inner.getLabels) this.getLabels = (issueId) => inner.getLabels!(issueId);
  }
  listOpenAndRecent(teamKey: string) {
    return this.inner.listOpenAndRecent(teamKey);
  }
  getComments(issueId: string) {
    return this.inner.getComments(issueId);
  }
  async createIssue(input: { teamKey: string; title: string; description: string; parentId?: string; priority?: number }): Promise<Issue> {
    this.n += 1;
    this.log.push(`would create issue "${input.title}"${input.parentId ? ` under ${input.parentId}` : ""}`);
    return {
      id: `dry-${this.n}`,
      identifier: `DRY-${this.n}`,
      title: input.title,
      description: input.description,
      url: "",
      priority: input.priority ?? 0,
      stateType: "unstarted",
      stateName: "Todo",
      labels: [],
      assignee: null,
      parentId: input.parentId ?? null,
      childIds: [],
      createdAt: new Date().toISOString(),
    };
  }
  async comment(issueId: string, body: string) {
    this.log.push(`would comment on ${issueId}: ${body.slice(0, 120).replace(/\n/g, " ")}…`);
  }
  async setState(issueId: string, _teamKey: string, type: StateType) {
    this.log.push(`would move ${issueId} to ${type}`);
  }
  async publishStatus(_content: string) {
    this.log.push("would update the engine status document");
  }
  /** Reads the real durable ledger, so a dry run checks spend exactly as a live run would. */
  async readLedger(): Promise<unknown> {
    return this.inner.readLedger ? this.inner.readLedger() : null;
  }
  async saveLedger(_content: string) {
    this.log.push("would update the spend ledger document");
  }
}
