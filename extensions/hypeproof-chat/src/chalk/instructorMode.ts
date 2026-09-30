// #1298 — instructor-mode state and server communication.
// Isolated from chatPanelProvider.ts so instructor logic has a single home.

export type WhoamiStatus = "ok" | "rejected" | "unreachable" | null;

export class InstructorModeManager {
  private _isInstructor: boolean | null = null;
  private _isInstructorToken: string | undefined = undefined;
  private _instructorBrief: string | undefined = undefined;
  private _instructorBriefVersion: number | undefined = undefined;
  private _lastWhoamiStatus: WhoamiStatus = null;

  // Model choice: remembered so first-turn error can revert to prevChoice.
  private _hasPendingModelRevert = false;
  private _pendingPrevModelChoice: unknown = undefined;

  get isInstructor(): boolean | null { return this._isInstructor; }
  get brief(): string | undefined { return this._instructorBrief; }
  // "ok" = 2xx, "rejected" = 401/403, "unreachable" = network/timeout, null = not checked yet
  get lastWhoamiStatus(): WhoamiStatus { return this._lastWhoamiStatus; }

  // Clears cached state on token change.
  reset(): void {
    this._isInstructor = null;
    this._isInstructorToken = undefined;
    this._instructorBrief = undefined;
    this._instructorBriefVersion = undefined;
    this._lastWhoamiStatus = null;
  }

  // Stores modelId as the active model choice; remembers prevChoice for revert.
  // No pre-flight ping: validation happens on the first turn (server or CLI).
  selectModel(
    modelId: string,
    getChoice: () => unknown,
    setChoice: (c: unknown) => Promise<void>,
  ): Promise<void> {
    this._pendingPrevModelChoice = getChoice();
    this._hasPendingModelRevert = true;
    return setChoice({ scope: 'instructor', alias: modelId });
  }

  // Clears the pending revert after a successful turn.
  onTurnSuccess(): void {
    this._hasPendingModelRevert = false;
    this._pendingPrevModelChoice = undefined;
  }

  // Reverts to prevChoice when a turn fails after selectModel was called.
  async revertModelOnTurnError(setChoice: (c: unknown) => Promise<void>): Promise<void> {
    if (!this._hasPendingModelRevert) return;
    this._hasPendingModelRevert = false;
    await setChoice(this._pendingPrevModelChoice);
    this._pendingPrevModelChoice = undefined;
  }

  // Called after checkInstructorMode on the auto-read path (postConfig/refresh, not the setInstructorToken command).
  // Returns what the caller should do based on the latest whoami result:
  //   "rejected_delete_and_show" — token was rejected; delete it and show the student start page once.
  //   "unreachable_keep"         — network failure; keep the token and do not show the start page.
  //   "ok_noop"                  — whoami succeeded; instructor mode is active; do nothing.
  handleAutoReadResult(): "rejected_delete_and_show" | "unreachable_keep" | "ok_noop" {
    if (this._lastWhoamiStatus === "rejected") return "rejected_delete_and_show";
    if (this._lastWhoamiStatus === "unreachable") return "unreachable_keep";
    return "ok_noop";
  }

  // Checks GET /admin/chalk/whoami with the current token.
  // Caches result per token so we don't hammer the server on every postConfig.
  // Sets lastWhoamiStatus: "ok" (2xx), "rejected" (401/403 only), or "unreachable" (network/timeout/other).
  // Unreachable results are NOT cached: the next refresh retries so a transient failure does not
  // permanently lock out instructor mode until the app restarts.
  async checkInstructorMode(token: string | undefined, proxyUrl: string): Promise<boolean> {
    if (!token) {
      this._isInstructor = false;
      this._isInstructorToken = undefined;
      this._lastWhoamiStatus = null;
      return false;
    }
    if (this._isInstructor !== null && this._isInstructorToken === token) return this._isInstructor;
    try {
      const base = proxyUrl.replace(/\/v1\/?$/, '');
      const res = await fetch(`${base}/admin/chalk/whoami`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        this._isInstructor = true;
        this._lastWhoamiStatus = "ok";
      } else if (res.status === 401 || res.status === 403) {
        this._isInstructor = false;
        this._lastWhoamiStatus = "rejected";
      } else {
        // 500, 429, 404, etc. — treat as unreachable; keep token, do not cache
        this._lastWhoamiStatus = "unreachable";
        return this._isInstructor === true;
      }
    } catch {
      // network/timeout failure — keep token, do not cache
      this._lastWhoamiStatus = "unreachable";
      return this._isInstructor === true;
    }
    this._isInstructorToken = token;
    return this._isInstructor;
  }

  // Fetches GET /admin/chalk/instructor-brief once per session.
  // Caches by version: if the server returns up_to_date:true the cached text is reused.
  // Falls back to undefined on network error (instructor chat still works, just no system prompt).
  async fetchInstructorBrief(token: string, proxyUrl: string): Promise<string | undefined> {
    const base = proxyUrl.replace(/\/v1\/?$/, '');
    const versionParam = this._instructorBriefVersion !== undefined
      ? `?version=${this._instructorBriefVersion}` : '';
    try {
      const res = await fetch(`${base}/admin/chalk/instructor-brief${versionParam}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return this._instructorBrief;
      const body = await res.json() as { id: string; version: number; text?: string | null; up_to_date?: boolean };
      if (body.up_to_date) return this._instructorBrief;
      this._instructorBriefVersion = body.version;
      this._instructorBrief = body.text ?? undefined;
    } catch {
      // network failure — reuse cached value
    }
    return this._instructorBrief;
  }
}
