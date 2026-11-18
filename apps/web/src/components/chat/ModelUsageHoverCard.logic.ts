import type { ServerProviderUsageWindow } from "@t3tools/contracts";

const MINUTE = 60_000;

/** "Claude Ultra Subscription" reads as "Ultra"; the card already names the account. */
export function shortPlanName(label: string | undefined): string | undefined {
  const short = label
    ?.trim()
    .replace(/\s+subscription$/i, "")
    .replace(/^(claude|chatgpt|openai|cursor)\s+/i, "")
    .trim();
  return short || undefined;
}

export function usageWindowLabel(
  window: ServerProviderUsageWindow,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): string {
  if (window.kind === "session" && window.windowDurationMins === 300) return "5-hour session";
  const hasModelWeekly = windows.some(
    (other) => other.kind === "weekly" && other.label.includes("·"),
  );
  if (window.kind === "weekly" && !window.label.includes("·") && hasModelWeekly) {
    return "Weekly · all models";
  }
  return window.label;
}

export function formatUsageReset(
  resetsAt: string | undefined,
  now: number,
  locale?: string,
): string | null {
  if (!resetsAt) return null;
  const parsed = Date.parse(resetsAt);
  if (!Number.isFinite(parsed)) return null;
  if (parsed <= now) return "Resets now";
  // Providers report a second before the hour, such as 3:59:59; show it as 4:00.
  const at = Math.round(parsed / MINUTE) * MINUTE;
  const time = new Date(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (parsed - now < 20 * 60 * MINUTE) return `Resets ${time}`;
  const day = new Date(at).toLocaleDateString(locale, { weekday: "short" });
  return `Resets ${day} ${time}`;
}

export function formatUsageAge(checkedAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(checkedAt)) / MINUTE));
  if (!Number.isFinite(minutes) || minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  return `Updated ${Math.round(minutes / 60)}h ago`;
}
