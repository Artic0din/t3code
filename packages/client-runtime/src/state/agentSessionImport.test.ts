import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type {
  EnvironmentRegistry as RegistryTypes,
  EnvironmentSupervisor as SupervisorTypes,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";

vi.mock("../../../../apps/web/src/connection/runtime", async () => {
  const rpc = { calls: 0, fail: false, release: () => {} };
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Latch = await import("effect/Latch");
  const Option = await import("effect/Option");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const { Atom } = await import("effect/reactivity");
  const { WS_METHODS } = await import("@t3tools/contracts");
  const { EnvironmentRegistry: RegistryModule, EnvironmentSupervisor: SupervisorModule } =
    await import("@t3tools/client-runtime/connection");
  const { EnvironmentRegistry } = RegistryModule;
  const { EnvironmentSupervisor } = SupervisorModule;
  const latch = Latch.makeUnsafe();
  rpc.release = () => latch.openUnsafe();
  const runtime = Atom.runtime(
    Layer.effect(
      EnvironmentRegistry,
      Effect.gen(function* () {
        const session = yield* SubscriptionRef.make(
          Option.some({
            client: {
              [WS_METHODS.agentSessionsImport]: () =>
                Effect.sync(() => rpc.calls++).pipe(
                  Effect.andThen(latch.await),
                  Effect.andThen(
                    Effect.suspend(() =>
                      rpc.fail
                        ? Effect.die(new Error("import failed"))
                        : Effect.succeed({ importedThreadCount: 1 }),
                    ),
                  ),
                ),
            },
          }),
        );
        return EnvironmentRegistry.of({
          run: (environmentId, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor, {
              target: { environmentId },
              session,
            } as unknown as SupervisorTypes.EnvironmentSupervisor["Service"]),
        } as RegistryTypes.EnvironmentRegistry["Service"]);
      }),
    ),
  );
  return { connectionAtomRuntime: runtime, testRpc: rpc };
});

vi.mock("../../../../apps/mobile/src/connection/runtime", async () =>
  vi.importMock("../../../../apps/web/src/connection/runtime"),
);

const { testRpc: rpc } = await vi.importMock<{
  testRpc: { calls: number; fail: boolean; release: () => void };
}>("../../../../apps/web/src/connection/runtime");

type ImportTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly projectId: ProjectId;
    readonly expectedWorkspaceRoot: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerSessionId: string;
  };
};

interface ImportCommand {
  readonly run: (
    registry: AtomRegistry.AtomRegistry,
    target: ImportTarget,
  ) => Promise<{ readonly _tag: "Success" | "Failure" }>;
}

const { agentSessionImport } = await vi.importActual<{ agentSessionImport: ImportCommand }>(
  "../../../../apps/web/src/state/agentSessions",
);
const { importAgentSession } = await vi.importActual<{ importAgentSession: ImportCommand }>(
  "../../../../apps/mobile/src/state/external-session-activity",
);

describe.each([
  ["web", agentSessionImport],
  ["mobile", importAgentSession],
] as const)("%s session imports", (_client, command) => {
  it("coalesces pending imports while keeping environment, instance, and session distinct", async () => {
    rpc.calls = 0;
    rpc.fail = false;
    const registry = AtomRegistry.make();
    const target = {
      environmentId: EnvironmentId.make("environment-a"),
      input: {
        projectId: ProjectId.make("project"),
        expectedWorkspaceRoot: "/workspace",
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: "session-a",
      },
    };
    try {
      const pending = [
        command.run(registry, target),
        command.run(registry, { ...target, input: { ...target.input } }),
        command.run(registry, { ...target, environmentId: EnvironmentId.make("environment-b") }),
        command.run(registry, {
          ...target,
          input: { ...target.input, providerInstanceId: ProviderInstanceId.make("codex-work") },
        }),
        command.run(registry, {
          ...target,
          input: { ...target.input, providerSessionId: "session-b" },
        }),
      ];
      rpc.release();
      const results = await Promise.all(pending);
      expect(results.every((result) => result._tag === "Success")).toBe(true);
      expect(rpc.calls).toBe(4);
      expect((await command.run(registry, target))._tag).toBe("Success");
      expect(rpc.calls).toBe(5);
      rpc.fail = true;
      expect((await command.run(registry, target))._tag).toBe("Failure");
      rpc.fail = false;
      expect((await command.run(registry, target))._tag).toBe("Success");
      expect(rpc.calls).toBe(7);
    } finally {
      registry.dispose();
    }
  });
});
