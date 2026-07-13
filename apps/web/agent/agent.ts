import { defineAgent } from 'eve';

export default defineAgent({
  model: 'anthropic/claude-opus-4.8',
  limits: {
    maxSubagentDepth: 1,
    maxSubagents: 1,
    maxInputTokensPerSession: 20_000,
    maxOutputTokensPerSession: 4_000,
  },
});
