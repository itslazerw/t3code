import { notificationChildThreadId } from "@t3tools/client-runtime/state/thread-execution";

import { formatDuration } from "../../session-logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

type Row = MessagesTimelineRow;
type EventRow = Extract<Row, { kind: "event" }>;

export function quietFoldId(firstRowId: string): string {
  return `quiet-fold:${firstRowId}`;
}

function isUserMessageRow(row: Row): boolean {
  return row.kind === "message" && row.message.role === "user";
}

/** A delegated task names its subagents; a child thread can carry several of them. */
function notificationSubagentKeys(row: Row): ReadonlyArray<string> {
  if (row.kind !== "work" || row.isExpandedToolGroup || row.groupedEntries.length !== 1) {
    return [];
  }
  const item = row.groupedEntries[0]?.projectedItem?.item;
  if (item?.type !== "notification") return [];
  if (item.source.kind === "delegated_task") {
    return item.source.taskIds.map((taskId) => `node:${taskId}`);
  }
  const child = notificationChildThreadId(item.source);
  return child === undefined ? [] : [`child:${child}`];
}

function singleSubagentEvent(row: Row): EventRow | null {
  return row.kind === "event" &&
    row.projectedItem.item.type === "subagent" &&
    (row.subagents?.length ?? 1) === 1
    ? row
    : null;
}

function subagentKeys(row: Row): ReadonlyArray<string> {
  if (row.kind !== "event") return notificationSubagentKeys(row);
  return (row.subagents ?? [row.projectedItem]).flatMap(({ item }) =>
    item.type !== "subagent"
      ? []
      : [`node:${item.subagentId}`, ...(item.childThreadId ? [`child:${item.childThreadId}`] : [])],
  );
}

/**
 * A subagent shows once per turn, in its latest place: an earlier row for the same
 * subagent is dropped. Subagent rows that end up side by side join into one group row.
 */
export function dedupeSubagentRows(rows: ReadonlyArray<Row>): Row[] {
  const kept: Row[] = [];
  let seen = new Set<string>();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (isUserMessageRow(row)) {
      seen = new Set();
      kept.push(row);
      continue;
    }
    const keys = subagentKeys(row);
    const single = singleSubagentEvent(row) !== null || notificationSubagentKeys(row).length === 1;
    if (single && keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    kept.push(row);
  }
  kept.reverse();

  const result: Row[] = [];
  for (const row of kept) {
    const previous = result.at(-1);
    if (
      row.kind === "event" &&
      row.projectedItem.item.type === "subagent" &&
      previous?.kind === "event" &&
      previous.projectedItem.item.type === "subagent"
    ) {
      result[result.length - 1] = {
        ...previous,
        subagents: [
          ...(previous.subagents ?? [previous.projectedItem]),
          ...(row.subagents ?? [row.projectedItem]),
        ],
      };
      continue;
    }
    result.push(row);
  }
  return result;
}

/** Routine bookkeeping: a finished turn's fold, or a background update that is not a subagent. */
export function isQuietTimelineRow(row: Row): boolean {
  if (row.kind === "turn-fold") return row.stopped !== true;
  if (row.kind !== "work" || row.isExpandedToolGroup || row.groupedEntries.length === 0) {
    return false;
  }
  return row.groupedEntries.every((entry) => {
    if (entry.itemType !== "notification") return false;
    const item = entry.projectedItem?.item;
    return item?.type !== "notification" || notificationChildThreadId(item.source) === undefined;
  });
}

function quietFoldLabel(group: ReadonlyArray<Row>): string {
  const workedMs = group.reduce(
    (total, row) => total + (row.kind === "turn-fold" ? (row.elapsedMs ?? 0) : 0),
    0,
  );
  if (workedMs > 0) return `Worked for ${formatDuration(workedMs)}`;
  if (group.some((row) => row.kind === "turn-fold")) return "Worked";
  return group.length === 1 ? "Background update" : `${group.length} background updates`;
}

/**
 * Routine rows in a row fold into one quiet line, so the answers stand out.
 * The fold opens on its own when a turn inside it was opened (find, a citation).
 */
export function foldQuietTimelineRows(
  rows: ReadonlyArray<Row>,
  expandedFoldIds: ReadonlySet<string>,
): Row[] {
  const result: Row[] = [];
  let group: Row[] = [];
  const flush = () => {
    const [first, last] = [group[0], group.at(-1)];
    if (!first || !last) return;
    // A lone finished turn is already one quiet line.
    if (group.length === 1 && first.kind === "turn-fold") {
      result.push(first);
    } else {
      const id = quietFoldId(first.id);
      const expanded =
        expandedFoldIds.has(id) || group.some((row) => row.kind === "turn-fold" && row.expanded);
      result.push({
        kind: "quiet-fold",
        id,
        createdAt: last.createdAt ?? first.createdAt ?? "",
        label: quietFoldLabel(group),
        expanded,
        runIds: group.flatMap((row) => (row.kind === "turn-fold" ? [row.runId] : [])),
      });
      if (expanded) result.push(...group);
    }
    group = [];
  };
  for (const row of rows) {
    if (isQuietTimelineRow(row)) {
      group.push(row);
      continue;
    }
    flush();
    result.push(row);
  }
  flush();
  return result;
}
