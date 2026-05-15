import { ChatMessage } from "./protocol";

interface ProxyChatArgs {
  proxyUrl: string;
  model: string;
  token: string | undefined;
  history: ChatMessage[];
  userText: string;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
}

// Streaming OpenAI-compatible chat completion call against the HypeProof Proxy.
// Expects SSE-style `data: {json}\n\n` chunks.
export async function proxyChat(args: ProxyChatArgs): Promise<void> {
  const { proxyUrl, model, token, history, userText, signal, onDelta } = args;

  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ];

  const url = proxyUrl.replace(/\/$/, "") + "/chat/completions";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Proxy ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const j = JSON.parse(data);
        const delta = j?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length) onDelta(delta);
      } catch {
        // ignore malformed line
      }
    }
  }
}
