import { assert, it } from "@effect/vitest";

import {
  nativeSessionHoldsImportedHistory,
  shouldPrepareLegacyImportHandoff,
} from "./Orchestrator.ts";

it("reissues imported context until a V2 run completes", () => {
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
      hasNativeHistory: true,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: true,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: undefined,
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 0,
    }),
  );
});

it("skips the imported-history recap only when the resumed session already holds it", () => {
  const ref = (driver: string) => ({
    driver,
    nativeThreadRef: { driver, nativeId: "session", strength: "strong" as const },
  });
  assert.isTrue(
    nativeSessionHoldsImportedHistory({
      providerThread: ref("claudeAgent") as never,
      targetDriver: "claudeAgent",
    }),
  );
  assert.isTrue(
    nativeSessionHoldsImportedHistory({
      providerThread: ref("acpRegistry") as never,
      targetDriver: "acpRegistry",
    }),
  );
  // Moving the thread to another agent still needs the recap.
  assert.isFalse(
    nativeSessionHoldsImportedHistory({
      providerThread: ref("claudeAgent") as never,
      targetDriver: "codex",
    }),
  );
  assert.isFalse(
    nativeSessionHoldsImportedHistory({
      providerThread: { driver: "claudeAgent", nativeThreadRef: null } as never,
      targetDriver: "claudeAgent",
    }),
  );
  assert.isFalse(
    nativeSessionHoldsImportedHistory({ providerThread: undefined, targetDriver: "claudeAgent" }),
  );
  assert.isFalse(
    nativeSessionHoldsImportedHistory({
      providerThread: ref("codex") as never,
      targetDriver: "codex",
    }),
  );
});
