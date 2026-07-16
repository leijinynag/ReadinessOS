import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunSummary } from '@readinessos/application';
import { LiveWorkspaceClient } from './live-workspace-client';

const runId = '018f4c8b-9ae2-7a72-86bd-4f867befef11';
const runtimeParticipantId = '018f4c8b-9ae2-7a72-86bd-4f867befef31';

describe('LiveWorkspaceClient', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    // JSDOM 没有布局尺寸，给虚拟列表一个可见视口以覆盖真实渲染路径。
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1024,
      bottom: 640,
      width: 1024,
      height: 640,
      toJSON: () => ({}),
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/actions')) {
        return Response.json({ result: {} }, { headers: { ETag: '"4"' } });
      }
      if (url.includes('/events?')) {
        return Response.json({ events: [], nextCursor: 0 });
      }
      if (url.endsWith(`/api/runs/${runId}`)) {
        return Response.json({ run: runFixture() });
      }
      if (url.includes('/agent-traces')) {
        return Response.json({ agentTraces: [] });
      }
      return Response.json({});
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('以运行时参与方 ID 提交 Human 动作，并显示已接受状态', async () => {
    render(<LiveWorkspaceClient {...workspaceProps()} />);

    fireEvent.click(screen.getByRole('button', { name: '提交动作 宣布事故' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/runs/${runId}/actions`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    const request = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/actions') && init?.method === 'POST',
    );
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      actionType: 'declare-incident',
      participantId: runtimeParticipantId,
    });
    expect(await screen.findByText('已接受')).toBeVisible();
  });
});

function workspaceProps() {
  return {
    run: runFixture(),
    participants: [
      {
        id: '018f4c8b-9ae2-7a72-86bd-4f867befef13',
        runtimeParticipantId,
        key: 'incident-commander',
        displayName: 'Incident Commander',
        controller: 'human' as const,
        capabilities: ['declare-incident'],
        objectives: ['serviceAvailability'],
        knowledgeScopes: ['incident'],
        projection: { status: 'active', data: {} },
      },
    ],
    actions: [
      {
        key: 'declare-incident',
        label: '宣布事故',
        risk: 'high' as const,
        approval: 'required' as const,
        participantIds: [runtimeParticipantId],
      },
    ],
    injects: [],
  };
}

function runFixture(): RunSummary {
  return {
    id: runId,
    organizationId: '018f4c8b-9ae2-7a72-86bd-4f867befef12',
    scenarioVersionId: '018f4c8b-9ae2-7a72-86bd-4f867befef14',
    status: 'running',
    version: 3,
    seed: 42,
    virtualTime: 4,
    latestSequence: 0,
    schedulerGeneration: 1,
    nextTickIndex: 2,
    tickIntervalSeconds: 15,
    startedAt: '2026-07-16T00:00:00.000Z',
    completedAt: undefined,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    data: {
      pendingApprovalIds: [],
      world: {
        service: {
          paymentSuccessRate: 0.96,
          errorRate: 0.04,
          latencyP95Ms: 810,
        },
        impact: { affectedCustomers: 242, estimatedRevenueLoss: 185000 },
        response: { severity: 'sev1' },
        objectives: { serviceAvailability: 'at-risk' },
      },
    },
  };
}
