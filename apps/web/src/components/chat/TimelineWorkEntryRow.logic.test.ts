import { describe, expect, it } from "vite-plus/test";

import { workEntryInitiallyExpanded } from "./TimelineWorkEntryRow.logic";

describe("workEntryInitiallyExpanded", () => {
  it("folds thinking until the user leaves one open", () => {
    const thinking = { isReasoning: true, openedBefore: false };
    expect(workEntryInitiallyExpanded({ ...thinking, thinkingExpanded: false })).toBe(false);
    expect(workEntryInitiallyExpanded({ ...thinking, thinkingExpanded: true })).toBe(true);
  });

  it("opens other rows only when they were opened before", () => {
    const tool = { isReasoning: false, thinkingExpanded: true };
    expect(workEntryInitiallyExpanded({ ...tool, openedBefore: false })).toBe(false);
    expect(workEntryInitiallyExpanded({ ...tool, openedBefore: true })).toBe(true);
  });
});
