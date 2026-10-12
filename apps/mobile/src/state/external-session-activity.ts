import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import {
  parseExternalSessionActivityEnabled,
  serializeExternalSessionActivityEnabled,
} from "@t3tools/shared/externalSessionActivity";

import { connectionAtomRuntime } from "../connection/runtime";

let stored: string | null = null;

export function readExternalSessionActivityEnabled(): boolean {
  return parseExternalSessionActivityEnabled(stored);
}

export function writeExternalSessionActivityEnabled(enabled: boolean): void {
  stored = serializeExternalSessionActivityEnabled(enabled);
}

export const refreshAgentSessionScan = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:refresh",
  tag: WS_METHODS.agentSessionsScan,
});

export const importAgentSession = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:import",
  tag: WS_METHODS.agentSessionsImport,
});
