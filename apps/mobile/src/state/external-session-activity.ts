import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const refreshAgentSessionScan = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:refresh",
  tag: WS_METHODS.agentSessionsScan,
  concurrency: {
    mode: "singleFlight",
    key: (input) => String(input.environmentId),
  },
});

export const importAgentSession = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:import",
  tag: WS_METHODS.agentSessionsImport,
});
