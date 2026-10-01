// "사용자 테스트용으로 공개" — the App side of Publish for User Test (cr-publish #1393;
// CR-11, CR-17–CR-22, CR-39, CR-64, CR-73, CR-81). Pure over its ports, vscode-free, so a
// smoke drives exactly what the provider runs.
//
// One action from the panel: build the R4 published set of the version in the preview (the
// publish scan refuses before anything is uploaded), upload it as a content-addressed test
// version of the student's Project, start the test (the Service stores the Experiment and,
// when the Project has none, the student's Hypothesis: CR-39), and issue a share link with
// the expiry the student chose (there is no default yet: CR-19) and an optional channel
// label (CR-73). The panel shows whether that version is verified, read from the record's
// events by `productVerification` for exactly this version (CR-81); nothing here sets it.
// The project's test origin joins the Experiment Browser's allowed origins (CR-11).

import { productVerification } from "../../../worker/src/lib/measurement-core/verification.ts";
import type { ObservationEvent } from "../../../worker/src/lib/measurement-core/legacy-observation.ts";
import { buildPublishSet, publishSetRefusalText, type PublishSet } from "./publishSet.ts";
import { curriculumRequest, publishTestVersion, type CurriculumResult } from "./galleryPublish.ts";
import type { PublishExperimentView, PublishForm, PublishLinkView, PublishView } from "./publishView.ts";

export interface PublishPorts {
  switchOn(): boolean;
  token(): Promise<string | null>;
  /** The Service's curriculum base (`curriculumBase(proxyUrl)`). */
  base(): string;
  fetchImpl?: typeof fetch;
  /** The live server's root and the entry page's URL path; null when no preview runs. */
  root(): string | null;
  entry(): string | null;
  /** The seat's observation events, for CR-81. */
  events(): Promise<readonly ObservationEvent[]>;
  projectId(): string | undefined;
  setProjectId(id: string | undefined): Promise<void>;
  /** The project's test origin as last read from the Service, kept with the project id (CR-11 after a restart). */
  rememberedOrigin?(): string | null;
  rememberOrigin?(origin: string | null): Promise<void>;
  /** The lesson's curriculum week, when the profile names one. */
  week(): number | null;
  defaultTitle(): string;
  now?(): number;
  /** The QR image of a share URL (testQr.ts `qrDataUrl` in the App), drawn on this machine. */
  qr(url: string): string;
}

/** CR-64: publishing a test version completes in under 10 s. */
export const PUBLISH_TARGET_MS = 10_000;

/** A timing against the target: a miss is recorded with its cause, never rounded away (CR-T20). */
export function publishTiming(startedAt: number, endedAt: number, phases: Record<string, number>, targetMs = PUBLISH_TARGET_MS): { ms: number; ok: boolean; cause: string | null } {
  const ms = endedAt - startedAt;
  if (ms < targetMs) return { ms, ok: true, cause: null };
  const slowest = Object.entries(phases).sort((a, b) => b[1] - a[1])[0];
  return { ms, ok: false, cause: slowest ? `${slowest[0]} ${slowest[1]}ms` : "unknown" };
}

type Client = { base: string; token: string; fetchImpl?: typeof fetch };

type ProjectState = {
  project: { id: string; title: string; members?: string[] };
  test_origin: string | null;
  versions: Array<{ id: string; entry_html?: string; files?: Array<{ path: string; sha256: string; bytes: number }> }>;
  hypotheses: Array<{ id: string; statement: string }>;
  experiments: Array<{ id: string; week: number; question: string; method: string; success_criteria: string[]; hypothesis_id: string; product_version_id: string; status: string }>;
  links: Array<{ id: string; experiment_id: string; channel?: string; expires_at: number; state: "live" | "revoked" | "expired"; share_url: string | null }>;
};

const DAY = 24 * 3600_000;
/** One refused file as the student reads it; a hit without a known line names the file only. */
const hitLine = (h: { file: string; line: number; rule: string }) => (h.line > 0 ? `${h.file} ${h.line}번째 줄 (${h.rule})` : `${h.file} (${h.rule})`);
/** The sign-in code, in the App's own words for it (startPage.ts "수업 참여 코드"). */
const SIGN_IN = "참여 코드를 먼저 입력해 주세요.";

export class PublishSession {
  private origin: string | null = null;
  private cached: ProjectState | null = null;
  private timing: PublishView["timing"] = null;
  private manifest: string[] = [];
  private readonly ports: PublishPorts;
  constructor(ports: PublishPorts) {
    this.ports = ports;
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  /** CR-11: the published test origin of the student's own Project (none until known). */
  publishedOrigins(): string[] {
    const origin = this.origin ?? this.ports.rememberedOrigin?.() ?? null;
    return this.ports.switchOn() && this.ports.projectId() && origin ? [origin] : [];
  }

  private async client(): Promise<Client | null> {
    const token = await this.ports.token();
    return token ? { base: this.ports.base(), token, ...(this.ports.fetchImpl ? { fetchImpl: this.ports.fetchImpl } : {}) } : null;
  }

  private scanContext(projectId: string | undefined) {
    return { projectId: projectId ?? "", testOrigin: this.origin };
  }

  private async currentSet(projectId: string | undefined, manifest: string[]): Promise<{ ok: true; set: PublishSet } | { ok: false; message: string; lines: string[] } | null> {
    const root = this.ports.root();
    const entry = this.ports.entry();
    if (!root || !entry) return null;
    const built = await buildPublishSet(root, entry, manifest, this.scanContext(projectId));
    if (built.ok) return built;
    return {
      ok: false,
      message: publishSetRefusalText(built.refusal),
      lines: (built.refusal.hits ?? []).map(hitLine),
    };
  }

  private async state(client: Client, projectId: string): Promise<CurriculumResult<ProjectState>> {
    const r = await curriculumRequest<ProjectState>(client, "GET", `/projects/${encodeURIComponent(projectId)}`);
    if (!r.ok) return r;
    this.origin = r.body.test_origin;
    this.cached = r.body;
    await this.ports.rememberOrigin?.(this.origin);
    return r;
  }

  /**
   * The student's Project on the Service. The remembered one when it answers; otherwise one
   * the student is a member of (`GET /projects`: a team Project the director set up, or their
   * own after a lost id), the newest first; otherwise none (`state: null`), and only then may
   * a publish create one. Any answer that is not definite (a network failure, a 5xx, or a
   * 404 from the list, which is also what every route answers while the switch is off) is an
   * error the student reads, and the remembered id is kept: nothing is forked or orphaned.
   */
  private async resolveProject(client: Client): Promise<{ ok: true; state: ProjectState | null } | { ok: false; message: string }> {
    const remembered = this.ports.projectId();
    if (remembered) {
      const r = await this.state(client, remembered);
      if (r.ok) {
        // A solo Project made before the director set up the team gives way to the team's
        // (decision 7), so the team's experiments and evidence stay in one Project. Only a
        // definite list can move it; any failure keeps the remembered one.
        if ((r.body.project.members?.length ?? 1) > 1) return { ok: true, state: r.body };
        const list = await curriculumRequest<{ projects: Array<{ id: string; members?: string[] }> }>(client, "GET", "/projects");
        const team = list.ok && Array.isArray(list.body.projects) ? [...list.body.projects].reverse().find((p) => p.id !== remembered && (p.members?.length ?? 0) > 1) : undefined;
        if (!team) return { ok: true, state: r.body };
        const t = await this.state(client, team.id);
        if (!t.ok) return { ok: true, state: r.body };
        await this.ports.setProjectId(team.id);
        return { ok: true, state: t.body };
      }
      if (r.status !== 404) return { ok: false, message: r.message };
    }
    const list = await curriculumRequest<{ projects: Array<{ id: string; created_at?: number; members?: string[] }> }>(client, "GET", "/projects");
    if (!list.ok) return { ok: false, message: list.message };
    const projects = Array.isArray(list.body.projects) ? list.body.projects : [];
    const pick = projects.find((p) => p.id === remembered) ?? projects[projects.length - 1];
    if (!pick) {
      // The Service answered the list and the remembered Project is not in it: it is no longer this student's.
      if (remembered) {
        await this.ports.setProjectId(undefined);
        this.origin = null;
        await this.ports.rememberOrigin?.(null);
      }
      return { ok: true, state: null };
    }
    const r = await this.state(client, pick.id);
    if (!r.ok) return { ok: false, message: r.message };
    if (pick.id !== remembered) await this.ports.setProjectId(pick.id);
    return { ok: true, state: r.body };
  }

  /**
   * CR-10 on a published page: the version a link serves is the one its experiment pins, so a
   * browser result taken there names that version (never the local files). null when the URL
   * is not a link of this Project as last read from the Service.
   */
  publishedArtifactVersion(url: string): { id: string; entry: string; files: Array<{ path: string; sha256: string; bytes: number }> } | null {
    const st = this.cached;
    if (!st?.test_origin) return null;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.origin !== st.test_origin) return null;
    const m = /^\/l\/([A-Za-z0-9_-]{22})(?:\/(.*))?$/.exec(u.pathname);
    const link = m ? st.links.find((l) => l.id === m[1]) : undefined;
    const exp = link ? st.experiments.find((e) => e.id === link.experiment_id) : undefined;
    const version = exp ? st.versions.find((v) => v.id === exp.product_version_id) : undefined;
    if (!version?.files) return null;
    return { id: version.id, entry: version.entry_html ?? "", files: version.files };
  }

  /** What the panel draws, computed every time from the files, the record and the Service. */
  async view(notice: string | null = null): Promise<PublishView> {
    const empty: PublishView = {
      available: false,
      reason: null,
      project: null,
      version: { id: null, files: [], manifest_added: [], refusal: null, refusal_lines: [] },
      verification: { state: "not_verified", open: [] },
      hypotheses: [],
      experiments: [],
      timing: this.timing,
      notice,
    };
    if (!this.ports.switchOn()) return { ...empty, reason: "이 수업에서는 사용자 테스트 공개를 쓸 수 없어요." };
    const client = await this.client();
    if (!client) return { ...empty, reason: SIGN_IN };
    const resolved = await this.resolveProject(client);
    const state = resolved.ok ? resolved.state : null;
    if (!resolved.ok) notice ??= resolved.message;
    const built = await this.currentSet(state?.project.id, this.manifest);
    const version: PublishView["version"] = !built
      ? { id: null, files: [], manifest_added: [], refusal: "미리보기를 먼저 켜 주세요. 미리보기에 보이는 페이지를 공개해요.", refusal_lines: [] }
      : built.ok
        ? { id: built.set.id, files: built.set.files.map((f) => ({ path: f.path, bytes: f.bytes })), manifest_added: built.set.manifest_added, refusal: null, refusal_lines: [] }
        : { id: null, files: [], manifest_added: [...this.manifest], refusal: built.message, refusal_lines: built.lines };
    const verification = productVerification(await this.ports.events(), version.id);
    const experiments: PublishExperimentView[] = [];
    for (const e of state?.experiments ?? []) {
      const channels = await curriculumRequest<{ sessions_opened: PublishExperimentView["sessions"] }>(client, "GET", `/experiments/${encodeURIComponent(e.id)}/channels`);
      experiments.push({
        id: e.id,
        week: e.week,
        question: e.question,
        method: e.method,
        success_criteria: e.success_criteria,
        hypothesis: state?.hypotheses.find((h) => h.id === e.hypothesis_id)?.statement ?? null,
        product_version_id: e.product_version_id,
        current_version: e.product_version_id === version.id,
        status: e.status,
        links: (state?.links ?? []).filter((l) => l.experiment_id === e.id).map((l) => this.linkView(l)),
        sessions: channels.ok ? channels.body.sessions_opened : null,
      });
    }
    return {
      ...empty,
      available: true,
      project: state ? { id: state.project.id, title: state.project.title } : null,
      version,
      verification,
      hypotheses: state?.hypotheses.map((h) => ({ id: h.id, statement: h.statement })) ?? [],
      experiments: experiments.reverse(),
      notice,
    };
  }

  private linkView(l: ProjectState["links"][number]): PublishLinkView {
    const live = l.state === "live" && !!l.share_url;
    return { id: l.id, channel: l.channel ?? null, share_url: l.share_url, qr: live ? this.ports.qr(l.share_url!) : null, expires_at: l.expires_at, state: l.state };
  }

  /** Add or remove files beyond static reach (the R4 manifest); the panel lists the set again. */
  setManifest(paths: unknown): void {
    this.manifest = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= 300).slice(0, 50) : [];
  }

  /**
   * The one publish action: version → test → link. Every refusal is the student's to read,
   * and nothing is uploaded when the set is refused (the scan runs before any request).
   */
  async submit(form: PublishForm): Promise<{ ok: true; share_url: string } | { ok: false; message: string; lines?: string[] }> {
    if (!this.ports.switchOn()) return { ok: false, message: "이 수업에서는 사용자 테스트 공개를 쓸 수 없어요." };
    const days = form.expires_in_days;
    if (typeof days !== "number" || !Number.isFinite(days) || days <= 0 || days > 90) return { ok: false, message: "링크를 언제까지 열어 둘지 골라 주세요." };
    const client = await this.client();
    if (!client) return { ok: false, message: SIGN_IN };
    const started = this.now();
    const phases: Record<string, number> = {};
    const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const t = this.now();
      try {
        return await fn();
      } finally {
        phases[name] = this.now() - t;
      }
    };
    if (form.manifest) this.setManifest(form.manifest);
    // The set is built and scanned before any request, so a refused set sends nothing and
    // leaves nothing behind on the Service.
    const pre = await phase("scan", () => this.currentSet(this.ports.projectId(), this.manifest));
    if (!pre) return { ok: false, message: "미리보기를 먼저 켜 주세요. 미리보기에 보이는 페이지를 공개해요." };
    if (!pre.ok) return { ok: false, message: pre.message, lines: pre.lines };
    const resolved = await phase("resolve", () => this.resolveProject(client));
    if (!resolved.ok) return { ok: false, message: resolved.message };
    let projectId = resolved.state?.project.id;
    if (!projectId) {
      const made = await phase("project", () => curriculumRequest<{ project: { id: string } }>(client, "POST", "/projects", { title: form.title?.trim() || this.ports.defaultTitle() }));
      if (!made.ok) return { ok: false, message: made.message };
      projectId = made.body.project.id;
      await this.ports.setProjectId(projectId);
      await this.state(client, projectId);
    }
    // Rebuilt against the project and its origin (the token rule names both), and read again.
    const built = await phase("files", () => this.currentSet(projectId, this.manifest));
    if (!built || !built.ok) return { ok: false, message: built ? built.message : "미리보기를 먼저 켜 주세요.", ...(built && !built.ok ? { lines: built.lines } : {}) };
    const verification = productVerification(await this.ports.events(), built.set.id);
    const up = await phase("upload", () => publishTestVersion(client, projectId!, built.set, verification.state === "verified" ? verification.run_id : undefined));
    if (!up.ok) return this.refusal(up);
    const devices = form.devices?.filter((d) => d === "camera" || d === "microphone");
    const declarations = { ...(form.repeated_use ? { repeated_use: true } : {}), ...(devices?.length ? { devices } : {}) };
    const exp = await phase("experiment", () =>
      curriculumRequest<{ experiment: { id: string } }>(client, "POST", "/experiments", {
        project_id: projectId,
        product_version_id: built.set.id,
        week: form.week ?? this.ports.week() ?? 1,
        question: form.question,
        method: form.method,
        success_criteria: form.success_criteria,
        ...(form.hypothesis_id ? { hypothesis_id: form.hypothesis_id } : { hypothesis: form.hypothesis }),
        ...(Object.keys(declarations).length ? { declarations } : {}),
      }),
    );
    if (!exp.ok) return this.refusal(exp);
    const link = await phase("link", () => this.issue(client, exp.body.experiment.id, form.channel, days));
    this.timing = publishTiming(started, this.now(), phases);
    if (!link.ok) return this.refusal(link);
    return { ok: true, share_url: link.body.share_url };
  }

  private issue(client: Client, experimentId: string, channel: string | undefined, days: number) {
    return curriculumRequest<{ share_url: string; test_origin: string }>(client, "POST", `/experiments/${encodeURIComponent(experimentId)}/links`, {
      expires_at: this.now() + days * DAY,
      ...(channel?.trim() ? { channel: channel.trim() } : {}),
    });
  }

  private refusal(r: Extract<CurriculumResult<unknown>, { ok: false }>): { ok: false; message: string; lines?: string[] } {
    const hits = Array.isArray(r.detail?.hits) ? (r.detail!.hits as Array<{ file: string; line: number; rule: string }>) : [];
    return { ok: false, message: r.message, ...(hits.length ? { lines: hits.map(hitLine) } : {}) };
  }

  /** Another channel's link for a running experiment (CR-73). */
  async link(experimentId: string, form: { channel?: string; expires_in_days?: number }): Promise<{ ok: true; share_url: string } | { ok: false; message: string }> {
    if (!this.ports.switchOn()) return { ok: false, message: "이 수업에서는 사용자 테스트 공개를 쓸 수 없어요." };
    const days = form.expires_in_days;
    if (typeof days !== "number" || !Number.isFinite(days) || days <= 0 || days > 90) return { ok: false, message: "링크를 언제까지 열어 둘지 골라 주세요." };
    const client = await this.client();
    if (!client) return { ok: false, message: SIGN_IN };
    const r = await this.issue(client, experimentId, form.channel, days);
    return r.ok ? { ok: true, share_url: r.body.share_url } : this.refusal(r);
  }

  /** Turn a link off for good (CR-19). Other links of the experiment keep serving (CR-73). */
  async revoke(linkId: string): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!this.ports.switchOn()) return { ok: false, message: "이 수업에서는 사용자 테스트 공개를 쓸 수 없어요." };
    const client = await this.client();
    if (!client) return { ok: false, message: SIGN_IN };
    const r = await curriculumRequest(client, "POST", `/links/${encodeURIComponent(linkId)}/revoke`, {});
    return r.ok ? { ok: true } : this.refusal(r);
  }
}
