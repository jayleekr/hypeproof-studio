export function startToolServer(
  tools: Array<{ name: string; description: string; inputSchema: unknown }>,
  call: (name: string, args: unknown) => Promise<string>,
  signal?: AbortSignal,
): Promise<{ url: string; token: string; close(): void }>;
