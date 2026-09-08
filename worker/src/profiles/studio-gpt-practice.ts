import type { Profile } from './types';
import { profile as trial } from './studio-native-trial';

// Separate adult practice profile. No production roster/session is opened here.
// Existing proxy supports text and HTML preview, not the Claude SDK tool set.
export const profile: Profile = {
  ...structuredClone(trial),
  id: 'studio-gpt-practice',
  display_name: '내 삶에 AI 더하기 · GPT 실습',
  dashboard_hidden: true,
  observation: { enabled: false },
  coach_runtime: 'proxy',
  model: { provider: 'openai', default: 'gpt-5.6-luna',
    allowed: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'], max_tokens: 4096 },
  session: { cohort_id: 'studio-gpt-practice', series_index: 1, series_total: 1, hours: 1 },
  sandbox: { file_write: true, execute_shell: false, mcp_tools_enabled: [], workspace_root: '~/HypeProofGPTPractice' },
  sdk_tools: { read: false, write: false, shell: false, browser: false, subagents: false },
  browser_control: { enabled: false, max_iterations: 1 },
  input: { page_context: false, image_paste: false },
  tools: { web_search: false, max_uses: 0 },
  publishing: { enabled: false, strategy: 'local_only' },
  system_prompt: trial.system_prompt + '\n현재 GPT 실습은 텍스트 대화와 정적 HTML 미리보기 경로입니다. 파일 읽기/직접 수정, 셸, 웹 검색, 브라우저 조작 도구는 제공되지 않습니다. 사용자가 홈페이지를 요청하면 완전한 HTML을 html 코드 블록으로 주고 앱의 Run으로 열 수 있게 하세요. 확인하지 않은 파일 저장·화면 검수·복구를 완료했다고 말하지 마세요. 기존 파일 수정에는 사용자가 제공한 원문을 사용하세요.',
  welcome: { ...trial.welcome,
    greeting_md: trial.welcome.greeting_md + '\n\nGPT 실습에서는 글과 HTML 초안을 만들 수 있습니다. HTML은 Run으로 열어 확인하세요. AI의 파일 직접 수정·검색·브라우저 검수는 이 연결에서 지원하지 않습니다.' },
};
