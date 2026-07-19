import type { SessionMessage, SessionMessageReplayPage } from './types';

export interface SessionMessageInboxOptions {
  initialAfterSeq: number;
  fetchPage: (afterSeq: number) => Promise<SessionMessageReplayPage>;
  deliver: (message: SessionMessage) => void | Promise<void>;
  maxRememberedIds?: number;
}

/**
 * Serialized, cursor-driven view of the server-side session message table.
 * Socket notifications are wake-ups only; this inbox is the canonical source.
 */
export class SessionMessageInbox {
  private cursor: number;
  private readonly fetchPage: SessionMessageInboxOptions['fetchPage'];
  private readonly deliver: SessionMessageInboxOptions['deliver'];
  private readonly maxRememberedIds: number;
  private readonly rememberedIds = new Map<string, number>();
  private requested = false;
  private worker: Promise<void> | null = null;

  constructor(options: SessionMessageInboxOptions) {
    if (!Number.isInteger(options.initialAfterSeq) || options.initialAfterSeq < 0) {
      throw new Error('Session message inbox requires a non-negative initial cursor');
    }
    this.cursor = options.initialAfterSeq;
    this.fetchPage = options.fetchPage;
    this.deliver = options.deliver;
    this.maxRememberedIds = Math.max(1, options.maxRememberedIds ?? 2_048);
  }

  get afterSeq(): number {
    return this.cursor;
  }

  /** Coalesces concurrent wake-ups into one strictly serialized reconciliation. */
  reconcile(): Promise<void> {
    this.requested = true;
    if (!this.worker) this.worker = this.runWorker();
    return this.worker;
  }

  private async runWorker(): Promise<void> {
    try {
      while (this.requested) {
        this.requested = false;
        try {
          await this.reconcilePages();
        } catch (error) {
          // A failed delivery or fetch must remain requested so the next retry
          // begins at the last message which was safely handed off.
          this.requested = true;
          throw error;
        }
      }
    } finally {
      // This runs before the worker promise settles, so a later wake-up cannot
      // observe a settled-but-still-registered worker and get lost.
      this.worker = null;
    }
  }

  private async reconcilePages(): Promise<void> {
    let hasMore = false;
    do {
      const pageStart = this.cursor;
      const page = await this.fetchPage(pageStart);
      const messages = this.validatePage(page, pageStart);

      for (const message of messages) {
        const rememberedSeq = this.rememberedIds.get(message.id);
        if (rememberedSeq !== undefined && rememberedSeq !== message.seq) {
          throw new Error(`Session message id ${message.id} changed sequence`);
        }

        // Cursor advancement is deliberately after delivery. If decryption,
        // image resolution, or the local callback fails, this record retries.
        await this.deliver(message);
        this.cursor = message.seq;
        this.remember(message.id, message.seq);
      }

      hasMore = page.hasMore;
      if (hasMore && this.cursor === pageStart) {
        throw new Error('Session message replay page made no cursor progress');
      }
    } while (hasMore);
  }

  private validatePage(page: SessionMessageReplayPage, pageStart: number): SessionMessage[] {
    const messages = this.validateAndOrderPage(page.messages);
    let expectedSeq = pageStart + 1;
    for (const message of messages) {
      if (message.seq !== expectedSeq) {
        throw new Error(
          `Session message replay sequence gap: expected ${expectedSeq}, received ${message.seq}`,
        );
      }
      expectedSeq += 1;
    }

    const expectedNextAfterSeq = messages.at(-1)?.seq ?? pageStart;
    if (page.nextAfterSeq !== expectedNextAfterSeq) {
      throw new Error(
        `Session message replay cursor mismatch: expected ${expectedNextAfterSeq}, received ${page.nextAfterSeq}`,
      );
    }
    if (page.hasMore && messages.length === 0) {
      throw new Error('Session message replay page claims more rows without making progress');
    }
    return messages;
  }

  private validateAndOrderPage(messages: SessionMessage[]): SessionMessage[] {
    const idToSeq = new Map<string, number>();
    const seqToId = new Map<number, string>();
    const unique: SessionMessage[] = [];

    for (const message of messages) {
      const priorSeq = idToSeq.get(message.id);
      if (priorSeq !== undefined && priorSeq !== message.seq) {
        throw new Error(`Session message id ${message.id} appears at multiple sequences`);
      }
      const priorId = seqToId.get(message.seq);
      if (priorId !== undefined && priorId !== message.id) {
        throw new Error(`Session message sequence ${message.seq} has conflicting ids`);
      }
      if (priorSeq === message.seq && priorId === message.id) continue;
      idToSeq.set(message.id, message.seq);
      seqToId.set(message.seq, message.id);
      unique.push(message);
    }

    return unique.sort((left, right) => left.seq - right.seq);
  }

  private remember(id: string, seq: number): void {
    this.rememberedIds.delete(id);
    this.rememberedIds.set(id, seq);
    while (this.rememberedIds.size > this.maxRememberedIds) {
      const oldest = this.rememberedIds.keys().next().value as string | undefined;
      if (!oldest) break;
      this.rememberedIds.delete(oldest);
    }
  }
}
