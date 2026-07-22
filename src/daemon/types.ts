/**
 * Daemon-specific types (not related to API/server communication)
 */

import type { AgentPlaneSessionEncryptionAttestation, Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: 'daemon' | string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  /** tmux session identifier (format: session:window) */
  tmuxSessionId?: string;
  /** Whether this daemon observed the spawn directly or re-adopted it from durable registry. */
  trackingSource?: 'memory' | 'registry';
  /** Last explicit liveness/activity report from the session process. */
  lastActivityAt?: number;
  /** Agent-reported thinking state; undefined means cleanup is not safe. */
  thinking?: boolean;
  /** Durable session-message outbox depth; undefined means cleanup is not safe. */
  pendingOutbox?: number;
  /** Daemon receipt time for the latest explicit activity report. */
  activityReportedAt?: number;
  /** Protocol reported by this exact child through its startup webhook. */
  terminalProtocol?: 1;
  /** Encryption reported by this exact child through its startup webhook. */
  sessionEncryption?: AgentPlaneSessionEncryptionAttestation;
  /** OS process-incarnation identity; unlike PID, this is not reused. */
  processBirthFingerprint?: string;
}
