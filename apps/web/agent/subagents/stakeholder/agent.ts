import { defineAgent } from 'eve';

import { deepseekV4Pro } from '../../deepseek';

export default defineAgent({
  description:
    'Analyze the business impact of a proposed action without executing platform changes.',
  model: deepseekV4Pro,
});
