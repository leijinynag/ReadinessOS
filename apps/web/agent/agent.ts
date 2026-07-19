import { defineAgent } from 'eve';

import { deepseekV4Pro } from './deepseek';

export default defineAgent({
  model: deepseekV4Pro,
  limits: {
    // Eve 0.22.5 的公开配置要求这两个值为正整数。实际的 agent 工具已在
    // tools/agent.ts 禁用，因此这里的最小框架上限不会让模型获得委派能力。
    maxSubagentDepth: 1,
    maxSubagents: 1,
    maxInputTokensPerSession: 20_000,
    maxOutputTokensPerSession: 4_000,
  },
});
