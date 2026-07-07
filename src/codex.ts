import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type SessionStatus = 'active' | 'idle' | 'done' | 'error';

export interface MissionControlSettings {
  codexHome: string;
  maxSessions: number;
  activeThresholdMinutes: number;
  showPreview: boolean;
}

export interface CodexSession {
  id: string;
  sessionId?: string;
  parentThreadId?: string;
  filePath: string;
  fileName: string;
  cwd?: string;
  workspaceName?: string;
  gitBranch?: string;
  gitOriginUrl?: string;
  model?: string;
  modelProvider?: string;
  source?: string;
  threadSource?: string;
  agentNickname?: string;
  agentRole?: string;
  cliVersion?: string;
  title: string;
  preview?: string;
  firstUserPreview?: string;
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

export interface MissionCard {
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

export interface MissionControlData {
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

export interface CodexDiagnostics {
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
  settings: MissionControlSettings;
}

interface FileCandidate {
  filePath: string;
  fileName: string;
  size: number;
  mtimeMs: number;
}

export function resolveCodexHome(configuredCodexHome?: string): string {
  const configured = configuredCodexHome?.trim();
  if (configured) {
    return normalizeHomePath(configured);
  }

  const envHome = process.env.CODEX_HOME?.trim();
  if (envHome) {
    return normalizeHomePath(envHome);
  }

  return path.join(os.homedir(), '.codex');
}

export async function collectMissionControlData(settings: MissionControlSettings): Promise<MissionControlData> {
  const codexHome = resolveCodexHome(settings.codexHome);
  const sessionsRoot = path.join(codexHome, 'sessions');
  const files = await findJsonlFiles(sessionsRoot, settings.maxSessions);

  const sessions: CodexSession[] = [];
  let skippedFiles = 0;

  for (const file of files) {
    const session = await parseSessionFile(file, settings).catch(() => undefined);
    if (session) {
      sessions.push(session);
    } else {
      skippedFiles += 1;
    }
  }

  const missions = buildMissionCards(sessions);

  return {
    generatedAt: new Date().toISOString(),
    codexHome,
    sessionsRoot,
    missions,
    sessions,
    metrics: {
      totalSessions: sessions.length,
      totalMissions: missions.length,
      totalSubagents: sessions.filter((session) => session.isSubagent).length,
      activeSessions: sessions.filter((session) => session.status === 'active').length,
      doneSessions: sessions.filter((session) => session.status === 'done').length,
      errorSessions: sessions.filter((session) => session.status === 'error').length,
      parsedFiles: sessions.length,
      skippedFiles
    }
  };
}

export async function getDiagnostics(settings: MissionControlSettings): Promise<CodexDiagnostics> {
  const codexHome = resolveCodexHome(settings.codexHome);
  const sessionsRoot = path.join(codexHome, 'sessions');
  const sessionIndexPath = path.join(codexHome, 'session_index.jsonl');
  const stateDbPath = path.join(codexHome, 'state_5.sqlite');
  const files = await findJsonlFiles(sessionsRoot, settings.maxSessions).catch(() => []);
  const newest = files[0];

  return {
    codexHome,
    codexHomeExists: syncFs.existsSync(codexHome),
    sessionsRoot,
    sessionsRootExists: syncFs.existsSync(sessionsRoot),
    sessionIndexPath,
    sessionIndexExists: syncFs.existsSync(sessionIndexPath),
    stateDbPath,
    stateDbExists: syncFs.existsSync(stateDbPath),
    jsonlFileCount: files.length,
    newestJsonl: newest?.filePath,
    newestJsonlUpdatedAt: newest ? new Date(newest.mtimeMs).toISOString() : undefined,
    settings
  };
}

async function findJsonlFiles(root: string, maxFiles: number): Promise<FileCandidate[]> {
  const candidates: FileCandidate[] = [];
  const pending = [root];
  const maxVisitedDirectories = 2000;
  let visitedDirectories = 0;

  while (pending.length > 0 && visitedDirectories < maxVisitedDirectories) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    visitedDirectories += 1;

    let entries: syncFs.Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        const stat = await fs.stat(fullPath).catch(() => undefined);
        if (stat) {
          candidates.push({
            filePath: fullPath,
            fileName: entry.name,
            size: stat.size,
            mtimeMs: stat.mtimeMs
          });
        }
      }
    }
  }

  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.max(10, maxFiles));
}

async function parseSessionFile(file: FileCandidate, settings: MissionControlSettings): Promise<CodexSession | undefined> {
  const text = await readJsonlSample(file.filePath, file.size);
  const lines = text.split(/\r?\n/).filter(Boolean);

  let meta: Record<string, unknown> = {};
  let turnContext: Record<string, unknown> = {};
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let firstUserPreview: string | undefined;
  let lastAssistantPreview: string | undefined;
  let lastToolName: string | undefined;
  let toolCallCount = 0;
  let errorCount = 0;
  let taskComplete = false;
  let taskStarted = false;

  for (const line of lines) {
    const parsed = safeJsonParse(line);
    if (!parsed) {
      continue;
    }

    const topType = stringValue(parsed.type);
    const timestamp = stringValue(parsed.timestamp);
    if (timestamp) {
      firstTimestamp ??= timestamp;
      lastTimestamp = timestamp;
    }

    const payload = isRecord(parsed.payload) ? parsed.payload : {};
    const payloadType = stringValue(payload.type);

    if (topType === 'session_meta') {
      meta = { ...meta, ...payload };
      continue;
    }

    if (topType === 'turn_context') {
      turnContext = { ...turnContext, ...payload };
      continue;
    }

    if (topType === 'event_msg') {
      if (payloadType === 'task_started') {
        taskStarted = true;
      }
      if (payloadType === 'task_complete') {
        taskComplete = true;
      }
      if (payloadType === 'patch_apply_end' && payload.success === false) {
        errorCount += 1;
      }
      if (payloadType === 'agent_message') {
        const preview = cleanPreview(extractText(payload.message));
        if (preview) {
          lastAssistantPreview = preview;
        }
      }
      if (payloadType === 'user_message' && !firstUserPreview) {
        const preview = cleanPreview(extractText(payload.message) || extractText(payload.text_elements));
        if (preview) {
          firstUserPreview = preview;
        }
      }
      continue;
    }

    if (topType === 'response_item') {
      if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
        toolCallCount += 1;
        lastToolName = formatToolName(payload);
      }

      if (payloadType === 'message') {
        const role = stringValue(payload.role);
        const preview = cleanPreview(extractText(payload.content));
        if (preview && role === 'assistant') {
          lastAssistantPreview = preview;
        }
        if (preview && role === 'user' && !firstUserPreview) {
          firstUserPreview = preview;
        }
      }
    }
  }

  const inferredId = inferThreadIdFromFileName(file.fileName);
  const id = stringValue(meta.id) || stringValue(meta.session_id) || inferredId;
  if (!id) {
    return undefined;
  }

  const parentThreadId = stringValue(meta.parent_thread_id) || undefined;
  const cwd = stringValue(meta.cwd) || stringValue(turnContext.cwd) || undefined;
  const git = isRecord(meta.git) ? meta.git : undefined;
  const workspaceName = cwd ? path.basename(cwd) : undefined;
  const updatedAtMs = toTimeMs(lastTimestamp) ?? file.mtimeMs;
  const activeThresholdMs = Math.max(1, settings.activeThresholdMinutes) * 60 * 1000;
  const isRecentlyTouched = Date.now() - updatedAtMs <= activeThresholdMs;
  const status = inferStatus({ taskComplete, errorCount, isRecentlyTouched });
  const preview = settings.showPreview ? lastAssistantPreview || firstUserPreview : undefined;
  const title = buildTitle({
    agentNickname: stringValue(meta.agent_nickname),
    agentRole: stringValue(meta.agent_role),
    firstUserPreview,
    cwd,
    id,
    isSubagent: Boolean(parentThreadId)
  });

  return {
    id,
    sessionId: stringValue(meta.session_id) || undefined,
    parentThreadId,
    filePath: file.filePath,
    fileName: file.fileName,
    cwd,
    workspaceName,
    gitBranch: stringValue(git?.branch) || stringValue(git?.git_branch) || undefined,
    gitOriginUrl: stringValue(git?.origin_url) || stringValue(git?.origin) || undefined,
    model: stringValue(turnContext.model) || stringValue(meta.model) || undefined,
    modelProvider: stringValue(meta.model_provider) || undefined,
    source: stringValue(meta.source) || undefined,
    threadSource: stringValue(meta.thread_source) || undefined,
    agentNickname: stringValue(meta.agent_nickname) || undefined,
    agentRole: stringValue(meta.agent_role) || undefined,
    cliVersion: stringValue(meta.cli_version) || undefined,
    title,
    preview,
    firstUserPreview: settings.showPreview ? firstUserPreview : undefined,
    lastToolName,
    toolCallCount,
    errorCount,
    taskComplete,
    taskStarted,
    createdAt: firstTimestamp,
    updatedAt: lastTimestamp || new Date(file.mtimeMs).toISOString(),
    updatedAtMs,
    status,
    isSubagent: Boolean(parentThreadId)
  };
}

async function readJsonlSample(filePath: string, fileSize: number): Promise<string> {
  const maxBytes = 768 * 1024;
  if (fileSize <= maxBytes) {
    return fs.readFile(filePath, 'utf8');
  }

  const headBytes = 192 * 1024;
  const tailBytes = maxBytes - headBytes;
  const handle = await fs.open(filePath, 'r');
  try {
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    const headRead = await handle.read(head, 0, headBytes, 0);
    const tailStart = Math.max(0, fileSize - tailBytes);
    const tailRead = await handle.read(tail, 0, tailBytes, tailStart);
    return `${head.subarray(0, headRead.bytesRead).toString('utf8')}\n${tail.subarray(0, tailRead.bytesRead).toString('utf8')}`;
  } finally {
    await handle.close();
  }
}

function buildMissionCards(sessions: CodexSession[]): MissionCard[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const childrenByParent = new Map<string, CodexSession[]>();

  for (const session of sessions) {
    if (!session.parentThreadId) {
      continue;
    }
    const children = childrenByParent.get(session.parentThreadId) ?? [];
    children.push(session);
    childrenByParent.set(session.parentThreadId, children);
  }

  const parentIds = new Set<string>();
  for (const session of sessions) {
    if (!session.parentThreadId) {
      parentIds.add(session.id);
    }
  }
  for (const parentId of childrenByParent.keys()) {
    parentIds.add(parentId);
  }

  return [...parentIds]
    .map((parentId) => {
      const parent = byId.get(parentId);
      const children = (childrenByParent.get(parentId) ?? []).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      const related = [parent, ...children].filter(Boolean) as CodexSession[];
      const updatedAtMs = related.length > 0 ? Math.max(...related.map((session) => session.updatedAtMs)) : 0;
      const status = inferMissionStatus(parent, children);
      const cwd = parent?.cwd ?? children[0]?.cwd;
      const workspaceName = parent?.workspaceName ?? children[0]?.workspaceName;
      const gitBranch = parent?.gitBranch ?? children[0]?.gitBranch;
      const model = parent?.model ?? children[0]?.model;

      return {
        id: parentId,
        title: parent?.title || `Parent ${shortId(parentId)}`,
        parent,
        children,
        childCount: children.length,
        activeCount: related.filter((session) => session.status === 'active').length,
        doneCount: related.filter((session) => session.status === 'done').length,
        errorCount: related.reduce((sum, session) => sum + session.errorCount, 0),
        status,
        cwd,
        workspaceName,
        gitBranch,
        model,
        updatedAt: related.find((session) => session.updatedAtMs === updatedAtMs)?.updatedAt,
        updatedAtMs,
        isVirtualParent: !parent
      };
    })
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

function inferMissionStatus(parent: CodexSession | undefined, children: CodexSession[]): SessionStatus {
  const related = [parent, ...children].filter(Boolean) as CodexSession[];
  if (related.some((session) => session.status === 'error')) {
    return 'error';
  }
  if (related.some((session) => session.status === 'active')) {
    return 'active';
  }
  if (related.length > 0 && related.every((session) => session.status === 'done')) {
    return 'done';
  }
  return 'idle';
}

function inferStatus(input: { taskComplete: boolean; errorCount: number; isRecentlyTouched: boolean }): SessionStatus {
  if (input.taskComplete) {
    return 'done';
  }
  if (input.errorCount > 0) {
    return 'error';
  }
  if (input.isRecentlyTouched) {
    return 'active';
  }
  return 'idle';
}

function buildTitle(input: {
  agentNickname?: string;
  agentRole?: string;
  firstUserPreview?: string;
  cwd?: string;
  id: string;
  isSubagent: boolean;
}): string {
  if (input.isSubagent) {
    return cleanPreview(input.agentNickname || input.agentRole || input.firstUserPreview) || `Subagent ${shortId(input.id)}`;
  }

  return cleanPreview(input.firstUserPreview) || (input.cwd ? path.basename(input.cwd) : undefined) || `Chat ${shortId(input.id)}`;
}

function formatToolName(payload: Record<string, unknown>): string | undefined {
  const namespace = stringValue(payload.namespace);
  const name = stringValue(payload.name);
  if (namespace && name) {
    return `${namespace}.${name}`;
  }
  return name || namespace || undefined;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join(' ');
  }

  if (isRecord(value)) {
    return extractText(value.text) || extractText(value.content) || extractText(value.message) || '';
  }

  return '';
}

function cleanPreview(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : extractText(value);
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return undefined;
  }
  return cleaned.length > 220 ? `${cleaned.slice(0, 217)}...` : cleaned;
}

function inferThreadIdFromFileName(fileName: string): string | undefined {
  const match = fileName.match(/(019[0-9a-f-]{28,})/i);
  return match?.[1];
}

function normalizeHomePath(value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function safeJsonParse(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toTimeMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shortId(id: string): string {
  return id.replace(/-/g, '').slice(-6);
}
