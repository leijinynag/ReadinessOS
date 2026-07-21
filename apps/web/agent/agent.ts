import { defineAgent } from 'eve';

import { deepseekV4Pro } from './deepseek';

export default defineAgent({
  model: deepseekV4Pro,
  limits: {
    // 角色 Agent 只负责分析和形成建议，禁止委派给子 Agent。
    maxSubagentDepth: 0,
    maxSubagents: 0,
    maxInputTokensPerSession: 20_000,
    maxOutputTokensPerSession: 4_000,
  },
});
