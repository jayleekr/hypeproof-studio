import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// Per-turn, authenticated loopback MCP transport. It owns no filesystem policy;
// both providers call the same Studio host tool handler.
export async function startToolServer(tools, call, signal) {
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    const reply = (status, value) => {
      if (!res.destroyed) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(value === undefined ? "" : JSON.stringify(value));
      }
    };
    if (req.headers.authorization !== "Bearer " + token) {
      reply(401);
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      reply(405);
      return;
    }
    let size = 0,
      body = "";
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_000_000) {
          reply(413);
          return;
        }
        body += chunk;
      }
      const m = JSON.parse(body);
      if (m.id === undefined) {
        reply(202);
        return;
      }
      let result;
      if (m.method === "initialize")
        result = {
          protocolVersion: m.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "studio-local-tools", version: "1.0.0" },
        };
      else if (m.method === "ping") result = {};
      else if (m.method === "tools/list") result = { tools };
      else if (m.method === "tools/call") {
        if (signal?.aborted) throw Error("요청이 중지되었습니다.");
        try {
          result = {
            content: [
              {
                type: "text",
                text: await call(m.params.name, m.params.arguments),
              },
            ],
          };
        } catch (e) {
          result = {
            isError: true,
            content: [{ type: "text", text: e.message }],
          };
        }
      } else {
        reply(200, {
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32601, message: "Unsupported method" },
        });
        return;
      }
      reply(200, { jsonrpc: "2.0", id: m.id, result });
    } catch {
      reply(400);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: "http://127.0.0.1:" + server.address().port + "/mcp",
    token,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
