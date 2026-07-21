import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunSummary } from '@readinessos/application';
import { LiveWorkspaceClient } from './live-workspace-client';

const runId = '018f4c8b-9ae2-7a72-86bd-4f867befef11';
const runtimeParticipantId = '018f4c8b-9ae2-7a72-86bd-4f867befef31';

describe('LiveWorkspaceClient', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let actionResponse: Record<string, unknown>;

  beforeEach(() => {
    fetchMock.mockReset();
    actionResponse = { result: {} };
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
        return Response.json(actionResponse, { headers: { ETag: '"4"' } });
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
      if (url.endsWith('/recommendations')) {
        return Response.json({
          recommendations: [],
          questions: [],
          activities: [],
          nextActivityCursor: 0,
        });
      }
      if (url.endsWith('/approvals')) {
        return Response.json({
          approvals: [
            {
              id: '018f4c8b-9ae2-7a72-86bd-4f867befef41',
              actionType: 'declare-incident',
              participantId: runtimeParticipantId,
              requestedSequence: 5,
              parameters: {},
              status: 'pending',
              requestedAt: '2026-07-16T00:00:00.000Z',
              expiresAt: '2026-07-16T00:15:00.000Z',
              evidence: [],
            },
          ],
        });
      }
      if (init?.method === 'POST' && url.includes('/approvals/')) {
        return Response.json({ result: {} }, { headers: { ETag: '"5"' } });
      }
      return Response.json({});
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('以运行时参与方 ID 提交 Human 动作，并显示已接受状态', async () => {
    render(<LiveWorkspaceClient {...workspaceProps()} />);

    fireEvent.click(screen.getAllByRole('button', { name: '提交动作 宣布事故' }).at(-1)!);

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

  it('展示待审批动作并可以批准', async () => {
    render(<LiveWorkspaceClient {...workspaceProps()} />);

    expect(await screen.findByText('待审批')).toBeVisible();
    fireEvent.click(screen.getAllByRole('button', { name: '批准' }).at(-1)!);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/approvals/018f4c8b-9ae2-7a72-86bd-4f867befef41'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('兼容旧接口返回的 200 + Kernel 拒绝，不把命令显示为已接受', async () => {
    actionResponse = {
      result: {
        status: 'rejected',
        rejection: { message: 'Run version does not match the command.' },
      },
    };
    render(<LiveWorkspaceClient {...workspaceProps()} />);

    fireEvent.click(screen.getAllByRole('button', { name: '提交动作 宣布事故' }).at(-1)!);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Run version does not match the command.',
    );
    expect(screen.queryByText('已接受')).not.toBeInTheDocument();
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
    advisors: [],
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
    expiresAt: undefined,
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
