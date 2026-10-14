// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto has no synchronous digest for pure snapshot comparisons.
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2HistoricalMessage,
} from "@t3tools/contracts";
import { historyCost, renderHistory } from "./ContextHandoffBudget.ts";

type DeliveredSnapshot = NonNullable<
  NonNullable<OrchestrationV2ContextHandoff["delivery"]>["snapshots"]
>[number];
type SnapshotFreshness = Pick<DeliveredSnapshot, "sourceUpdatedAtMs" | "capturedAtMs">;
type PlanCoverage = SnapshotFreshness & {
  readonly contentHash: string | undefined;
  readonly order: number;
  readonly delivered: boolean;
};

export function isOlderPlanSnapshot(
  snapshot: SnapshotFreshness,
  previous: SnapshotFreshness | undefined,
): boolean {
  if (
    snapshot.sourceUpdatedAtMs !== undefined &&
    previous?.sourceUpdatedAtMs !== undefined &&
    snapshot.sourceUpdatedAtMs !== previous.sourceUpdatedAtMs
  )
    return snapshot.sourceUpdatedAtMs < previous.sourceUpdatedAtMs;
  return (
    snapshot.capturedAtMs !== undefined &&
    previous?.capturedAtMs !== undefined &&
    snapshot.capturedAtMs < previous.capturedAtMs
  );
}

export function planSnapshotCovered(
  snapshot: Pick<DeliveredSnapshot, "contentHash" | "sourceUpdatedAtMs" | "capturedAtMs">,
  previous:
    | (SnapshotFreshness & {
        readonly contentHash: string | undefined;
      })
    | undefined,
): boolean {
  return previous?.contentHash === snapshot.contentHash || isOlderPlanSnapshot(snapshot, previous);
}

export function historyItemKey(
  item: Pick<OrchestrationV2HistoricalMessage, "threadId" | "itemId">,
): string {
  return JSON.stringify([item.threadId, item.itemId]);
}

export function isPlanSnapshot(item: Pick<OrchestrationV2HistoricalMessage, "kind">): boolean {
  return item.kind === "todo_list" || item.kind === "proposed_plan";
}

export function deliverySnapshot(
  message: OrchestrationV2HistoricalMessage,
  order: number,
  delivered = true,
  capturedAtMs?: number,
): DeliveredSnapshot {
  return {
    threadId: message.threadId,
    itemId: message.itemId,
    kind: message.kind,
    ...(capturedAtMs === undefined ? {} : { capturedAtMs }),
    ...(message.sourceUpdatedAtMs === undefined
      ? {}
      : { sourceUpdatedAtMs: message.sourceUpdatedAtMs }),
    contentHash: NodeCrypto.createHash("sha256")
      .update(JSON.stringify([message.kind, message.status, message.text]))
      .digest("hex"),
    textBytes: Buffer.byteLength(renderHistory([message], "")),
    order,
    delivered,
  };
}

export function omittedPlanSnapshots(
  messages: ReadonlyArray<OrchestrationV2HistoricalMessage>,
  selected: ReadonlyArray<OrchestrationV2HistoricalMessage>,
) {
  const selectedKeys = new Set(selected.map(historyItemKey));
  return messages
    .filter((message) => isPlanSnapshot(message) && !selectedKeys.has(historyItemKey(message)))
    .map((message) => ({
      threadId: message.threadId,
      itemId: message.itemId,
      kind: message.kind,
      contentHash: deliverySnapshot(message, 0).contentHash,
      ...(message.sourceUpdatedAtMs === undefined
        ? {}
        : { sourceUpdatedAtMs: message.sourceUpdatedAtMs }),
    }));
}

export function contextHandoffDeliveryState(
  handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>,
) {
  const records = new Map(handoffs.map((handoff) => [handoff.id, handoff]));
  const deliveredKeys = new Set<string>();
  const knownItemIds = new Set<string>();
  const latestPlans = new Map<
    string,
    Pick<DeliveredSnapshot, "contentHash" | "order" | "sourceUpdatedAtMs" | "capturedAtMs">
  >();
  const coveredPlans = new Map<string, PlanCoverage>();
  const legacyHashes = new Map<string, Set<string>>();
  const legacyBytes = new Map<string, number>();
  const immutableBytes = new Map<string, number>();
  const planVersions = new Map<string, Map<number, number>>();
  const contextVersions = new Map<number, number>();
  let legacyContextBytes = 0;
  let maxOrder = 0;
  const cover = (key: string, coverage: PlanCoverage) => {
    const previous = coveredPlans.get(key);
    if (isOlderPlanSnapshot(coverage, previous)) return;
    if (
      previous === undefined ||
      isOlderPlanSnapshot(previous, coverage) ||
      coverage.order > previous.order ||
      (coverage.order === previous.order && (coverage.delivered || !previous.delivered))
    )
      coveredPlans.set(key, coverage);
  };
  for (const handoff of records.values()) {
    const receipt = handoff.delivery;
    if (receipt === undefined || receipt.status === "pending") continue;
    maxOrder = Math.max(maxOrder, receipt.order ?? 0);
    if (receipt.contexts === undefined) {
      legacyContextBytes += historyCost([], handoff.history?.coverage ?? handoff.summaryText);
    } else {
      for (const context of receipt.contexts) {
        maxOrder = Math.max(maxOrder, context.order);
        if (context.order === 0) {
          legacyContextBytes += context.bytes;
          continue;
        }
        contextVersions.set(
          context.order,
          Math.max(contextVersions.get(context.order) ?? 0, context.bytes),
        );
      }
    }
    const itemIds = new Set(receipt.itemIds);
    const snapshots =
      receipt.snapshots ??
      (handoff.history?.messages ?? [])
        .filter((message) => itemIds.has(message.itemId))
        .map((message) =>
          deliverySnapshot(message, 0, true, DateTime.toEpochMillis(handoff.createdAt)),
        );
    for (const snapshot of snapshots) {
      const key = historyItemKey(snapshot);
      maxOrder = Math.max(maxOrder, snapshot.order);
      if (isPlanSnapshot(snapshot))
        cover(key, {
          contentHash: snapshot.contentHash,
          order: snapshot.order,
          delivered: snapshot.delivered,
          ...(snapshot.capturedAtMs === undefined ? {} : { capturedAtMs: snapshot.capturedAtMs }),
          ...(snapshot.sourceUpdatedAtMs === undefined
            ? {}
            : { sourceUpdatedAtMs: snapshot.sourceUpdatedAtMs }),
        });
      if (!snapshot.delivered) continue;
      deliveredKeys.add(key);
      knownItemIds.add(snapshot.itemId);
      if (!isPlanSnapshot(snapshot)) {
        immutableBytes.set(key, Math.max(immutableBytes.get(key) ?? 0, snapshot.textBytes));
        continue;
      }
      if (snapshot.order === 0) {
        const hashes = legacyHashes.get(key) ?? new Set<string>();
        hashes.add(snapshot.contentHash);
        legacyHashes.set(key, hashes);
        legacyBytes.set(key, Math.max(legacyBytes.get(key) ?? 0, snapshot.textBytes));
      } else {
        const versions = planVersions.get(key) ?? new Map<number, number>();
        versions.set(
          snapshot.order,
          Math.max(versions.get(snapshot.order) ?? 0, snapshot.textBytes),
        );
        planVersions.set(key, versions);
        const latest = latestPlans.get(key);
        if (latest === undefined || snapshot.order > latest.order) latestPlans.set(key, snapshot);
      }
    }
    const omitted = new Set(receipt.snapshots === undefined ? receipt.omittedItemIds : []);
    for (const message of handoff.history?.messages ?? []) {
      if (isPlanSnapshot(message) && omitted.has(message.itemId))
        cover(historyItemKey(message), {
          contentHash: deliverySnapshot(message, 0).contentHash,
          order: receipt.order ?? 0,
          delivered: false,
        });
    }
  }
  for (const [key, hashes] of legacyHashes) {
    if (!latestPlans.has(key) && hashes.size === 1)
      latestPlans.set(key, {
        contentHash: [...hashes][0]!,
        order: 0,
      });
    if (hashes.size > 1 && coveredPlans.get(key)?.order === 0)
      coveredPlans.set(key, { contentHash: undefined, order: 0, delivered: true });
  }
  const occupiedBytes = new Map(immutableBytes);
  for (const key of new Set([...legacyBytes.keys(), ...planVersions.keys()]))
    occupiedBytes.set(
      key,
      (legacyBytes.get(key) ?? 0) +
        [...(planVersions.get(key)?.values() ?? [])].reduce((sum, bytes) => sum + bytes, 0),
    );
  const contextBytes =
    legacyContextBytes + [...contextVersions.values()].reduce((sum, bytes) => sum + bytes, 0);
  return {
    deliveredKeys,
    knownItemIds,
    latestPlans,
    coveredPlans,
    occupiedBytes,
    contextBytes,
    maxOrder,
  };
}
