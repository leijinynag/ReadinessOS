import { createOpenAI } from '@ai-sdk/openai';

// DeepSeek 提供 OpenAI 兼容接口，模型调用不会经过 Vercel AI Gateway。
const deepseek = createOpenAI({
  name: 'deepseek',
  apiKey: process.env.DEEPSEEK_API_KEY?.trim() ?? '',
  baseURL: 'https://api.deepseek.com/v1',
});

export const deepseekV4Pro = deepseek.chat('deepseek-v4-pro');
