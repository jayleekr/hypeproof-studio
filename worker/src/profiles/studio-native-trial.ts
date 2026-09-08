import type { Profile } from './types';
import { ASSET_FOCUS } from './types';
import { profile as practice } from './homepage-practice-s1';
// @ts-ignore — bundled as text by Wrangler, like existing cohort prompts.
import prompt from '../prompts/studio-native-trial.md';

// Native trial runtime. Observation is opt-in; public self-service issuance
// remains hidden until the documented release gates are satisfied.
export const profile: Profile = {
  ...structuredClone(practice),
  id: 'studio-native-trial',
  version: 1,
  display_name: 'Studio · 내 삶에 AI 더하기',
  dashboard_hidden: true, // not offered for customer issuance before live validation
  observation: { enabled: true },
  system_prompt: prompt as unknown as string,
  coach_runtime: 'agent-sdk',
  model: { ...practice.model, provider: 'anthropic', max_tokens: 8192,
    effort: {default:'medium',allowed:['low','medium','high']},
    allowed: ['hypeproof-default', 'hypeproof-fast', 'claude-sonnet-5',
      'claude-sonnet-4-5-20250929', 'claude-opus-5', 'claude-opus-4-8',
      'hypeproof-strong', 'claude-opus-4-6', 'claude-opus-4-5-20251101'],
  },
  session: { cohort_id: 'studio-native-trial', series_total: 1, series_index: 1, hours: 1 },
  sandbox: { ...practice.sandbox, workspace_root: '~/HypeProofTrial' },
  assets_focus: [...ASSET_FOCUS],
  essences_focus: [],
  skills: [],
  tools: { web_search: true, max_uses: 2 },
  analytics: { log_user_messages: false, log_metadata: true, upload_session_logs: false },
  welcome: {
    greeting_md: '지금 해결하거나 더 낫게 만들고 싶은 일이 있나요? 이미 하고 싶은 일이 분명하면 바로 말해주세요. 아직 막연하다면 아래 상황 중 가까운 것을 골라도 좋아요.',
    example_prompts: [
      '해야 할 일은 있는데 어디서 시작할지 모르겠어',
      '이미 하고 있는 일이 있는데 더 잘하고 싶어',
      'AI에게 맡기고 싶은데 어디까지 맡겨야 할지 모르겠어',
    ],
  },
  ux: {
    ...structuredClone(practice.ux),
    coach: { ...practice.ux.coach, naming_mode: 'fixed', fallback_name: '코치', naming_prompt_md: '', personality_prompt_md: '' },
    suggestions: {
      initial: [
        { text: '해야 할 일은 있는데 어디서 시작할지 모르겠어', style: 'good', caption: '시작이 막막해' },
        { text: '이미 하고 있는 일이 있는데 더 잘하고 싶어', style: 'good', caption: '지금 일을 개선' },
        { text: 'AI에게 맡기고 싶은데 어디까지 맡겨야 할지 모르겠어', style: 'good', caption: '위임 범위 고민' },
      ],
      follow_up: [],
    },
    hints: { ...structuredClone(practice.ux.hints), short_input: { enabled: false, min_chars: 1, message_md: '' } },
  },
};
