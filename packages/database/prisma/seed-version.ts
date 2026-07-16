export const studioSeedRevision = 'studio-lite-v1';
export const saasIncidentSeedRevision = 'saas-incident-v2';

type ExistingScenarioVersion = {
  version: number;
  publishedAt: Date | null;
  config: unknown;
};

/**
 * Seed 只在尚无当前已发布模板时选择下一个版本号，绝不修改既有版本。
 * revision 标记让重复执行稳定命中同一版本，同时允许旧 seed 迁移到新版本。
 */
export function nextSeedScenarioVersion(
  versions: readonly ExistingScenarioVersion[],
  revision: string,
): number | null {
  const currentPublishedVersion = versions.some(
    (version) => version.publishedAt !== null && readSeedRevision(version.config) === revision,
  );
  if (currentPublishedVersion) {
    return null;
  }

  return versions.reduce((maximum, version) => Math.max(maximum, version.version), 0) + 1;
}

function readSeedRevision(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return undefined;
  }

  const revision = Reflect.get(config, 'seedRevision');
  return typeof revision === 'string' ? revision : undefined;
}
