import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { collectProviderUsageLimits } from "@t3tools/shared/usageLimits";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";

import { useEnvironmentProviders } from "../../state/environments";
import { Button } from "../ui/button";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { PreviewCard, PreviewCardPopup } from "../ui/preview-card";
import { readUsagePagePreferences, saveUsagePagePreferences } from "../usage/usagePagePreferences";
import {
  formatUsageAge,
  formatUsageReset,
  shortPlanName,
  usageWindowLabel,
} from "./ModelUsageHoverCard.logic";

const OPEN_DELAY_MS = 2000;
// An older reading is refreshed in the background when the card opens; the card never waits for it.
const STALE_AFTER_MS = 2 * 60_000;
const EMPTY_PROVIDERS: readonly ServerProvider[] = [];

function LimitRow({
  window,
  windows,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly now: number;
}) {
  const label = usageWindowLabel(window, windows);
  const used = Math.round(Math.max(0, Math.min(100, window.usedPercent ?? 0)));
  const reset = formatUsageReset(window.resetsAt, now);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-4 text-xs">
        <span className="truncate text-foreground">{label}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {reset ? `${reset} · ` : ""}
          <span className={used >= 90 ? "text-destructive-foreground" : undefined}>{used}%</span>
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={
            used >= 90 ? "h-full rounded-full bg-destructive" : "h-full rounded-full bg-info"
          }
          style={{ width: `${used}%` }}
        />
      </div>
    </div>
  );
}

function UsageCardBody({
  environmentId,
  instanceId,
  now,
  onSeeAll,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly now: number;
  readonly onSeeAll: () => void;
}) {
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_PROVIDERS;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  const report = collectProviderUsageLimits(
    instanceId,
    providers,
    config?.usageLimitSources ?? [],
    now,
  );
  // Only this account's own reading: another entry in the report may be a different login.
  const limits =
    report?.accounts.find((account) => account.instanceId === instanceId)?.limits ??
    provider?.usageLimits;
  const plan = shortPlanName(provider?.auth.label);
  const accountName = provider?.displayName?.trim() || String(instanceId);
  const notice = limits ? cardNotice(limits) : null;
  const windows = limits && !notice ? limits.windows : [];

  return (
    <div className="flex w-80 flex-col gap-3 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-pretty text-foreground">
            {windows.length > 0 ? "Plan usage limits" : "Usage limits"}
            {plan ? ` · ${plan}` : ""}
          </div>
          <div className="truncate text-xs text-muted-foreground">{accountName}</div>
        </div>
        <Button size="xs" variant="ghost" className="shrink-0" onClick={onSeeAll}>
          See all
          <ArrowRightIcon aria-hidden />
        </Button>
      </div>
      {windows.length > 0 ? (
        <div className="flex flex-col gap-3">
          {windows.map((window) => (
            <LimitRow key={window.id} window={window} windows={windows} now={now} />
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          {notice ??
            (limits
              ? "No plan limits on this account, such as an API key."
              : "No usage reading yet for this account.")}
        </div>
      )}
      {limits?.checkedAt ? (
        <div className="text-2xs text-muted-foreground/70">
          {formatUsageAge(limits.checkedAt, now)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * After a 2 second mouse hover on the model picker, shows the plan limits of the account the
 * picker is set to. It sits beside the picker and watches its button, so the picker itself stays
 * as T3 ships it. The picker's own popup always wins.
 */
// Per environment and account, so repeated hovers or several pickers ask for one refresh at a time.
const lastRefreshRequest = new Map<string, number>();
const CLOSE_DELAY_MS = 150;


// The card's own wording for an account without readable limits. T3 moved its helper into
// translated copy after v0.1.10, so the card keeps these few lines instead of depending on it.
function cardNotice(limits: ServerProviderUsageLimits): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  return limits.windows.length === 0 ? "No limits reported." : null;
}
export function ModelUsageHoverCard({
  anchorRef,
  enabled,
  environmentId,
  instanceId,
  pickerOpen,
}: {
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: ProviderInstanceId;
  readonly pickerOpen: boolean;
}) {
  // The account the card was opened for; switching account closes it.
  const [openFor, setOpenFor] = useState<ProviderInstanceId | null>(null);
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  const navigate = useNavigate();
  const providers = useEnvironmentProviders();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const timers = useRef<{ open?: number | undefined; close?: number | undefined }>({});
  const popupRef = useRef<HTMLDivElement>(null);
  if (openFor !== null && (pickerOpen || openFor !== instanceId || !enabled)) setOpenFor(null);

  const clearTimers = () => {
    window.clearTimeout(timers.current.open);
    window.clearTimeout(timers.current.close);
    timers.current = {};
  };
  // Closes once the mouse is over neither the picker nor the card, checking again while it is.
  const scheduleClose = () => {
    window.clearTimeout(timers.current.close);
    timers.current.close = window.setTimeout(() => {
      if (anchorRef.current?.matches(":hover") || popupRef.current?.matches(":hover")) {
        scheduleClose();
        return;
      }
      setOpenFor(null);
    }, CLOSE_DELAY_MS);
  };
  const openCard = useEffectEvent(() => {
    if (pickerOpen || environmentId === null) return;
    const now = Date.now();
    setOpenFor(instanceId);
    setOpenedAt(now);
    const checkedAt = providers.get(environmentId)?.find((entry) => entry.instanceId === instanceId)
      ?.usageLimits?.checkedAt;
    const key = `${environmentId}:${instanceId}`;
    const stale = !checkedAt || now - Date.parse(checkedAt) > STALE_AFTER_MS;
    const recentlyAsked = now - (lastRefreshRequest.get(key) ?? 0) < STALE_AFTER_MS;
    if (stale && !recentlyAsked) {
      lastRefreshRequest.set(key, now);
      void refreshProviders({ environmentId, input: { instanceId } });
    }
  });
  // Mouse only: keyboard focus or a touch on the picker should not pop a card.
  const onAnchorEnter = useEffectEvent((event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    window.clearTimeout(timers.current.close);
    if (timers.current.open !== undefined) return;
    timers.current.open = window.setTimeout(() => {
      timers.current.open = undefined;
      openCard();
    }, OPEN_DELAY_MS);
  });
  const onAnchorLeave = useEffectEvent(() => {
    window.clearTimeout(timers.current.open);
    timers.current.open = undefined;
    scheduleClose();
  });
  const onAnchorPress = useEffectEvent(() => {
    clearTimers();
    setOpenFor(null);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pointer listeners on the picker's button, a DOM node this component does not render
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!enabled || environmentId === null || anchor === null) return;
    const enter = (event: PointerEvent) => onAnchorEnter(event);
    const leave = () => onAnchorLeave();
    const press = () => onAnchorPress();
    anchor.addEventListener("pointerenter", enter);
    anchor.addEventListener("pointerleave", leave);
    anchor.addEventListener("pointerdown", press);
    return () => {
      anchor.removeEventListener("pointerenter", enter);
      anchor.removeEventListener("pointerleave", leave);
      anchor.removeEventListener("pointerdown", press);
      window.clearTimeout(timers.current.open);
      window.clearTimeout(timers.current.close);
      timers.current = {};
    };
  }, [anchorRef, enabled, environmentId]);

  if (!enabled || environmentId === null) return null;
  const onSeeAll = () => {
    clearTimers();
    setOpenFor(null);
    saveUsagePagePreferences({
      ...readUsagePagePreferences(),
      metric: "limits",
      hiddenProviders: [],
    });
    void navigate({ to: "/usage" });
  };

  return (
    <PreviewCard
      open={openFor === instanceId && !pickerOpen}
      onOpenChange={(next) => {
        if (!next) setOpenFor(null);
      }}
    >
      <PreviewCardPopup
        ref={popupRef}
        anchor={anchorRef}
        side="top"
        align="start"
        sideOffset={8}
        onPointerEnter={() => window.clearTimeout(timers.current.close)}
        onPointerLeave={scheduleClose}
      >
        <UsageCardBody
          environmentId={environmentId}
          instanceId={instanceId}
          now={openedAt}
          onSeeAll={onSeeAll}
        />
      </PreviewCardPopup>
    </PreviewCard>
  );
}
