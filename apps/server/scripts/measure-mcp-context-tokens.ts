// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import * as Orchestrator from "../src/orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as DeviceService from "../src/device/DeviceService.ts";
import * as ServerConfig from "../src/config.ts";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter } from "effect/http";

import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../src/git/GitWorkflowService.ts";
import * as ProviderAdapterRegistry from "../src/orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../src/orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../src/project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../src/project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../src/provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../src/scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../src/secrets/SecretRequests.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import * as VcsStatusBroadcaster from "../src/vcs/VcsStatusBroadcaster.ts";
import * as McpHttpServer from "../src/mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../src/mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../src/mcp/PreviewAutomationBroker.ts";
import * as PreviewBrowser from "../src/preview/PreviewBrowser.ts";
import { measureT3CodeMcpContextBaseline } from "../src/mcp/mcpContextBaseline.ts";
import {
  buildCodexAdditionalContext,
  buildCodexDeveloperInstructions,
} from "../src/provider/CodexDeveloperInstructions.ts";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "../src/provider/T3OrchestrationInstructions.ts";

const TRIVIAL_PROMPT = "Reply with exactly: ok";
const CODEX_MEASURE_MODEL = process.env.T3_MCP_MEASURE_CODEX_MODEL?.trim() || "gpt-5.4";

type LiveTokenRow = {
  readonly provider: "claude" | "codex";
  readonly withT3CodeMcp: boolean;
  readonly inputTokens: number;
  readonly model: string;
  readonly cliVersion: string;
};

type McpEndpoint = {
  readonly url: string;
  readonly authorizationHeader: string;
};

const layerStubServices = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
);

function hasAnthropicApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

function ambientCodexHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return NodePath.join(NodeOS.homedir(), ".codex");
}

function hasCodexCredentials(): boolean {
  if (process.env.OPENAI_API_KEY?.trim()) {
    return true;
  }
  const authPath = NodePath.join(ambientCodexHome(), "auth.json");
  try {
    const raw = NodeFS.readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw) as {
      tokens?: unknown;
      OPENAI_API_KEY?: unknown;
      auth_mode?: unknown;
    };
    if (parsed.tokens != null && typeof parsed.tokens === "object") {
      return true;
    }
    if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim() !== "") {
      return true;
    }
    return parsed.auth_mode === "apikey";
  } catch {
    return false;
  }
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const reservation = NodeHttp.createServer();
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      if (address === null || typeof address === "string") {
        reservation.close();
        reject(new Error("Failed to reserve a loopback port"));
        return;
      }
      const { port } = address;
      reservation.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string } = {},
): Promise<{ readonly stdout: string; readonly stderr: string; readonly status: number | null }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      env: options.env ?? process.env,
      cwd: options.cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ stdout, stderr, status });
    });
  });
}

type ClaudeStreamEvent = {
  readonly type?: string;
  readonly subtype?: string;
  readonly mcp_servers?: ReadonlyArray<{ readonly name?: string; readonly status?: string }>;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
    readonly cache_read_input_tokens?: number;
  };
  readonly modelUsage?: Record<string, unknown>;
  readonly is_error?: boolean;
  readonly result?: string;
};

async function readCliVersion(command: string): Promise<string> {
  const result = await runCommand(command, ["--version"]);
  const version = result.stdout.trim();
  if (result.status !== 0 || version === "") {
    throw new Error(`${command} --version failed: ${result.stderr.trim() || result.status}`);
  }
  return version;
}

// Claude completes the turn even when an MCP server fails to load, so the
// with-MCP row is only valid if the init event reports t3-code as connected.
function parseClaudeStreamJson(
  stdout: string,
  requireT3CodeMcp: boolean,
): { inputTokens: number; model: string } {
  let init: ClaudeStreamEvent | undefined;
  let result: ClaudeStreamEvent | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: ClaudeStreamEvent;
    try {
      event = JSON.parse(trimmed) as ClaudeStreamEvent;
    } catch {
      continue;
    }
    if (event.type === "system" && event.subtype === "init") init = event;
    if (event.type === "result") result = event;
  }
  if (requireT3CodeMcp) {
    const t3Code = init?.mcp_servers?.find((server) => server.name === "t3-code");
    if (t3Code?.status !== "connected") {
      throw new Error(
        `Claude did not connect to the t3-code MCP server (status: ${t3Code?.status ?? "missing"})`,
      );
    }
  }
  if (result === undefined) {
    throw new Error("Claude stream-json output did not include a result event");
  }
  return parseClaudeInputTokens(result);
}

function parseClaudeInputTokens(payload: ClaudeStreamEvent): {
  inputTokens: number;
  model: string;
} {
  if (payload.is_error) {
    throw new Error(payload.result ?? "Claude turn failed");
  }
  const usage = payload.usage;
  if (!usage || typeof usage.input_tokens !== "number") {
    throw new Error("Claude JSON output did not include usage.input_tokens");
  }
  const inputTokens =
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  const model = Object.keys(payload.modelUsage ?? {})[0] ?? "unknown";
  return { inputTokens, model };
}

function parseCodexInputTokens(
  stdout: string,
  pinnedModel: string,
): { inputTokens: number; model: string } {
  let inputTokens: number | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const usage = event.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage.input_tokens === "number") {
      inputTokens = usage.input_tokens;
    }
    const tokenUsage = event.token_usage as Record<string, unknown> | undefined;
    if (tokenUsage && typeof tokenUsage.input_tokens === "number") {
      inputTokens = tokenUsage.input_tokens;
    }
    const info = event.info as Record<string, unknown> | undefined;
    const infoUsage = info?.usage as Record<string, unknown> | undefined;
    if (infoUsage && typeof infoUsage.input_tokens === "number") {
      inputTokens = infoUsage.input_tokens;
    }
  }
  if (inputTokens === undefined) {
    throw new Error("Codex JSONL output did not include input_tokens");
  }
  return { inputTokens, model: pinnedModel };
}

function buildCodexMeasureDeveloperInstructions(model: string): string {
  const collaboration = buildCodexDeveloperInstructions("default");
  const additional = buildCodexAdditionalContext(
    { model, reasoningEffort: "medium" },
    { browser: true, device: false },
  );
  const additionalBlocks = Object.entries(additional).map(
    ([key, entry]) => `<${key}>\n${entry.value}\n</${key}>`,
  );
  return [collaboration, ...additionalBlocks].join("\n\n");
}

async function withEphemeralMcpServer<A>(use: (mcp: McpEndpoint) => Promise<A>): Promise<A> {
  const port = await reserveLoopbackPort();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const layerRoutes = McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer));
        yield* HttpRouter.serve(layerRoutes, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed("environment-mcp-measure" as never),
            }),
          ),
          Layer.provide(PreviewAutomationBroker.layer),
          Layer.provide(PreviewBrowser.layer),
          Layer.provide(layerStubServices),
          Layer.provide(
            NodeHttpServer.layer(NodeHttp.createServer, {
              host: "127.0.0.1",
              port,
              disablePreemptiveShutdown: true,
            }),
          ),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-measure-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeServices.layer),
          Layer.build,
        );

        const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
          threadId: ThreadId.make(`thread-mcp-measure-${NodeCrypto.randomUUID()}`),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        });
        if (credential === undefined) {
          return yield* Effect.die("Failed to issue MCP credential");
        }

        const mcp: McpEndpoint = {
          url: `http://127.0.0.1:${port}/mcp`,
          authorizationHeader: credential.config.authorizationHeader,
        };
        return yield* Effect.promise(() => use(mcp));
      }),
    ),
  );
}

async function measureClaude(
  withT3CodeMcp: boolean,
  cliVersion: string,
  mcp?: McpEndpoint,
): Promise<LiveTokenRow> {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-measure-claude-"));
  try {
    // Isolate via CLAUDE_CONFIG_DIR + --strict-mcp-config instead of --bare so
    // the built-in claude_code tool surface matches production.
    const configDir = NodePath.join(tempDir, "claude-config");
    NodeFS.mkdirSync(configDir, { recursive: true });
    const mcpConfigPath = NodePath.join(tempDir, "mcp.json");
    NodeFS.writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers:
          withT3CodeMcp && mcp !== undefined
            ? {
                "t3-code": {
                  type: "http",
                  url: mcp.url,
                  headers: {
                    Authorization: mcp.authorizationHeader,
                  },
                },
              }
            : {},
      }),
    );
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--mcp-config",
      mcpConfigPath,
      "--strict-mcp-config",
      TRIVIAL_PROMPT,
    ];
    if (withT3CodeMcp) {
      if (mcp === undefined) {
        throw new Error("Claude with-MCP measurement requires an MCP endpoint");
      }
      args.push("--append-system-prompt", T3_CODE_ORCHESTRATION_INSTRUCTIONS);
    }
    const result = await runCommand("claude", args, {
      cwd: tempDir,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
      },
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || `claude exited ${result.status}`);
    }
    const parsed = parseClaudeStreamJson(result.stdout, withT3CodeMcp);
    return {
      provider: "claude",
      withT3CodeMcp,
      inputTokens: parsed.inputTokens,
      model: parsed.model,
      cliVersion,
    };
  } finally {
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }
}

function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/Authorization["']?\s*[:=]\s*["'][^"']+["']/giu, 'Authorization:"[redacted]"');
}

async function measureCodex(
  withT3CodeMcp: boolean,
  cliVersion: string,
  mcp?: McpEndpoint,
): Promise<LiveTokenRow> {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-measure-codex-"));
  try {
    const args = [
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--model",
      CODEX_MEASURE_MODEL,
      TRIVIAL_PROMPT,
    ];
    // Both sides use an isolated CODEX_HOME so the user's global MCP servers
    // and developer instructions do not contaminate the delta. Seed auth from
    // the ambient CODEX_HOME (or ~/.codex) captured before isolation.
    const sourceAuthPath = NodePath.join(ambientCodexHome(), "auth.json");
    const isolatedHome = NodePath.join(tempDir, "codex-home");
    NodeFS.mkdirSync(isolatedHome, { recursive: true });
    NodeFS.symlinkSync(sourceAuthPath, NodePath.join(isolatedHome, "auth.json"));
    // Same developer_instructions on both sides so the live delta isolates MCP
    // tool schemas. CLI config cannot replace Codex's built-in collaboration
    // prompt the way the app-server path does; absolute totals are still not
    // production-identical.
    const configLines: string[] = [
      `developer_instructions = ${JSON.stringify(buildCodexMeasureDeveloperInstructions(CODEX_MEASURE_MODEL))}`,
      "",
    ];
    if (withT3CodeMcp) {
      if (mcp === undefined) {
        throw new Error("Codex with-MCP measurement requires an MCP endpoint");
      }
      const authorization = mcp.authorizationHeader.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      configLines.push(
        "[mcp_servers.t3-code]",
        `url = ${JSON.stringify(mcp.url)}`,
        "required = true",
        "",
        "[mcp_servers.t3-code.http_headers]",
        `Authorization = "${authorization}"`,
        "",
      );
    }
    NodeFS.writeFileSync(NodePath.join(isolatedHome, "config.toml"), configLines.join("\n"));
    const result = await runCommand("codex", args, {
      cwd: tempDir,
      env: { ...process.env, CODEX_HOME: isolatedHome },
    });
    if (result.status !== 0) {
      throw new Error(redactSecrets(result.stderr || `codex exited ${result.status}`));
    }
    try {
      const parsed = parseCodexInputTokens(result.stdout, CODEX_MEASURE_MODEL);
      return {
        provider: "codex",
        withT3CodeMcp,
        inputTokens: parsed.inputTokens,
        model: parsed.model,
        cliVersion,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        redactSecrets(
          `${detail}\nstderr: ${result.stderr}\nstdout: ${result.stdout.slice(0, 2000)}`,
        ),
        { cause: error },
      );
    }
  } finally {
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }
}

const baseline = measureT3CodeMcpContextBaseline();
console.log(
  JSON.stringify({
    kind: "static-baseline",
    toolCount: baseline.toolCount,
    orchestrationInstructionsBytes: baseline.orchestrationInstructionsBytes,
    orchestrationInstructionsTrimmedBytes: baseline.orchestrationInstructionsTrimmedBytes,
  }),
);

const wantClaude = hasAnthropicApiKey();
const wantCodex = hasCodexCredentials();

if (!wantClaude && !wantCodex) {
  console.error(
    [
      "Live token measurement skipped: missing provider credentials.",
      "Set ANTHROPIC_API_KEY for Claude, and/or ensure Codex credentials via $CODEX_HOME/auth.json (or ~/.codex/auth.json) or OPENAI_API_KEY.",
      "Refusing to invent live token numbers.",
    ].join("\n"),
  );
  process.exit(2);
}

const rows: LiveTokenRow[] = [];
const claudeVersion = wantClaude ? await readCliVersion("claude") : undefined;
const codexVersion = wantCodex ? await readCliVersion("codex") : undefined;

try {
  await withEphemeralMcpServer(async (mcp) => {
    if (wantClaude) {
      if (claudeVersion === undefined) {
        throw new Error("Claude version missing after readCliVersion");
      }
      rows.push(await measureClaude(false, claudeVersion));
      console.log(JSON.stringify({ kind: "live-first-turn-input-tokens", ...rows.at(-1)! }));
      rows.push(await measureClaude(true, claudeVersion, mcp));
      console.log(JSON.stringify({ kind: "live-first-turn-input-tokens", ...rows.at(-1)! }));
    } else {
      console.error("Claude live measurement skipped: ANTHROPIC_API_KEY is not set.");
    }
    if (wantCodex) {
      if (codexVersion === undefined) {
        throw new Error("Codex version missing after readCliVersion");
      }
      rows.push(await measureCodex(false, codexVersion));
      console.log(JSON.stringify({ kind: "live-first-turn-input-tokens", ...rows.at(-1)! }));
      rows.push(await measureCodex(true, codexVersion, mcp));
      console.log(JSON.stringify({ kind: "live-first-turn-input-tokens", ...rows.at(-1)! }));
    } else {
      console.error(
        "Codex live measurement skipped: no ChatGPT tokens, auth_mode=apikey, or OPENAI_API_KEY.",
      );
    }
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Live token measurement failed:\n${redactSecrets(message)}`);
  console.error("Refusing to invent live token numbers.");
  process.exit(2);
}

if (rows.length === 0) {
  console.error("No live token rows were recorded.");
  process.exit(2);
}
