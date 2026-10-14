// @effect-diagnostics nodeBuiltinImport:off - local HTTP protocol fixture.
import * as NodeHttp from "node:http";
import { expect, it } from "vite-plus/test";

import { formatLiveTokenRow, readCredentialMcpToolNames } from "./mcpContextMeasurement.ts";

it("labels Claude's tool and orchestration instruction comparison", () => {
  expect(
    formatLiveTokenRow(
      {
        provider: "claude",
        withT3CodeMcp: true,
        inputTokens: 100,
        model: "fixture",
        cliVersion: "1",
      },
      ["delegate_task", "t3_thread_read"],
    ),
  ).toEqual({
    kind: "live-first-turn-input-tokens",
    provider: "claude",
    withT3CodeMcp: true,
    inputTokens: 100,
    model: "fixture",
    cliVersion: "1",
    deltaScope: "mcp-tools-and-orchestration-instructions",
    credentialToolCount: 2,
    credentialToolNames: ["delegate_task", "t3_thread_read"],
  });
});

it("labels Codex's fixed developer instruction comparison without attributing tools to the control", () => {
  expect(
    formatLiveTokenRow(
      {
        provider: "codex",
        withT3CodeMcp: false,
        inputTokens: 90,
        model: "fixture",
        cliVersion: "2",
      },
      ["delegate_task", "t3_thread_read"],
    ),
  ).toEqual({
    kind: "live-first-turn-input-tokens",
    provider: "codex",
    withT3CodeMcp: false,
    inputTokens: 90,
    model: "fixture",
    cliVersion: "2",
    deltaScope: "mcp-tools-with-fixed-developer-instructions",
    credentialToolCount: 0,
    credentialToolNames: [],
  });
});

it("measures the authenticated, paginated tool list rather than all source toolkits", async () => {
  const server = NodeHttp.createServer((request, response) => {
    if (request.headers.authorization !== "Bearer fixture-credential") {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const message = JSON.parse(body) as {
        id?: number;
        method: string;
        params?: { cursor?: string };
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : message.params?.cursor === "second-page"
            ? { tools: [{ name: "delegate_task", inputSchema: { type: "object" } }] }
            : {
                tools: [{ name: "t3_thread_read", inputSchema: { type: "object" } }],
                nextCursor: "second-page",
              };
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP fixture");
    expect(
      await readCredentialMcpToolNames(
        `http://127.0.0.1:${address.port}/mcp`,
        "Bearer fixture-credential",
      ),
    ).toEqual(["delegate_task", "t3_thread_read"]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
