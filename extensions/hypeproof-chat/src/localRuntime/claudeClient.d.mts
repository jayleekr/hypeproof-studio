export function claudeStatus(executable?: string): {
  provider: "claude";
  model: string;
  label: string;
};
export function runClaude(args: {
  executable?: string;
  cwd: string;
  model?: string;
  messages: Array<{ role: string; content: string }>;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  toolServer: { url: string; token: string };
}): Promise<{ model: string; usage: unknown }>;
