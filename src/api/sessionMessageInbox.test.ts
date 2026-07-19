import { describe, expect, it, vi } from 'vitest';
import { SessionMessageInbox } from './sessionMessageInbox';
import type { SessionMessage, SessionMessageReplayPage } from './types';

function message(seq: number, id = `message-${seq}`): SessionMessage {
  return {
    id,
    seq,
    content: { t: 'encrypted', c: `ciphertext-${seq}` },
    createdAt: seq,
    updatedAt: seq,
  };
}

function page(
  messages: SessionMessage[],
  hasMore = false,
  emptyCursor = 0,
): SessionMessageReplayPage {
  return {
    messages,
    hasMore,
    nextAfterSeq: messages.reduce((maximum, item) => Math.max(maximum, item.seq), emptyCursor),
  };
}

describe('SessionMessageInbox', () => {
  it('orders out-of-order rows and deduplicates repeated seq/id pairs', async () => {
    const delivered: number[] = [];
    const inbox = new SessionMessageInbox({
      initialAfterSeq: 10,
      fetchPage: async () => page([
        message(12),
        message(11),
        message(11),
      ]),
      deliver: async (record) => { delivered.push(record.seq); },
    });

    await inbox.reconcile();

    expect(delivered).toEqual([11, 12]);
    expect(inbox.afterSeq).toBe(12);
  });

  it('serializes concurrent wake-ups and starts the second pass at the advanced cursor', async () => {
    let releaseFirst!: (value: SessionMessageReplayPage) => void;
    const firstPage = new Promise<SessionMessageReplayPage>((resolve) => { releaseFirst = resolve; });
    const fetchPage = vi.fn()
      .mockImplementationOnce(() => firstPage)
      .mockImplementationOnce(async () => page([], false, 5));
    const inbox = new SessionMessageInbox({
      initialAfterSeq: 4,
      fetchPage,
      deliver: async () => undefined,
    });

    const first = inbox.reconcile();
    const duplicateWake = inbox.reconcile();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    releaseFirst(page([message(5)]));
    await Promise.all([first, duplicateWake]);

    expect(fetchPage.mock.calls.map((call) => call[0])).toEqual([4, 5]);
  });

  it('does not advance past a record whose local handoff failed', async () => {
    let failSecond = true;
    const delivered: number[] = [];
    const inbox = new SessionMessageInbox({
      initialAfterSeq: 0,
      fetchPage: async (afterSeq) => page([message(1), message(2)].filter((item) => item.seq > afterSeq)),
      deliver: async (record) => {
        if (record.seq === 2 && failSecond) throw new Error('queue unavailable');
        delivered.push(record.seq);
      },
    });

    await expect(inbox.reconcile()).rejects.toThrow('queue unavailable');
    expect(inbox.afterSeq).toBe(1);

    failSecond = false;
    await inbox.reconcile();
    expect(delivered).toEqual([1, 2]);
    expect(inbox.afterSeq).toBe(2);
  });

  it('fails closed on conflicting duplicate sequence identities', async () => {
    const deliver = vi.fn();
    const inbox = new SessionMessageInbox({
      initialAfterSeq: 0,
      fetchPage: async () => page([message(1, 'first'), message(1, 'second')]),
      deliver,
    });

    await expect(inbox.reconcile()).rejects.toThrow('conflicting ids');
    expect(deliver).not.toHaveBeenCalled();
    expect(inbox.afterSeq).toBe(0);
  });

  it('fails closed before delivery when the canonical page skips a sequence', async () => {
    const deliver = vi.fn();
    const inbox = new SessionMessageInbox({
      initialAfterSeq: 10,
      fetchPage: async () => page([message(12)]),
      deliver,
    });

    await expect(inbox.reconcile()).rejects.toThrow('expected 11, received 12');
    expect(deliver).not.toHaveBeenCalled();
    expect(inbox.afterSeq).toBe(10);
  });

  it('fails closed before delivery when the server cursor disagrees with its rows', async () => {
    const deliver = vi.fn();
    const inbox = new SessionMessageInbox({
      initialAfterSeq: 10,
      fetchPage: async () => ({
        messages: [message(11)],
        hasMore: false,
        nextAfterSeq: 12,
      }),
      deliver,
    });

    await expect(inbox.reconcile()).rejects.toThrow('expected 11, received 12');
    expect(deliver).not.toHaveBeenCalled();
    expect(inbox.afterSeq).toBe(10);
  });
});
