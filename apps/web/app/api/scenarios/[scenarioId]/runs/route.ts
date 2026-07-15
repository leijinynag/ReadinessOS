import { OrganizationAuthorizationService, type AuthSession } from '@readinessos/application';
import { prisma } from '@readinessos/database';
import { ApplicationError } from '@readinessos/domain-events';
import { apiError, requiredIdempotencyKey, responseWithRunVersion } from '@/lib/api-response';
import { getAuthSession } from '@/lib/auth-session';
import { drainRuntimeOutbox, runService } from '@/lib/run-runtime';
import {
  createStudioRunService,
  studioRunDraftSchema,
  type StudioRunDraft,
} from '@/lib/studio-run-service';

type RouteContext = { params: Promise<{ scenarioId: string }> };
type PostDependencies = {
  getSession: () => Promise<AuthSession | null>;
  findDemoOrganization: () => Promise<{ id: string } | null>;
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
  }) => ReturnType<ReturnType<typeof createStudioRunService>['createAndStart']>;
  drainOutbox: () => Promise<void>;
};

const authorization = new OrganizationAuthorizationService();

export function createPostHandler(dependencies: PostDependencies) {
  return async function POST(request: Request, context: RouteContext): Promise<Response> {
    try {
      const [{ scenarioId }, draft, session, organization] = await Promise.all([
        context.params,
        request.json().then((body) => studioRunDraftSchema.parse(body)),
        dependencies.getSession(),
        dependencies.findDemoOrganization(),
      ]);
      if (!organization) {
        throw new ApplicationError('NOT_FOUND', 'Demo organization is not configured.');
      }
      authorization.requireOrganizationAccess(session, organization.id, 'member');
      const authenticatedSession = session as AuthSession;
      const idempotencyKey = requiredIdempotencyKey(request);
      const result = await dependencies.createAndStart({
        organizationId: organization.id,
        scenarioId,
        createdById: authenticatedSession.userId,
        actor: {
          id: authenticatedSession.userId,
          type: 'user',
          organizationId: organization.id,
          displayName: authenticatedSession.email,
        },
        idempotencyKey,
        draft,
        simulatedAt: new Date().toISOString(),
      });
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
  findDemoOrganization: () =>
    prisma.organization.findUnique({
      where: { slug: 'readiness-demo' },
      select: { id: true },
    }),
  createAndStart: (input) => createStudioRunService(runService).createAndStart(input),
  drainOutbox: drainRuntimeOutbox,
});
