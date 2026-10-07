// Minimal Linear GraphQL client. Linear is the shared task queue: commands, sub-tasks, handoffs and evidence all live there.

type Fetch = typeof fetch;

export type StateType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";

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
  createIssue(input: { teamKey: string; title: string; description: string; parentId?: string; priority?: number }): Promise<Issue>;
  comment(issueId: string, body: string): Promise<void>;
  setState(issueId: string, teamKey: string, type: StateType): Promise<void>;
}

interface TeamInfo {
  id: string;
  states: { id: string; type: StateType; position: number }[];
}

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
          { completedAt:{ gte:$since } } ] }){ nodes { ${ISSUE_FIELDS} } } }`,
      { key: teamKey, since },
    );
    return d.issues.nodes.map(toIssue);
  }

  async getComments(issueId: string) {
    const d = await this.gql(`query($id:String!){ issue(id:$id){ comments(first:100){ nodes { body createdAt } } } }`, { id: issueId });
    return d.issue.comments.nodes;
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
}

/** Wraps a store so writes are logged, not performed. Reads still hit Linear. */
export class DryRunStore implements TaskStore {
  readonly log: string[] = [];
  private n = 0;
  private readonly inner: TaskStore;
  constructor(inner: TaskStore) {
    this.inner = inner;
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
}
