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
    greeting_md: '지금 하는 일에서 작게 하나 만들어볼까요? 시작이 막막하면 아래 예시를 골라도 좋아요.',
    example_prompts: ['내 업무를 설명하는 자료를 만들고 싶어', '여러 선택지를 비교해서 결정하고 싶어', '반복하는 일을 줄일 방법을 찾아보고 싶어'],
  },
  ux: {
    ...structuredClone(practice.ux),
    coach: { ...practice.ux.coach, naming_mode: 'fixed', fallback_name: '코치', naming_prompt_md: '', personality_prompt_md: '' },
    suggestions: {
      initial: [
        { text: '내 업무를 설명하는 자료를 만들고 싶어', style: 'good', caption: '설명 자료' },
        { text: '여러 선택지를 비교해서 결정하고 싶어', style: 'good', caption: '비교와 결정' },
        { text: '반복하는 일을 줄일 방법을 찾아보고 싶어', style: 'good', caption: '반복 업무' },
      ],
      follow_up: [],
    },
    hints: { ...structuredClone(practice.ux.hints), short_input: { enabled: false, min_chars: 1, message_md: '' } },
  },
};
