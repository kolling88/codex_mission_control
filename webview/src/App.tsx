import { useEffect, useMemo, useState } from 'react';

declare global {
  interface Window {
    acquireVsCodeApi?: () => { postMessage: (message: unknown) => void };
  }
}

const vscode = window.acquireVsCodeApi?.() ?? { postMessage: (message: unknown) => console.log(message) };

type SessionStatus = 'active' | 'idle' | 'done' | 'error';

interface CodexSession {
  id: string;
  sessionId?: string;
  parentThreadId?: string;
  filePath: string;
  fileName: string;
  cwd?: string;
  workspaceName?: string;
  gitBranch?: string;
  model?: string;
  modelProvider?: string;
  agentNickname?: string;
  agentRole?: string;
  title: string;
  preview?: string;
  lastToolName?: string;
  toolCallCount: number;
  errorCount: number;
  taskComplete: boolean;
  taskStarted: boolean;
  createdAt?: string;
  updatedAt?: string;
  updatedAtMs: number;
  status: SessionStatus;
  isSubagent: boolean;
}

interface MissionCard {
  id: string;
  title: string;
  parent?: CodexSession;
  children: CodexSession[];
  childCount: number;
  activeCount: number;
  doneCount: number;
  errorCount: number;
  status: SessionStatus;
  cwd?: string;
  workspaceName?: string;
  gitBranch?: string;
  model?: string;
  updatedAt?: string;
  updatedAtMs: number;
  isVirtualParent: boolean;
}

interface MissionControlData {
  generatedAt: string;
  codexHome: string;
  sessionsRoot: string;
  missions: MissionCard[];
  sessions: CodexSession[];
  metrics: {
    totalSessions: number;
    totalMissions: number;
    totalSubagents: number;
    activeSessions: number;
    doneSessions: number;
    errorSessions: number;
    parsedFiles: number;
    skippedFiles: number;
  };
}

interface Diagnostics {
  codexHome: string;
  codexHomeExists: boolean;
  sessionsRoot: string;
  sessionsRootExists: boolean;
  sessionIndexPath: string;
  sessionIndexExists: boolean;
  stateDbPath: string;
  stateDbExists: boolean;
  jsonlFileCount: number;
  newestJsonl?: string;
  newestJsonlUpdatedAt?: string;
}

type FilterStatus = 'all' | SessionStatus;

export function App() {
  const [data, setData] = useState<MissionControlData | undefined>();
  const [diagnostics, setDiagnostics] = useState<Diagnostics | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('all');
  const [projectFilter, setProjectFilter] = useState('all');
  const [compact, setCompact] = useState(true);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'data') {
        setData(message.data);
        setError(undefined);
      }
      if (message.type === 'diagnostics') {
        setDiagnostics(message.diagnostics);
      }
      if (message.type === 'error') {
        setError(message.message);
      }
    };

    window.addEventListener('message', listener);
    vscode.postMessage({ type: 'ready' });

    return () => window.removeEventListener('message', listener);
  }, []);

  const projects = useMemo(() => {
    const names = new Set<string>();
    for (const mission of data?.missions ?? []) {
      if (mission.workspaceName) {
        names.add(mission.workspaceName);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [data]);

  const filteredMissions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (data?.missions ?? []).filter((mission) => {
      if (statusFilter !== 'all' && mission.status !== statusFilter) {
        return false;
      }
      if (projectFilter !== 'all' && mission.workspaceName !== projectFilter) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const haystack = [
        mission.title,
        mission.cwd,
        mission.gitBranch,
        mission.model,
        mission.parent?.preview,
        ...mission.children.flatMap((child) => [child.title, child.preview, child.agentRole, child.agentNickname, child.lastToolName])
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [data, projectFilter, query, statusFilter]);

  return (
    <main className={compact ? 'app compact' : 'app'}>
      <header className="topbar">
        <div>
          <h1>Codex Mission Control</h1>
          <p>Parent chats, subagents e sinais vitais do Codex local.</p>
        </div>
        <div className="actions">
          <button onClick={() => vscode.postMessage({ type: 'refresh' })}>Refresh</button>
          <button onClick={() => vscode.postMessage({ type: 'showDiagnostics' })}>Diagnostics</button>
          <button onClick={() => vscode.postMessage({ type: 'openCodexHome' })}>Open .codex</button>
        </div>
      </header>

      {data && <Metrics data={data} />}
      {error && <div className="banner error">{error}</div>}
      {diagnostics && <DiagnosticsPanel diagnostics={diagnostics} />}

      <section className="filters">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por projeto, branch, ferramenta, preview..." />
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as FilterStatus)}>
          <option value="all">Todos status</option>
          <option value="active">Ativos</option>
          <option value="idle">Idle</option>
          <option value="done">Done</option>
          <option value="error">Erros</option>
        </select>
        <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
          <option value="all">Todos projetos</option>
          {projects.map((project) => (
            <option key={project} value={project}>{project}</option>
          ))}
        </select>
        <label className="toggle">
          <input type="checkbox" checked={compact} onChange={(event) => setCompact(event.target.checked)} />
          Compacto
        </label>
      </section>

      {!data && <div className="empty">Lendo sessões do Codex...</div>}

      {data && filteredMissions.length === 0 && (
        <div className="empty">Nenhuma missão bateu com os filtros. O radar está limpo, por enquanto.</div>
      )}

      <section className="mission-grid">
        {filteredMissions.map((mission) => (
          <MissionCardView key={mission.id} mission={mission} />
        ))}
      </section>

      {data && (
        <footer className="footer">
          Atualizado em {formatDateTime(data.generatedAt)} · {data.sessionsRoot}
        </footer>
      )}
    </main>
  );
}

function Metrics({ data }: { data: MissionControlData }) {
  return (
    <section className="metrics">
      <Metric label="Missões" value={data.metrics.totalMissions} />
      <Metric label="Subagentes" value={data.metrics.totalSubagents} />
      <Metric label="Ativos" value={data.metrics.activeSessions} tone="active" />
      <Metric label="Done" value={data.metrics.doneSessions} tone="done" />
      <Metric label="Erros" value={data.metrics.errorSessions} tone="error" />
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <article className={`metric ${tone ?? ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </article>
  );
}

function DiagnosticsPanel({ diagnostics }: { diagnostics: Diagnostics }) {
  return (
    <section className="diagnostics">
      <div><strong>Codex home</strong><span>{diagnostics.codexHomeExists ? 'ok' : 'não encontrado'}</span></div>
      <div><strong>Sessions</strong><span>{diagnostics.sessionsRootExists ? `${diagnostics.jsonlFileCount} JSONL` : 'não encontrado'}</span></div>
      <div><strong>session_index</strong><span>{diagnostics.sessionIndexExists ? 'ok' : 'ausente'}</span></div>
      <div><strong>state_5.sqlite</strong><span>{diagnostics.stateDbExists ? 'ok' : 'ausente'}</span></div>
    </section>
  );
}

function MissionCardView({ mission }: { mission: MissionCard }) {
  const parent = mission.parent;
  return (
    <article className={`mission-card status-${mission.status}`}>
      <header className="mission-header">
        <div>
          <div className="eyebrow">{mission.isVirtualParent ? 'Parent inferido' : 'Parent chat'}</div>
          <h2 title={mission.title}>{mission.title}</h2>
        </div>
        <StatusPill status={mission.status} />
      </header>

      <div className="meta-row">
        {mission.workspaceName && <Chip label={mission.workspaceName} />}
        {mission.gitBranch && <Chip label={mission.gitBranch} />}
        {mission.model && <Chip label={mission.model} />}
        <Chip label={`${mission.childCount} subagente${mission.childCount === 1 ? '' : 's'}`} />
      </div>

      {parent?.preview && <p className="preview">{parent.preview}</p>}

      <div className="mission-actions">
        {mission.cwd && <button onClick={() => vscode.postMessage({ type: 'revealPath', path: mission.cwd })}>Projeto</button>}
        {parent?.filePath && <button onClick={() => vscode.postMessage({ type: 'openFile', filePath: parent.filePath })}>JSONL</button>}
        <button onClick={() => copyText(mission.id)}>Thread ID</button>
      </div>

      <section className="subagents">
        {mission.children.length === 0 && <div className="no-subagents">Sem subagentes detectados.</div>}
        {mission.children.map((child) => (
          <SubagentCard key={child.id} session={child} />
        ))}
      </section>

      <footer className="mission-footer">
        <span>{formatRelative(mission.updatedAtMs)}</span>
        {mission.errorCount > 0 && <span>{mission.errorCount} erro(s)</span>}
        {mission.activeCount > 0 && <span>{mission.activeCount} ativo(s)</span>}
      </footer>
    </article>
  );
}

function SubagentCard({ session }: { session: CodexSession }) {
  return (
    <article className={`subagent-card status-${session.status}`}>
      <div className="subagent-main">
        <StatusDot status={session.status} />
        <div>
          <h3 title={session.title}>{session.title}</h3>
          <p>{session.agentRole || session.lastToolName || session.fileName}</p>
        </div>
      </div>
      {session.preview && <p className="preview small">{session.preview}</p>}
      <div className="subagent-meta">
        {session.lastToolName && <span>{session.lastToolName}</span>}
        {session.toolCallCount > 0 && <span>{session.toolCallCount} tools</span>}
        <span>{formatRelative(session.updatedAtMs)}</span>
      </div>
      <div className="subagent-actions">
        <button onClick={() => vscode.postMessage({ type: 'openFile', filePath: session.filePath })}>JSONL</button>
        <button onClick={() => copyText(session.id)}>ID</button>
      </div>
    </article>
  );
}

function Chip({ label }: { label: string }) {
  return <span className="chip" title={label}>{label}</span>;
}

function StatusPill({ status }: { status: SessionStatus }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}

function StatusDot({ status }: { status: SessionStatus }) {
  return <span className={`status-dot status-${status}`} />;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(new Date(value));
}

function formatRelative(ms: number): string {
  if (!ms) {
    return 'sem data';
  }
  const diff = Date.now() - ms;
  const minutes = Math.max(0, Math.round(diff / 60000));
  if (minutes < 1) {
    return 'agora';
  }
  if (minutes < 60) {
    return `${minutes} min atrás`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h atrás`;
  }
  const days = Math.round(hours / 24);
  return `${days} d atrás`;
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // VS Code webviews may deny clipboard in some contexts. Ignore quietly.
  }
}
