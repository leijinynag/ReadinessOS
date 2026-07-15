import { ApplicationError } from '@readinessos/domain-events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  findScenario: vi.fn(),
  findScenarioVersion: vi.fn(),
}));

vi.mock('@readinessos/database', () => ({
  Prisma: { sql: (parts: TemplateStringsArray) => parts.join('') },
  prisma: {
    $transaction: mocks.transaction,
  },
}));

const { StudioRunService } = await import('./studio-run-service');

const organizationId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';
const scenarioId = '018f4c8b-9ae2-7a72-86bd-4f867befef02';
const userId = '018f4c8b-9ae2-7a72-86bd-4f867befef03';
const runId = '018f4c8b-9ae2-7a72-86bd-4f867befef04';
const scenarioVersionId = '018f4c8b-9ae2-7a72-86bd-4f867befef05';
const participantId = '018f4c8b-9ae2-7a72-86bd-4f867befef06';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      $queryRaw: mocks.queryRaw,
      scenario: { findFirst: mocks.findScenario },
      scenarioVersion: { findFirst: mocks.findScenarioVersion },
    }),
  );
  mocks.findScenario.mockResolvedValue({ id: scenarioId });
  mocks.findScenarioVersion.mockResolvedValue({
    id: scenarioVersionId,
    version: 3,
  });
});

describe('StudioRunService', () => {
  it('将 Run 幂等键限定到场景，并在启动竞争时重试一次', async () => {
    const createRun = vi.fn().mockResolvedValue({
      id: runId,
      version: 0,
    });
    const execute = vi
      .fn()
      .mockRejectedValueOnce(
        new ApplicationError('RUN_VERSION_CONFLICT', 'The run changed before this command.'),
      )
      .mockResolvedValueOnce({});
    const getRun = vi
      .fn()
      .mockResolvedValueOnce({ id: runId, version: 1 })
      .mockResolvedValueOnce({ id: runId, version: 1, status: 'running' });
    const service = new StudioRunService({ runService: { createRun, execute, getRun } });

    const result = await service.createAndStart(createInput());

    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `studio:${scenarioId}:browser-request-1`,
      }),
    );
    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        expectedRunVersion: 0,
        idempotencyKey: `studio-start:studio:${scenarioId}:browser-request-1`,
      }),
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedRunVersion: 1,
        idempotencyKey: `studio-start:studio:${scenarioId}:browser-request-1`,
      }),
    );
    expect(result).toEqual({
      run: { id: runId, version: 1, status: 'running' },
      scenarioVersionId,
      scenarioVersion: 3,
    });
  });
});

function createInput() {
  return {
    organizationId,
    scenarioId,
    createdById: userId,
    actor: {
      id: userId,
      type: 'user' as const,
      organizationId,
      displayName: 'operator@example.com',
    },
    idempotencyKey: 'browser-request-1',
    draft: {
      difficulty: 'intermediate' as const,
      seed: 42,
      selectedObjectiveKeys: ['availability'],
      participants: [{ id: participantId, enabled: true, controller: 'human' as const }],
    },
    simulatedAt: '2026-07-16T00:00:00.000Z',
  };
}
