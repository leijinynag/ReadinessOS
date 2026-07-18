import { defineAgent } from 'eve';

import { deepseekV4Pro } from './deepseek';

export default defineAgent({
  model: deepseekV4Pro,
  limits: {
    maxSubagentDepth: 0,
    maxSubagents: 0,
    maxInputTokensPerSession: 20_000,
    maxOutputTokensPerSession: 4_000,
  },
});
