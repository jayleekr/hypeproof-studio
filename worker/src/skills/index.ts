// #168 M1 — Studio-bundled meta-skill registry.
//
// Profiles can declare `skills: ["<name>"]`. At chat-time, the worker appends
// the listed skill's markdown to the cached system prefix (see translate.ts
// buildCachedPrefix). The markdown is bundled at build time via the wrangler
// "Text" rule on **/*.md.
//
// Why a registry: a profile may opt into multiple skills later (e.g. boah +
// generic-conversation-coach). Keeping the lookup explicit catches typos at
// the seam, instead of silently shipping a chat with the wrong instructions.
//
// Adding a skill:
//   1. Drop the markdown next to this file (`worker/src/skills/<name>.md`).
//   2. Import it below and add to SKILLS.
//   3. Declare the skill name on a profile's `skills` array.

// @ts-ignore — string import enabled via wrangler text rules (wrangler.toml).
import boaSearchSkillCreator from "./boa-search-skill-creator.md";
// @ts-ignore — string import enabled via wrangler text rules (wrangler.toml).
import publishHomepage from "./publish-homepage.md";
// @ts-ignore — string import enabled via wrangler text rules (wrangler.toml).
import designCraft from "./design-craft.md";
// @ts-ignore — string import enabled via wrangler text rules (wrangler.toml).
import githubRepo from "./github-repo.md";
// @ts-ignore — string import enabled via wrangler text rules (wrangler.toml).
import workshopSetup from "./workshop-setup.md";

export type SkillName =
  | "boa-search-skill-creator"
  | "design-craft"
  | "github-repo"
  | "publish-homepage"
  | "workshop-setup";

const SKILLS: Record<SkillName, string> = {
  "boa-search-skill-creator": boaSearchSkillCreator as unknown as string,
  // #434 — 코호트 프롬프트에 박혀 있던 디자인 원칙(80줄)을 그대로 분리. 코호트가
  // 바뀌어도 같은 how-to라 teaser 등 다른 트랙이 복사 없이 쓸 수 있다.
  "design-craft": designCraft as unknown as string,
  // epic #431 — 큐시트 결과물 3번(저장소). git은 쓰지 않는다: macOS의
  // /usr/bin/git은 CLT stub이라 수업 중에 2GB GUI 설치를 띄운다.
  "github-repo": githubRepo as unknown as string,
  // epic #431 — 큐시트 결과물 2번(배포 URL). 정적이면 GitHub Pages(영구 주소,
  // github-repo 선행), 동적이거나 막히면 Cloudflare 빠른 터널(로그인 불필요).
  "publish-homepage": publishHomepage as unknown as string,
  // #431 — 클릭 설치(앱만) 참가자의 도구 세팅. Jay 의 install.ps1 을
  // HPS_SKIP_STUDIO=1 로 그대로 실행한다 — 자체 설치 로직 없음. 발동 입구는
  // 첫 화면 칩("환경 세팅 점검해줘")이고, 스크립트가 멱등이라 오발동 무해.
  "workshop-setup": workshopSetup as unknown as string,
};

/**
 * Resolve a list of skill names to their concatenated markdown. Unknown skill
 * names are dropped with a console.warn — easier to debug than failing the
 * whole chat request, and the consequence (missing coaching) is visible to
 * the operator as the model behaves like the un-skilled cohort.
 */
export function resolveSkills(names: readonly string[] | undefined): string {
  if (!names || names.length === 0) return "";
  const chunks: string[] = [];
  for (const name of names) {
    const md = SKILLS[name as SkillName];
    if (md) {
      chunks.push(md);
    } else {
      console.warn(`[skills] unknown skill name: ${name}`);
    }
  }
  return chunks.join("\n\n---\n\n");
}

export function isKnownSkill(name: string): name is SkillName {
  return name in SKILLS;
}
