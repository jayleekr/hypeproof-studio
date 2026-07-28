import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatConfig,
  ChatMessage,
  Citation,
  SuggestionChip,
  UpdateOffer,
  UxConfig,
} from "../../src/protocol";
import { postToHost } from "./vscode";
import type { ToolLogEntry } from "./App";
import { decideEnter, draftAfterStop, shouldFlushQueue } from "./sendQueue";

interface Props {
  config: ChatConfig | null;
  // #384 — image handed from the host (editor-tab image → attach to coach).
  incomingImage: { dataUrl: string; nonce: number } | null;
  messages: ChatMessage[];
  toolLog: ToolLogEntry[];              // #278 Phase 3 — browser loop action log
  pageNotice: string | null;           // #308 — "페이지를 코치에게" 인라인 안내
  aiNotice: string | null;             // #320 — AI disclosure at session start
  stopNotice: string | null;           // #497 — Stop 으로 턴이 끊겼음을 알리는 안내
  streaming: boolean;
  /**
   * WHICH message is streaming, not just whether one is (#429). `streaming` is
   * a turn-level flag; handing it to every row made each FINISHED assistant
   * message re-render its in-progress spinner the moment a NEW turn started, so
   * "🛠️ 웹사이트 만드는 중… ✨" sat under a turn that had visibly ended. Row-level
   * progress has to key off identity; turn-level concerns (composer disabled,
   * retry buttons hidden) correctly stay on `streaming`.
   */
  streamingId: string | null;
  error: string | null;
  errorRequestId: string | null;
  errorRunbookUrl: string | null;  // #165 — render as clickable runbook link
  canRetryLast: boolean;
  onSend: (text: string, images?: string[]) => void;
  onRetry: (prompt: string) => void;
  onRetryLast: () => void;
  onDismissError: () => void;
  onCancel: () => void;
  onClear: () => void;
  onSetToken: () => void;
  onSettings: () => void;
  onRunCode: (html: string) => void;
  onNamingRitual: () => void;
  onSaveCoach: (name: string, personality: string) => void;
  onReportProblem: () => void;                          // #64
  onInstallUpdate: () => void;                          // #72
  onDismissUpdate: (version: string) => void;           // #72
}

function extractRenderableHtml(text: string): string | null {
  const htmlFence = /```(?:html|HTML)\s*\n([\s\S]*?)\n```/.exec(text);
  if (htmlFence) return htmlFence[1].trim();
  const doctype = /<!doctype\s+html[\s\S]*?<\/html\s*>/i.exec(text);
  if (doctype) return doctype[0];
  const jsFence = /```(?:javascript|js)\s*\n([\s\S]*?)\n```/.exec(text);
  if (jsFence) {
    const js = jsFence[1].trim();
    return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:sans-serif;padding:12px}</style></head><body><script>try{${js}}catch(e){document.body.innerHTML='<pre style="color:#c00">'+e+'</pre>';}</script></body></html>`;
  }
  return null;
}

// Pasted-image context (website-copyclone). Bounds match the worker's
// translate.ts caps so a paste that the webview accepts is one the worker
// will also forward. Raw-file bytes here ≈ base64 chars there with headroom.
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 3_500_000;   // ~3.5MB raw → ~4.7MB base64, under the worker's ceiling
const DOWNSCALE_MAX_DIM = 1600;      // longest side after downscale — plenty for reading a webpage layout

/** Estimate decoded byte size of a data: URL from its base64 payload length. */
function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor((b64.length * 3) / 4);
}

/**
 * Turn a pasted image File into a data: URL that fits under MAX_IMAGE_BYTES —
 * a full-res Retina screenshot (which would otherwise be rejected) is scaled
 * down + re-encoded as JPEG so image paste "just works" for any screenshot.
 * All in-webview (canvas + data URLs) — CSP-safe, no external fetch.
 */
async function fitPastedImage(file: File): Promise<string> {
  const original: string = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });
  // Already small enough → send as-is (keeps PNG crispness for tiny images).
  if (file.size <= MAX_IMAGE_BYTES) return original;
  return fitDataUrl(original);
}

/** #384 — downscale a data: URL (from the host "image opened" flow) the same
 *  way fitPastedImage handles a File. Already-small URLs pass through. */
async function fitDataUrl(original: string): Promise<string> {
  if (dataUrlBytes(original) <= MAX_IMAGE_BYTES) return original;
  const img: HTMLImageElement = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("decode failed"));
    el.src = original;
  });

  let scale = Math.min(1, DOWNSCALE_MAX_DIM / Math.max(img.width, img.height));
  let quality = 0.85;
  let out = original;
  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) break;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    out = canvas.toDataURL("image/jpeg", quality);
    if (dataUrlBytes(out) <= MAX_IMAGE_BYTES) return out;
    // Still too big → shrink dimensions, then bite into quality.
    if (attempt < 3) scale *= 0.75;
    else quality -= 0.15;
  }
  return out; // best effort — worker cap still guards the extreme tail
}

const DEFAULT_UX: UxConfig = {
  coach: {
    naming_mode: "fixed",
    fallback_name: "코치",
    naming_prompt_md: "",
    personality_prompt_md: "",
  },
  suggestions: { initial: [], follow_up: [] },
  hints: {
    short_input: { enabled: false, min_chars: 0, message_md: "" },
    roll_input_button: { enabled: false, label: "", probe_md: "" },
  },
  retry_button: { enabled: false, show_counter: false },
};

/** Find the user prompt that led to a given assistant message, walking backwards. */
function userPromptBefore(messages: ChatMessage[], assistantId: string): string | null {
  const idx = messages.findIndex((m) => m.id === assistantId);
  if (idx < 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return null;
}

export function ChatPanel(props: Props) {
  const { config, messages, streaming, streamingId, error, incomingImage } = props;
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [rollExpand, setRollExpand] = useState<{ original: string } | null>(null);
  // Pasted-image attachments for the next turn (data URLs). `imgNote` surfaces
  // a brief reason when a paste is rejected (too big / too many).
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [imgNote, setImgNote] = useState<string | null>(null);
  // #416 — the ONE message parked while a turn is running (null = none).
  const [queued, setQueued] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** Previous `streaming` value — the flush must fire on the edge, not the state. */
  const prevStreamingRef = useRef(streaming);

  const ux: UxConfig = config?.profile?.ux ?? DEFAULT_UX;
  // Image paste is a per-profile opt-in (website-copyclone). Default-off so
  // minor cohorts never expose the image flow — the worker enforces the same
  // gate server-side, this just keeps the UI honest (no thumbnail, plain text
  // paste). Absent on older cached /v1/profile responses → treated as off.
  const imagePasteEnabled = config?.profile?.input?.image_paste === true;
  // Fixed-naming cohorts (e.g. boah-dental) must NOT show a user-supplied
  // coach name carried over from a different cohort's user-data-dir (#140).
  const coachName =
    ux.coach.naming_mode === "fixed"
      ? (ux.coach.fallback_name || "코치")
      : (config?.coach?.name?.trim() || ux.coach.fallback_name || "코치");

  // Tone for hard-coded chat-panel labels — game (kids) vs search-webapp
  // (보아치과 teaser) vs website (보아치과 원장 copyclone). Centralized in
  // chatPanelHelpers (appToneOf/TONE_LABELS) but mirrored here so the webview
  // stays vscode-free (chatPanelHelpers imports Node `Buffer`).
  const templateTier =
    (config?.profile as { game?: { template_tier?: string } } | undefined)?.game?.template_tier;
  const appTone: "game" | "search" | "site" =
    templateTier === "search-webapp" ? "search" : templateTier === "website" ? "site" : "game";
  const buildingLabel =
    appTone === "search" ? "검색엔진 만드는 중" : appTone === "site" ? "웹사이트 만드는 중" : "게임 만드는 중";
  const namingEmoji = appTone === "search" ? "🔍" : appTone === "site" ? "🌐" : "🎮";

  // Show the kid-friendly naming card when: profile loaded, it asks the kid to
  // name the coach, and they haven't yet.
  const [forceNaming, setForceNaming] = useState(false);

  const needsNaming =
    !!config?.profile &&
    config.profile.ux.coach.naming_mode === "user_names_it" &&
    !config.coach?.configured;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, streaming]);

  if ((needsNaming || forceNaming) && config?.profile) {
    return (
      <NamingCard
        namingPromptMd={config.profile.ux.coach.naming_prompt_md}
        personalityPromptMd={config.profile.ux.coach.personality_prompt_md}
        fallbackName={config.profile.ux.coach.fallback_name}
        emoji={namingEmoji}
        onSave={(n, p) => {
          props.onSaveCoach(n, p);
          setForceNaming(false);
        }}
      />
    );
  }

  const submit = (text?: string) => {
    const value = (text ?? draft).trim();
    if ((!value && pendingImages.length === 0) || streaming) return;
    props.onSend(value, pendingImages.length > 0 ? pendingImages : undefined);
    setDraft("");
    setPendingImages([]);
    setImgNote(null);
    setRollExpand(null);
  };

  // #416 — the turn ended: send the message the participant parked during it.
  // Edge-triggered (see shouldFlushQueue): firing while `streaming` is still
  // true would hit submit()'s own guard and silently drop the message.
  useEffect(() => {
    const prev = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    if (!shouldFlushQueue(prev, streaming, queued)) return;
    const text = queued as string;
    setQueued(null);
    submit(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, queued]);

  /** Stop / cancel-reservation: the parked text goes back to the draft, never away. */
  const restoreQueuedToDraft = () => {
    setDraft((d) => draftAfterStop(d, queued));
    setQueued(null);
  };

  // Shared attach path for both clipboard paste (⌘V) and drag-and-drop.
  // Downscales oversized screenshots instead of rejecting them (#384), bounds
  // the count, and surfaces a brief note on limit/failure.
  const attachImageFiles = (imageFiles: File[]) => {
    for (const f of imageFiles) {
      fitPastedImage(f)
        .then((url) => {
          if (!url) return;
          setPendingImages((prev) => {
            if (prev.length >= MAX_IMAGES) {
              setImgNote(`이미지는 한 번에 최대 ${MAX_IMAGES}장까지 붙일 수 있어요.`);
              return prev;
            }
            setImgNote(null);
            return [...prev, url];
          });
        })
        .catch(() => {
          setImgNote("이미지를 붙이지 못했어요. 다시 시도하거나 URL로 참고 화면을 주세요.");
        });
    }
  };

  // #384 — attach an image handed over by the host (an image opened in an
  // editor tab, e.g. a dropped screenshot). Same downscale + thumbnail path as
  // paste, just from a data URL. Re-runs on nonce so the same file re-attaches.
  const incomingNonce = incomingImage?.nonce;
  useEffect(() => {
    if (!incomingImage || !imagePasteEnabled) return;
    fitDataUrl(incomingImage.dataUrl)
      .then((url) => {
        if (!url) return;
        setPendingImages((prev) => {
          if (prev.length >= MAX_IMAGES) {
            setImgNote(`이미지는 한 번에 최대 ${MAX_IMAGES}장까지 붙일 수 있어요.`);
            return prev;
          }
          setImgNote(null);
          return [...prev, url];
        });
      })
      .catch(() => setImgNote(platformizeKeys("이미지를 붙이지 못했어요. ⌘V로 다시 시도해 주세요.")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingNonce]);

  // Clipboard paste of an image (e.g. ⌘⌃⇧4 screenshot → ⌘V) attaches it to the
  // next turn instead of pasting raw text. A normal text paste falls through
  // to the textarea default (we only preventDefault when we found image data).
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!imagePasteEnabled) return;          // text-only cohort — let default text paste happen
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (imageFiles.length === 0) return;     // plain text paste — let default happen
    e.preventDefault();
    attachImageFiles(imageFiles);
  };

  // #384 — drag a screenshot file from Finder/desktop straight onto the input.
  // Same attach path as paste. dragover must preventDefault so drop fires.
  const [dragActive, setDragActive] = useState(false);
  const handleDragOver = (e: React.DragEvent<HTMLElement>) => {
    if (!imagePasteEnabled) return;
    if (!Array.from(e.dataTransfer.items ?? []).some((it) => it.kind === "file")) return;
    e.preventDefault();
    if (!dragActive) setDragActive(true);
  };
  const handleDragLeave = () => setDragActive(false);
  const handleDrop = (e: React.DragEvent<HTMLElement>) => {
    if (!imagePasteEnabled) return;
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) { setDragActive(false); return; }
    e.preventDefault();
    setDragActive(false);
    attachImageFiles(files);
  };

  const removePendingImage = (idx: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== idx));
    setImgNote(null);
  };

  const handleChip = (chip: SuggestionChip) => {
    if (chip.style === "weak") return;       // contrast-only chips are not clickable
    // Drop the chip text into draft and focus textarea so kid can append/edit.
    setDraft(chip.text);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleRollClick = () => {
    // Capture the current draft as the "first thought" and prompt expansion.
    setRollExpand({ original: draft.trim() });
    setDraft("");
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleRollSend = () => {
    const extra = draft.trim();
    if (!extra || !rollExpand) return;
    const combined = rollExpand.original
      ? `${rollExpand.original} — 그리고 ${extra}`
      : extra;
    props.onSend(combined, pendingImages.length > 0 ? pendingImages : undefined);
    setDraft("");
    setPendingImages([]);
    setImgNote(null);
    setRollExpand(null);
  };

  const shortHintVisible =
    ux.hints.short_input.enabled &&
    draft.length > 0 &&
    draft.trim().length < ux.hints.short_input.min_chars;

  const showInitialChips =
    messages.length === 0 &&
    !streaming &&
    ux.suggestions.initial.length > 0;

  const showFollowUpChips =
    !streaming &&
    messages.length > 0 &&
    messages[messages.length - 1]?.role === "assistant" &&
    ux.suggestions.follow_up.length > 0;

  return (
    <div
      className={`hps-shell${dragActive ? " hps-shell-drag" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive && (
        <div className="hps-shell-drop-overlay">여기에 놓으면 이미지가 첨부돼요 🖼</div>
      )}
      <header className="hps-header">
        <strong title="이 친구 이름 바꾸기" onClick={() => setForceNaming(true)} className="hps-coach-name">
          {coachName}
        </strong>
        <div className="hps-actions">
          <button onClick={props.onSetToken} title="Workshop token">
            {config?.hasToken ? "Token ✓" : "Token"}
          </button>
          <button onClick={props.onClear} title="Clear conversation">Clear</button>
          <button onClick={props.onSettings} title="Open settings">⚙</button>
        </div>
      </header>

      {config?.update && (
        <UpdateBanner
          offer={config.update}
          onInstall={props.onInstallUpdate}
          onDismiss={props.onDismissUpdate}
        />
      )}

      <div className="hps-messages" ref={scrollRef}>
        {props.aiNotice && (
          // #320 — AI disclosure (Anthropic Usage Policy / ToS §D.3). Compact
          // and unobtrusive; sits at the top of the conversation so it reads
          // as a session-start notice, not an interruption.
          <div className="hps-ai-disclosure" role="note" aria-live="polite">
            {props.aiNotice}
          </div>
        )}

        {messages.length === 0 && (
          <EmptyState
            ux={ux}
            coachName={coachName}
            greetingMd={config?.profile?.welcome.greeting_md ?? ""}
          />
        )}

        {showInitialChips && (
          <ChipRack
            chips={ux.suggestions.initial}
            onPick={handleChip}
            label="이렇게 시작해볼까요? (탭하면 입력창에 들어가요)"
          />
        )}

        {messages.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            streaming={streaming}
            isStreamingThis={streaming && m.id === streamingId}
            ux={ux}
            coachName={coachName}
            buildingLabel={buildingLabel}
            tone={appTone}
            messages={messages}
            hasActivity={props.toolLog.length > 0}
            onRunCode={props.onRunCode}
            onRetry={props.onRetry}
          />
        ))}

        {props.pageNotice && (
          <div className="hps-page-notice" role="status" aria-live="polite">
            {props.pageNotice}
          </div>
        )}

        {/* #497 — Stop 직후 안내. 오류가 아니므로 에러 배너가 아니라 조용한
            인라인 상태줄로 알린다. 다음 입력을 하면 사라진다. */}
        {props.stopNotice && (
          <div className="hps-stop-notice" role="status" aria-live="polite">
            <span className="hps-stop-notice-icon" aria-hidden="true">⏹</span>
            {props.stopNotice}
          </div>
        )}

        {props.toolLog.length > 0 && (
          <div className="hps-tool-log" role="status" aria-live="polite">
            {props.toolLog.map((e) => (
              <div key={e.id} className={`hps-tool-log-line hps-tool-${e.state}`}>
                <span className="hps-tool-icon">{e.icon}</span>
                <span className="hps-tool-label">{e.label}</span>
                <span className="hps-tool-mark">
                  {e.state === "running" ? "…" : e.state === "error" ? "⚠️" : "✓"}
                </span>
              </div>
            ))}
          </div>
        )}

        {showFollowUpChips && (
          <ChipRack
            chips={ux.suggestions.follow_up}
            onPick={handleChip}
            label="이어서 이런 것도 해볼래요?"
          />
        )}

        {error && (
          <ErrorBanner
            message={error}
            requestId={props.errorRequestId}
            runbookUrl={props.errorRunbookUrl}
            canRetry={props.canRetryLast}
            onRetry={props.onRetryLast}
            onDismiss={props.onDismissError}
            onReport={props.onReportProblem}
          />
        )}
      </div>

      {rollExpand !== null && (
        <RollExpandHint
          probe={ux.hints.roll_input_button.probe_md}
          original={rollExpand.original}
          onCancel={() => setRollExpand(null)}
        />
      )}

      <footer className="hps-input-area">
        {shortHintVisible && (
          <div className="hps-hint" dangerouslySetInnerHTML={{
            __html: renderInlineMd(ux.hints.short_input.message_md),
          }} />
        )}
        {imgNote && <div className="hps-img-note">{imgNote}</div>}
        {queued !== null && (
          // #416 — what is parked, and how to take it back. Cancel returns it to
          // the draft (see restoreQueuedToDraft): the × must not mean "delete".
          <div className="hps-queued" role="status" aria-live="polite">
            <span className="hps-queued-label">다음에 보낼 메시지</span>
            <span className="hps-queued-text" title={queued}>{queued}</span>
            <button
              type="button"
              className="hps-queued-cancel"
              onClick={restoreQueuedToDraft}
              title="예약 취소 — 입력창으로 되돌려요"
              aria-label="예약 취소"
            >
              ×
            </button>
          </div>
        )}
        {pendingImages.length > 0 && (
          <div className="hps-attachments" aria-label="첨부한 이미지">
            {pendingImages.map((url, i) => (
              <div key={i} className="hps-attachment">
                <img src={url} alt={`첨부 이미지 ${i + 1}`} />
                <button
                  type="button"
                  className="hps-attachment-remove"
                  onClick={() => removePendingImage(i)}
                  title="이미지 제거"
                  aria-label="이미지 제거"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          className={`hps-input${dragActive ? " hps-input-drag" : ""}`}
        >
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={handlePaste}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(e) => {
              const isComposing =
                composing ||
                e.nativeEvent.isComposing ||
                // keyCode 229 is the legacy Safari signal for IME composition.
                e.nativeEvent.keyCode === 229;
              // Composing Hangul: Enter commits the syllable, it must never
              // send. Unchanged from before — typing mid-turn does not make the
              // IME any less load-bearing.
              if (e.key !== "Enter" || e.shiftKey || isComposing) return;
              e.preventDefault();
              // Roll-expand owns Enter while it is open (idle-only flow).
              if (rollExpand && !streaming) {
                handleRollSend();
                return;
              }
              // #416 — mid-turn Enter parks the message instead of sending it.
              const decision = decideEnter({
                draft,
                streaming,
                queued,
                hasImages: pendingImages.length > 0,
              });
              if (decision.action === "ignore") return;
              if (decision.action === "queue") {
                setQueued(decision.queued);
                setDraft("");
                return;
              }
              submit();
            }}
            placeholder={
              streaming
                ? queued
                  ? "이어서 적으면 예약 메시지에 덧붙여요"
                  : "응답 중에도 적을 수 있어요 — Enter 로 예약하면 끝나고 바로 보내요"
                : rollExpand
                  ? "한 가지만 더 떠올려서 적어주세요"
                  : imagePasteEnabled
                    ? platformizeKeys("메시지를 입력하고 Enter — 이미지는 ⌘V로 붙여넣기 (Shift+Enter 줄바꿈)")
                    : "메시지를 입력하고 Enter (Shift+Enter 줄바꿈)"
            }
            rows={3}
          />
          <div className="hps-input-buttons">
            {!streaming && ux.hints.roll_input_button.enabled && !rollExpand && (
              <button
                onClick={handleRollClick}
                disabled={!draft.trim()}
                className="hps-btn-roll"
                title="떠오른 것에 한 줄 더 보태기"
              >
                {ux.hints.roll_input_button.label}
              </button>
            )}
            {streaming ? (
              <button
                onClick={() => {
                  // #416 — a parked message survives the stop as draft text.
                  restoreQueuedToDraft();
                  props.onCancel();
                }}
                className="hps-btn-stop"
              >
                Stop
              </button>
            ) : rollExpand ? (
              <button
                onClick={handleRollSend}
                disabled={!draft.trim()}
                className="hps-btn-send"
              >
                Send
              </button>
            ) : (
              <button
                onClick={() => submit()}
                disabled={!draft.trim() && pendingImages.length === 0}
                className="hps-btn-send"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function NamingCard({
  namingPromptMd,
  personalityPromptMd,
  fallbackName,
  emoji,
  onSave,
}: {
  namingPromptMd: string;
  personalityPromptMd: string;
  fallbackName: string;
  emoji: string;
  onSave: (name: string, personality: string) => void;
}) {
  const [step, setStep] = useState<"name" | "personality">("name");
  const [name, setName] = useState("");
  const [personality, setPersonality] = useState("");
  const nameRef = useRef<HTMLInputElement | null>(null);
  const persRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTimeout(() => nameRef.current?.focus(), 100);
  }, []);
  useEffect(() => {
    if (step === "personality") setTimeout(() => persRef.current?.focus(), 100);
  }, [step]);

  const goNext = () => {
    if (personalityPromptMd) setStep("personality");
    else onSave(name || fallbackName, "");
  };
  const finish = () => onSave(name || fallbackName, personality);

  return (
    <div className="hps-shell">
      <div className="hps-naming">
        <div className="hps-naming-emoji">{emoji}</div>
        {step === "name" ? (
          <>
            <h2
              className="hps-naming-title"
              dangerouslySetInnerHTML={{ __html: renderInlineMd(namingPromptMd) }}
            />
            <input
              ref={nameRef}
              className="hps-naming-input"
              value={name}
              maxLength={20}
              placeholder={`예: 별이, 루카, 포포 (안 정하면 '${fallbackName}')`}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) goNext();
              }}
            />
            <button className="hps-naming-btn" onClick={goNext}>
              다음 →
            </button>
          </>
        ) : (
          <>
            <h2
              className="hps-naming-title"
              dangerouslySetInnerHTML={{ __html: renderInlineMd(personalityPromptMd) }}
            />
            <input
              ref={persRef}
              className="hps-naming-input"
              value={personality}
              maxLength={60}
              placeholder="예: 친절하고 엉뚱한 친구 (건너뛰어도 돼요)"
              onChange={(e) => setPersonality(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) finish();
              }}
            />
            <div className="hps-naming-row">
              <button className="hps-naming-btn-ghost" onClick={() => onSave(name || fallbackName, "")}>
                건너뛰기
              </button>
              <button className="hps-naming-btn" onClick={finish}>
                시작하기 →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function EmptyState({
  ux,
  coachName,
  greetingMd,
}: {
  ux: UxConfig;
  coachName: string;
  greetingMd: string;
}) {
  // Profile-driven greeting (welcome.greeting_md) is the source of truth per
  // cohort. For user-named coaches (kid cohorts), prepend a coach-intro line
  // so the kid sees the name they chose echoed back. For fixed-name cohorts
  // (e.g. adult professional teasers — naming_mode=fixed), the coach name is
  // just a generic label and shouldn't dilute the cohort framing.
  const showCoachIntro = ux.coach.naming_mode === "user_names_it" && coachName;
  const hasGreeting = greetingMd.trim().length > 0;

  return (
    <div className="hps-empty">
      <p className="hps-empty-greeting">
        {showCoachIntro && (
          <>
            안녕하세요! 저는 <strong>{coachName}</strong>예요.
            {hasGreeting && <br />}
          </>
        )}
        {hasGreeting ? (
          <span dangerouslySetInnerHTML={{ __html: renderInlineMd(greetingMd) }} />
        ) : (
          !showCoachIntro && <>안녕하세요! 저는 <strong>{coachName}</strong>예요.</>
        )}
      </p>
    </div>
  );
}

function ChipRack({
  chips,
  onPick,
  label,
}: {
  chips: SuggestionChip[];
  onPick: (c: SuggestionChip) => void;
  label: string;
}) {
  return (
    <div className="hps-chips-rack">
      <div className="hps-chips-label">{label}</div>
      <div className="hps-chips">
        {chips.map((c, i) => (
          <button
            key={i}
            className={`hps-chip hps-chip-${c.style}`}
            onClick={() => onPick(c)}
            disabled={c.style === "weak"}
            title={c.style === "weak" ? platformizeKeys(c.caption ?? "예시일 뿐이에요") : "탭하면 입력창에 들어가요"}
          >
            <span className="hps-chip-text">{platformizeKeys(c.text)}</span>
            {c.caption && (
              <span className="hps-chip-caption">{platformizeKeys(c.caption)}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageItem({
  message,
  streaming,
  isStreamingThis,
  ux,
  coachName,
  buildingLabel,
  tone,
  messages,
  hasActivity,
  onRunCode,
  onRetry,
}: {
  message: ChatMessage;
  /** Turn-level: any stream in flight. Gates the retry button, not the spinner. */
  streaming: boolean;
  /** Row-level: THIS message is the one streaming. Gates the spinner (#429). */
  isStreamingThis: boolean;
  ux: UxConfig;
  coachName: string;
  buildingLabel: string;
  tone: "game" | "search" | "site";
  messages: ChatMessage[];
  /** #414 — an activity log is on screen, so the spinner must not invent stages. */
  hasActivity: boolean;
  onRunCode: (html: string) => void;
  onRetry: (prompt: string) => void;
}) {
  const renderable = useMemo(
    () => (message.role === "assistant" ? extractRenderableHtml(message.content) : null),
    [message.role, message.content],
  );
  const canRetry =
    !streaming &&
    message.role === "assistant" &&
    ux.retry_button.enabled &&
    message.content.length > 0;
  const retryPrompt = canRetry ? userPromptBefore(messages, message.id) : null;

  return (
    <div className={`hps-msg hps-msg-${message.role}`}>
      <div className="hps-msg-role">
        <span>{message.role === "user" ? "나" : coachName}</span>
        {renderable && (
          <button
            className="hps-msg-run"
            onClick={() => onRunCode(renderable)}
            title="미리보기 패널에서 실행"
          >
            ▶ Run
          </button>
        )}
        {retryPrompt && (
          <button
            className="hps-msg-retry"
            onClick={() => onRetry(retryPrompt)}
            title="다른 방식으로 한 번 더 만들기"
          >
            🔄
          </button>
        )}
      </div>
      <div className="hps-msg-body">
        {message.role === "assistant" ? (
          <AssistantContent
            content={message.content}
            streaming={isStreamingThis}
            buildingLabel={buildingLabel}
            tone={tone}
            hasActivity={hasActivity}
          />
        ) : (
          <>
            {message.images && message.images.length > 0 && (
              <div className="hps-msg-images">
                {message.images.map((url, i) => (
                  <img key={i} src={url} alt={`첨부 이미지 ${i + 1}`} />
                ))}
              </div>
            )}
            {message.content}
          </>
        )}
      </div>
      {message.role === "assistant" && message.citations && message.citations.length > 0 && (
        <CitationRack citations={message.citations} />
      )}
    </div>
  );
}

/**
 * #173 — Render the citation chip rack under an assistant message body.
 * Tier number drives the trust palette via CSS class; clicking a chip posts
 * to the host so VS Code opens the URL in the user's default browser
 * (webview iframe has no direct openExternal capability).
 */
function CitationRack({ citations }: { citations: Citation[] }) {
  return (
    <div className="hps-cit-rack" role="list" aria-label="검색 출처">
      {citations.map((c, i) => (
        <button
          key={`${c.url}-${i}`}
          type="button"
          role="listitem"
          className={`hps-cit-chip hps-cit-tier-${c.tier}`}
          onClick={() => postToHost({ type: "openExternal", url: c.url })}
          title={c.url}
        >
          <span className="hps-cit-index">[{i + 1}]</span>
          <span className="hps-cit-title">{c.title || c.domain}</span>
          <span className="hps-cit-domain">{c.domain}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Render an assistant message with code fences hidden behind a collapsed pill.
 * - While streaming and a fence has opened: show "<tone> 만드는 중… ✨".
 * - When streaming ends with the fence still open (max_tokens cut / network
 *   drop / model bailed) — render the partial as a code pill + a stuck-stream
 *   note so the user can retry instead of staring at a spinner forever. (#159)
 * - When done normally: prose + a collapsed "📄 코드 보기" pill per code block.
 */
/**
 * Stream-length-based stage label for the build spinner (#161). Lets the
 * participant feel forward motion instead of staring at a static "만드는 중…".
 *
 * Stages are derived from cumulative response length + fence-open detection;
 * no LLM-side cooperation required. Tuned for the dental V1 skeleton
 * (~2.5KB HTML output).
 *
 * #414 — the length heuristic is a PROXY-path device. On the agent-sdk path the
 * coach writes files with tools, so the chat text barely grows and every turn
 * froze on "구조 정리 중" while the coach was actually running thinking → Write
 * → Bash → Write. When a real activity log is on screen (`hasActivity`) the
 * truth is right there, so the spinner drops the invented sub-stage instead of
 * contradicting it. A guess is only acceptable while nothing better exists.
 */
function buildStageText(
  buildingLabel: string,
  content: string,
  fenceOpen: boolean,
  tone: "game" | "search" | "site",
  hasActivity = false,
): string {
  if (fenceOpen) return "거의 다 됐어요";
  // Real signal present → say only what is certainly true.
  if (hasActivity) return buildingLabel;
  const len = content.length;
  if (tone === "site") {
    // website-copyclone substages (clone target → layout → polish).
    if (len > 500) return `${buildingLabel} — 화면 그리는 중`;
    if (len > 200) return `${buildingLabel} — 레이아웃 잡는 중`;
    return `${buildingLabel} — 구조 정리 중`;
  }
  if (len > 500) return `${buildingLabel} — V1 화면 그리는 중`;
  if (len > 200) return `${buildingLabel} — 검색어·출처 정리`;
  return `${buildingLabel} — 검색 주제 잡는 중`;
}

function AssistantContent({
  content,
  streaming,
  buildingLabel,
  tone,
  hasActivity = false,
}: {
  content: string;
  streaming: boolean;
  buildingLabel: string;
  tone: "game" | "search" | "site";
  /** #414 — the tool/activity log below carries the real state of the turn. */
  hasActivity?: boolean;
}) {
  const segments = useMemo(() => splitFences(content), [content]);
  const hasOpenFence = segments.some((s) => s.type === "code-open");

  if (content.length === 0) {
    return <span>{streaming ? "생각하는 중… ✨" : ""}</span>;
  }

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === "text") {
          return <span key={i} className="hps-prose">{seg.value}</span>;
        }
        if (seg.type === "code-open") {
          if (streaming) {
            const stage = buildStageText(buildingLabel, content, hasOpenFence, tone, hasActivity);
            return (
              <div key={i} className="hps-code-progress">
                🛠️ {stage}… <span className="hps-dots">✨</span>
              </div>
            );
          }
          // Stream ended with the fence still open → render partial + retry note.
          return (
            <div key={i}>
              <CodePill code={seg.value} />
              <div className="hps-stream-note">
                응답이 도중에 끊겼어요. 위의 🔄 버튼으로 다시 시도해주세요.
              </div>
            </div>
          );
        }
        return <CodePill key={i} code={seg.value} />;
      })}
      {streaming && !hasOpenFence && content.length > 0 && (
        <div className="hps-code-progress hps-code-progress-prelude">
          🛠️ {buildStageText(buildingLabel, content, false, tone, hasActivity)}… <span className="hps-dots">✨</span>
        </div>
      )}
    </>
  );
}

function CodePill({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  const lines = code.split("\n").length;
  return (
    <div className="hps-codepill">
      <button className="hps-codepill-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} 📄 코드 {open ? "숨기기" : `보기 (${lines}줄)`}
      </button>
      {open && <pre className="hps-codepill-body">{code}</pre>}
    </div>
  );
}

type FenceSeg =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "code-open"; value: string };

/** Split content into prose / closed-code / still-open-code segments. */
function splitFences(content: string): FenceSeg[] {
  const out: FenceSeg[] = [];
  const fenceRe = /```[^\n]*\n?/g;
  let idx = 0;
  let m: RegExpExecArray | null;
  let inCode = false;
  let codeStart = 0;

  while ((m = fenceRe.exec(content)) !== null) {
    if (!inCode) {
      if (m.index > idx) out.push({ type: "text", value: content.slice(idx, m.index) });
      inCode = true;
      codeStart = m.index + m[0].length;
    } else {
      out.push({ type: "code", value: content.slice(codeStart, m.index).replace(/\n$/, "") });
      inCode = false;
      idx = m.index + m[0].length;
    }
  }

  if (inCode) {
    // Opened fence with no closing yet → still being generated.
    out.push({ type: "code-open", value: content.slice(codeStart) });
  } else if (idx < content.length) {
    out.push({ type: "text", value: content.slice(idx) });
  }
  return out;
}

function ErrorBanner({
  message,
  requestId,
  runbookUrl,
  canRetry,
  onRetry,
  onDismiss,
  onReport,
}: {
  message: string;
  requestId: string | null;
  runbookUrl: string | null;
  canRetry: boolean;
  onRetry: () => void;
  onDismiss: () => void;
  onReport: () => void;
}) {
  // Spot common transport-layer signals so the framing is honest about the
  // recovery path. We don't try to classify perfectly — just enough to pick
  // between "연결 끊김" (worth retrying) and "토큰/세션 문제" (강사에게).
  const isAuth = /토큰|세션|강사|만료|등록|인가/.test(message);
  const isConn = /연결|네트워크|시간|타임아웃|중단|stream|interrupt|abort/i.test(message);
  const icon = isAuth ? "🔒" : isConn ? "🔌" : "⚠️";
  const title = isAuth ? "잠시 멈춰요" : isConn ? "연결이 끊겼어요" : "문제가 생겼어요";

  return (
    <div className="hps-error-banner" role="alert">
      <div className="hps-error-banner-icon">{icon}</div>
      <div className="hps-error-banner-body">
        <div className="hps-error-banner-title">{title}</div>
        <div className="hps-error-banner-msg">{message}</div>
        {runbookUrl && (
          <div className="hps-error-banner-runbook">
            <a href={runbookUrl} target="_blank" rel="noopener noreferrer">
              📖 강사 안내 — 세션 여는 법
            </a>
          </div>
        )}
        {requestId && (
          <div className="hps-error-banner-rid" title="강사에게 이 ID를 알려주세요 — Jay가 바로 추적할 수 있어요">
            ID: <code>{requestId}</code>
          </div>
        )}
      </div>
      <div className="hps-error-banner-actions">
        {canRetry && (
          <button className="hps-error-banner-retry" onClick={onRetry}>
            다시 보내기
          </button>
        )}
        <button
          className="hps-error-banner-report"
          onClick={onReport}
          title="이 문제를 Jay에게 신고합니다 (request_id 등 메타데이터 자동 첨부) — #64"
        >
          🚨 신고하기
        </button>
        <button
          className="hps-error-banner-dismiss"
          onClick={onDismiss}
          title="이 메시지 숨기기 (대화는 계속할 수 있어요)"
        >
          닫기
        </button>
      </div>
    </div>
  );
}

function RollExpandHint({
  probe,
  original,
  onCancel,
}: {
  probe: string;
  original: string;
  onCancel: () => void;
}) {
  return (
    <div className="hps-roll-hint">
      <div className="hps-roll-probe" dangerouslySetInnerHTML={{ __html: renderInlineMd(probe) }} />
      {original && (
        <div className="hps-roll-original">
          <span className="hps-roll-original-label">처음 떠올린 것 →</span> {original}
        </div>
      )}
      <button className="hps-roll-cancel" onClick={onCancel}>취소</button>
    </div>
  );
}

// Tiny inline-markdown renderer for hints (bold, italic, code). Not a full MD;
// these messages are author-controlled in profiles, so escaping isn't critical.
// Profiles author keyboard hints with macOS glyphs (⌘V). On Windows/Linux we
// rewrite them to the real platform keys so a learner is never told to press a
// key that doesn't exist on their machine. `navigator.platform` reflects the
// host OS inside the VS Code webview renderer.
const IS_MAC =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || "");

function platformizeKeys(text: string): string {
  if (IS_MAC) return text;
  return text
    .replace(/⌘/g, "Ctrl+")
    .replace(/⌥/g, "Alt+")
    .replace(/⌃/g, "Ctrl+")
    .replace(/⇧/g, "Shift+");
}

function renderInlineMd(md: string): string {
  return platformizeKeys(md)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

// #72: in-app update banner. Sits between header and message list. Compact
// (kid-friendly UX shouldn't be dominated by an update card), with the full
// release notes hidden behind a "자세히" toggle to keep visual noise low.
function UpdateBanner({
  offer,
  onInstall,
  onDismiss,
}: {
  offer: UpdateOffer;
  onInstall: () => void;
  onDismiss: (version: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const sizeMb = offer.sizeBytes > 0 ? (offer.sizeBytes / 1024 / 1024).toFixed(0) + " MB" : "";

  return (
    <div className="hps-update-banner" role="status">
      <div className="hps-update-banner-icon">⬆️</div>
      <div className="hps-update-banner-body">
        <div className="hps-update-banner-title">
          새 버전 v{offer.version} 나왔어요{sizeMb ? ` · ${sizeMb}` : ""}
        </div>
        <div className="hps-update-banner-sub">
          업데이트하면 자동으로 재시작됩니다. 작업 중인 내용은 미리 저장해주세요.
        </div>
        {expanded && offer.notes && (
          <pre className="hps-update-banner-notes">{offer.notes}</pre>
        )}
        {offer.notes && (
          <button
            className="hps-update-banner-toggle"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "접기" : "자세히 보기"}
          </button>
        )}
      </div>
      <div className="hps-update-banner-actions">
        <button
          className="hps-update-banner-install"
          onClick={onInstall}
          title={`v${offer.version} 다운로드 + 자동 적용`}
        >
          업데이트
        </button>
        <button
          className="hps-update-banner-dismiss"
          onClick={() => onDismiss(offer.version)}
          title="이 버전은 7일 동안 다시 묻지 않음"
        >
          나중에
        </button>
      </div>
    </div>
  );
}
