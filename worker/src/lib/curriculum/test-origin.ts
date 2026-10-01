// Where published test versions are served (recon §6 "Test origin"; Jay's decision 5).
//
// One origin per project, never api.hypeproof-ai.xyz (its /admin uses Basic auth) and never
// hypeproof-ai.xyz (member cookies). The host is configuration, `HPS_TEST_ORIGIN`:
//   - `https://{project}.try.hypeproof-ai.xyz`: the production setting, live only once Jay
//     approves the DNS and Worker route at a deploy (decision 5);
//   - `http://{project}.test.invalid:<port>`: local and e2e runs (hostResolverRules map it);
//   - one host without `{project}` (an ngrok URL): a dev-only shared origin so a phone can
//     open a link before the wildcard domain exists. Refused when ENVIRONMENT is production,
//     because every project would then share one origin and its storage.
// Unset (the default) means no link can be issued: the publish route says so instead of
// inventing a host.

export interface TestOriginConfig {
  /** `dedicated`: one origin per project. `shared`: dev only, one origin for all. */
  mode: "dedicated" | "shared";
  scheme: "http:" | "https:";
  /** Host pattern parts: `{project}` + suffix (dedicated), or the whole host (shared). */
  suffix: string;
  port: string;
}

export type TestOriginProblem = "not_configured" | "invalid" | "shared_in_production" | "http_in_production";

export function parseTestOrigin(template: string | undefined | null, environment: string | undefined): { ok: true; config: TestOriginConfig } | { ok: false; problem: TestOriginProblem } {
  const raw = (template ?? "").trim().replace(/\/+$/, "");
  if (!raw) return { ok: false, problem: "not_configured" };
  const dedicated = raw.includes("{project}");
  let u: URL;
  try {
    u = new URL(raw.replace("{project}", "project-placeholder"));
  } catch {
    return { ok: false, problem: "invalid" };
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.pathname !== "/" || u.search || u.hash || u.username || u.password) return { ok: false, problem: "invalid" };
  if (dedicated && !u.hostname.startsWith("project-placeholder.")) return { ok: false, problem: "invalid" };
  if (environment === "production" && !dedicated) return { ok: false, problem: "shared_in_production" };
  if (environment === "production" && u.protocol !== "https:") return { ok: false, problem: "http_in_production" };
  return {
    ok: true,
    config: {
      mode: dedicated ? "dedicated" : "shared",
      scheme: u.protocol as "http:" | "https:",
      suffix: dedicated ? u.hostname.slice("project-placeholder".length) : u.hostname,
      port: u.port,
    },
  };
}

/** A project id is used as the DNS label of its origin (`prj-<hex>`, lowercased). */
export const projectLabel = (projectId: string): string => projectId.toLowerCase();

export function originFor(config: TestOriginConfig, projectId: string): string {
  const host = config.mode === "dedicated" ? `${projectLabel(projectId)}${config.suffix}` : config.suffix;
  return `${config.scheme}//${host}${config.port ? `:${config.port}` : ""}`;
}

/**
 * Is this request for a test origin? `dedicated`: any host of the pattern, every path.
 * `shared`: the configured host, only under `/l/`, so the dev Service keeps answering its
 * own routes on other paths.
 */
export function matchTestOrigin(config: TestOriginConfig, url: URL): { project_label: string | null } | null {
  const host = url.hostname.toLowerCase();
  const portOk = (url.port || "") === (config.port || "");
  if (!portOk) return null;
  if (config.mode === "dedicated") {
    if (!host.endsWith(config.suffix.toLowerCase())) return null;
    const label = host.slice(0, host.length - config.suffix.length);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(label)) return null;
    return { project_label: label };
  }
  if (host !== config.suffix.toLowerCase()) return null;
  return url.pathname.startsWith("/l/") ? { project_label: null } : null;
}

export function shareUrl(config: TestOriginConfig, projectId: string, linkId: string): string {
  return `${originFor(config, projectId)}/l/${linkId}/`;
}
