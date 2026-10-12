import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { DeviceToolkit } from "./toolkits/device/tools.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { HtmlToolkit } from "./toolkits/html/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "../provider/T3OrchestrationInstructions.ts";

/** Toolkits registered for every credential session on `McpHttpServer.layer`. */
export const T3_CODE_CREDENTIAL_SESSION_TOOLKITS = [
  OrchestratorToolkit,
  PreviewToolkit,
  WorktreeToolkit,
  ThreadToolkit,
  AttachmentToolkit,
  ProjectToolkit,
  EnvironmentToolkit,
  PreviewControlsToolkit,
  DeviceToolkit,
  PullRequestsToolkit,
  HtmlToolkit,
] as const;

export type T3CodeMcpContextBaseline = {
  readonly toolCount: number;
  readonly toolNames: ReadonlyArray<string>;
  readonly orchestrationInstructionsBytes: number;
  readonly orchestrationInstructionsTrimmedBytes: number;
};

export function listT3CodeCredentialSessionToolNames(): string[] {
  const names = new Set<string>();
  for (const toolkit of T3_CODE_CREDENTIAL_SESSION_TOOLKITS) {
    for (const tool of Object.values(toolkit.tools)) {
      names.add(tool.name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function measureT3CodeMcpContextBaseline(): T3CodeMcpContextBaseline {
  const toolNames = listT3CodeCredentialSessionToolNames();
  return {
    toolCount: toolNames.length,
    toolNames,
    orchestrationInstructionsBytes: Buffer.byteLength(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "utf8"),
    orchestrationInstructionsTrimmedBytes: Buffer.byteLength(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
      "utf8",
    ),
  };
}
