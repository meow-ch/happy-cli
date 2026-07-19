import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configuration } from '@/configuration';
import { Metadata } from '@/api/types';

export type DaemonSessionStatus =
  | 'tracked_alive'
  | 'tracked_dead'
  | 'recovered_alive'
  | 'recovered_dead'
  | 'unknown';

export interface PersistedDaemonSession {
  sessionId: string;
  pid: number;
  startedBy: string;
  path?: string;
  flavor?: string;
  startedAt: number;
  updatedAt: number;
  lastActivityAt?: number;
  thinking?: boolean;
  pendingOutbox?: number;
  activityReportedAt?: number;
  terminalProtocol?: 1;
}

interface PersistedDaemonSessionRegistry {
  version: 1;
  sessions: PersistedDaemonSession[];
}

export function defaultDaemonSessionRegistryPath(): string {
  return join(configuration.happyHomeDir, 'daemon.sessions.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSession(value: unknown): PersistedDaemonSession | null {
  if (!isRecord(value)) return null;
  const sessionId = typeof value.sessionId === 'string' && value.sessionId.length > 0 ? value.sessionId : null;
  const pid = typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : null;
  if (!sessionId || !pid) return null;
  const now = Date.now();
  const session: PersistedDaemonSession = {
    sessionId,
    pid,
    startedBy: typeof value.startedBy === 'string' && value.startedBy.length > 0 ? value.startedBy : 'unknown',
    startedAt: typeof value.startedAt === 'number' && Number.isFinite(value.startedAt) ? value.startedAt : now,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : now,
  };
  if (typeof value.path === 'string' && value.path.length > 0) session.path = value.path;
  if (typeof value.flavor === 'string' && value.flavor.length > 0) session.flavor = value.flavor;
  if (typeof value.lastActivityAt === 'number' && Number.isFinite(value.lastActivityAt)) {
    session.lastActivityAt = value.lastActivityAt;
  }
  if (typeof value.thinking === 'boolean') session.thinking = value.thinking;
  if (typeof value.pendingOutbox === 'number'
    && Number.isInteger(value.pendingOutbox)
    && value.pendingOutbox >= 0) {
    session.pendingOutbox = value.pendingOutbox;
  }
  if (typeof value.activityReportedAt === 'number' && Number.isFinite(value.activityReportedAt)) {
    session.activityReportedAt = value.activityReportedAt;
  }
  if (value.terminalProtocol === 1) session.terminalProtocol = 1;
  return session;
}

export function readDaemonSessionRegistry(registryPath = defaultDaemonSessionRegistryPath()): PersistedDaemonSession[] {
  if (!existsSync(registryPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(registryPath, 'utf8')) as unknown;
    if (!isRecord(raw) || !Array.isArray(raw.sessions)) return [];
    return raw.sessions
      .map(normalizeSession)
      .filter((session): session is PersistedDaemonSession => session !== null);
  } catch {
    return [];
  }
}

export function writeDaemonSessionRegistry(
  sessions: PersistedDaemonSession[],
  registryPath = defaultDaemonSessionRegistryPath(),
): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  const deduped = new Map<string, PersistedDaemonSession>();
  for (const session of sessions) {
    deduped.set(session.sessionId, session);
  }
  const payload: PersistedDaemonSessionRegistry = {
    version: 1,
    sessions: Array.from(deduped.values()).sort((a, b) => a.startedAt - b.startedAt),
  };
  const tmpPath = `${registryPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  renameSync(tmpPath, registryPath);
}

export function upsertDaemonSessionRecord(
  input: {
    sessionId: string;
    pid: number;
    startedBy?: string;
    metadata?: Metadata;
  },
  registryPath = defaultDaemonSessionRegistryPath(),
): PersistedDaemonSession {
  const now = Date.now();
  const current = readDaemonSessionRegistry(registryPath);
  const sessions = current
    .filter((session) => session.sessionId !== input.sessionId && session.pid !== input.pid);
  const existing = current
    .find((session) => session.sessionId === input.sessionId || session.pid === input.pid);
  const sameProcess = existing?.pid === input.pid;
  const next: PersistedDaemonSession = {
    sessionId: input.sessionId,
    pid: input.pid,
    startedBy: input.startedBy ?? input.metadata?.startedBy ?? existing?.startedBy ?? 'unknown',
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
  };
  if (sameProcess && existing?.lastActivityAt !== undefined) next.lastActivityAt = existing.lastActivityAt;
  if (sameProcess && existing?.thinking !== undefined) next.thinking = existing.thinking;
  if (sameProcess && existing?.pendingOutbox !== undefined) next.pendingOutbox = existing.pendingOutbox;
  if (sameProcess && existing?.activityReportedAt !== undefined) next.activityReportedAt = existing.activityReportedAt;
  const terminalProtocol = input.metadata?.terminalProtocol
    ?? (sameProcess ? existing?.terminalProtocol : undefined);
  if (terminalProtocol === 1) next.terminalProtocol = 1;
  const path = input.metadata?.path ?? existing?.path;
  const flavor = input.metadata?.flavor ?? existing?.flavor;
  if (path) next.path = path;
  if (flavor) next.flavor = flavor;
  sessions.push(next);
  writeDaemonSessionRegistry(sessions, registryPath);
  return next;
}

export function updateDaemonSessionActivity(
  input: {
    sessionId: string;
    lastActivityAt: number;
    thinking: boolean;
    pendingOutbox: number;
    reportedAt?: number;
  },
  registryPath = defaultDaemonSessionRegistryPath(),
): PersistedDaemonSession | null {
  const sessions = readDaemonSessionRegistry(registryPath);
  const index = sessions.findIndex((session) => session.sessionId === input.sessionId);
  if (index < 0) return null;
  const current = sessions[index];
  const updated: PersistedDaemonSession = {
    ...current,
    lastActivityAt: Math.max(current.lastActivityAt ?? 0, input.lastActivityAt),
    thinking: input.thinking,
    pendingOutbox: input.pendingOutbox,
    activityReportedAt: input.reportedAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  sessions[index] = updated;
  writeDaemonSessionRegistry(sessions, registryPath);
  return updated;
}

export function removeDaemonSessionRecord(
  match: { sessionId?: string; pid?: number },
  registryPath = defaultDaemonSessionRegistryPath(),
): void {
  const sessions = readDaemonSessionRegistry(registryPath)
    .filter((session) => {
      if (match.sessionId && session.sessionId === match.sessionId) return false;
      if (match.pid && session.pid === match.pid) return false;
      return true;
    });
  writeDaemonSessionRegistry(sessions, registryPath);
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function pruneDeadDaemonSessionRecords(
  registryPath = defaultDaemonSessionRegistryPath(),
): PersistedDaemonSession[] {
  const alive = readDaemonSessionRegistry(registryPath).filter((session) => pidIsAlive(session.pid));
  writeDaemonSessionRegistry(alive, registryPath);
  return alive;
}
