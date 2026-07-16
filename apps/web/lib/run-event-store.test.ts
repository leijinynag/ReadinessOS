import { describe, expect, it } from 'vitest';
import { RunEventStore } from './run-event-store';

const runId = '018f4c8b-9ae2-7a72-86bd-4f867befef11';
const organizationId = '018f4c8b-9ae2-7a72-86bd-4f867befef12';

describe('RunEventStore', () => {
  it('按 cursor 去重，并在补齐缺口后推进连续游标', () => {
    const store = new RunEventStore();

    expect(store.ingest(envelope(1))).toMatchObject({ inserted: true, gap: false });
    expect(store.ingest(envelope(3))).toMatchObject({ inserted: true, gap: true });
    expect(store.snapshot()).toMatchObject({ cursor: 1, hasGap: true });

    expect(store.ingest(envelope(2))).toMatchObject({ inserted: true, gap: false });
    expect(store.snapshot()).toMatchObject({ cursor: 3, hasGap: false });
    expect(store.ingest(envelope(3))).toMatchObject({ inserted: false, duplicate: true });
    expect(store.snapshot().events.map((item) => item.cursor)).toEqual([1, 2, 3]);
  });

  it('跟踪命令的 pending、accepted 与 rejected 状态', () => {
    const store = new RunEventStore();
    store.enqueueCommand({ id: 'command-1', label: '暂停运行' });
    store.resolveCommand('command-1', 'accepted');
    store.enqueueCommand({ id: 'command-2', label: '触发注入' });
    store.resolveCommand('command-2', 'rejected', '当前注入不可用');

    expect(store.snapshot().pendingCommands).toEqual([
      { id: 'command-1', label: '暂停运行', status: 'accepted' },
      { id: 'command-2', label: '触发注入', status: 'rejected', message: '当前注入不可用' },
    ]);
  });
});

function envelope(cursor: number) {
  return {
    cursor,
    event: {
      id: `018f4c8b-9ae2-7a72-86bd-4f867befef${String(cursor).padStart(2, '0')}`,
      organizationId,
      runId,
      sequence: cursor,
      type: 'state.changed',
      version: 1,
      source: 'system' as const,
      simulatedAt: '2026-07-16T00:00:00.000Z',
      recordedAt: '2026-07-16T00:00:00.000Z',
      idempotencyKey: `event-${cursor}`,
      payload: {},
    },
  };
}
