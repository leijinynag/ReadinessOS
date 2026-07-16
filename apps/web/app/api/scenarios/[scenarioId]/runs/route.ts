import { type AuthSession } from '@readinessos/application';
import { ApplicationError } from '@readinessos/domain-events';
import { apiError, requiredIdempotencyKey, responseWithRunVersion } from '@/lib/api-response';
import { getAuthSession, getPrimaryOrganizationId } from '@/lib/auth-session';
import { withSpan } from '@/lib/observability';
import { drainRuntimeOutbox, runService } from '@/lib/run-runtime';
import { guestRunExpiresAt } from '@/lib/release-policy';
import {
  createStudioRunService,
  studioRunDraftSchema,
  type StudioRunDraft,
} from '@/lib/studio-run-service';

type RouteContext = { params: Promise<{ scenarioId: string }> };
type PostDependencies = {
  getSession: () => Promise<AuthSession | null>;
  createAndStart: (input: {
    organizationId: string;
    scenarioId: string;
    createdById: string;
    actor: {
      id: string;
      type: 'user';
      organizationId: string;
      displayName: string;
    };
    idempotencyKey: string;
    draft: StudioRunDraft;
    simulatedAt: string;
    expiresAt?: string;
  }) => ReturnType<ReturnType<typeof createStudioRunService>['createAndStart']>;
  drainOutbox: () => Promise<void>;
};

export function createPostHandler(dependencies: PostDependencies) {
  return async function POST(request: Request, context: RouteContext): Promise<Response> {
    try {
      const [{ scenarioId }, draft, session] = await Promise.all([
        context.params,
        request.json().then((body) => studioRunDraftSchema.parse(body)),
        dependencies.getSession(),
      ]);
      if (!session) throw new ApplicationError('UNAUTHENTICATED', 'Authentication is required.');
      const authenticatedSession = session as AuthSession;
      const organizationId = getPrimaryOrganizationId(authenticatedSession);
      const idempotencyKey = requiredIdempotencyKey(request);
      const result = await withSpan(
        'readinessos.command.create_and_start_run',
        {
          'organization.id': organizationId,
          'scenario.id': scenarioId,
          'actor.is_guest': authenticatedSession.isGuest,
        },
        () =>
          dependencies.createAndStart({
            organizationId,
            scenarioId,
            createdById: authenticatedSession.userId,
            actor: {
              id: authenticatedSession.userId,
              type: 'user',
              organizationId,
              displayName: authenticatedSession.email,
            },
            idempotencyKey,
            draft,
            simulatedAt: new Date().toISOString(),
            ...(authenticatedSession.isGuest
              ? { expiresAt: guestRunExpiresAt().toISOString() }
              : {}),
          }),
      );
      await dependencies.drainOutbox();
      return responseWithRunVersion(
        {
          run: result.run,
          scenarioVersion: {
            id: result.scenarioVersionId,
            version: result.scenarioVersion,
          },
        },
        result.run.version,
        201,
      );
    } catch (error) {
      return apiError(error);
    }
  };
}

export const POST = createPostHandler({
  getSession: getAuthSession,
  createAndStart: (input) => createStudioRunService(runService).createAndStart(input),
  drainOutbox: drainRuntimeOutbox,
});
