export class CodexLocalClient {
  constructor(options?: { executable?: string });
  connect(): Promise<{
    auth: string;
    models: Array<{ id: string; label: string }>;
    external_tools: number;
  }>;
  complete(args: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
    maxOutputBytes?: number;
    tools?: Array<{ name: string; description: string; inputSchema: unknown }>;
    onToolCall?: (name: string, args: unknown) => Promise<string>;
  }): Promise<{ text: string; model: string; usage: unknown; auth: string }>;
  close(): void;
}
