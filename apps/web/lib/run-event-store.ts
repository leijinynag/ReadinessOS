import type { StreamEnvelope } from '@readinessos/application';

export type PendingCommandStatus = 'pending' | 'accepted' | 'rejected';

export type PendingRunCommand = {
  id: string;
  label: string;
  status: PendingCommandStatus;
  message?: string;
};

export type RunEventStoreSnapshot = {
  cursor: number;
  events: readonly StreamEnvelope[];
  pendingCommands: readonly PendingRunCommand[];
  hasGap: boolean;
};

export type EventIngestResult = {
  inserted: boolean;
  duplicate: boolean;
  gap: boolean;
};

/**
 * 浏览器端事件缓存只负责显示与恢复。它不替代数据库事件流：
 * cursor 永远以服务端 `run_events.sequence` 为准，遇到缺口必须回源补拉。
 */
export class RunEventStore {
  private readonly envelopes = new Map<number, StreamEnvelope>();
  private readonly commands = new Map<string, PendingRunCommand>();
  private cursor = 0;
  private hasGap = false;

  ingest(envelope: StreamEnvelope): EventIngestResult {
    if (this.envelopes.has(envelope.cursor) || envelope.cursor <= this.cursor) {
      return { inserted: false, duplicate: true, gap: this.hasGap };
    }

    const gap = envelope.cursor !== this.cursor + 1;
    this.envelopes.set(envelope.cursor, envelope);
    if (gap) {
      this.hasGap = true;
      return { inserted: true, duplicate: false, gap: true };
    }

    this.advanceCursor();
    return { inserted: true, duplicate: false, gap: this.hasGap };
  }

  ingestMany(envelopes: readonly StreamEnvelope[]): EventIngestResult {
    let inserted = false;
    let duplicate = false;
    for (const envelope of [...envelopes].sort((left, right) => left.cursor - right.cursor)) {
      const result = this.ingest(envelope);
      inserted ||= result.inserted;
      duplicate ||= result.duplicate;
    }
    return { inserted, duplicate, gap: this.hasGap };
  }

  enqueueCommand(command: Omit<PendingRunCommand, 'status'>): void {
    this.commands.set(command.id, { ...command, status: 'pending' });
  }

  resolveCommand(
    id: string,
    status: Exclude<PendingCommandStatus, 'pending'>,
    message?: string,
  ): void {
    const command = this.commands.get(id);
    if (!command) {
      return;
    }
    this.commands.set(id, { ...command, status, ...(message === undefined ? {} : { message }) });
  }

  snapshot(): RunEventStoreSnapshot {
    return {
      cursor: this.cursor,
      events: [...this.envelopes.values()].sort((left, right) => left.cursor - right.cursor),
      pendingCommands: [...this.commands.values()],
      hasGap: this.hasGap,
    };
  }

  private advanceCursor(): void {
    while (this.envelopes.has(this.cursor + 1)) {
      this.cursor += 1;
    }
    this.hasGap = [...this.envelopes.keys()].some((cursor) => cursor > this.cursor + 1);
  }
}
