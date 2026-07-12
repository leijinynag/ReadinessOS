import {
  InMemoryScenarioPackRegistry,
  PrismaRunRepository,
  RunApplicationService,
  RunEventHub,
  RuntimeOutboxPublisher,
  type OutboxMessageHandler,
} from '@readinessos/application';
import { prisma } from '@readinessos/database';
import { saasIncidentPack } from '@readinessos/scenario-pack-saas-incident';

/**
 * Runtime 组合根只存在于 Web 层：Application 保持对 Next、Workflow、Eve
 * 与具体场景包无感，因而内核可在测试或其他宿主中复用。
 */
const registry = new InMemoryScenarioPackRegistry([saasIncidentPack]);
const repository = new PrismaRunRepository(prisma);
const hub = new RunEventHub();

let schedulerHandler: OutboxMessageHandler | undefined;
let publisher: RuntimeOutboxPublisher | undefined;

export const runService = new RunApplicationService(repository, registry);
export { hub as runEventHub, repository as runRepository };

export function configureRuntimeOutboxHandlers(
  handlers: Readonly<Record<string, OutboxMessageHandler>>,
) {
  schedulerHandler = handlers['run.scheduler.start'];
  publisher = new RuntimeOutboxPublisher(repository, hub, handlers);
}

/**
 * Command 成功后立即尝试投递 Outbox。未投递完的消息仍由后续请求或对账任务
 * 接管，因此进程重启不会损失事件。
 */
export async function drainRuntimeOutbox(): Promise<void> {
  const activePublisher =
    publisher ??
    new RuntimeOutboxPublisher(repository, hub, {
      ...(schedulerHandler ? { 'run.scheduler.start': schedulerHandler } : {}),
    });

  for (let batch = 0; batch < 10; batch += 1) {
    const count = await activePublisher.publishPending(100);
    if (count === 0) {
      return;
    }
  }
}
