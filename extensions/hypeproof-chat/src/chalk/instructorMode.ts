// #1298 — instructor-mode state and server communication.
// Isolated from chatPanelProvider.ts so instructor logic has a single home.

export class InstructorModeManager {
  private _isInstructor: boolean | null = null;
  private _isInstructorToken: string | undefined = undefined;
  private _instructorBrief: string | undefined = undefined;
  private _instructorBriefVersion: number | undefined = undefined;

  get isInstructor(): boolean | null { return this._isInstructor; }
  get brief(): string | undefined { return this._instructorBrief; }

  // Clears cached state on token change.
  reset(): void {
    this._isInstructor = null;
    this._isInstructorToken = undefined;
    this._instructorBrief = undefined;
    this._instructorBriefVersion = undefined;
  }

  // Checks GET /admin/chalk/whoami with the current token.
  // Caches result per token so we don't hammer the server on every postConfig.
  async checkInstructorMode(token: string | undefined, proxyUrl: string): Promise<boolean> {
    if (!token) { this._isInstructor = false; this._isInstructorToken = undefined; return false; }
    if (this._isInstructor !== null && this._isInstructorToken === token) return this._isInstructor;
    try {
      const base = proxyUrl.replace(/\/v1\/?$/, '');
      const res = await fetch(`${base}/admin/chalk/whoami`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      this._isInstructor = res.ok;
    } catch {
      this._isInstructor = false;
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
