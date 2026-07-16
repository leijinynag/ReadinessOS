import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { ApplicationError } from '@readinessos/domain-events';
import { prisma } from '@readinessos/database';
import { notFound, redirect } from 'next/navigation';
import { getAuthSession } from '@/lib/auth-session';
import { requireRunSession } from '@/lib/run-api';
import { runService } from '@/lib/run-runtime';
import { ReviewWorkspace } from './review-workspace';

type ReviewPageProps = { params: Promise<{ runId: string }> };

export default async function ReviewPage({ params }: ReviewPageProps) {
  const session = await getAuthSession();
  if (!session) redirect('/login');
  const { runId } = await params;
  const run = await prisma.simulationRun.findUnique({
    where: { id: runId },
    select: { organizationId: true },
  });
  if (!run) notFound();
  await requireRunSession(run.organizationId, 'viewer');
  const review = await runService.getReview(runId, run.organizationId);
  if (!review) throw new ApplicationError('NOT_FOUND', 'Review not found');
  return (
    <>
      <div className="live-backbar">
        <div className="page-content">
          <Link className="back-link" href={`/runs/${runId}`}>
            <ArrowLeft size={16} aria-hidden="true" /> 返回实时运行
          </Link>
        </div>
      </div>
      <ReviewWorkspace initialReview={review} />
    </>
  );
}
