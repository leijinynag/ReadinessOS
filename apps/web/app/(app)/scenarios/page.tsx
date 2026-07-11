import Link from 'next/link';
import { ArrowRight, Clock3 } from 'lucide-react';
import { OrganizationAuthorizationService } from '@readinessos/application';
import { prisma } from '@readinessos/database';
import { redirect } from 'next/navigation';
import { getAuthSession } from '@/lib/auth-session';
import { formatDuration } from '@/lib/format';

type ScenarioConfig = {
  defaultDurationMinutes?: number;
};

export default async function ScenariosPage() {
  const [session, organization] = await Promise.all([
    getAuthSession(),
    prisma.organization.findUnique({
      where: {
        slug: 'readiness-demo',
      },
    }),
  ]);

  if (!organization) {
    return null;
  }

  // RSC 的页面与 Layout 可并行执行，页面本身也应处理未认证请求，避免产生无意义的 500 日志。
  if (!session) {
    redirect('/login');
  }

  new OrganizationAuthorizationService().requireOrganizationAccess(session, organization.id);

  const scenarios = await prisma.scenario.findMany({
    where: {
      status: 'published',
      organizationId: organization.id,
    },
    include: {
      versions: {
        where: {
          publishedAt: {
            not: null,
          },
        },
        orderBy: {
          version: 'desc',
        },
        take: 1,
      },
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  return (
    <main className="page-content">
      <p className="eyebrow">场景工作区</p>
      <h1>选择一次业务韧性演练</h1>
      <p className="page-lede">
        每个场景都通过确定性 Simulation Kernel 推进，并让受权限与证据约束的参与方协作决策。
      </p>

      {scenarios.length === 0 ? (
        <div className="empty-state">
          还没有已发布场景。运行 <code>pnpm db:seed</code> 创建本地演示数据。
        </div>
      ) : (
        <div className="scenario-grid">
          {scenarios.map((scenario) => {
            const version = scenario.versions[0];
            const config = (version?.config ?? {}) as ScenarioConfig;

            return (
              <article className="scenario-card" key={scenario.id}>
                <div>
                  <span className="badge">已发布 v{version?.version ?? 1}</span>
                  <h2>{scenario.name}</h2>
                  <p>{scenario.description}</p>
                </div>
                <div className="card-meta">
                  <span>
                    <Clock3 size={15} aria-hidden="true" />{' '}
                    {formatDuration(config.defaultDurationMinutes ?? 10)}
                  </span>
                  <Link
                    className="button button-secondary"
                    href={`/scenarios/${scenario.id}`}
                    aria-label={`打开${scenario.name}`}
                  >
                    配置 <ArrowRight size={16} aria-hidden="true" />
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
