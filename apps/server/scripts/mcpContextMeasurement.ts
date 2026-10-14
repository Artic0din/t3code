import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type MeasuredProvider = "claude" | "codex";

export type LiveTokenMeasurement = {
  readonly provider: MeasuredProvider;
  readonly withT3CodeMcp: boolean;
  readonly inputTokens: number;
  readonly model: string;
  readonly cliVersion: string;
};

export function formatLiveTokenRow(
  measurement: LiveTokenMeasurement,
  toolNames: ReadonlyArray<string>,
) {
  const credentialToolNames = measurement.withT3CodeMcp ? toolNames : [];
  return {
    kind: "live-first-turn-input-tokens",
    ...measurement,
    deltaScope:
      measurement.provider === "claude"
        ? "mcp-tools-and-orchestration-instructions"
        : "mcp-tools-with-fixed-developer-instructions",
    credentialToolCount: credentialToolNames.length,
    credentialToolNames,
  };
}

export async function readCredentialMcpToolNames(
  url: string,
  authorizationHeader: string,
): Promise<ReadonlyArray<string>> {
  const client = new Client({ name: "t3-mcp-context-measure", version: "1.0.0" });
  const transport: Omit<StreamableHTTPClientTransport, "sessionId"> =
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: authorizationHeader } },
    });
  try {
    await client.connect(transport);
    const names = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor });
      for (const tool of page.tools) names.add(tool.name);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return [...names].sort((left, right) => left.localeCompare(right));
  } finally {
    await client.close();
  }
}
