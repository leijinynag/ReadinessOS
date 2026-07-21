import { ArrowLeft, ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { OrganizationAuthorizationService } from '@readinessos/application';
import { prisma } from '@readinessos/database';
import { notFound, redirect } from 'next/navigation';
import { getAuthSession } from '@/lib/auth-session';
import { runService } from '@/lib/run-runtime';
import { LiveWorkspace, type LiveParticipant } from './live-workspace';
import type { LiveAdvisor } from './live-types';

export type LiveAction = {
  key: string;
  label: string;
  risk: 'low' | 'high';
  approval: 'none' | 'required';
  participantIds: readonly string[];
};

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

  const [run, records, specializedPack] = await Promise.all([
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
        knowledgeScopes: true,
        projection: {
          select: {
            status: true,
            data: true,
          },
        },
      },
    }),
    runService.getRunScenarioPack(runId, runReference.organizationId),
  ]);

  const runtimeParticipantIdsByKey = new Map(
    specializedPack.participants.map((participant) => [participant.key, participant.id]),
  );
  const participants: LiveParticipant[] = records.flatMap((participant) => {
    const runtimeParticipantId = runtimeParticipantIdsByKey.get(participant.key);
    // RunParticipant 是投影记录，Kernel 只认识 Pack 里的静态参与方 ID。
    // 如果两者不再对应，则不向浏览器暴露不可执行的参与方。
    if (!runtimeParticipantId) {
      return [];
    }
    return [
      {
        ...participant,
        runtimeParticipantId,
        controller: participant.controller,
        capabilities: stringArray(participant.capabilities),
        objectives: stringArray(participant.objectives),
        knowledgeScopes: stringArray(participant.knowledgeScopes),
      },
    ];
  });
  const actionDefinitions = specializedPack.actions.map((action) => ({
    key: action.key,
    label: action.label,
    risk: action.risk,
    approval: action.approval,
    participantIds: participants
      .filter(
        (participant) =>
          participant.controller === 'human' &&
          containsAll(participant.capabilities, action.requiredCapabilities),
      )
      .map((participant) => participant.runtimeParticipantId),
  }));
  const actions: LiveAction[] = actionDefinitions.filter(
    (action) => action.participantIds.length > 0,
  );
  const injects = specializedPack.injects.map((inject) => ({
    key: inject.key,
    label: inject.key.replaceAll('-', ' '),
  }));
  const participantsByKey = new Map(participants.map((participant) => [participant.key, participant]));
  const actionsByKey = new Map(specializedPack.actions.map((action) => [action.key, action]));
  const advisors: LiveAdvisor[] =
    specializedPack.agentPolicy?.advisors.flatMap((policy) => {
      const advisor = participantsByKey.get(policy.advisorParticipantKey);
      if (!advisor) return [];
      return [
        {
          participantId: advisor.id,
          actions: policy.recommendationPermissions.flatMap((permission) => {
            const target = participantsByKey.get(permission.targetParticipantKey);
            const action = actionsByKey.get(permission.actionType);
            if (!target || !action) return [];
            return [
              {
                targetParticipantId: target.id,
                targetDisplayName: target.displayName,
                actionType: action.key,
                actionLabel: action.label,
                risk: action.risk,
                approval: action.approval,
              },
            ];
          }),
        },
      ];
    }) ?? [];

  return (
    <>
      <div className="live-backbar">
        <div className="page-content">
          <Link className="back-link" href="/scenarios">
            <ArrowLeft size={16} aria-hidden="true" /> 返回场景列表
          </Link>
          <Link className="back-link" href={`/runs/${runId}/review`}>
            <ClipboardCheck size={16} aria-hidden="true" /> 查看复盘
          </Link>
        </div>
      </div>
      <LiveWorkspace
        run={run}
        participants={participants}
        actions={actions}
        injects={injects}
        advisors={advisors}
      />
    </>
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function containsAll(values: readonly string[], required: readonly string[] | undefined): boolean {
  return required?.every((item) => values.includes(item)) ?? true;
}
