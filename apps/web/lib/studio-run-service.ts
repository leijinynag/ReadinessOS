import { randomUUID } from 'node:crypto';
import type { RunApplicationService, RunSummary } from '@readinessos/application';
import { Prisma, prisma } from '@readinessos/database';
import { ApplicationError, type ActorRef } from '@readinessos/domain-events';
import { z } from 'zod';
import { studioScenarioConfigSchema, type StudioScenarioConfig } from './scenario-query';

const participantDraftSchema = z
  .object({
    id: z.string().uuid(),
    enabled: z.boolean(),
    controller: z.enum(['human', 'agent', 'system']),
  })
  .strict();

export const studioRunDraftSchema = z
  .object({
    difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
    seed: z.number().int().min(0).max(2_147_483_647),
    selectedObjectiveKeys: z.array(z.string().min(1)).max(100),
    participants: z.array(participantDraftSchema).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    validateDuplicates(value.selectedObjectiveKeys, 'selectedObjectiveKeys', context);
    validateDuplicates(
      value.participants.map((participant) => participant.id),
      'participants',
      context,
    );
  });
export type StudioRunDraft = z.infer<typeof studioRunDraftSchema>;

type CreateStudioRunInput = {
  organizationId: string;
  scenarioId: string;
  createdById: string;
  actor: ActorRef;
  idempotencyKey: string;
  draft: StudioRunDraft;
  simulatedAt: string;
};

type StudioRunResult = {
  run: RunSummary;
  scenarioVersionId: string;
  scenarioVersion: number;
};

type StudioRunDependencies = {
  runService: Pick<RunApplicationService, 'createRun' | 'execute' | 'getRun'>;
};

/**
 * Studio 的写入边界：浏览器草稿只能从最新已发布版本的可信配置派生出一个新的
 * 不可变快照，不能越过 Pack 允许范围直接创建运行时定义。
 */
export class StudioRunService {
  constructor(private readonly dependencies: StudioRunDependencies) {}

  async createAndStart(input: CreateStudioRunInput): Promise<StudioRunResult> {
    const draft = studioRunDraftSchema.parse(input.draft);
    const version = await this.createScenarioVersion(input, draft);
    const runIdempotencyKey = createStudioRunIdempotencyKey(input);
    const run = await this.dependencies.runService.createRun({
      organizationId: input.organizationId,
      scenarioVersionId: version.id,
      createdById: input.createdById,
      idempotencyKey: runIdempotencyKey,
      seed: draft.seed,
      simulatedAt: input.simulatedAt,
    });

    await this.startRun(input, run, runIdempotencyKey);

    return {
      run: await this.dependencies.runService.getRun(run.id, input.organizationId),
      scenarioVersionId: version.id,
      scenarioVersion: version.version,
    };
  }

  private async startRun(
    input: CreateStudioRunInput,
    initialRun: RunSummary,
    runIdempotencyKey: string,
  ): Promise<void> {
    let run = initialRun;
    const idempotencyKey = `studio-start:${runIdempotencyKey}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // 同一浏览器请求并发抵达时，另一请求可能已先启动 Run。重试读取当前
        // version 后会命中稳定的命令幂等键，避免向内核重复写入 start 事件。
        await this.dependencies.runService.execute({
          commandId: randomUUID(),
          organizationId: input.organizationId,
          runId: run.id,
          actor: input.actor,
          expectedRunVersion: run.version,
          idempotencyKey,
          issuedAt: input.simulatedAt,
          payload: { type: 'start-run' },
        });
        return;
      } catch (error) {
        if (!(error instanceof ApplicationError) || error.code !== 'RUN_VERSION_CONFLICT') {
          throw error;
        }
        run = await this.dependencies.runService.getRun(run.id, input.organizationId);
      }
    }

    throw new ApplicationError(
      'RUN_VERSION_CONFLICT',
      'The run changed while the Studio start request was being applied.',
    );
  }

  private async createScenarioVersion(input: CreateStudioRunInput, draft: StudioRunDraft) {
    return prisma.$transaction(async (tx) => {
      // 锁住同一场景后计算版本号，避免并发 Studio 请求撞上 (scenario_id, version) 唯一约束。
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM scenarios
        WHERE id = ${input.scenarioId}::uuid
          AND organization_id = ${input.organizationId}::uuid
        FOR UPDATE
      `);

      const scenario = await tx.scenario.findFirst({
        where: {
          id: input.scenarioId,
          organizationId: input.organizationId,
          status: 'published',
        },
        select: { id: true },
      });
      if (!scenario) {
        throw new ApplicationError('NOT_FOUND', 'Scenario was not found for this organization.');
      }

      const existing = await tx.scenarioVersion.findFirst({
        where: {
          scenarioId: scenario.id,
          config: {
            path: ['_studioRunRequest', 'idempotencyKey'],
            equals: input.idempotencyKey,
          },
        },
        orderBy: { version: 'desc' },
        select: { id: true, version: true },
      });
      if (existing) {
        return existing;
      }

      const publishedBaseline = await tx.scenarioVersion.findFirst({
        where: {
          scenarioId: scenario.id,
          publishedAt: { not: null },
        },
        orderBy: { version: 'desc' },
        select: { config: true, version: true },
      });
      if (!publishedBaseline) {
        throw new ApplicationError('NOT_FOUND', 'Scenario has no published version.');
      }
      const latestVersion = await tx.scenarioVersion.findFirst({
        where: { scenarioId: scenario.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });

      const baseline = studioScenarioConfigSchema.parse(publishedBaseline.config);
      const config = buildScenarioVersionConfig(baseline, draft, {
        idempotencyKey: input.idempotencyKey,
        createdById: input.createdById,
      });
      return tx.scenarioVersion.create({
        data: {
          scenarioId: scenario.id,
          version: (latestVersion?.version ?? 0) + 1,
          config: toInputJson(config),
          publishedAt: new Date(),
        },
        select: { id: true, version: true },
      });
    });
  }
}

export function createStudioRunService(
  runService: Pick<RunApplicationService, 'createRun' | 'execute' | 'getRun'>,
) {
  return new StudioRunService({ runService });
}

function buildScenarioVersionConfig(
  baseline: StudioScenarioConfig,
  draft: StudioRunDraft,
  metadata: { idempotencyKey: string; createdById: string },
): StudioScenarioConfig & { _studioRunRequest: typeof metadata } {
  const objectiveKeys = new Set(baseline.objectives.map((objective) => objective.key));
  for (const objectiveKey of draft.selectedObjectiveKeys) {
    if (!objectiveKeys.has(objectiveKey)) {
      throw new ApplicationError('VALIDATION_ERROR', `Unknown objective: ${objectiveKey}.`);
    }
  }

  const baselineParticipants = new Map(
    baseline.participants.map((participant) => [participant.id, participant]),
  );
  for (const participant of draft.participants) {
    if (!baselineParticipants.has(participant.id)) {
      throw new ApplicationError('VALIDATION_ERROR', `Unknown participant: ${participant.id}.`);
    }
  }

  const participantDrafts = new Map(
    draft.participants.map((participant) => [participant.id, participant]),
  );
  const participants = baseline.participants.flatMap((participant) => {
    const override = participantDrafts.get(participant.id);
    if (!override || !override.enabled) {
      return [];
    }
    return [
      {
        ...participant,
        enabled: true,
        controller: override.controller,
      },
    ];
  });

  if (!participants.some((participant) => participant.controller === 'human')) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      'At least one enabled human participant is required.',
    );
  }

  return {
    ...baseline,
    difficulty: draft.difficulty,
    defaultSeed: draft.seed,
    objectives: baseline.objectives.filter((objective) =>
      draft.selectedObjectiveKeys.includes(objective.key),
    ),
    participants,
    _studioRunRequest: metadata,
  };
}

function validateDuplicates(
  values: readonly string[],
  field: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} must not contain duplicates.`,
      });
      return;
    }
    seen.add(value);
  }
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function createStudioRunIdempotencyKey(
  input: Pick<CreateStudioRunInput, 'scenarioId' | 'idempotencyKey'>,
) {
  // simulation_runs 的唯一键没有 scenario_id。内部增加场景命名空间，保证两个
  // 场景的浏览器请求即使意外使用同一 header，也不会复用彼此的 Run。
  return `studio:${input.scenarioId}:${input.idempotencyKey}`;
}
