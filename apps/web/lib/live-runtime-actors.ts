import { assign, createMachine } from 'xstate';
import type { RunSummary } from '@readinessos/application';

type RunContext = Pick<RunSummary, 'status' | 'version' | 'virtualTime' | 'latestSequence'>;

export const liveRunMachine = createMachine(
  {
    types: {} as {
      context: RunContext;
      events: { type: 'sync'; run: RunContext };
    },
    id: 'live-run',
    initial: 'created',
    context: ({ input }: { input: RunContext }) => input,
    states: {
      created: { on: { sync: { target: 'route', actions: 'assignRun' } } },
      running: { on: { sync: { target: 'route', actions: 'assignRun' } } },
      paused: { on: { sync: { target: 'route', actions: 'assignRun' } } },
      completed: { on: { sync: { target: 'route', actions: 'assignRun' } } },
      failed: { on: { sync: { target: 'route', actions: 'assignRun' } } },
      route: {
        always: [
          { target: 'created', guard: ({ context }) => context.status === 'created' },
          { target: 'running', guard: ({ context }) => context.status === 'running' },
          { target: 'paused', guard: ({ context }) => context.status === 'paused' },
          { target: 'completed', guard: ({ context }) => context.status === 'completed' },
          { target: 'failed' },
        ],
      },
    },
  },
  {
    actions: {
      assignRun: assign(({ event }) => event.run),
    },
  },
);

export const liveConnectionMachine = createMachine(
  {
    types: {} as {
      context: { recoveries: number };
      events:
        | { type: 'connect' }
        | { type: 'open' }
        | { type: 'recover' }
        | { type: 'offline' }
        | { type: 'gap' };
    },
    id: 'live-connection',
    initial: 'connecting',
    context: { recoveries: 0 },
    states: {
      connecting: {
        on: {
          open: 'connected',
          recover: { target: 'recovering', actions: 'countRecovery' },
          offline: 'offline',
        },
      },
      connected: {
        on: {
          gap: { target: 'recovering', actions: 'countRecovery' },
          recover: { target: 'recovering', actions: 'countRecovery' },
          offline: 'offline',
        },
      },
      recovering: {
        on: {
          open: 'connected',
          offline: 'offline',
        },
      },
      offline: {
        on: {
          connect: 'connecting',
          open: 'connected',
        },
      },
    },
  },
  {
    actions: {
      countRecovery: assign(({ context }) => ({ recoveries: context.recoveries + 1 })),
    },
  },
);

export const liveApprovalMachine = createMachine(
  {
    types: {} as {
      context: { count: number };
      events: { type: 'sync'; count: number };
    },
    id: 'live-approval',
    initial: 'empty',
    context: { count: 0 },
    states: {
      empty: {
        on: {
          sync: [
            { target: 'pending', guard: ({ event }) => event.count > 0, actions: 'assignCount' },
            { actions: 'assignCount' },
          ],
        },
      },
      pending: {
        on: {
          sync: [
            { target: 'empty', guard: ({ event }) => event.count === 0, actions: 'assignCount' },
            { actions: 'assignCount' },
          ],
        },
      },
    },
  },
  {
    actions: {
      assignCount: assign(({ event }) => ({ count: event.count })),
    },
  },
);
