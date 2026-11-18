import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  formatUsageAge,
  formatUsageReset,
  shortPlanName,
  usageWindowLabel,
} from "./ModelUsageHoverCard.logic";

const weekly = (id: string, label: string): ServerProviderUsageWindow => ({
  id,
  kind: "weekly",
  label,
  windowDurationMins: 7 * 24 * 60,
  usedPercent: 10,
});

it("shortens plan names to the tier", () => {
  expect(shortPlanName("Claude Ultra Subscription")).toBe("Ultra");
  expect(shortPlanName("ChatGPT Plus Subscription")).toBe("Plus");
  expect(shortPlanName("Claude API Key")).toBe("API Key");
  expect(shortPlanName("  ")).toBeUndefined();
  expect(shortPlanName(undefined)).toBeUndefined();
});

it("names the all-models weekly limit only when a model has its own", () => {
  const all = weekly("seven_day", "Weekly");
  const fable = weekly("seven_day_fable", "Weekly · Fable");
  expect(usageWindowLabel(all, [all, fable])).toBe("Weekly · all models");
  expect(usageWindowLabel(fable, [all, fable])).toBe("Weekly · Fable");
  expect(usageWindowLabel(all, [all])).toBe("Weekly");
  expect(
    usageWindowLabel(
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        windowDurationMins: 300,
        usedPercent: 0,
      },
      [all],
    ),
  ).toBe("5-hour session");
});

it("rounds a reset a second before the hour up to the hour", () => {
  const now = Date.parse("2026-11-17T23:00:00");
  expect(formatUsageReset("2026-11-18T01:59:59", now, "en-US")).toBe("Resets 2:00 AM");
  expect(formatUsageReset("2026-11-23T03:59:59", now, "en-US")).toBe("Resets Mon 4:00 AM");
  expect(formatUsageReset("2026-11-17T22:00:00", now, "en-US")).toBe("Resets now");
  expect(formatUsageReset("not a date", now)).toBeNull();
  // Rounding never says "now" before the reset has passed.
  const justBefore = Date.parse("2026-11-18T02:00:00");
  expect(formatUsageReset("2026-11-18T02:00:20", justBefore, "en-US")).toBe("Resets 2:00 AM");
});

it("says how old the reading is", () => {
  const now = Date.parse("2026-11-17T23:00:00Z");
  expect(formatUsageAge("2026-11-17T22:59:40Z", now)).toBe("Updated just now");
  expect(formatUsageAge("2026-11-17T23:00:30Z", now)).toBe("Updated just now");
  expect(formatUsageAge("2026-11-17T22:55:00Z", now)).toBe("Updated 5m ago");
  expect(formatUsageAge("2026-11-17T20:00:00Z", now)).toBe("Updated 3h ago");
});
