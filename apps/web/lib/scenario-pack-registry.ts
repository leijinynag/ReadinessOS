import { InMemoryScenarioPackRegistry } from '@readinessos/application';
import { customerEscalationPack } from '@readinessos/scenario-pack-customer-escalation';
import { saasIncidentPack } from '@readinessos/scenario-pack-saas-incident';

/**
 * Studio 与 Runtime 共享同一份服务端 Pack allowlist。客户端 packKey 或图数据
 * 永远不能扩展该集合，也不能触发动态模块加载。
 */
export const scenarioPackRegistry = new InMemoryScenarioPackRegistry([
  saasIncidentPack,
  customerEscalationPack,
]);
