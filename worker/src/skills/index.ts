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

export type SkillName = "boa-search-skill-creator" | "publish-homepage";

const SKILLS: Record<SkillName, string> = {
  "boa-search-skill-creator": boaSearchSkillCreator as unknown as string,
  // epic #431 — 큐시트 20:35 블록. 정적이면 GitHub Pages(영구 주소), 동적이거나
  // 막히면 Cloudflare 빠른 터널(로그인 불필요). git은 쓰지 않는다: macOS의
  // /usr/bin/git은 CLT stub이라 수업 중에 2GB GUI 설치를 띄운다.
  "publish-homepage": publishHomepage as unknown as string,
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
