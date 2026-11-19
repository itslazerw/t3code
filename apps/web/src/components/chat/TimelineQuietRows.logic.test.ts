import { describe, expect, it } from "vite-plus/test";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  dedupeSubagentRows,
  foldQuietTimelineRows,
  isQuietTimelineRow,
  quietFoldId,
} from "./TimelineQuietRows.logic";

type Row = MessagesTimelineRow;
const at = "2026-11-18T20:00:00.000Z";

function message(id: string, role: "user" | "assistant"): Row {
  return {
    kind: "message",
    id,
    createdAt: at,
    message: { id, role, text: id },
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  } as unknown as Row;
}

function turnFold(id: string, elapsedMs: number, extra: Partial<Row> = {}): Row {
  return {
    kind: "turn-fold",
    id,
    createdAt: at,
    runId: `run-${id}`,
    label: `Worked for ${elapsedMs / 1000}s`,
    expanded: false,
    elapsedMs,
    ...extra,
  } as Row;
}

function notification(id: string, source: Record<string, unknown> = { kind: "command" }): Row {
  const item = { type: "notification", source };
  return {
    kind: "work",
    id,
    createdAt: at,
    isExpandedToolGroup: false,
    groupedEntries: [{ id, itemType: "notification", projectedItem: { item } }],
  } as unknown as Row;
}

function subagentEvent(id: string, childThreadId: string): Row {
  return {
    kind: "event",
    id,
    createdAt: at,
    projectedItem: { item: { type: "subagent", subagentId: id, childThreadId } },
  } as unknown as Row;
}

const ids = (rows: ReadonlyArray<Row>) => rows.map((row) => row.id);

describe("foldQuietTimelineRows", () => {
  it("folds routine rows between answers into one line with the total time", () => {
    const rows = [
      message("ask", "user"),
      notification("bg-1"),
      notification("restart", { kind: "system" }),
      turnFold("fold-1", 21_000),
      message("waiting", "assistant"),
      notification("bg-2"),
      turnFold("fold-2", 60_000),
      turnFold("fold-3", 21_000),
      message("answer", "assistant"),
    ];
    const folded = foldQuietTimelineRows(rows, new Set());
    expect(ids(folded)).toEqual([
      "ask",
      quietFoldId("bg-1"),
      "waiting",
      quietFoldId("bg-2"),
      "answer",
    ]);
    expect(folded[1]).toMatchObject({ kind: "quiet-fold", label: "Worked for 21s" });
    expect(folded[3]).toMatchObject({ kind: "quiet-fold", label: "Worked for 1m 21s" });
  });

  it("never hides what the assistant wrote", () => {
    const rows = [notification("a"), message("text", "assistant"), turnFold("fold", 9_000)];
    const folded = foldQuietTimelineRows(rows, new Set());
    expect(ids(folded)).toEqual([quietFoldId("a"), "text", "fold"]);
    expect(folded[0]).toMatchObject({ label: "Background update" });
  });

  it("shows the folded rows unchanged once opened", () => {
    const rows = [notification("a"), turnFold("fold", 5_000)];
    const folded = foldQuietTimelineRows(rows, new Set([quietFoldId("a")]));
    expect(ids(folded)).toEqual([quietFoldId("a"), "a", "fold"]);
    expect(folded[0]).toMatchObject({ expanded: true, runIds: ["run-fold"] });
  });

  it("opens by itself when a turn inside was opened", () => {
    const rows = [notification("a"), turnFold("fold", 5_000, { expanded: true })];
    expect(ids(foldQuietTimelineRows(rows, new Set()))).toEqual([quietFoldId("a"), "a", "fold"]);
  });

  it("counts updates when no turn time is known", () => {
    const folded = foldQuietTimelineRows([notification("a"), notification("b")], new Set());
    expect(folded).toMatchObject([{ kind: "quiet-fold", label: "2 background updates" }]);
  });

  it("keeps a stopped turn and subagent updates in view", () => {
    expect(isQuietTimelineRow(turnFold("stopped", 1_000, { stopped: true } as Partial<Row>))).toBe(
      false,
    );
    expect(
      isQuietTimelineRow(notification("child", { kind: "subagent", childThreadId: "t" })),
    ).toBe(false);
    expect(isQuietTimelineRow(message("text", "assistant"))).toBe(false);
  });
});

describe("dedupeSubagentRows", () => {
  it("keeps only a subagent's latest row in a turn", () => {
    const rows = [
      message("ask", "user"),
      notification("old", { kind: "subagent", childThreadId: "child-a" }),
      message("waiting", "assistant"),
      subagentEvent("latest", "child-a"),
    ];
    expect(ids(dedupeSubagentRows(rows))).toEqual(["ask", "waiting", "latest"]);
  });

  it("keeps different tasks that share one child thread", () => {
    const delegated = (id: string) =>
      notification(id, { kind: "delegated_task", childThreadId: "shared", taskIds: [id] });
    expect(ids(dedupeSubagentRows([delegated("one"), delegated("two")]))).toEqual(["one", "two"]);
  });

  it("starts over at each of your messages", () => {
    const rows = [
      subagentEvent("first", "child-a"),
      message("ask", "user"),
      subagentEvent("again", "child-a"),
    ];
    expect(ids(dedupeSubagentRows(rows))).toEqual(["first", "ask", "again"]);
  });

  it("joins subagents side by side into one group row", () => {
    const rows = [subagentEvent("a", "child-a"), subagentEvent("b", "child-b")];
    const [group, ...rest] = dedupeSubagentRows(rows);
    expect(rest).toEqual([]);
    expect(group).toMatchObject({ kind: "event", id: "a" });
    expect(group?.kind === "event" ? group.subagents?.length : 0).toBe(2);
  });
});
