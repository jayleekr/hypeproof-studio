import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { LocalReviewService } from './localReviewService.ts';
import { MAX_TRANSCRIPT_BYTES, parseLocalTranscript } from './localTranscript.ts';
import type { LocalReviewRequest, LocalReviewState } from './localReviewProtocol.ts';

export function registerLocalReview(context: vscode.ExtensionContext, render: (webview: vscode.Webview, dist: vscode.Uri) => string) {
  const service = new LocalReviewService(join(context.globalStorageUri.fsPath, 'local-review-v1'));
  let panel: vscode.WebviewPanel | undefined;
  let selected: string | undefined;
  let busy = false;
  const refresh = async (extra: Partial<LocalReviewState> = {}) => {
    const tasks = (await service.record.records()).tasks;
    await panel?.webview.postMessage({ type: 'localReviewState', tasks, storage: service.store.root,
      ...(selected ? { card: await service.card(selected) } : {}), ...extra } satisfies LocalReviewState);
  };
  const handle = async (msg: LocalReviewRequest) => {
    if (!msg || msg.type !== 'localReview') return;
    if (busy) return;
    busy = true;
    try {
      if (msg.action === 'import') {
        if (!vscode.workspace.isTrusted) throw Error('Trust this workspace before importing a local transcript.');
        const project = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!project) throw Error('Open the task project folder before importing.');
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false, filters: { 'Task transcript': ['jsonl'] }, title: 'Select one task transcript from this project' });
        if (!picked?.[0]) { await refresh(); return; }
        const file = await fs.open(picked[0].fsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let raw: string;
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) throw Error('transcript_too_large');
          raw = await file.readFile('utf8');
        } finally { await file.close(); }
        const parsed = parseLocalTranscript(raw, msg.host);
        if (await fs.realpath(parsed.project) !== await fs.realpath(project)) throw Error('transcript_project_mismatch');
        const decision = await vscode.window.showInformationMessage(`Import ${parsed.batch.events.length} messages from this ${msg.host} task into private local storage? Known secret formats are removed. Tools and hidden reasoning are omitted.`, { modal: true }, 'Import task');
        if (decision !== 'Import task') { await refresh(); return; }
        selected = (await service.import(raw, msg.host, parsed.project)).task.id;
      } else if (msg.action === 'open') { await service.card(msg.task); selected = msg.task; }
      else if (msg.action !== 'load') {
        if (msg.task !== selected) throw Error('Select the task before editing it.');
        if (msg.action === 'purpose') await service.purpose(msg.task, msg.text);
        else if (msg.action === 'review') await service.review(msg.task, msg.capability, msg.decision, msg.text);
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
