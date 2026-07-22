/**
 * Daemon-side replay for outboxes whose original session process exited.
 *
 * The payload is already ciphertext, so the daemon needs only the account
 * token and session id. Replay is deliberately bounded and non-reconnecting;
 * the daemon heartbeat will retry later without creating a socket storm.
 */

import { io, Socket } from 'socket.io-client';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  SessionEndAckSchema,
  SessionMessageAckSchema,
} from './types';
import {
  defaultSessionMessageOutboxRoot,
  discoverPendingSessionOutboxSessionIds,
  SessionMessageOutbox,
} from './sessionMessageOutbox';

export interface ReplayPendingSessionOutboxesOptions {
  excludeSessionIds?: ReadonlySet<string>;
  limit?: number;
  connectTimeoutMs?: number;
  ackTimeoutMs?: number;
  maxRecordsPerSession?: number;
  rootDirectory?: string;
}

export interface ReplayPendingSessionOutboxesResult {
  attemptedSessions: number;
  drainedSessions: number;
  remainingMessages: number;
}

// A permanently blocked or temporarily unreachable outbox must not occupy the
// daemon's bounded replay budget forever. Rotation is process-local because a
// daemon restart immediately starts a new pass and subsequent heartbeats still
// visit every discovered session.
const nextReplayOffsetByRoot = new Map<string, number>();

function selectFairReplayBatch(sessionIds: string[], rootDirectory: string, limit: number): string[] {
  if (sessionIds.length === 0 || limit <= 0) return [];
  const start = (nextReplayOffsetByRoot.get(rootDirectory) ?? 0) % sessionIds.length;
  const count = Math.min(limit, sessionIds.length);
  const selected = Array.from(
    { length: count },
    (_, index) => sessionIds[(start + index) % sessionIds.length],
  );
  nextReplayOffsetByRoot.set(rootDirectory, (start + count) % sessionIds.length);
  return selected;
}

export async function replayPendingSessionOutboxes(
  token: string,
  options: ReplayPendingSessionOutboxesOptions = {},
): Promise<ReplayPendingSessionOutboxesResult> {
  const rootDirectory = options.rootDirectory ?? defaultSessionMessageOutboxRoot();
  const excluded = options.excludeSessionIds ?? new Set<string>();
  const discoveredSessionIds = discoverPendingSessionOutboxSessionIds(rootDirectory)
    .filter((sessionId) => !excluded.has(sessionId));
  const configuredLimit = options.limit ?? 2;
  const sessionIds = selectFairReplayBatch(
    discoveredSessionIds,
    rootDirectory,
    Number.isFinite(configuredLimit) ? Math.max(0, Math.floor(configuredLimit)) : 0,
  );
  let drainedSessions = 0;
  let remainingMessages = 0;

  for (const sessionId of sessionIds) {
    const outbox = new SessionMessageOutbox(sessionId, { rootDirectory });
    if (outbox.hasBarrier) {
      remainingMessages += outbox.undeliveredCount;
      continue;
    }
    const pendingSessionEnd = outbox.pendingSessionEnd();
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(configuration.serverUrl, {
      auth: {
        token,
        clientType: 'session-scoped' as const,
        sessionId,
        sessionInstanceId: pendingSessionEnd?.sessionInstanceId,
        replayOnly: true,
      },
      path: '/v1/updates',
      transports: ['websocket'],
      withCredentials: true,
      autoConnect: false,
      reconnection: false,
    });

    const connected = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), options.connectTimeoutMs ?? 10_000);
      socket.once('connect', () => {
        clearTimeout(timeout);
        resolve(true);
      });
      socket.once('connect_error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
      socket.connect();
    });

    if (connected) {
      try {
        const maxRecords = Math.max(1, Math.floor(options.maxRecordsPerSession ?? 25));
        let attemptedRecords = 0;
        for (const record of outbox.pendingRecords()) {
          if (attemptedRecords >= maxRecords) break;
          attemptedRecords += 1;
          const rawAnswer = await socket
            .timeout(options.ackTimeoutMs ?? 15_000)
            .emitWithAck('message', {
              sid: sessionId,
              message: record.message,
              localId: record.localId,
            });
          const parsedAnswer = SessionMessageAckSchema.safeParse(rawAnswer);
          if (!parsedAnswer.success) throw new Error('Invalid session message ACK from server');
          const answer = parsedAnswer.data;
          if (answer.result === 'success' && answer.message.localId !== record.localId) {
            throw new Error('Session message ACK localId mismatch');
          }
          if (answer.result !== 'success') {
            logger.debug('[OUTBOX REPLAY] Server rejected orphaned session message', {
              sessionId,
              localId: record.localId,
              code: answer.code,
              retryable: answer.retryable,
            });
            if (!answer.retryable) outbox.quarantine(record.localId, answer.code);
            break;
          }
          outbox.acknowledge(record.localId);
        }

        let sessionEnd = outbox.pendingSessionEnd();
        while (outbox.pendingRecords().length === 0
          && !outbox.hasBarrier
          && sessionEnd
          && attemptedRecords < maxRecords) {
          attemptedRecords += 1;
          const rawAnswer = await socket
            .timeout(options.ackTimeoutMs ?? 15_000)
            .emitWithAck('session-end', {
              sid: sessionId,
              time: sessionEnd.createdAt,
              localId: sessionEnd.localId,
              sessionInstanceId: sessionEnd.sessionInstanceId,
            });
          const parsedAnswer = SessionEndAckSchema.safeParse(rawAnswer);
          if (!parsedAnswer.success) throw new Error('Invalid session-end ACK from server');
          const answer = parsedAnswer.data;
          if (answer.result === 'success' && answer.localId !== sessionEnd.localId) {
            throw new Error('Session-end ACK localId mismatch');
          }
          if (answer.result !== 'success') {
            if (!answer.retryable) outbox.quarantine(sessionEnd.localId, answer.code);
          } else {
            outbox.acknowledge(sessionEnd.localId);
          }
          if (answer.result !== 'success') break;
          sessionEnd = outbox.pendingSessionEnd();
        }
      } catch (error) {
        logger.debug('[OUTBOX REPLAY] Orphaned session replay paused', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    socket.close();

    remainingMessages += outbox.undeliveredCount;
    if (outbox.undeliveredCount === 0) drainedSessions += 1;
  }

  return {
    attemptedSessions: sessionIds.length,
    drainedSessions,
    remainingMessages,
  };
}
