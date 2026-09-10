// #897 (VO-01 / VO-04) — 음성 capability 진단의 오케스트레이션 절반.
//
// 명령으로만 돈다. 활성화 시점에 돌리지 않는다: core patch 가 들어가면
// `getUserMedia` 가 OS 권한 프롬프트를 띄우고, 교실에서 아이가 묻지도 않은 프롬프트를
// 보는 것은 그 자체가 사고다.
//
// 이 파일은 vscode API 를 쓰므로 순수하지 않다. 판정 로직은
// `voiceCapabilityHelpers.ts` 에 있고 그쪽이 단위 테스트 대상이다(extension-dev.md
// 의 helpers/orchestration 분리).
import * as vscode from "vscode";
import {
  buildVoiceCapabilityReport,
  summarizeVoiceCapability,
  VoiceProbeMalformedError,
  type VoiceCapabilityReport,
  type VoiceProbeObservations,
} from "./voiceCapabilityHelpers";

/** 프로브를 실제로 수행할 수 있는 표면 — 웹뷰를 들고 있는 쪽이 구현한다. */
export interface VoiceProbeHost {
  /** 웹뷰에 프로브를 요청하고 원시 관측을 받는다. 웹뷰가 없으면 null. */
  probeVoiceCapability(timeoutMs: number): Promise<VoiceProbeObservations | null>;
}

const PROBE_TIMEOUT_MS = 15000;

/** 설치된 앱 버전 — 확장 버전과 **다르다**. 둘 다 보고서에 남긴다. */
function appVersion(): string | null {
  return typeof vscode.version === "string" ? vscode.version : null;
}

function extensionVersion(context: vscode.ExtensionContext): string | null {
  const v = (context.extension?.packageJSON as { version?: unknown } | undefined)?.version;
  return typeof v === "string" ? v : null;
}

/**
 * 진단을 돌리고 보고서를 남긴다.
 *
 * 보고서는 **로컬 전용**이다. 업로드 경로(`spoolUploader` ↔ worker 의
 * `ALLOWED_UPLOAD_FILENAMES`)는 세 파일로 닫힌 allowlist 이고, 여기에 음성 산출물을
 * 끼워 넣는 것은 미성년 보존 정책 결정 전에 할 수 없다(#901/V4).
 */
export async function diagnoseVoiceCapability(
  context: vscode.ExtensionContext,
  host: VoiceProbeHost | null,
  log: vscode.OutputChannel,
): Promise<VoiceCapabilityReport | null> {
  if (!host) {
    void vscode.window.showWarningMessage(
      "음성 진단은 채팅 패널이 열려 있어야 합니다. 패널을 열고 다시 실행해 주세요.",
    );
    return null;
  }

  let observations: VoiceProbeObservations | null = null;
  try {
    observations = await host.probeVoiceCapability(PROBE_TIMEOUT_MS);
  } catch (err) {
    log.appendLine(`[voice] 프로브 실행 실패: ${String(err).slice(0, 200)}`);
    void vscode.window.showErrorMessage("음성 진단을 실행하지 못했습니다. 출력 채널을 확인해 주세요.");
    return null;
  }
  if (!observations) {
    log.appendLine("[voice] 웹뷰가 관측을 돌려주지 않았다 — 측정 안 됨으로 남긴다");
    void vscode.window.showWarningMessage("음성 진단이 응답을 받지 못했습니다 (측정 안 됨).");
    return null;
  }

  let report: VoiceCapabilityReport;
  try {
    report = buildVoiceCapabilityReport(observations, {
      probedAt: new Date().toISOString(),
      appVersion: appVersion(),
      extensionVersion: extensionVersion(context),
      platform: `${process.platform}-${process.arch}`,
    });
  } catch (err) {
    // 모순된 관측은 분류하지 않는다. 분류하면 거짓 초록이 보고서 형식을 입고 나간다.
    const reason = err instanceof VoiceProbeMalformedError ? err.reason : String(err).slice(0, 200);
    log.appendLine(`[voice] 관측이 모양에 안 맞아 거부했다: ${reason}`);
    void vscode.window.showErrorMessage(`음성 진단 결과를 기록하지 않았습니다: ${reason}`);
    return null;
  }

  const body = JSON.stringify(report, null, 2);
  log.appendLine(`[voice] ${summarizeVoiceCapability(report)}`);
  for (const note of report.notes) log.appendLine(`[voice] ${note}`);
  log.appendLine(body);

  let saved: vscode.Uri | null = null;
  try {
    const dir = context.globalStorageUri;
    await vscode.workspace.fs.createDirectory(dir);
    saved = vscode.Uri.joinPath(dir, "voice-capability.json");
    await vscode.workspace.fs.writeFile(saved, Buffer.from(body, "utf8"));
  } catch (err) {
    // 저장 실패가 진단 실패는 아니다 — 판정은 이미 로그에 있다.
    log.appendLine(`[voice] 보고서 저장 실패(판정은 위에 있음): ${String(err).slice(0, 160)}`);
    saved = null;
  }

  const where = saved ? ` · ${saved.fsPath}` : "";
  void vscode.window.showInformationMessage(`음성 진단: ${summarizeVoiceCapability(report)}${where}`);
  return report;
}
