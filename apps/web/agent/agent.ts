import { defineAgent } from 'eve';

import { deepseekV4Pro } from './deepseek';

export default defineAgent({
  model: deepseekV4Pro,
  limits: {
    // Eve 0.22.5 的子 Agent 限额只能是正整数。当前 Agent 根目录没有
    // subagents，且未启用 Workflow，因此没有任何可用的委派路径。
    maxInputTokensPerSession: 20_000,
    maxOutputTokensPerSession: 4_000,
  },
});
