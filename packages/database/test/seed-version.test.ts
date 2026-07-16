import { describe, expect, it } from 'vitest';
import { nextSeedScenarioVersion, studioSeedRevision } from '../prisma/seed-version';

const publishedAt = new Date('2026-07-14T00:00:00.000Z');

describe('nextSeedScenarioVersion', () => {
  it('新鲜数据库使用 v1 创建初始发布版本', () => {
    expect(nextSeedScenarioVersion([], studioSeedRevision)).toBe(1);
  });

  it('旧 seed 的 v1 存在时选择下一个不可变版本', () => {
    expect(
      nextSeedScenarioVersion(
        [{ version: 1, publishedAt, config: { packKey: 'saas-incident' } }],
        studioSeedRevision,
      ),
    ).toBe(2);
  });

  it('当前 Studio seed 已发布时重复执行不创建新版本', () => {
    expect(
      nextSeedScenarioVersion(
        [
          { version: 1, publishedAt, config: { packKey: 'legacy' } },
          {
            version: 2,
            publishedAt,
            config: { packKey: 'saas-incident', seedRevision: studioSeedRevision },
          },
        ],
        studioSeedRevision,
      ),
    ).toBeNull();
  });

  it('相同 revision 仅存在草稿时创建下一个已发布版本', () => {
    expect(
      nextSeedScenarioVersion(
        [
          {
            version: 3,
            publishedAt: null,
            config: { seedRevision: studioSeedRevision },
          },
        ],
        studioSeedRevision,
      ),
    ).toBe(4);
  });
});
