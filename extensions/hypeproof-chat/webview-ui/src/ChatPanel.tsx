import { AccessControl } from './AccessControl';
import { EffortControl } from './EffortControl';
import {NativeObservationPanel} from './NativeObservationPanel';
import { MissionHeader } from './MissionHeader';
import { EvidenceDrawer } from './EvidenceDrawer';
import { isObservationFormat } from '../../src/nativeObservationContract';
import { MarkdownText } from './MarkdownText';
import { DisconnectedChat } from "./StartPage";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatConfig,
  ChatMessage,
  Citation,
  ResolvedProfile,
  SuggestionChip,
  UpdateOffer,
  UxConfig,
} from "../../src/protocol";
import type { LearningStatePayload } from "../../src/learningStateHelpers";
import { onHostMessage, postToHost } from "./vscode";
import { hasActivityThisTurn } from "../../src/chatTimeline";
import { composerLabel, copulaParticle, resolveCoachIdentity } from "../../src/coachIdentity";
import { decideEnter, draftAfterStop, shouldFlushQueue } from "./sendQueue";
import {
  RUNNER_PHRASE_MS,
  isRunnerCohort,
  runnerFace,
  runnerPhrase,
  shouldShowRunner,
  type RunnerFace,
} from "./runner";

interface Props {
  config: ChatConfig | null;
  // #384 — image handed from the host (editor-tab image → attach to coach).
  incomingImage: { dataUrl: string; nonce: number } | null;
  /**
   * #503 — a single timeline. user / assistant / tool are interleaved in the order
   * they happened. The `toolLog` prop that used to carry tool logs separately is gone
   * — that was what split the screen into two blocks.
   */
  messages: ChatMessage[];
  pageNotice: string | null;           // #308 — inline notice for "페이지를 코치에게"
  aiNotice: string | null;             // #320 — AI disclosure at session start
  stopNotice: string | null;           // #497 — notice that the turn was cut off by Stop
  /** #649 — id of the world currently open (the host's worldOpened). Used only to highlight the strip. */
  openWorldId: string | null;
  /** Progress of "갤러리에 올리기". null = not pressed yet. */
  publish:
    | { state: "uploading" }
    | { state: "done"; url: string }
    | { state: "error"; message: string }
    | null;
  onPublish: () => void;
  /** #607 — 상시 "기록 보내기". opt-in 코호트에서만 렌더된다. */
  onUploadLogs: () => void;
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
  const [draft, setDraft] = useState(() => draftAfterStop(config?.activityDraft?.text ?? "", config?.activityDraft?.queued ?? null));
  const [composing, setComposing] = useState(false);
  const [rollExpand, setRollExpand] = useState<{ original: string } | null>(null);
  // Pasted-image attachments for the next turn (data URLs). `imgNote` surfaces
  // a brief reason when a paste is rejected (too big / too many).
  const [pendingImages, setPendingImages] = useState<string[]>(config?.activityDraft?.images ?? []);
  const [imgNote, setImgNote] = useState<string | null>(null);
  // #416 — the ONE message parked while a turn is running (null = none).
  const [queued, setQueued] = useState<string | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  // SX-01/SX-02 — the step currently being viewed. A **view state**. Not a completion judgment.
  const [currentStepId, setCurrentStepId] = useState<string | null>(null);
  /**
   * SX-14·15·17 — the learning state the host computed and sent. **It is not
   * recomputed here.** null means this connection does not use learning events (it is
   * not `hps-observation/2`), and then region D is not drawn — an empty drawer left on
   * screen does nothing when pressed.
   */
  const [learning, setLearning] = useState<LearningStatePayload | null>(null);
  /** Drawer open/closed is a **view state**, so the webview owns it. Closed by default (SX-17). */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const snapshot = useRef({text:draft,images:pendingImages,queued});
  snapshot.current = {text:draft,images:pendingImages,queued};
  const activityId = config?.activity?.id;
  const initialDraft = useRef(true);
  useEffect(() => {
    if (initialDraft.current) { initialDraft.current=false; return; }
    if (activityId) postToHost({type:"saveActivityDraft",activityId,draft:{text:draft,images:pendingImages,queued}});
  }, [activityId,draft,pendingImages,queued]);
  useEffect(() => {
    const off = onHostMessage(msg => {
      if (!activityId || msg.activityId !== activityId) return;
      if (msg.type === "inputRejected") {
        setDraft(d => d === msg.text ? d : draftAfterStop(d,msg.text));
        if (msg.images?.length) setPendingImages(images => [...new Set([...images,...msg.images!])]);
      }
      if (msg.type === "activityFreeze") {
        setFrozen(msg.frozen);
        if (msg.nonce) postToHost({type:"saveActivityDraft",activityId,draft:snapshot.current,nonce:msg.nonce});
      }
      if (msg.type === "activityDraftError") setDraftError(msg.error);
    });
    return off;
  }, [activityId]);
  // SX-14·15·17 — take the learning state the host sent as-is. Why it is not filtered
  // by activity id: the gate is per **task**, and the host already sends only that
  // task's events.
  useEffect(() => {
    const off = onHostMessage((msg) => {
      if (msg.type === "learningState") setLearning(msg.state);
    });
    return off;
  }, []);
  /**
   * #642/#649 (2026-08-20 review) — the **unguarded window** between pressing a friend
   * and the host sending streamStart. In between, the host fetches the world HTML +
   * engine (two round trips), archives them and writes index.html — hundreds of ms to
   * several seconds. `streaming` is still false, so the whole strip stayed live and the
   * runner stayed folded: a kid pressing 초코 and then 나비 right after made two world
   * opens overlap (exactly the symptom #642·#649 were meant to catch).
   */
  const [worldPending, setWorldPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** Previous `streaming` value — the flush must fire on the edge, not the state. */
  const prevStreamingRef = useRef(streaming);

  // Once the host has started the turn (streamStart), `streaming` does the same job
  // from there on. Safety timer — so the buttons are never locked forever when opening
  // a world fails and the turn never starts at all (the kid reads that as a dead app).
  useEffect(() => {
    if (!worldPending) return;
    if (streaming) {
      setWorldPending(false);
      return;
    }
    const t = setTimeout(() => setWorldPending(false), 20000);
    // Written as `return () => …`, test/hook-order.smoke.mjs's static check reads this
    // line as an **early return of the component** (and counts every hook below it as a
    // violation) — so the cleanup function is named and then returned.
    const cancel = () => clearTimeout(t);
    return cancel;
  }, [worldPending, streaming]);

  /** Responding, or opening a world — the friend buttons and the runner read the same value. */
  const unavailable = frozen || (!!config?.activity && !config.activity.verified);
  const busy = streaming || worldPending || unavailable;

  const ux: UxConfig = config?.profile?.ux ?? DEFAULT_UX;
  // Image paste is a per-profile opt-in (website-copyclone). Default-off so
  // minor cohorts never expose the image flow — the worker enforces the same
  // gate server-side, this just keeps the UI honest (no thumbnail, plain text
  // paste). Absent on older cached /v1/profile responses → treated as off.
  const imagePasteEnabled = config?.profile?.input?.image_paste === true;
  // #649 — switching worlds is **click-only**. Only for cohorts whose profile carries
  // worlds (kids-quest), the friend strip is always up, right above the composer. It
  // must not disappear once the conversation has started — in v0.1.48, which had only
  // the first-screen chips, typing was the only way to change worlds, and that typing
  // overwrote the world the kid had already fixed up.
  const worlds: WorldChoice[] = config?.profile?.worlds ?? [];
  /**
   * Whether to show the gallery button. **The cohort profile decides** — only when the
   * worker's `publishing` is on (`enabled`) and the destination is the gallery
   * (`strategy`).
   *
   * The minor-cohort default is `local_only`, and that profile carries the decision as
   * a comment: "public publishing is turned on only after parental consent + the PII
   * design is finished". Opening the UI here alone still gets a 403 from the server
   * (fail closed), so this check is **about not showing a kid a button they do not
   * have**, not a security boundary.
   *
   * #748 — this used to look at `strategy` only. `enabled` was a value the worker
   * shipped down and nobody read. Now it reads **the same two values in the same
   * direction** as the host's `galleryPublishAllowed`. The reason for mirroring by hand
   * is the same as REQ-M33 — the webview is a separate vite app and does not import
   * extension-host modules. test/gallery-publish-gate.smoke.mjs locks the drift so the
   * two sides do not diverge.
   */
  const publishing = config?.profile?.publishing;
  const galleryEnabled =
    publishing?.enabled === true && publishing?.strategy === "hypeproof_gallery";
  /**
   * #607 — 기록 보내기 진입점. opt-in 한 수업에서만 **렌더 자체를 한다**.
   * 꺼진 수업에서 업로드를 권하는 UI 를 띄우지 않는 것은 배너(#596)와 같은
   * 규율이다 — 서버도 fail closed 로 거절하지만, 그건 아이가 누른 **뒤**다.
   *
   * 판정 입력은 호스트 커맨드(`extension.ts` 의 uploadSessionLogs)와 같은
   * 한 값이고, 같은 방향(`=== true`)으로 본다. 웹뷰는 별도 vite 앱이라 호스트
   * 모듈을 import 하지 않으므로(갤러리 게이트와 같은 이유) 드리프트는
   * test/session-upload-entrypoint.smoke.mjs 가 잠근다.
   */
  const uploadLogsEnabled = config?.profile?.analytics?.upload_session_logs === true;
  // #140 / #747 — one identity rule shared with the host (coachIdentity.ts):
  // a fixed cohort or lesson name wins over any stored student name.
  const coachName = resolveCoachIdentity(config?.coach, { ux }).name;

  // Tone for hard-coded chat-panel labels — game (kids) vs search-webapp
  // (보아치과 teaser) vs website (보아치과 원장 copyclone) vs world
  // ("내가 만든 미래"). Centralized in chatPanelHelpers (appToneOf/TONE_LABELS)
  // but mirrored here so the webview stays vscode-free (chatPanelHelpers
  // imports Node `Buffer`).
  //
  // ⚠ If this mirror drifts, the wrong word shows on screen. On 2026-08-17, on a real
  // device, the kids-world (now kids-quest) track put up "게임 만드는 중" — that
  // curriculum forbids the "게임" frame. test/tone-mirror.smoke.mjs forces the two
  // places to agree. When adding a tone, fix both sides.
  const templateTier =
    (config?.profile as { game?: { template_tier?: string } } | undefined)?.game?.template_tier;
  const appTone: "game" | "search" | "site" | "quest" =
    templateTier === "search-webapp"
      ? "search"
      : templateTier === "website"
        ? "site"
        : templateTier === "kids-quest"
          ? "quest"
          : "game";
  const buildingLabel =
    appTone === "search"
      ? "검색엔진 만드는 중"
      : appTone === "site"
        ? "웹사이트 만드는 중"
        : appTone === "quest"
          ? "생각 중…"
          : "게임 만드는 중";
  const namingEmoji =
    appTone === "search" ? "🔍" : appTone === "site" ? "🌐" : appTone === "quest" ? "✨" : "🎮";

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

  // NOTE: the early return into the naming card sits **below this component's last
  // hook**. It must not go here (between hooks) — see the "Hook order" comment below.

  const submit = (text?: string) => {
    const value = (text ?? draft).trim();
    if ((!value && pendingImages.length === 0) || streaming || unavailable) return;
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
    if (unavailable || !shouldFlushQueue(prev, streaming, queued)) return;
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

  // ─────────────────────────────────────────────────────────────────────────
  // Hook order — do not add hooks below this line. The early return is here.
  //
  // The naming card renders only when `needsNaming` is true. If that return sits
  // **between** hooks, the hook count differs per render and React crashes:
  //
  //   before naming (needsNaming=true) → return → N hooks
  //   kid saves the name → coach.configured=true
  //   after naming (needsNaming=false) → falls through → N+3 hooks   ← React #310
  //   (the other direction — config arriving late, `코치 이름 다시 짓기` → fewer hooks → React #300)
  //
  // Every student must pass through the naming ritual, so this transition happens 100%
  // of the time on the normal path.
  // Both directions, #300 and #310, reproduced in the 2026-08-10 real-device session (2/2).
  // ErrorBoundary catches it, it drops to "화면을 그리다가 멈췄어요", and only "다시 열기" recovers.
  //
  // If you need a new hook, add it **above** this block.
  // ─────────────────────────────────────────────────────────────────────────
  const updateBanner = config?.update ? (
    <UpdateBanner offer={config.update} onInstall={props.onInstallUpdate} onDismiss={props.onDismissUpdate} />
  ) : null;
  if (!config?.profile && !config?.activity) return <>{updateBanner}<DisconnectedChat open={props.onSetToken} /></>;
  if ((needsNaming || forceNaming) && config?.profile) {
    return (
      <>
      {config?.activity && <div className="hps-activity-header" aria-label="현재 활동">
        {config.activity.kind === "trial" ? "AI 체험" : config.activity.kind === "classroom" ? "수업" : "개인 작업"} · {config.activity.name}
        {!config.activity.verified && <p role="status">연결을 확인하지 못했습니다. 저장된 기록을 볼 수 있으며, 다시 연결한 뒤 보낼 수 있습니다.</p>}
      </div>}
      {draftError && <p role="alert">{draftError}</p>}
      {updateBanner}
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
      </>
    );
  }
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

  /**
   * #649 — friend button: sends the chip text **verbatim** (the host opens a world only
   * on an exact match). Why not submit(): submit clears the draft. If a kid is typing
   * "불 대신 물" and presses a friend, what they were writing vanishes silently — the
   * button changes only the world.
   */
  const handleWorldPick = (chip: string) => {
    if (busy) return;
    setWorldPending(true);
    props.onSend(chip);
    setRollExpand(null);
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

  // If the strip already carries the same chip, drop it from the first-screen chips —
  // two copies of the same button read to a kid as "these are two different things"
  // (2026-08-20 review).
  const stripChips = new Set(worlds.map((w) => w.chip));
  const initialChips =
    worlds.length > 0
      ? ux.suggestions.initial.filter((c) => !stripChips.has(c.text))
      : ux.suggestions.initial;
  const showInitialChips =
    messages.length === 0 &&
    !streaming &&
    initialChips.length > 0;

  // #503 — a tool row can come at the end of the timeline, so "is the last one the
  // assistant" is judged by the last **bubble**. Otherwise the follow-up chips vanish
  // on a turn that ended with a tool.
  const lastSpoken = [...messages].reverse().find((m) => m.role !== "tool");
  const showFollowUpChips =
    !streaming &&
    messages.length > 0 &&
    lastSpoken?.role === "assistant" &&
    ux.suggestions.follow_up.length > 0;
  // #414 — if a real activity log showed up this turn, the spinner does not invent fake stages.
  const turnHasActivity = hasActivityThisTurn(messages);

  // #642 — if the screen is static for the 1–3 minutes the coach is working, a kid
  // reads it as broken (2026-08-20, real device). The runner bar goes above the
  // composer on the kids track only. All the decisions live in runner.ts (pure). When
  // the cohort matches it **stays in place, folded, even with no turn running** — that
  // is what makes both the appearing and the disappearing smooth, and keeps the
  // composer from jumping up and down.
  const runnerCohort = isRunnerCohort({ worldCount: worlds.length, tone: appTone });
  const runnerRunning = shouldShowRunner({ streaming: busy, worldCount: worlds.length, tone: appTone });
  const runnerWho = runnerFace(worlds, props.openWorldId);

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
        {ux.coach.naming_mode === "fixed"
          ? <strong title={`이 수업의 AI 이름: ${coachName}`} className="hps-coach-name">{coachName}</strong>
          : <button title="코치 이름 바꾸기" onClick={() => setForceNaming(true)} className="hps-coach-name">{coachName}</button>}
        <div className="hps-actions">
          {/* Immediately **left** of Token, same size. It inherits the header button
              style (.hps-header button) as-is and differs only in color — giving it its
              own size makes the header row grow taller because of this one button.
              Token·Clear·⚙ are the settings family and this is a control the kid uses,
              so it stands in front of that group, where the hand reaches first. */}
          {galleryEnabled && props.openWorldId !== null && (
            <button
              className="hps-gallery-btn"
              onClick={props.onPublish}
              disabled={busy || props.publish?.state === "uploading"}
              title="지금 만든 세상을 갤러리에 올려요"
            >
              {props.publish?.state === "uploading"
                ? "올리는 중…"
                : props.publish?.state === "done"
                  ? "올렸어요 ✓"
                  : "🖼️ 갤러리"}
            </button>
          )}
          {uploadLogsEnabled && (
            <button
              className="hps-upload-btn"
              onClick={props.onUploadLogs}
              title="오늘 한 활동 기록을 선생님께 보내요"
            >
              📮 기록 보내기
            </button>
          )}
          <button onClick={props.onSetToken} title="연결된 활동 확인 및 변경">
            활동 변경
          </button>
          <button onClick={props.onClear} disabled={props.streaming} title="대화 기록 지우기">대화 지우기</button>
          <button onClick={props.onSettings} title="설정" aria-label="설정">⚙</button>
        </div>
      </header>

      {/* Region A — Mission header. Replaces both the old `hps-activity-header` and the
          `details.hps-lesson` summary (design §정보 구조, region A). The activity name
          moved down to a small line inside the header. */}
      <MissionHeader
        lesson={config?.profile?.lesson ?? null}
        currentStepId={currentStepId}
        onSelectStep={setCurrentStepId}
        onStartStep={(step) => {
          setCurrentStepId(step.id);
          const lesson = config?.profile?.lesson;
          if (!lesson) return;
          handleChip({
            style: 'good',
            text: `수업: ${lesson.content.title} (${lesson.version})\n과제: ${step.instructions}\n확인 기준: ${step.acceptance}\n현재 작업을 보존하면서 이 과제를 도와주세요.`,
          });
        }}
        onOpenGrowth={() => postToHost({ type: "openLocalReview" })}
        busy={streaming}
        activity={config?.activity ? {
          label: config.activity.kind === "trial" ? "AI 체험" : config.activity.kind === "classroom" ? "수업" : "개인 작업",
          name: config.activity.name,
          verified: !!config.activity.verified,
        } : null}
      />
      {draftError && <p role="alert">{draftError}</p>}
      {updateBanner}

      {/* Region B's lesson info — inside the coach rail, **outside** the message stream
          (SX-05). Closed by default, and it opens only the current step. It used to
          expand all six steps at once and took up more room than the mission. */}
      {config?.profile?.lesson && (() => {
        const lesson = config.profile.lesson;
        const steps = lesson.content.steps;
        const step = steps.find(s => s.id === currentStepId) ?? steps[0];
        if (!step) return null;
        const index = steps.indexOf(step);
        return (
          <details className="hp-rail-lesson">
            <summary>이번 단계 안내 · {index + 1}. {step.title}</summary>
            <p className="hp-rail-lesson-meta">{lesson.content.title} · 버전 {lesson.version} · {lesson.content.duration_minutes}분</p>
            <p>{step.instructions}</p>
            {step.hint ? <details><summary>힌트 보기</summary><p>{step.hint}</p></details> : null}
            <p>확인 기준: {step.acceptance}</p>
            <p className="hp-rail-lesson-note">안내를 읽은 것만으로 이 단계가 끝나지는 않습니다. 직접 만들고 확인한 기록이 남아야 합니다.</p>
          </details>
        );
      })()}

      {/* Region D — the completion gate and the Evidence drawer (SX-14·17). Drawn only
          when the host sends `learningState`. On a connection that does not send it (a
          profile that does not use learning events), an empty drawer left on screen is
          decoration that does nothing when pressed. */}
      {learning && (
        <section className="hp-evidence-region" aria-label="근거와 완료">
          <div className="hp-complete">
            {/* SX-14 — the reason it is disabled is visible **next to the button**.
                There is no bypass button. The host made the judgment; this only draws it. */}
            <button
              type="button"
              // **Not a Primary.** There is one emphasized button on screen and that
              // slot belongs to region A's "지금 할 행동" (SX-01·SX-51). Completion is
              // pressed **after** all those actions are done, so it has no reason to
              // catch the eye first. Emphasize both and "what to do now" becomes two things.
              className="hp-cta-quiet"
              disabled={!learning.complete.ok}
              onClick={() => postToHost({ type: "submitTask", task: learning.task })}
            >
              이 과제 완료하기
            </button>
            {!learning.complete.ok && (
              <ul className="hp-complete-why">
                {learning.complete.reasons.map((reason) => (
                  <li key={reason}>☐ {reason}</li>
                ))}
              </ul>
            )}
            {!learning.declared && (
              <p className="hp-complete-note">이 단계는 따로 정해 둔 완료 조건이 없어요.</p>
            )}
          </div>
          <EvidenceDrawer
            open={drawerOpen}
            rows={learning.evidence}
            verification={learning.verification}
            // The step id is a **view state**, so it comes from here. The host uses it
            // only after checking it is a step of this lesson — a value the webview
            // sent is never trusted as-is.
            onSubmit={(draft) => postToHost({ type: "learningEvent", draft, stepId: currentStepId ?? undefined })}
            onToggle={(open) => {
              setDrawerOpen(open);
              postToHost({ type: "learningDrawer", open });
            }}
          />
        </section>
      )}

      {/* Both lines were originally pinned to `=== 'hps-observation/1'`. The moment `/2`
          opened, (a) the observation panel disappeared and (b) "관찰을 지원하지 않습니다"
          showed up next to a screen whose drawer was working fine. The test is "is
          observation on", not "which version is it". */}
      {isObservationFormat(config?.profile?.observation?.format) && <NativeObservationPanel scope={config!.profile!.observation!.scope} coachName={coachName} />}
      {config?.profile?.profile_id === 'studio-native-trial' && !isObservationFormat(config.profile.observation?.format) && <p role="status">현재 연결은 작업 관찰을 지원하지 않습니다. 기존 작업 파일은 계속 사용할 수 있습니다.</p>}

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
            chips={initialChips}
            onPick={handleChip}
            label="이렇게 시작해볼까요? (탭하면 입력창에 들어가요)"
          />
        )}

        {messages.map((m) =>
          m.role === "tool" ? (
            <ToolLine key={m.id} message={m} />
          ) : (
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
              hasActivity={turnHasActivity}
              onRunCode={props.onRunCode}
              onRetry={props.onRetry}
            />
          ),
        )}

        {props.pageNotice && (
          <div className="hps-page-notice" role="status" aria-live="polite">
            {props.pageNotice}
          </div>
        )}

        {/* #497 — the notice right after Stop. It is not an error, so it is announced as
            a quiet inline status line rather than an error banner. It goes away on the
            next input. */}
        {props.stopNotice && (
          <div className="hps-stop-notice" role="status" aria-live="polite">
            <span className="hps-stop-notice-icon" aria-hidden="true">⏹</span>
            {props.stopNotice}
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
        {config.profile?.model_selection && <div className="hps-model-selection">
          <label>모델 <select aria-label="대화 모델" value={config.model}
            disabled={config.profile.model_selection.choices.length === 1}
            onChange={e => postToHost({ type: 'selectModel', alias: e.target.value })}
            onKeyDown={e => {
              // Embedded Mac webviews can forward native select keys to the workbench.
              // Keep version navigation in this control, including without a native popup.
              if (e.altKey || e.ctrlKey || e.metaKey || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
              const choices = config.profile?.model_selection?.choices ?? [];
              if (!choices.length) return;
              const current = choices.findIndex(c => c.alias === config.model);
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? choices.length - 1
                : Math.max(0, Math.min(choices.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)));
              e.preventDefault(); e.stopPropagation();
              if (choices[next]) postToHost({ type: 'selectModel', alias: choices[next].alias });
            }}>

            {config.profile.model_selection.choices.map(c => <option key={c.id} value={c.alias}>{c.label}</option>)}
          </select></label>
          <small>{config.profile.model_selection.choices.length === 1
            ? (config.profile.model_selection.source === 'lesson' ? '이 수업에서 고정한 모델' : '사용 가능한 모델 1개')
            : streaming ? '변경하면 다음 요청부터 적용돼요' : '대화를 유지하며 모델을 바꿀 수 있어요'}</small>
        </div>}
        <EffortControl config={config} post={postToHost} />
        <AccessControl config={config} streaming={streaming} post={postToHost} />
        {runnerCohort && <RunnerBar face={runnerWho} running={runnerRunning} />}
        {/* The button is in the header; **only the result** appears here. One header row
            has no room for either the link or the failure reason, and a kid cannot read
            a notice that disappears — so it stays as one line above the composer, only
            when there is something to say. */}
        {props.publish && props.publish.state !== "uploading" && (
          <GalleryNotice
            publish={props.publish}
            onOpenUrl={(url) => postToHost({ type: "openExternal", url })}
          />
        )}
        {worlds.length > 0 && (
          <WorldStrip
            worlds={worlds}
            openId={props.openWorldId}
            disabled={busy}
            /* When the conversation is empty (first screen, right after Clear) the
               instruction about what to press is needed again — in kids-quest the
               first-screen chips overlap the strip and drop out entirely, so this one
               line is the only instruction. */
            showLabel={props.openWorldId === null || messages.length === 0}
            onPick={handleWorldPick}
          />
        )}
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
            autoFocus
            readOnly={unavailable}
            aria-label={composerLabel(coachName)}
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
              if (e.key !== "Enter" || e.shiftKey || isComposing || unavailable) return;
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

/** One world the profile ships down (reuses the host protocol's definition as-is). */
type WorldChoice = NonNullable<ResolvedProfile["worlds"]>[number];

/**
 * One line of publish result. The button is in the header (next to Token); this says
 * **only the result**.
 *
 * Why success stays up: a kid cannot read a notice that disappears. The link has to
 * stay there so they can show it to the friend sitting next to them, or to a parent.
 * Changing worlds clears this state through App's `worldOpened` — from then on it is a
 * different world's story.
 *
 * The failure text is never truncated. "why it did not work" is this feature's only
 * recovery clue.
 */
function GalleryNotice({
  publish,
  onOpenUrl,
}: {
  publish: { state: "done"; url: string } | { state: "error"; message: string };
  onOpenUrl: (url: string) => void;
}) {
  if (publish.state === "done") {
    return (
      <div className="hps-gallery-notice hps-gallery-done" role="status" aria-live="polite">
        <span aria-hidden>🖼️</span> 갤러리에 올렸어요!{" "}
        <button type="button" className="hps-gallery-link" onClick={() => onOpenUrl(publish.url)}>
          보러 가기
        </button>
      </div>
    );
  }
  return (
    <div className="hps-gallery-notice hps-gallery-error" role="status" aria-live="polite">
      {publish.message}
    </div>
  );
}

/**
 * #649 — the friend strip. **Always** right above the composer (mid-conversation and
 * mid-response too).
 *
 * Why buttons: in v0.1.47/48, which also accepted world switches in prose, "초코 세상에
 * 다람쥐 데려와줘" opened 도토's world, and "초코 세상에 불 대신 물" re-fetched the
 * original 초코 and overwrote the screen the kid had fixed up (2026-08-20, real device).
 * Worlds now change only through this button.
 *
 * Disabled while responding — swapping the world in the middle attaches the answer now
 * arriving to somebody else's world. A click sends the chip text **verbatim** (the
 * host's matchWorldRef only catches an exact match, so not one character is touched up).
 */
function WorldStrip({
  worlds,
  openId,
  disabled,
  showLabel,
  onPick,
}: {
  worlds: WorldChoice[];
  openId: string | null;
  disabled: boolean;
  showLabel: boolean;
  onPick: (chip: string) => void;
}) {
  return (
    <div className="hps-worlds-wrap">
      {/* A one-line instruction when the conversation is empty or no world has been
          opened yet. The first-screen chips (same wording) are hidden because they
          overlap the strip, so the "what to press" has to be said here at least once.
          2026-08-20 review: the condition was `openId === null` alone, so **right after
          Clear** the first screen was empty — no chips and no label. The arrow points
          down — the buttons are directly below this line (matching the wording and
          direction of the guest-list answer). */}
      {showLabel && <div className="hps-worlds-label">👇 친구를 누르면 그 세상으로 가요</div>}
      <div className="hps-worlds" role="group" aria-label="친구 고르기">
        {worlds.map((w) => {
          const open = w.id === openId;
          return (
            <button
              key={w.id}
              type="button"
              className={`hps-world${open ? " hps-world-open" : ""}`}
              aria-pressed={open}
              /* The world currently open cannot be pressed again (2026-08-20 review). A
                 re-click means 're-fetch the pristine original and overwrite
                 index.html', so a world worked on for 20 minutes is reset by one
                 misoperation — and the most eye-catching color (button-background)
                 happens to be on that very button, which makes it the first thing a
                 3rd/4th grader mis-taps. The archived copy survives, but undoing it is
                 something that has to go through the coach. */
              disabled={disabled || open}
              title={
                open
                  ? `${w.guest} 세상을 열어 뒀어요`
                  : w.line
                    ? `${w.guest} — ${w.line}`
                    : `${w.guest} 세상으로 가기`
              }
              onClick={() => onPick(w.chip)}
            >
              <span className="hps-world-emoji" aria-hidden="true">{w.emoji}</span>
              <span className="hps-world-name">{w.guest}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * #642 — the running guest. Fills the 1–3 minutes that used to sit static after
 * "Read ✓" (2026-08-20, real device: the kid read the frozen screen as broken and sent
 * the same message again — turns overlap).
 *
 * Why it always renders and only toggles a class: attaching and detaching it
 * conditionally cuts the moment of disappearance off abruptly and pops the composer up
 * 40px. Leaving it folded (max-height:0) lets CSS handle both directions smoothly.
 *
 * Hidden from screen readers (aria-hidden): reading out a phrase that changes every 4
 * seconds through a live region is noise. The accessible route to progress is the tool
 * log in the timeline ("✍️ 고치는 중…"); this bar is a visual device laid on top of it.
 */
function RunnerBar({ face, running }: { face: RunnerFace; running: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    // When the turn ends, stop the timer and reset to 0 — the next turn has to start
    // over from "세상을 고치는 중…" (carrying on from "거의 다 됐어요…" would be a lie).
    if (!running) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), RUNNER_PHRASE_MS);
    return () => clearInterval(timer);
  }, [running]);

  return (
    <div className={`hps-runner${running ? " hps-runner-on" : ""}`} aria-hidden="true">
      <div className="hps-runner-track">
        {/* The dust trails behind the face — CSS row-reverse flips the order.
            Under prefers-reduced-motion three dots just blink in place. */}
        <div className="hps-runner-go">
          <span className="hps-runner-face">{face.emoji}</span>
          <span className="hps-runner-dust" />
          <span className="hps-runner-dust" />
          <span className="hps-runner-dust" />
        </div>
      </div>
      <span className="hps-runner-say">{runnerPhrase(elapsed, face.guest)}</span>
    </div>
  );
}

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
            안녕하세요! 저는 <strong>{coachName}</strong>{copulaParticle(coachName)}.
            {hasGreeting && <br />}
          </>
        )}
        {hasGreeting ? (
          <span dangerouslySetInnerHTML={{ __html: renderInlineMd(greetingMd) }} />
        ) : (
          !showCoachIntro && <>안녕하세요! 저는 <strong>{coachName}</strong>{copulaParticle(coachName)}.</>
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

/**
 * #503 — one tool row inside the timeline. It used to be a single `.hps-tool-log` box
 * sitting **below** all the bubbles, so "what the coach said and then what it did"
 * could not be read off the screen. Now it sits exactly where it happened.
 *
 * The class names (`hps-tool-log-line` / `hps-tool-icon` / `hps-tool-label` /
 * `hps-tool-<state>`) are **left alone on purpose** — the e2e (t1-first-turn-trace) and
 * the observer (e2e/observe/watch.mjs) read activity through these selectors.
 */
function ToolLine({ message }: { message: ChatMessage }) {
  const t = message.tool;
  if (!t) return null;
  // This row is a waiting indicator, never evidence that a file was changed.
  // Hide completed waits from old histories too; retain the stored timeline.
  if (message.id.startsWith('pending-') && t.state === 'done') return null;
  const thinking = /^think-\d+$/.test(message.id);
  if (thinking && t.state === 'done') {
    return (
      <details className="hps-thinking-details">
        <summary className="hps-tool-log-line hps-tool-done" aria-label="AI 처리 내용 보기">
          <span className="hps-tool-icon">{t.icon}</span>
          <span className="hps-tool-label">응답 준비</span>
          <span className="hps-tool-mark">▾</span>
        </summary>
        <pre>{t.label}</pre>
      </details>
    );
  }
  return (
    <div className={`hps-tool-log-line hps-tool-${t.state}`} role="status" aria-live="polite">
      <span className="hps-tool-icon">{t.icon}</span>
      <span className="hps-tool-label">{thinking ? '응답을 준비하는 중…' : t.label}</span>
      <span className="hps-tool-mark">
        {t.state === "running" ? "…" : t.state === "error" ? "⚠️" : "✓"}
      </span>
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
  tone: "game" | "search" | "site" | "quest";
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
        {/*
          * #747 (AE-08) — if a stored name exists, use **that**. If not (rows from
          * before this change, a bubble still streaming) it falls back to the live name.
          * Re-resolving here would make the past change along the moment the name changes.
          */}
        <span>{message.role === "user" ? "나" : message.assistantName ?? coachName}</span>
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
        <span key={`${c.url}-${i}`} role="listitem"><button
          type="button"
          className={`hps-cit-chip hps-cit-tier-${c.tier}`}
          onClick={() => postToHost({ type: "openExternal", url: c.url })}
          title={c.url}
        >
          <span className="hps-cit-index">[{i + 1}]</span>
          <span className="hps-cit-title">{c.title || c.domain}</span>
          <span className="hps-cit-domain">{c.domain}</span>
        </button></span>
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
  tone: "game" | "search" | "site" | "quest",
  hasActivity = false,
): string {
  if (fenceOpen) return "거의 다 됐어요";
  // The quest track does not name what is being made — the label itself is "생각 중…",
  // and adding sub-stages would define "what" is being made all over again.
  if (tone === "quest") return buildingLabel;
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
  tone: "game" | "search" | "site" | "quest";
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
          return <MarkdownText key={i} text={seg.value} />;
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
  // between "연결 끊김" (worth retrying) and "토큰/세션 문제" (go to the instructor).
  const isAuth = /참여 코드|토큰|세션|강사|만료|등록|인가/.test(message);
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
