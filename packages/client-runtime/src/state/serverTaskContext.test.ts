import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  TaskContextGroupId,
  TaskContextResourceId,
  ThreadId,
  WS_METHODS,
  type ServerConfig,
  type TaskContextGroup,
  type TaskContextGroupMutateInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
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
  beforeMutate: (input: TaskContextGroupMutateInput) => Effect.Effect<void> = () => Effect.void,
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
      Effect.gen(function* () {
        yield* beforeMutate(input);
        if (input.action === "create")
          group = {
            id: TaskContextGroupId.make("shared-context-group"),
            title: "Shared work",
            brief: input.brief ?? "",
            resources: [],
            memberThreadIds: [threadId],
            createdAt: "2026-10-13T00:00:00.000Z",
            updatedAt: "2026-10-13T00:00:00.000Z",
          };
        if (group === null)
          return yield* Effect.die(new Error("Create a group before mutating it."));
        if (input.action === "attach-resource") {
          const resource = input.resource;
          if (resource.kind !== "note")
            return yield* Effect.die(new Error("This fixture attaches notes."));
          group = {
            ...group,
            resources: [
              ...group.resources,
              {
                ...resource,
                resourceId: TaskContextResourceId.make(`resource:${resource.title}`),
              },
            ],
          };
        }
        if (input.action === "detach-resource") {
          group = {
            ...group,
            resources: group.resources.filter(
              (resource) => resource.resourceId !== input.resourceId,
            ),
          };
        }
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
    mutate: (input: TaskContextGroupMutateInput) =>
      atoms.mutateTaskContextGroup.run(registry, { environmentId, input }),
    group: () => group,
    subscriptions: () => subscriptions,
  };
});

it.effect(
  "persists both distinct attachments and removals requested while another mutation is pending",
  () =>
    Effect.gen(function* () {
      const attachmentGate = yield* Deferred.make<void>();
      const removalGate = yield* Deferred.make<void>();
      const entered = yield* Queue.unbounded<string>();
      const harness = yield* makeHarness(false, (input) =>
        input.action === "attach-resource" || input.action === "detach-resource"
          ? Queue.offer(entered, input.action).pipe(
              Effect.andThen(
                Deferred.await(input.action === "attach-resource" ? attachmentGate : removalGate),
              ),
            )
          : Effect.void,
      );
      yield* harness.create();
      const groupId = TaskContextGroupId.make("shared-context-group");
      const firstAttachment = harness.mutate({
        action: "attach-resource",
        groupId,
        resource: { kind: "note", title: "First", body: "First decision" },
      });
      expect(yield* Queue.take(entered)).toBe("attach-resource");
      const secondAttachment = harness.mutate({
        action: "attach-resource",
        groupId,
        resource: { kind: "note", title: "Second", body: "Second decision" },
      });
      yield* Deferred.succeed(attachmentGate, undefined);
      const attachments = yield* Effect.promise(() =>
        Promise.all([firstAttachment, secondAttachment]),
      );
      expect(attachments.map((result) => result._tag)).toEqual(["Success", "Success"]);
      expect(harness.group()?.resources).toEqual([
        { kind: "note", title: "First", body: "First decision", resourceId: "resource:First" },
        { kind: "note", title: "Second", body: "Second decision", resourceId: "resource:Second" },
      ]);
      expect(yield* Queue.take(entered)).toBe("attach-resource");
      const firstRemoval = harness.mutate({
        action: "detach-resource",
        groupId,
        resourceId: TaskContextResourceId.make("resource:First"),
      });
      expect(yield* Queue.take(entered)).toBe("detach-resource");
      const secondRemoval = harness.mutate({
        action: "detach-resource",
        groupId,
        resourceId: TaskContextResourceId.make("resource:Second"),
      });
      yield* Deferred.succeed(removalGate, undefined);
      const removals = yield* Effect.promise(() => Promise.all([firstRemoval, secondRemoval]));
      expect(removals.map((result) => result._tag)).toEqual(["Success", "Success"]);
      expect(harness.group()?.resources).toEqual([]);
    }).pipe(Effect.scoped),
);

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
