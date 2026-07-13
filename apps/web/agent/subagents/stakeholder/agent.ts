import { defineAgent } from 'eve';

export default defineAgent({
  description: 'Analyze the business impact of a proposed action without executing platform changes.',
  model: 'anthropic/claude-opus-4.8',
});
