import { homedir } from 'node:os';
import { recentLocalSessions } from './localSessionDiscovery.ts';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { LocalReviewService } from './localReviewService.ts';
import { parseLocalTranscriptFile } from './localTranscript.ts';
import type { LocalReviewRequest, LocalReviewState } from './localReviewProtocol.ts';

export function registerLocalReview(context: vscode.ExtensionContext, render: (webview: vscode.Webview, dist: vscode.Uri) => string) {
  const service = new LocalReviewService(join(context.globalStorageUri.fsPath, 'local-review-v1'));
  let panel: vscode.WebviewPanel | undefined;
  let selected: string | undefined;
  let busy = false;
  const refresh = async (extra: Partial<LocalReviewState> = {}) => {
    const { tasks, improvements } = await service.record.records();
    await panel?.webview.postMessage({ type: 'localReviewState', tasks, improvements, storage: service.store.root,
      ...(selected ? { card: await service.card(selected) } : {}), ...extra } satisfies LocalReviewState);
  };
  const handle = async (msg: LocalReviewRequest) => {
    if (!msg || msg.type !== 'localReview') return;
    if (busy) return;
    busy = true;
    try {
      if (msg.action === 'import' || msg.action === 'recent') {
        if (!vscode.workspace.isTrusted) throw Error('Trust this workspace before importing a local transcript.');
        const project = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!project) throw Error('Open the task project folder before importing.');
        let path: string | undefined;
        if (msg.action === 'recent') {
          const sessions = (await recentLocalSessions(homedir(), project)).filter(s => s.host === msg.host);
          const choice = await vscode.window.showQuickPick(sessions.map(s => ({ label: `${new Date(s.modified).toLocaleString()} · ${s.session}`, description: `${(s.bytes / 1048576).toFixed(1)} MiB`, detail: s.path, path: s.path })), { title: 'Recent sessions for this project', matchOnDetail: true, placeHolder: sessions.length ? 'Select a session snapshot to review locally' : 'No matching sessions found (Codex: last 7 days). Use Import to select a file.' });
          path = choice?.path;
        } else {
          const picked = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false, filters: { 'Task transcript': ['jsonl'] }, title: 'Select one task transcript from this project' });
          path = picked?.[0]?.fsPath;
        }
        if (!path) { await refresh(); return; }
        const parsed = await parseLocalTranscriptFile(path, msg.host);
        if (await fs.realpath(parsed.project) !== await fs.realpath(project)) throw Error('transcript_project_mismatch');
        const decision = await vscode.window.showInformationMessage(`Import ${parsed.batch.events.length} messages from this ${msg.host} task into private local storage? Known secret formats are removed. Tools and hidden reasoning are omitted.`, { modal: true }, 'Import task');
        if (decision !== 'Import task') { await refresh(); return; }
        selected = (await service.importParsed(parsed, parsed.project)).task.id;
      } else if (msg.action === 'open') { await service.card(msg.task); selected = msg.task; }
      else if (msg.action !== 'load') {
        if (msg.task !== selected) throw Error('Select the task before editing it.');
        if (msg.action === 'purpose') await service.purpose(msg.task, msg.text);
        else if (msg.action === 'review') await service.review(msg.task, msg.capability, msg.decision, msg.text, msg.evidence);
        else if (msg.action === 'improvement') await service.improvement(msg.task, msg.text);
        else if (msg.action === 'followUp') await service.followUp(msg.task, msg.improvement, msg.attempt, msg.observed);
        else if (msg.action === 'preview') { await refresh({ preview: await service.preview(msg.task, msg.includeEvidence) }); return; }
        else if (msg.action === 'submit') { await service.submit(msg.task, msg.digest); await refresh({ notice: 'Accepted in the local inbox. Receipt and stored bundle match.' }); return; }
        else if (msg.action === 'delete') {
          const answer = await vscode.window.showWarningMessage('Delete this local task, evidence, reviews and receipts? The host transcript and separately exported copies remain.', { modal: true }, 'Delete local task');
          if (answer === 'Delete local task') { await service.delete(msg.task); selected = undefined; }
        }
      }
      await refresh();
    } catch (e) {
      // Do not hide a damaged receipt behind stale success UI.
      await panel?.webview.postMessage({ type: 'localReviewState', tasks: [], storage: service.store.root, error: e instanceof Error ? e.message : 'Local storage failed. No receipt was confirmed.' } satisfies LocalReviewState);
    } finally { busy = false; }
  };
  context.subscriptions.push(vscode.commands.registerCommand('hypeproof-chat.localReview', () => {
    if (panel) { panel.reveal(); void handle({ type: 'localReview', action: 'load' }); return; }
    const dist = vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'dist');
    panel = vscode.window.createWebviewPanel('hypeproof.localReview', 'My task reviews', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist] });
    panel.webview.html = render(panel.webview, dist).replace(/<html\b/, '<html data-surface="local-review"');
    panel.webview.onDidReceiveMessage(handle, undefined, context.subscriptions);
    panel.onDidDispose(() => { panel = undefined; selected = undefined; });
    context.subscriptions.push(panel);
  }));
}
