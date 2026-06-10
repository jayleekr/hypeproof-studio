import * as vscode from "vscode";
import type { AssetScoreChunk, AssetScores } from "./protocol";
import {
  emptyAssetScores,
  formatAssetHistogramLines,
  formatAssetStatusText,
  formatAssetTooltip,
  mergeAssetScores,
} from "./assetStatus";

export interface AssetScoreSink {
  recordAssetScore(score: AssetScoreChunk): void;
  resetAssetScores(): void;
}

export class AssetStatusBar implements AssetScoreSink, vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private scores: AssetScores = emptyAssetScores();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "hypeproof-chat.showAssetHistogram";
    this.disposables.push(
      this.item,
      vscode.commands.registerCommand("hypeproof-chat.showAssetHistogram", () => this.showHistogram()),
    );
    this.refresh();
    this.item.show();
  }

  recordAssetScore(score: AssetScoreChunk): void {
    this.scores = mergeAssetScores(this.scores, score.scores);
    this.refresh();
  }

  resetAssetScores(): void {
    this.scores = emptyAssetScores();
    this.refresh();
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  private refresh(): void {
    this.item.text = formatAssetStatusText(this.scores);
    this.item.tooltip = formatAssetTooltip(this.scores);
  }

  private async showHistogram(): Promise<void> {
    await vscode.window.showQuickPick(formatAssetHistogramLines(this.scores), {
      title: "7 AI Native Assets",
      placeHolder: "최근 대화에서 누적된 자산 발현 정도",
    });
  }
}
