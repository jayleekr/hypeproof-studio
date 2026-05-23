import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatConfig,
  ChatMessage,
  SuggestionChip,
  UpdateOffer,
  UxConfig,
} from "../../src/protocol";

interface Props {
  config: ChatConfig | null;
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  errorRequestId: string | null;
  errorRunbookUrl: string | null;  // #165 — render as clickable runbook link
  canRetryLast: boolean;
  onSend: (text: string) => void;
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
  const { config, messages, streaming, error } = props;
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [rollExpand, setRollExpand] = useState<{ original: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const ux: UxConfig = config?.profile?.ux ?? DEFAULT_UX;
  // Fixed-naming cohorts (e.g. boah-dental) must NOT show a user-supplied
  // coach name carried over from a different cohort's user-data-dir (#140).
  const coachName =
    ux.coach.naming_mode === "fixed"
      ? (ux.coach.fallback_name || "코치")
      : (config?.coach?.name?.trim() || ux.coach.fallback_name || "코치");

  // Tone for hard-coded chat-panel labels — game (kids cohorts) vs
  // search-webapp (보아치과 류). Centralized in chatPanelHelpers (#159) but
  // duplicated as a one-liner here so the webview stays vscode-free.
  const isSearchWebapp =
    (config?.profile as { game?: { template_tier?: string } } | undefined)?.game
      ?.template_tier === "search-webapp";
  const buildingLabel = isSearchWebapp ? "검색엔진 만드는 중" : "게임 만드는 중";
  const namingEmoji = isSearchWebapp ? "🔍" : "🎮";

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
    if (!value || streaming) return;
    props.onSend(value);
    setDraft("");
    setRollExpand(null);
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
    props.onSend(combined);
    setDraft("");
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
    <div className="hps-shell">
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
            ux={ux}
            coachName={coachName}
            buildingLabel={buildingLabel}
            messages={messages}
            onRunCode={props.onRunCode}
            onRetry={props.onRetry}
          />
        ))}

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
        <div className="hps-input">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(e) => {
              const isComposing =
                composing ||
                e.nativeEvent.isComposing ||
                // keyCode 229 is the legacy Safari signal for IME composition.
                e.nativeEvent.keyCode === 229;
              if (e.key === "Enter" && !e.shiftKey && !isComposing) {
                e.preventDefault();
                if (rollExpand) handleRollSend();
                else submit();
              }
            }}
            placeholder={
              streaming
                ? "응답 중..."
                : rollExpand
                  ? "한 가지만 더 떠올려서 적어주세요"
                  : "메시지를 입력하고 Enter (Shift+Enter 줄바꿈)"
            }
            disabled={streaming}
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
              <button onClick={props.onCancel} className="hps-btn-stop">Stop</button>
            ) : rollExpand ? (
              <button
                onClick={handleRollSend}
                disabled={!draft.trim()}
                className="hps-btn-send"
              >
                Send
              </button>
            ) : (
              <button onClick={() => submit()} disabled={!draft.trim()} className="hps-btn-send">
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
            title={c.style === "weak" ? c.caption ?? "예시일 뿐이에요" : "탭하면 입력창에 들어가요"}
          >
            <span className="hps-chip-text">{c.text}</span>
            {c.caption && (
              <span className="hps-chip-caption">{c.caption}</span>
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
  ux,
  coachName,
  buildingLabel,
  messages,
  onRunCode,
  onRetry,
}: {
  message: ChatMessage;
  streaming: boolean;
  ux: UxConfig;
  coachName: string;
  buildingLabel: string;
  messages: ChatMessage[];
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
          <AssistantContent content={message.content} streaming={streaming} buildingLabel={buildingLabel} />
        ) : (
          message.content
        )}
      </div>
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
 */
function buildStageText(buildingLabel: string, content: string, fenceOpen: boolean): string {
  if (fenceOpen) return "거의 다 됐어요";
  const len = content.length;
  if (len > 500) return `${buildingLabel} — V1 화면 그리는 중`;
  if (len > 200) return `${buildingLabel} — 검색어·출처 정리`;
  return `${buildingLabel} — 검색 주제 잡는 중`;
}

function AssistantContent({
  content,
  streaming,
  buildingLabel,
}: {
  content: string;
  streaming: boolean;
  buildingLabel: string;
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
            const stage = buildStageText(buildingLabel, content, hasOpenFence);
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
          🛠️ {buildStageText(buildingLabel, content, false)}… <span className="hps-dots">✨</span>
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
function renderInlineMd(md: string): string {
  return md
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
