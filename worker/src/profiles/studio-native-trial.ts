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
  display_name: 'Studio · 내 업무로 AI 체험',
  dashboard_hidden: true, // not offered for customer issuance before live validation
  observation: { enabled: true },
  system_prompt: prompt as unknown as string,
  coach_runtime: 'agent-sdk',
  model: { ...practice.model, max_tokens: 8192 },
  session: { cohort_id: 'studio-native-trial', series_total: 1, series_index: 1, hours: 1 },
  sandbox: { ...practice.sandbox, workspace_root: '~/HypeProofTrial' },
  assets_focus: [...ASSET_FOCUS],
  essences_focus: [],
  skills: [],
  tools: { web_search: true, max_uses: 2 },
  analytics: { log_user_messages: false, log_metadata: true, upload_session_logs: false },
  welcome: {
    greeting_md:
      '바로 만들기 전에, 먼저 지금 어떤 일을 해결하려는지 알아볼게요. 완벽하게 정리되어 있지 않아도 괜찮아요. 몇 번 대화하면서 필요한 걸 같이 명확하게 만들어봅니다.',
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
        { text: '해야 할 일은 있는데 어디서 시작할지 모르겠어', style: 'good', caption: '아직 막연한 일' },
        { text: '이미 하고 있는 일이 있는데 더 잘하고 싶어', style: 'good', caption: '기존 일 개선' },
        { text: 'AI에게 맡기고 싶은데 어디까지 맡겨야 할지 모르겠어', style: 'good', caption: '위임 범위' },
      ],
      follow_up: [],
    },
    hints: { ...structuredClone(practice.ux.hints), short_input: { enabled: false, min_chars: 1, message_md: '' } },
  },
};
