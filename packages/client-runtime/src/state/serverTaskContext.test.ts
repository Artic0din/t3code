import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  TaskContextGroupId,
  ThreadId,
  WS_METHODS,
  type ServerConfig,
  type TaskContextGroup,
  type TaskContextGroupMutateInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const environmentId = EnvironmentId.make("shared-context-environment");
const threadId = ThreadId.make("shared-context-thread");

const makeHarness = Effect.fn("TaskContextQueryTest.makeHarness")(function* (
  supportsChanges: boolean,
) {
  const config = {
    settings: DEFAULT_SERVER_SETTINGS,
    environment: {
      serverVersion: "0.0.1",
      capabilities: { taskContextGroups: true, taskContextGroupChanges: supportsChanges },
    },
  } as ServerConfig;
  const changes = yield* Queue.unbounded<number>();
  let group: TaskContextGroup | null = null;
  let subscriptions = 0;
  const client = {
    [WS_METHODS.subscribeServerConfig]: () =>
      Stream.make({ version: 1 as const, type: "snapshot" as const, config }),
    [WS_METHODS.taskContextGroupsForThread]: () =>
      Effect.sync(() => ({ group, relatedThreads: [] })),
    [WS_METHODS.taskContextGroupsSubscribe]: () => {
      subscriptions += 1;
      return Stream.concat(Stream.make(0), Stream.fromQueue(changes));
    },
    [WS_METHODS.taskContextGroupsMutate]: (input: TaskContextGroupMutateInput) =>
      Effect.sync(() => {
        group = {
          id: TaskContextGroupId.make("shared-context-group"),
          title: "Shared work",
          brief: input.action === "create" ? (input.brief ?? "") : "",
          resources: [],
          memberThreadIds: [threadId],
          createdAt: "2026-10-13T00:00:00.000Z",
          updatedAt: "2026-10-13T00:00:00.000Z",
        };
        return { group };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed(config),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Shared context",
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (_id, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
      Layer.mock(Persistence.EnvironmentCacheStore)({
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
      }),
    ),
  );
  const initial = Atom.make(config);
  const atoms = createServerEnvironmentAtoms(runtime, { initialConfigValueAtom: () => initial });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  const query = atoms.taskContextGroupForThread({ environmentId, input: { threadId } });
  const unmount = registry.mount(query);
  yield* Effect.addFinalizer(() => Effect.sync(unmount));
  const create = () =>
    Effect.promise(() =>
      atoms.mutateTaskContextGroup.run(registry, {
        environmentId,
        input: { action: "create", threadId, brief: "Created brief" },
      }),
    );
  const externalEdit = (brief: string) =>
    Effect.gen(function* () {
      if (group === null) return yield* Effect.die(new Error("Create a group before editing it."));
      group = { ...group, brief };
      yield* Queue.offer(changes, 1);
    });
  const waitForBrief = (brief: string | null) =>
    AtomRegistry.toStream(registry, query).pipe(
      Stream.filter(
        (result) =>
          AsyncResult.isSuccess(result) &&
          !result.waiting &&
          (result.value.group?.brief ?? null) === brief,
      ),
      Stream.runHead,
    );
  return {
    registry,
    query,
    create,
    externalEdit,
    waitForBrief,
    subscriptions: () => subscriptions,
  };
});

it.effect("refreshes a mounted empty query after creating a group on an older server", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness(false);
      yield* harness.waitForBrief(null);
      expect((yield* harness.create())._tag).toBe("Success");
      yield* harness.waitForBrief("Created brief");
      const result = harness.registry.get(harness.query);
      expect(AsyncResult.isSuccess(result) ? result.value.group?.brief : null).toBe(
        "Created brief",
      );
      expect(harness.subscriptions()).toBe(0);
    }),
  ),
);

it.effect("refreshes mounted context when another client edits the group", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness(true);
      yield* harness.waitForBrief(null);
      yield* harness.create();
      yield* harness.waitForBrief("Created brief");
      yield* harness.externalEdit("Another client's brief");
      yield* harness.waitForBrief("Another client's brief");
      const result = harness.registry.get(harness.query);
      expect(AsyncResult.isSuccess(result) ? result.value.group?.brief : null).toBe(
        "Another client's brief",
      );
      expect(harness.subscriptions()).toBe(1);
    }),
  ),
);
