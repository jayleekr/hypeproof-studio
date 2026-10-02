/**
 * Pure functions for building auto-generated materials and consent items
 * from a cohort profile and (optionally) a lesson model policy.
 *
 * These functions produce the data that the server embeds in ops skeleton
 * HTML as data-auto="true" elements and exposes in brief(file=ops) as
 * auto_materials[] and consent_pending[].
 *
 * No side effects. No I/O. Deterministic given the same inputs.
 * Depends on E3-1 for HTML serialization and parsePlan integration.
 */

import type { Profile } from '../profiles/types.ts';
import type { LessonModelPolicy } from './lesson-model-policy.ts';

export interface AutoMaterial {
  id: string;
  kind: 'physical' | 'digital' | 'account';
  owner: 'instructor' | 'learner' | 'parent';
  text: string;
  /** true when produced from profile config, not typed by the instructor */
  auto: true;
  /** non-null when a known-skill check found an unregistered name */
  warning?: string;
}

export interface ConsentItem {
  key: 'model' | 'account' | 'log-collection' | 'publishing';
  text: string | null;   // null = pending (profile absent or field absent)
  auto: true;
}

/** auto_materials[] embedded in brief(file=ops). */
export function buildAutoMaterials(
  profile: Profile,
  skillValidator: (name: string) => boolean = () => true,
): AutoMaterial[] {
  const items: AutoMaterial[] = [];

  // auto-token: always present (one per cohort)
  items.push({
    id: 'auto-token',
    kind: 'account',
    owner: 'instructor',
    text: '학생 토큰 발급(참가 인원만큼)',
    auto: true,
  });

  // auto-skill-<name>: one line per skill in profile.skills[]
  for (const name of profile.skills ?? []) {
    const item: AutoMaterial = {
      id: `auto-skill-${name}`,
      kind: 'digital',
      owner: 'instructor',
      text: `스킬 ${name} 탑재 확인`,
      auto: true,
    };
    if (!skillValidator(name)) {
      item.warning = `spec.material_unknown_skill: '${name}' is not a registered skill name`;
    }
    items.push(item);
  }

  // auto-studio: always present (all Studio cohorts need Studio installed)
  items.push({
    id: 'auto-studio',
    kind: 'account',
    owner: 'learner',
    text: '학생 기기에 Studio 설치·토큰 입력',
    auto: true,
  });

  return items;
}

/**
 * consent_pending[] keys embedded in brief(file=ops).
 *
 * `analytics` and `publishing` are required fields in Profile, so they are
 * always present when a profile is loaded. pending = profile is null (no
 * profile assigned to this ops context yet).
 */
export function buildAutoConsent(
  profile: Profile | null,
  lessonModelPolicy?: LessonModelPolicy | null,
): ConsentItem[] {
  const minor = profile?.minor_cohort === true;

  // model consent
  const modelName = lessonModelPolicy?.default ?? profile?.model.default ?? null;
  const modelText = modelName !== null
    ? `학생이 쓰는 모델: ${modelName}`
    : null;

  // account consent
  let accountText: string | null = null;
  if (profile !== null) {
    const parts = ['강사 발급 수업 토큰 사용; 학생 개인 계정 없음'];
    if (profile.trial?.individual === true) parts.push('개인 체험 좌석');
    if (minor) parts.push('보호자 동의 필요');
    accountText = parts.join('. ');
  }

  // log-collection consent
  let logText: string | null = null;
  if (profile !== null) {
    const stores = profile.analytics.log_user_messages;
    const suffix = minor ? ' (보호자 동의 필요)' : '';
    logText = stores
      ? `대화 본문을 저장합니다${suffix}`
      : '대화 본문을 저장하지 않습니다';
  }

  // publishing consent
  let pubText: string | null = null;
  if (profile !== null) {
    const { enabled, strategy } = profile.publishing;
    const suffix = minor ? ' (보호자 동의 필요)' : '';
    pubText = enabled
      ? `결과물을 공개합니다(방식: ${strategy})${suffix}`
      : '결과물을 공개하지 않습니다';
  }

  return [
    { key: 'model',          text: modelText,   auto: true },
    { key: 'account',        text: accountText, auto: true },
    { key: 'log-collection', text: logText,     auto: true },
    { key: 'publishing',     text: pubText,     auto: true },
  ];
}

/** Keys of consent items that are still pending (text === null). */
export function consentPendingKeys(items: ConsentItem[]): string[] {
  return items.filter(c => c.text === null).map(c => c.key);
}

/**
 * Returns true when the stored auto-material ids differ from the
 * live (current-config) ids — signals spec.auto_material_stale.
 *
 * Order-insensitive comparison: only the set of ids matters.
 */
export function diffAutoMaterials(storedIds: string[], liveIds: string[]): boolean {
  if (storedIds.length !== liveIds.length) return true;
  const stored = new Set(storedIds);
  return liveIds.some(id => !stored.has(id));
}
