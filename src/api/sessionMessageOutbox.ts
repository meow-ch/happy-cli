/**
 * Durable, encrypted session-message outbox.
 *
 * Message payloads are encrypted by ApiSessionClient before they enter this
 * store. Each pending message is kept in its own atomically-created file and
 * is removed only after the server acknowledges its durable commit. Session
 * end is also a durable record and is delivered only after every message.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { configuration } from '@/configuration';

const MANIFEST_FILENAME = 'manifest.json';

export interface SessionMessageOutboxManifest {
  version: 1;
  sessionId: string;
}

export interface SessionMessageOutboxRecord {
  version: 1;
  sessionId: string;
  localId: string;
  /** Base64-encoded ciphertext; plaintext is never persisted here. */
  message: string;
  createdAt: number;
  orderKey: string;
}

export interface SessionEndOutboxRecord {
  version: 1;
  kind: 'session-end';
  sessionId: string;
  localId: string;
  /** Identifies the runtime process incarnation that requested termination. */
  sessionInstanceId: string;
  createdAt: number;
  orderKey: string;
}

export type SessionOutboxRecord = SessionMessageOutboxRecord | SessionEndOutboxRecord;

export interface SessionMessageOutboxQuarantine {
  version: 1;
  status: 'quarantined';
  record: SessionOutboxRecord;
  rejectedAt: number;
  rejection: {
    code: string;
    retryable: false;
  };
}

export interface SessionMessageOutboxOptions {
  rootDirectory?: string;
  now?: () => number;
  createLocalId?: () => string;
  /** Test seam; returns false only when directory fsync is unsupported. */
  syncDirectory?: (directory: string) => boolean;
}

export function defaultSessionMessageOutboxRoot(): string {
  return join(configuration.happyHomeDir, 'session-message-outbox');
}

function isManifestFilename(filename: string): boolean {
  return filename === MANIFEST_FILENAME || filename.startsWith(`${MANIFEST_FILENAME}.`);
}

function isManagedRecordFilename(filename: string): boolean {
  return !isManifestFilename(filename)
    && (filename.endsWith('.json') || filename.endsWith('.pending'));
}

export function discoverPendingSessionOutboxSessionIds(
  rootDirectory = defaultSessionMessageOutboxRoot(),
): string[] {
  if (!existsSync(rootDirectory)) return [];
  const sessionIds = new Set<string>();
  for (const directory of readdirSync(rootDirectory, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const sessionDirectory = join(rootDirectory, directory.name);
    let manifestSessionId: string | null = null;
    let recordSessionId: string | null = null;
    let hasManagedRecord = false;

    for (const entry of readdirSync(sessionDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const sourcePath = join(sessionDirectory, entry.name);
      if (isManifestFilename(entry.name)) {
        try {
          const parsed = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown;
          if (isOutboxManifest(parsed)) manifestSessionId = parsed.sessionId;
        } catch {
          // A valid canonical manifest, if present, still attributes this dir.
        }
        continue;
      }
      if (!isManagedRecordFilename(entry.name)) continue;
      hasManagedRecord = true;
      try {
        const parsed = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown;
        if (isOutboxQuarantine(parsed)) recordSessionId = parsed.record.sessionId;
        else if (isOutboxRecord(parsed)) recordSessionId = parsed.sessionId;
      } catch {
        // The manifest makes malformed-only directories attributable.
      }
    }

    if (hasManagedRecord && (manifestSessionId ?? recordSessionId)) {
      sessionIds.add((manifestSessionId ?? recordSessionId)!);
    }
  }
  return Array.from(sessionIds).sort();
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isOutboxManifest(value: unknown): value is SessionMessageOutboxManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return manifest.version === 1
    && typeof manifest.sessionId === 'string'
    && manifest.sessionId.length > 0;
}

function isMessageOutboxRecord(value: unknown): value is SessionMessageOutboxRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && record.kind === undefined
    && typeof record.sessionId === 'string'
    && record.sessionId.length > 0
    && typeof record.localId === 'string'
    && record.localId.length > 0
    && typeof record.message === 'string'
    && record.message.length > 0
    && typeof record.createdAt === 'number'
    && Number.isFinite(record.createdAt)
    && typeof record.orderKey === 'string'
    && record.orderKey.length > 0;
}

function isSessionEndOutboxRecord(value: unknown): value is SessionEndOutboxRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && record.kind === 'session-end'
    && typeof record.sessionId === 'string'
    && record.sessionId.length > 0
    && typeof record.localId === 'string'
    && record.localId.length > 0
    && typeof record.sessionInstanceId === 'string'
    && record.sessionInstanceId.length > 0
    && typeof record.createdAt === 'number'
    && Number.isFinite(record.createdAt)
    && typeof record.orderKey === 'string'
    && record.orderKey.length > 0;
}

function isOutboxRecord(value: unknown): value is SessionOutboxRecord {
  return isMessageOutboxRecord(value) || isSessionEndOutboxRecord(value);
}

function sameOutboxRecord(left: SessionOutboxRecord, right: SessionOutboxRecord): boolean {
  if (left.sessionId !== right.sessionId
    || left.localId !== right.localId
    || left.createdAt !== right.createdAt
    || left.orderKey !== right.orderKey) return false;
  if (isSessionEndOutboxRecord(left) || isSessionEndOutboxRecord(right)) {
    return isSessionEndOutboxRecord(left)
      && isSessionEndOutboxRecord(right)
      && left.sessionInstanceId === right.sessionInstanceId;
  }
  return left.message === right.message;
}

function isOutboxQuarantine(value: unknown): value is SessionMessageOutboxQuarantine {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const quarantine = value as Record<string, unknown>;
  if (quarantine.version !== 1 || quarantine.status !== 'quarantined') return false;
  if (!isOutboxRecord(quarantine.record)) return false;
  if (typeof quarantine.rejectedAt !== 'number' || !Number.isFinite(quarantine.rejectedAt)) return false;
  if (typeof quarantine.rejection !== 'object'
    || quarantine.rejection === null
    || Array.isArray(quarantine.rejection)) return false;
  const rejection = quarantine.rejection as Record<string, unknown>;
  return typeof rejection.code === 'string'
    && rejection.code.length > 0
    && rejection.retryable === false;
}

function isExplicitlyUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP';
}

/** Returns false when this filesystem explicitly does not support directory fsync. */
export function syncDirectoryForDurability(directory: string): boolean {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(directory, 'r');
    fsyncSync(descriptor);
    return true;
  } catch (error) {
    if (isExplicitlyUnsupportedDirectorySync(error)) return false;
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export class SessionMessageOutbox {
  private readonly directory: string;
  private readonly now: () => number;
  private readonly createLocalId: () => string;
  private readonly syncDirectory: (directory: string) => boolean;
  private readonly recordsByLocalId = new Map<string, SessionMessageOutboxRecord>();
  private readonly sessionEndRecordsByLocalId = new Map<string, SessionEndOutboxRecord>();
  private readonly quarantineByLocalId = new Map<string, SessionMessageOutboxQuarantine>();
  private integrityBarrier = false;
  private enqueueCounter = 0;
  private lastCreatedAt = 0;

  constructor(
    readonly sessionId: string,
    options: SessionMessageOutboxOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createLocalId = options.createLocalId ?? randomUUID;
    this.syncDirectory = options.syncDirectory ?? syncDirectoryForDurability;
    const rootDirectory = options.rootDirectory ?? defaultSessionMessageOutboxRoot();
    this.directory = join(rootDirectory, digest(sessionId));
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.directory, 0o700);
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
    this.ensureManifest();
    this.loadQuarantinedRecords();
    this.loadPendingRecords();
  }

  enqueue(message: string, localId = this.createLocalId()): SessionMessageOutboxRecord {
    if (!localId) throw new Error('Session outbox localId must not be empty');
    if (!message) throw new Error('Session outbox message must not be empty');

    const existing = this.recordsByLocalId.get(localId);
    if (existing) {
      if (existing.message !== message) throw new Error(`Session outbox localId conflict: ${localId}`);
      return existing;
    }

    const record: SessionMessageOutboxRecord = {
      version: 1,
      sessionId: this.sessionId,
      localId,
      message,
      ...this.nextOrderingFields(localId),
    };
    this.writeAtomicRecord(this.pathFor(record), record);
    this.recordsByLocalId.set(localId, record);
    return record;
  }

  enqueueSessionEnd(sessionInstanceId: string, localId = this.createLocalId()): SessionEndOutboxRecord {
    const existingForInstance = Array.from(this.sessionEndRecordsByLocalId.values())
      .find((record) => record.sessionInstanceId === sessionInstanceId);
    if (existingForInstance) return existingForInstance;
    if (!localId) throw new Error('Session-end outbox localId must not be empty');
    if (!sessionInstanceId) throw new Error('Session-end instance id must not be empty');
    const record: SessionEndOutboxRecord = {
      version: 1,
      kind: 'session-end',
      sessionId: this.sessionId,
      localId,
      sessionInstanceId,
      ...this.nextOrderingFields(localId),
    };
    this.writeAtomicRecord(this.pathFor(record), record);
    this.sessionEndRecordsByLocalId.set(record.localId, record);
    return record;
  }

  acknowledge(localId: string): boolean {
    const record = this.recordForLocalId(localId);
    if (!record) return false;
    const path = this.pathFor(record);
    if (existsSync(path)) unlinkSync(path);
    this.syncDirectory(this.directory);
    this.removeInMemory(record);
    return true;
  }

  quarantine(localId: string, rejectionCode: string): SessionMessageOutboxQuarantine {
    const existingQuarantine = this.quarantineByLocalId.get(localId);
    if (existingQuarantine) return existingQuarantine;
    const record = this.recordForLocalId(localId);
    if (!record) throw new Error(`Cannot quarantine unknown outbox localId ${localId}`);

    const quarantine: SessionMessageOutboxQuarantine = {
      version: 1,
      status: 'quarantined',
      record,
      rejectedAt: this.now(),
      rejection: { code: rejectionCode, retryable: false },
    };
    const quarantineDurable = this.writeAtomicRecord(this.quarantinePathFor(localId), quarantine);

    // If directory fsync is unsupported, retain both copies. On the next
    // process start, the surviving quarantine proves it is safe to unlink the
    // pending copy; if the rename is lost, the pending copy remains recoverable.
    if (quarantineDurable) {
      const pendingPath = this.pathFor(record);
      if (existsSync(pendingPath)) unlinkSync(pendingPath);
      this.syncDirectory(this.directory);
    }
    this.removeInMemory(record);
    this.quarantineByLocalId.set(localId, quarantine);
    return quarantine;
  }

  pendingRecords(): SessionMessageOutboxRecord[] {
    return Array.from(this.recordsByLocalId.values())
      .sort((left, right) => left.orderKey.localeCompare(right.orderKey));
  }

  pendingSessionEnd(): SessionEndOutboxRecord | null {
    return Array.from(this.sessionEndRecordsByLocalId.values())
      .sort((left, right) => left.orderKey.localeCompare(right.orderKey))[0] ?? null;
  }

  get pendingCount(): number {
    return this.recordsByLocalId.size + this.sessionEndRecordsByLocalId.size;
  }

  get quarantinedCount(): number {
    return this.quarantineByLocalId.size;
  }

  get undeliveredCount(): number {
    return this.pendingCount + this.quarantinedCount + (this.integrityBarrier ? 1 : 0);
  }

  get hasIntegrityBarrier(): boolean {
    return this.integrityBarrier;
  }

  get hasBarrier(): boolean {
    return this.integrityBarrier || this.quarantineByLocalId.size > 0;
  }

  /** Backward-compatible name for callers written before integrity barriers. */
  get hasQuarantine(): boolean {
    return this.quarantineByLocalId.size > 0;
  }

  quarantinedRecords(): SessionMessageOutboxQuarantine[] {
    return Array.from(this.quarantineByLocalId.values())
      .sort((left, right) => left.record.orderKey.localeCompare(right.record.orderKey));
  }

  private nextOrderingFields(localId: string): { createdAt: number; orderKey: string } {
    const createdAt = Math.max(this.now(), this.lastCreatedAt + 1);
    this.lastCreatedAt = createdAt;
    const orderKey = [
      createdAt.toString().padStart(16, '0'),
      process.pid.toString().padStart(10, '0'),
      (this.enqueueCounter++).toString().padStart(10, '0'),
      localId,
    ].join('-');
    return { createdAt, orderKey };
  }

  private recordForLocalId(localId: string): SessionOutboxRecord | null {
    return this.recordsByLocalId.get(localId)
      ?? this.sessionEndRecordsByLocalId.get(localId)
      ?? null;
  }

  private removeInMemory(record: SessionOutboxRecord): void {
    if (isSessionEndOutboxRecord(record)) {
      this.sessionEndRecordsByLocalId.delete(record.localId);
    } else {
      this.recordsByLocalId.delete(record.localId);
    }
  }

  private pathFor(record: SessionOutboxRecord): string {
    const suffix = isSessionEndOutboxRecord(record) ? '.session-end.json' : '.json';
    return join(this.directory, `${digest(record.localId)}${suffix}`);
  }

  private quarantinePathFor(localId: string): string {
    return join(this.directory, `${digest(localId)}.quarantine.json`);
  }

  private writeAtomicRecord(finalPath: string, value: unknown): boolean {
    const temporaryPath = `${finalPath}.${process.pid}.${randomUUID()}.pending`;
    const descriptor = openSync(temporaryPath, 'wx', 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, finalPath);
    return this.syncDirectory(this.directory);
  }

  private ensureManifest(): void {
    const manifestPath = join(this.directory, MANIFEST_FILENAME);
    const manifestCandidates = readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isManifestFilename(entry.name));
    let validCandidatePath: string | null = null;
    let invalidCandidate = false;
    let canonicalValid = false;

    for (const entry of manifestCandidates) {
      const sourcePath = join(this.directory, entry.name);
      try {
        const parsed = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown;
        if (!isOutboxManifest(parsed) || parsed.sessionId !== this.sessionId) {
          this.integrityBarrier = true;
          invalidCandidate = true;
          continue;
        }
        if (entry.name === MANIFEST_FILENAME) canonicalValid = true;
        else validCandidatePath ??= sourcePath;
      } catch {
        this.integrityBarrier = true;
        invalidCandidate = true;
      }
    }

    // Never overwrite evidence of a corrupt/conflicting manifest. A valid
    // outbox record can still make the directory discoverable for repair.
    if (invalidCandidate) return;
    if (canonicalValid) return;
    if (validCandidatePath) {
      renameSync(validCandidatePath, manifestPath);
      this.syncDirectory(this.directory);
      return;
    }

    if (manifestCandidates.length > 0) return;

    this.writeAtomicRecord(manifestPath, { version: 1, sessionId: this.sessionId });
  }

  private loadQuarantinedRecords(): void {
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.includes('.quarantine.json')) continue;
      const sourcePath = join(this.directory, entry.name);
      try {
        const parsed = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown;
        if (!isOutboxQuarantine(parsed) || parsed.record.sessionId !== this.sessionId) {
          this.integrityBarrier = true;
          continue;
        }
        const existing = this.quarantineByLocalId.get(parsed.record.localId);
        if (existing && !sameOutboxRecord(existing.record, parsed.record)) {
          this.integrityBarrier = true;
          continue;
        }
        this.quarantineByLocalId.set(parsed.record.localId, parsed);
        this.lastCreatedAt = Math.max(this.lastCreatedAt, parsed.record.createdAt);

        if (entry.name.endsWith('.pending')) {
          const finalPath = this.quarantinePathFor(parsed.record.localId);
          if (!existsSync(finalPath)) {
            renameSync(sourcePath, finalPath);
            this.syncDirectory(this.directory);
          } else {
            const canonical = JSON.parse(readFileSync(finalPath, 'utf8')) as unknown;
            if (!isOutboxQuarantine(canonical)
              || !sameOutboxRecord(canonical.record, parsed.record)) {
              this.integrityBarrier = true;
              continue;
            }
            unlinkSync(sourcePath);
            this.syncDirectory(this.directory);
          }
        }
      } catch {
        this.integrityBarrier = true;
      }
    }
  }

  private loadPendingRecords(): void {
    const entries = readdirSync(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()
        || !isManagedRecordFilename(entry.name)
        || entry.name.includes('.quarantine.json')) continue;
      const sourcePath = join(this.directory, entry.name);
      try {
        const parsed = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown;
        if (!isOutboxRecord(parsed) || parsed.sessionId !== this.sessionId) {
          this.integrityBarrier = true;
          continue;
        }

        const quarantined = this.quarantineByLocalId.get(parsed.localId);
        if (quarantined) {
          if (!sameOutboxRecord(quarantined.record, parsed)) {
            this.integrityBarrier = true;
            continue;
          }
          // This is a later process start, so the surviving quarantine entry
          // proves the replacement exists independently of the original rename.
          if (existsSync(sourcePath)) unlinkSync(sourcePath);
          this.syncDirectory(this.directory);
          continue;
        }

        this.rememberPendingRecord(parsed);
        const finalPath = this.pathFor(parsed);
        if (entry.name.endsWith('.pending')) {
          if (!existsSync(finalPath)) {
            renameSync(sourcePath, finalPath);
            this.syncDirectory(this.directory);
          } else {
            const canonical = JSON.parse(readFileSync(finalPath, 'utf8')) as unknown;
            if (!isOutboxRecord(canonical) || !sameOutboxRecord(canonical, parsed)) {
              this.integrityBarrier = true;
              continue;
            }
            unlinkSync(sourcePath);
            this.syncDirectory(this.directory);
          }
        }
      } catch {
        this.integrityBarrier = true;
      }
    }
  }

  private rememberPendingRecord(record: SessionOutboxRecord): void {
    this.lastCreatedAt = Math.max(this.lastCreatedAt, record.createdAt);
    if (isSessionEndOutboxRecord(record)) {
      const existing = this.sessionEndRecordsByLocalId.get(record.localId);
      if (existing && !sameOutboxRecord(existing, record)) {
        this.integrityBarrier = true;
        return;
      }
      this.sessionEndRecordsByLocalId.set(record.localId, record);
      return;
    }
    const existing = this.recordsByLocalId.get(record.localId);
    if (existing && !sameOutboxRecord(existing, record)) {
      this.integrityBarrier = true;
      return;
    }
    this.recordsByLocalId.set(record.localId, record);
  }
}
