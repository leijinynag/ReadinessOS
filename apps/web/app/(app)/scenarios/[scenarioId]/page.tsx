import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { notFound, redirect } from 'next/navigation';
import { getAuthSession, getPrimaryOrganizationId } from '@/lib/auth-session';
import { buildScenarioGraph } from '@/lib/scenario-graph';
import { scenarioPackRegistry } from '@/lib/scenario-pack-registry';
import { getPublishedScenarioDetail } from '@/lib/scenario-query';
import { StudioDraft } from './studio-draft';

type ScenarioDetailPageProps = {
  params: Promise<{ scenarioId: string }>;
};

export default async function ScenarioDetailPage({ params }: ScenarioDetailPageProps) {
  const session = await getAuthSession();
  if (!session) {
    redirect('/login');
  }

  const organizationId = getPrimaryOrganizationId(session);

  const { scenarioId } = await params;
  const scenario = await getPublishedScenarioDetail({
    scenarioId,
    organizationId,
  });
  if (!scenario) {
    notFound();
  }

  // packKey 只来自已鉴权查询到的已发布版本；客户端不能替换图的权威 Pack。
  const pack = scenarioPackRegistry.get(scenario.config.packKey);
  const graph = pack ? buildScenarioGraph(pack) : null;

  return (
    <main className="page-content scenario-detail">
      <Link className="back-link" href="/scenarios">
        <ArrowLeft size={16} aria-hidden="true" /> 返回场景列表
      </Link>

      <header className="scenario-detail-header">
        <div>
          <p className="eyebrow">Studio Lite · 场景配置</p>
          <h1>{scenario.name}</h1>
          <p className="page-lede">{scenario.description}</p>
        </div>
        <span className="badge">已发布 v{scenario.version}</span>
      </header>

      <StudioDraft
        scenarioId={scenario.id}
        version={scenario.version}
        baseline={scenario.config}
        graph={graph}
      />
    </main>
  );
}
