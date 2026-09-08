import { profile as gpt } from './studio-gpt-practice';
import { ANTHROPIC_MODELS, OPENAI_MODELS, GEMINI_MODELS, GLM_MODELS, type Profile, type ModelKey } from './types';

// Separate synthetic/adult practice admission. Never expands existing classes.
export const profile: Profile = {
  ...structuredClone(gpt),
  id: 'studio-model-practice',
  display_name: '내 삶에 AI 더하기 · 모델 비교',
  audience: { ...gpt.audience, age_range: [18, 99] },
  minor_cohort: false,
  model: { provider: 'glm', default: 'glm-5.2', cross_provider: true,
    allowed: Object.keys({ ...GLM_MODELS, ...OPENAI_MODELS, ...GEMINI_MODELS, ...ANTHROPIC_MODELS }) as ModelKey[], max_tokens: 4096 },
  session: { ...gpt.session, cohort_id: 'studio-model-practice' },
  sandbox: { ...gpt.sandbox, workspace_root: '~/HypeProofModelPractice' },
  system_prompt: gpt.system_prompt.replaceAll('GPT 실습', '모델 비교 실습'),
  welcome: { ...gpt.welcome, greeting_md: gpt.welcome.greeting_md.replaceAll('GPT 실습', '모델 비교 실습') },
};
