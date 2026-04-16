import { buildPageStateSummary, resolveUserIntervention } from "./dom";
import { nowIso } from "./logger";
import { resolveSiteAdapterFromState } from "./site-adapters";
import { buildTabContextFromPageState } from "./tab-context";
import type { NavigationMode, PageKind, PageStateBasic, TabContext, TrackedTabState } from "./types";

export interface NativeBrowserTabSummary {
  tabId: number;
  browserTargetId: string | null;
  url: string;
  title: string;
  readyState: DocumentReadyState;
  interactiveCount: number;
  formCount: number;
  visibleTextLength: number;
  hasSensitiveInputs: boolean;
  active: boolean;
  capturedAt: string;
}

export interface NativeTabMatchTarget {
  tabId?: number;
  browserTargetId?: string | null;
  url?: string;
  title?: string;
}

export interface NativeTabInventoryEntry {
  tabContext: TabContext;
  active: boolean;
  browserTargetId: string | null;
  pageState: PageStateBasic;
  summary: string;
}

function normalizeWhitespace(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

function normalizeComparable(input: string): string {
  return normalizeWhitespace(input).toLowerCase();
}

function normalizeUrl(input: string): string {
  if (!input) {
    return "";
  }

  try {
    const url = new URL(input);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return normalizeWhitespace(input).replace(/\/$/, "");
  }
}

function normalizeNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function hostnameFromUrl(input: string): string {
  try {
    return new URL(input).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function normalizeNativeBrowserTabSummary(value: unknown): NativeBrowserTabSummary | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
  if (!url) {
    return null;
  }

  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const browserTargetId = typeof candidate.browserTargetId === "string" && candidate.browserTargetId.trim() ? candidate.browserTargetId.trim() : null;
  const readyState =
    candidate.readyState === "loading" || candidate.readyState === "interactive" || candidate.readyState === "complete"
      ? (candidate.readyState as DocumentReadyState)
      : "complete";

  return {
    tabId: normalizeNumber(candidate.tabId, -1),
    browserTargetId,
    url,
    title,
    readyState,
    interactiveCount: normalizeNumber(candidate.interactiveCount, 0),
    formCount: normalizeNumber(candidate.formCount, 0),
    visibleTextLength: normalizeNumber(candidate.visibleTextLength, 0),
    hasSensitiveInputs: candidate.hasSensitiveInputs === true,
    active: candidate.active === true,
    capturedAt: typeof candidate.capturedAt === "string" && candidate.capturedAt.trim() ? candidate.capturedAt.trim() : nowIso(),
  };
}

function inferNativePageKind(summary: NativeBrowserTabSummary): PageKind {
  const hostname = hostnameFromUrl(summary.url);
  const haystack = normalizeComparable([summary.url, summary.title].filter(Boolean).join(" "));

  if (
    summary.hasSensitiveInputs ||
    hostname === "accounts.google.com" ||
    /(sign in|log in|login|authenticate|verify account)/.test(haystack)
  ) {
    return "login";
  }

  if (
    /(checkout|payment|pay now|pay|billing|card|credit card|purchase|buy now|place order|order summary|subscription|donate|invoice|wallet|paypal)/.test(
      haystack,
    )
  ) {
    return "payment";
  }

  if (hostname === "docs.google.com") {
    return "document";
  }

  if (hostname === "drive.google.com") {
    return "mixed";
  }

  if (hostname.endsWith("linkedin.com")) {
    return "mixed";
  }

  if (summary.visibleTextLength > 3000) {
    return "article";
  }

  if (summary.formCount > 0) {
    return "form";
  }

  if (summary.interactiveCount > 0) {
    return "mixed";
  }

  return "unknown";
}

function inferNativeNavigationMode(summary: NativeBrowserTabSummary, pageKind: PageKind): NavigationMode {
  if (pageKind === "spa") {
    return "spa";
  }

  const hostname = hostnameFromUrl(summary.url);
  if (hostname === "docs.google.com" || hostname === "drive.google.com" || hostname.endsWith("linkedin.com")) {
    return "spa";
  }

  if (summary.url.includes("#")) {
    return "spa";
  }

  return "document";
}

export function buildNativePageState(summary: NativeBrowserTabSummary): PageStateBasic {
  const pageKind = inferNativePageKind(summary);
  const navigationMode = inferNativeNavigationMode(summary, pageKind);
  const provisionalState: PageStateBasic = {
    url: summary.url,
    title: normalizeWhitespace(summary.title) || "Untitled",
    readyState: summary.readyState,
    navigationMode,
    pageKind,
    interactiveCount: summary.interactiveCount,
    formCount: summary.formCount,
    visibleTextLength: summary.visibleTextLength,
    hasSensitiveInputs: summary.hasSensitiveInputs,
    siteAdapterId: null,
    siteAdapterLabel: null,
    userInterventionKind: null,
    userInterventionMessage: null,
    updatedAt: summary.capturedAt,
  };

  const siteAdapter = resolveSiteAdapterFromState(provisionalState);
  const intervention = resolveUserIntervention(pageKind);

  return {
    ...provisionalState,
    siteAdapterId: siteAdapter?.id ?? null,
    siteAdapterLabel: siteAdapter?.label ?? null,
    userInterventionKind: intervention?.kind ?? null,
    userInterventionMessage: intervention?.message ?? null,
  };
}

export function buildNativeTabContext(summary: NativeBrowserTabSummary): TabContext {
  const pageState = buildNativePageState(summary);
  const tabContext = buildTabContextFromPageState(summary.tabId, pageState);
  const snapshotId = summary.browserTargetId ? `native-${summary.browserTargetId}` : `native-tab-${summary.tabId}`;

  return {
    ...(tabContext ?? {
      tabId: summary.tabId,
      windowId: null,
      url: pageState.url,
      title: pageState.title,
      pageKind: pageState.pageKind,
      siteAdapterId: pageState.siteAdapterId,
      siteAdapterLabel: pageState.siteAdapterLabel,
      snapshotId: null,
      capturedAt: pageState.updatedAt,
    }),
    browserTargetId: summary.browserTargetId,
    snapshotId,
    capturedAt: summary.capturedAt,
  };
}

export function buildNativeTrackedTab(summary: NativeBrowserTabSummary): TrackedTabState {
  const pageState = buildNativePageState(summary);

  return {
    tabId: summary.tabId,
    windowId: 0,
    active: summary.active,
    url: summary.url,
    title: pageState.title,
    pageState,
    snapshot: null,
    snapshotFresh: false,
    contentReady: true,
    busy: false,
    approvals: [],
    activityLog: [],
    lastError: null,
    lastSeenAt: summary.capturedAt,
  };
}

export function buildNativeTabInventoryEntry(summary: NativeBrowserTabSummary): NativeTabInventoryEntry {
  const pageState = buildNativePageState(summary);

  return {
    tabContext: buildNativeTabContext(summary),
    active: summary.active,
    browserTargetId: summary.browserTargetId,
    pageState,
    summary: buildPageStateSummary(pageState),
  };
}

export function summarizeNativeTab(summary: NativeBrowserTabSummary): string {
  return buildPageStateSummary(buildNativePageState(summary));
}

export function resolveNativeTabContextTarget(
  tabs: NativeBrowserTabSummary[],
  target: NativeTabMatchTarget | null | undefined,
): NativeBrowserTabSummary | null {
  if (!target) {
    return null;
  }

  const browserTargetId = target.browserTargetId?.trim();
  if (browserTargetId) {
    const match = tabs.find((tab) => tab.browserTargetId === browserTargetId);
    if (match) {
      return match;
    }
  }

  if (typeof target.tabId === "number" && Number.isFinite(target.tabId)) {
    const match = tabs.find((tab) => tab.tabId === target.tabId);
    if (match) {
      return match;
    }
  }

  const normalizedUrl = target.url ? normalizeUrl(target.url) : "";
  if (normalizedUrl) {
    const match = tabs.find((tab) => normalizeUrl(tab.url) === normalizedUrl);
    if (match) {
      return match;
    }
  }

  const normalizedTitle = target.title ? normalizeComparable(target.title) : "";
  if (normalizedTitle) {
    const match = tabs.find((tab) => normalizeComparable(tab.title) === normalizedTitle);
    if (match) {
      return match;
    }
  }

  return null;
}
