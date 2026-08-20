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
import { postToHost } from "./vscode";
import { hasActivityThisTurn } from "../../src/chatTimeline";
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
   * #503 — 단일 타임라인. user / assistant / tool 이 일어난 순서대로 섞여 있다.
   * 툴 로그를 따로 받던 `toolLog` prop 은 사라졌다 — 그게 화면을 두 덩어리로
   * 가르던 원인이었다.
   */
  messages: ChatMessage[];
  pageNotice: string | null;           // #308 — "페이지를 코치에게" 인라인 안내
  aiNotice: string | null;             // #320 — AI disclosure at session start
  stopNotice: string | null;           // #497 — Stop 으로 턴이 끊겼음을 알리는 안내
  /** #649 — 지금 열려 있는 세상 id (호스트의 worldOpened). 스트립 강조에만 쓴다. */
  openWorldId: string | null;
  /** "갤러리에 올리기" 진행 상태. null = 아직 안 눌렀다. */
  publish:
    | { state: "uploading" }
    | { state: "done"; url: string }
    | { state: "error"; message: string }
    | null;
  onPublish: () => void;
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
  /**
   * #642/#649 (2026-08-20 검토) — 친구를 누른 순간부터 호스트가 streamStart 를
   * 보내기까지의 **무방비 구간**. 그 사이 호스트는 세상 HTML + 엔진을 받아오고(왕복
   * 두 번) 보관하고 index.html 을 쓴다 — 수백 ms ~ 수 초다. `streaming` 은 아직
   * false 라 스트립은 다 살아 있고 러너도 접혀 있었다: 아이가 초코를 누른 직후 나비를
   * 누르면 세상 열기가 겹쳤다(#642·#649 가 잡으려던 바로 그 증상).
   */
  const [worldPending, setWorldPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** Previous `streaming` value — the flush must fire on the edge, not the state. */
  const prevStreamingRef = useRef(streaming);

  // 호스트가 턴을 시작했으면(streamStart) 그때부터는 streaming 이 같은 일을 한다.
  // 안전 타이머 — 세상 열기가 실패해 턴이 아예 안 시작되는 경우에도 버튼이 영영
  // 잠기지는 않게(그러면 아이는 앱이 죽은 줄 안다).
  useEffect(() => {
    if (!worldPending) return;
    if (streaming) {
      setWorldPending(false);
      return;
    }
    const t = setTimeout(() => setWorldPending(false), 20000);
    // `return () => …` 로 쓰면 test/hook-order.smoke.mjs 의 정적 검사가 이 줄을
    // **컴포넌트의 조기 return** 으로 읽어(아래 훅들을 전부 위반으로 센다) — 정리
    // 함수는 이름을 붙여 돌려준다.
    const cancel = () => clearTimeout(t);
    return cancel;
  }, [worldPending, streaming]);

  /** 응답 중이거나 세상을 여는 중 — 친구 버튼과 러너는 같은 값을 본다. */
  const busy = streaming || worldPending;

  const ux: UxConfig = config?.profile?.ux ?? DEFAULT_UX;
  // Image paste is a per-profile opt-in (website-copyclone). Default-off so
  // minor cohorts never expose the image flow — the worker enforces the same
  // gate server-side, this just keeps the UI honest (no thumbnail, plain text
  // paste). Absent on older cached /v1/profile responses → treated as off.
  const imagePasteEnabled = config?.profile?.input?.image_paste === true;
  // #649 — 세상 전환은 **클릭만**. 프로필에 worlds 가 실려 오는 코호트(kids-quest)
  // 에서만, 작성란 바로 위에 친구 스트립을 늘 띄운다. 대화가 시작된 뒤에도 사라지지
  // 않아야 한다 — 첫 화면 칩만 있던 v0.1.48 에서는 세상을 바꾸려면 타이핑밖에
  // 길이 없었고, 그 타이핑이 아이가 고쳐 둔 세상을 덮어썼다.
  const worlds: WorldChoice[] = config?.profile?.worlds ?? [];
  /**
   * 갤러리 버튼을 보일지. **코호트 프로필이 정한다** — 워커의
   * `publishing.strategy` 가 `hypeproof_gallery` 일 때만.
   *
   * 미성년 코호트 기본값은 `local_only` 이고, 그 프로필에는 "공개 퍼블리시는
   * 부모 동의 + PII 설계가 끝난 뒤에만 켠다" 는 결정이 주석으로 박혀 있다.
   * 여기서 화면만 열어 봐야 서버가 403 으로 막으므로(fail closed), 이 판단은
   * **아이에게 없는 버튼을 안 보여주기 위한 것**이지 보안 경계가 아니다.
   */
  const galleryEnabled = config?.profile?.publishing?.strategy === "hypeproof_gallery";
  // Fixed-naming cohorts (e.g. boah-dental) must NOT show a user-supplied
  // coach name carried over from a different cohort's user-data-dir (#140).
  const coachName =
    ux.coach.naming_mode === "fixed"
      ? (ux.coach.fallback_name || "코치")
      : (config?.coach?.name?.trim() || ux.coach.fallback_name || "코치");

  // Tone for hard-coded chat-panel labels — game (kids) vs search-webapp
  // (보아치과 teaser) vs website (보아치과 원장 copyclone) vs world
  // ("내가 만든 미래"). Centralized in chatPanelHelpers (appToneOf/TONE_LABELS)
  // but mirrored here so the webview stays vscode-free (chatPanelHelpers
  // imports Node `Buffer`).
  //
  // ⚠ 이 미러가 어긋나면 화면에 틀린 낱말이 뜬다. 2026-08-17 실기기에서 kids-world(현 kids-quest)
  // 트랙이 "게임 만드는 중" 을 띄웠다 — 그 커리큘럼은 "게임" 프레임을 금지한다.
  // test/tone-mirror.smoke.mjs 가 두 곳의 일치를 강제한다. 톤을 추가하면 양쪽 다 고칠 것.
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

  // NOTE: 작명 카드로 빠지는 조기 return 은 **이 컴포넌트의 마지막 훅 아래**에 있다.
  // 여기(훅 사이)에 두면 안 된다 — 아래 "훅 순서" 주석 참조.

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

  // ─────────────────────────────────────────────────────────────────────────
  // 훅 순서 — 이 아래로는 훅을 추가하지 말 것. 조기 return 이 여기 있다.
  //
  // 작명 카드는 `needsNaming` 이 true 일 때만 렌더된다. 이 return 이 훅들 **사이**
  // 에 있으면 렌더마다 훅 개수가 달라져 React 가 크래시한다:
  //
  //   작명 전 (needsNaming=true)  → return → 훅 N개
  //   아이가 이름 저장 → coach.configured=true
  //   작명 후 (needsNaming=false) → 통과   → 훅 N+3개   ← React #310
  //   (반대 방향 — config 지연 도착·`코치 이름 다시 짓기` → 훅 감소 → React #300)
  //
  // 작명 의식은 모든 학생이 반드시 통과하므로 이 전이는 정상 경로에서 100% 발생한다.
  // 2026-08-10 실기기 세션에서 #300·#310 두 방향 모두 재현됐다 (2/2).
  // ErrorBoundary 가 잡아 "화면을 그리다가 멈췄어요" 로 떨어지고 "다시 열기" 로만 복구된다.
  //
  // 새 훅이 필요하면 이 블록 **위**에 추가한다.
  // ─────────────────────────────────────────────────────────────────────────
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
   * #649 — 친구 버튼: 칩 문구를 **그대로** 보낸다(호스트가 정확일치로만 세상을 연다).
   * submit() 을 쓰지 않는 이유: submit 은 draft 를 비운다. 아이가 "불 대신 물" 을
   * 적다가 친구를 누르면 적던 글이 소리 없이 사라진다 — 버튼은 세상만 바꾼다.
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

  // 스트립이 같은 칩을 이미 들고 있으면 첫 화면 칩에서는 뺀다 — 같은 버튼이 두 벌
  // 뜨면 아이가 "둘이 다른 것" 이라고 읽는다(2026-08-20 검토).
  const stripChips = new Set(worlds.map((w) => w.chip));
  const initialChips =
    worlds.length > 0
      ? ux.suggestions.initial.filter((c) => !stripChips.has(c.text))
      : ux.suggestions.initial;
  const showInitialChips =
    messages.length === 0 &&
    !streaming &&
    initialChips.length > 0;

  // #503 — 타임라인 끝에 툴 줄이 올 수 있으므로 "마지막이 어시스턴트인가"를
  // 마지막 **말풍선** 기준으로 본다. 안 그러면 툴로 끝난 턴에서 후속 칩이 사라진다.
  const lastSpoken = [...messages].reverse().find((m) => m.role !== "tool");
  const showFollowUpChips =
    !streaming &&
    messages.length > 0 &&
    lastSpoken?.role === "assistant" &&
    ux.suggestions.follow_up.length > 0;
  // #414 — 이번 턴에 진짜 활동 로그가 떴으면 스피너가 가짜 단계를 지어내지 않는다.
  const turnHasActivity = hasActivityThisTurn(messages);

  // #642 — 코치가 일하는 1~3분 동안 화면이 정적이면 아이는 고장으로 읽는다(2026-08-20
  // 실기기). 아이 트랙에서만 작성란 위에 러너 바를 둔다. 판단은 전부 runner.ts(순수).
  // 코호트가 맞으면 **턴이 없을 때도 접힌 채로 자리에** 있다 — 그래야 나타날 때와
  // 사라질 때 둘 다 부드럽고, 작성란이 위아래로 튀지 않는다.
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
        <strong title="이 친구 이름 바꾸기" onClick={() => setForceNaming(true)} className="hps-coach-name">
          {coachName}
        </strong>
        <div className="hps-actions">
          {/* Token 바로 **왼쪽**, 같은 크기. 헤더 버튼 스타일(.hps-header button)을
              그대로 물려받고 색만 다르다 — 크기를 따로 주면 헤더 줄 높이가 이 버튼
              하나 때문에 늘어난다.
              Token·Clear·⚙ 는 설정 계열이고 이건 아이가 쓰는 조작이라, 그 묶음
              앞에 세워 손이 먼저 닿는 자리에 둔다. */}
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

        {/* #497 — Stop 직후 안내. 오류가 아니므로 에러 배너가 아니라 조용한
            인라인 상태줄로 알린다. 다음 입력을 하면 사라진다. */}
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
        {runnerCohort && <RunnerBar face={runnerWho} running={runnerRunning} />}
        {/* 버튼은 헤더에 있고 여기는 **결과만** 나온다. 헤더 한 줄에는 링크도
            실패 사유도 들어갈 자리가 없는데, 아이는 사라지는 안내를 못 읽는다 —
            그래서 말할 것이 있을 때만 작성란 위에 한 줄로 남는다. */}
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
            /* 대화가 비어 있으면(첫 화면 · Clear 직후) 무엇을 누르라는 말이 다시
               필요하다 — kids-quest 는 첫 화면 칩이 스트립과 겹쳐 통째로 빠지므로
               이 한 줄이 유일한 지시문이다. */
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

/** 프로필이 실어 보내는 세상 하나 (호스트 protocol 의 정의를 그대로 쓴다). */
type WorldChoice = NonNullable<ResolvedProfile["worlds"]>[number];

/**
 * 발행 결과 한 줄. 버튼은 헤더에 있고(Token 옆) 여기는 **결과만** 말한다.
 *
 * 성공을 계속 띄워 두는 이유: 아이는 사라지는 안내를 못 읽는다. 링크가 남아
 * 있어야 옆자리 친구에게, 부모에게 보여줄 수 있다. 세상을 바꾸면 App 의
 * `worldOpened` 가 이 상태를 지운다 — 그때부터는 다른 세상 얘기라서다.
 *
 * 실패 문구는 자르지 않는다. "왜 안 됐는지"가 이 기능의 유일한 복구 단서다.
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
 * #649 — 친구 스트립. 작성란 바로 위에 **항상** 있다(대화 중에도, 응답 중에도).
 *
 * 왜 버튼인가: 세상 전환을 말로도 받던 v0.1.47/48 에서 "초코 세상에 다람쥐 데려와줘"
 * 가 도토 세상을 띄우고, "초코 세상에 불 대신 물" 이 초코 원본을 다시 받아 아이가
 * 고쳐 둔 화면을 덮어썼다(2026-08-20 실기기). 이제 세상은 이 버튼으로만 바뀐다.
 *
 * 응답 중에는 비활성 — 그 사이 세상을 갈아치우면 지금 오고 있는 답이 남의 세상에
 * 붙는다. 클릭은 칩 문구를 **그대로** 보낸다(호스트 matchWorldRef 가 정확일치로만
 * 잡으므로 한 글자도 다듬지 않는다).
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
      {/* 대화가 비어 있거나 아직 아무 세상도 안 열렸으면 한 줄 안내. 첫 화면 칩(같은
          문구)은 스트립과 겹쳐서 숨겼으므로, 무엇을 누르라는 말은 여기 한 번은 있어야
          한다. 2026-08-20 검토: 조건이 `openId === null` 뿐이라 **Clear 직후**에는
          칩도 라벨도 없는 빈 첫 화면이 됐다. 화살표는 아래를 가리킨다 — 이 줄 바로
          밑이 버튼이다(게스트 목록 답변의 문구와 방향을 맞춘다). */}
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
              /* 지금 열린 세상은 다시 누를 수 없다 (2026-08-20 검토). 재클릭은
                 '처음 상태 원본을 다시 받아 index.html 을 덮는' 동작이라, 20분 고친
                 세상이 한 번의 오조작으로 초기화된다 — 그리고 가장 눈에 띄는 색
                 (button-background)이 하필 그 버튼이라 초3·4 의 첫 오조작 대상이다.
                 보관본은 남지만 되돌리는 건 코치를 거쳐야 하는 일이다. */
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
 * #642 — 달리는 게스트. "Read ✓" 뒤 1~3분 정적이던 구간을 채운다(2026-08-20 실기기:
 * 아이는 멈춘 화면을 고장으로 읽고 같은 말을 또 보냈다 — 턴이 겹친다).
 *
 * 왜 항상 렌더하고 클래스만 토글하나: 조건부로 붙였다 떼면 사라지는 순간이 뚝
 * 끊기고 작성란이 40px 튀어 오른다. 접힌 상태(max-height:0)로 남겨 두면 CSS 가
 * 양방향을 다 부드럽게 처리한다.
 *
 * 스크린리더에는 숨긴다(aria-hidden): 4초마다 바뀌는 문구를 live region 으로
 * 읽어 주면 소음이 된다. 진행 상황의 접근 가능한 통로는 타임라인의 툴 로그
 * ("✍️ 고치는 중…") 쪽이고, 이 바는 그 위에 얹은 시각 장치다.
 */
function RunnerBar({ face, running }: { face: RunnerFace; running: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    // 턴이 끝나면 타이머를 끄고 0 으로 되돌린다 — 다음 턴은 "세상을 고치는 중…"
    // 부터 다시 시작해야 한다(이어서 "거의 다 됐어요…" 로 시작하면 거짓말이 된다).
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
        {/* 먼지는 얼굴 뒤에 남는다 — CSS 의 row-reverse 가 순서를 뒤집는다.
            prefers-reduced-motion 에서는 제자리에서 점 세 개만 깜빡인다. */}
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

/**
 * #503 — 타임라인 안의 툴 한 줄. 예전에는 말풍선 전부 **아래**에 있는 하나의
 * `.hps-tool-log` 상자였고, 그래서 "코치가 무슨 말을 하고 나서 무슨 일을 했는지"가
 * 화면에서 읽히지 않았다. 지금은 일어난 자리에 그대로 놓인다.
 *
 * 클래스 이름(`hps-tool-log-line` / `hps-tool-icon` / `hps-tool-label` /
 * `hps-tool-<state>`)은 **일부러 그대로 둔다** — e2e(t1-first-turn-trace)와
 * 관측기(e2e/observe/watch.mjs)가 이 셀렉터로 활동을 읽는다.
 */
function ToolLine({ message }: { message: ChatMessage }) {
  const t = message.tool;
  if (!t) return null;
  return (
    <div className={`hps-tool-log-line hps-tool-${t.state}`} role="status" aria-live="polite">
      <span className="hps-tool-icon">{t.icon}</span>
      <span className="hps-tool-label">{t.label}</span>
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
  tone: "game" | "search" | "site" | "quest",
  hasActivity = false,
): string {
  if (fenceOpen) return "거의 다 됐어요";
  // quest 트랙은 만드는 대상을 이름 붙이지 않는다 — 라벨 자체가 "생각 중…" 이고
  // 하위 단계를 붙이면 다시 "무엇을" 만드는지 규정하게 된다.
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
