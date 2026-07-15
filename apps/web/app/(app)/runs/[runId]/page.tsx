import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { OrganizationAuthorizationService } from '@readinessos/application';
import { prisma } from '@readinessos/database';
import { notFound, redirect } from 'next/navigation';
import { getAuthSession } from '@/lib/auth-session';
import { runService } from '@/lib/run-runtime';
import { LiveWorkspace, type LiveParticipant } from './live-workspace';

type LiveRunPageProps = {
  params: Promise<{ runId: string }>;
};

export default async function LiveRunPage({ params }: LiveRunPageProps) {
  const session = await getAuthSession();
  if (!session) {
    redirect('/login');
  }

  const { runId } = await params;
  // 先使用 Run 的真实 organizationId 鉴权，再读取投影；URL 中的 runId 不能越过租户边界。
  const runReference = await prisma.simulationRun.findUnique({
    where: { id: runId },
    select: { organizationId: true },
  });
  if (!runReference) {
    notFound();
  }

  new OrganizationAuthorizationService().requireOrganizationAccess(
    session,
    runReference.organizationId,
  );

  const [run, records] = await Promise.all([
    runService.getRun(runId, runReference.organizationId),
    prisma.runParticipant.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        key: true,
        displayName: true,
        controller: true,
        capabilities: true,
        objectives: true,
        projection: {
          select: {
            status: true,
            data: true,
          },
        },
      },
    }),
  ]);

  const participants: LiveParticipant[] = records.map((participant) => ({
    ...participant,
    controller: participant.controller,
    capabilities: stringArray(participant.capabilities),
    objectives: stringArray(participant.objectives),
  }));

  return (
    <>
      <div className="live-backbar">
        <div className="page-content">
          <Link className="back-link" href="/scenarios">
            <ArrowLeft size={16} aria-hidden="true" /> 返回场景列表
          </Link>
        </div>
      </div>
      <LiveWorkspace run={run} participants={participants} />
    </>
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
