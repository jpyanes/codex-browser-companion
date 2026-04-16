import type { ActionRequest, PageKind, PageSnapshot, PageStateBasic, SuggestedAction, SuggestedRequest, TabContext, TrackedTabState } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPageKind(value: unknown): value is PageKind {
  return value === "unknown" || value === "document" || value === "mixed" || value === "article" || value === "form" || value === "login" || value === "payment" || value === "spa";
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isValidTabId(tabId: number | null | undefined): tabId is number {
  return typeof tabId === "number" && Number.isFinite(tabId) && tabId >= 0;
}

export function buildTabContextFromSnapshot(snapshot: Pick<PageSnapshot, "tabId" | "url" | "title" | "pageKind" | "siteAdapter" | "snapshotId" | "capturedAt">): TabContext {
  return {
    tabId: snapshot.tabId,
    windowId: null,
    url: snapshot.url,
    title: snapshot.title,
    pageKind: snapshot.pageKind,
    siteAdapterId: snapshot.siteAdapter?.id ?? null,
    siteAdapterLabel: snapshot.siteAdapter?.label ?? null,
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt,
  };
}

export function buildTabContextFromPageState(tabId: number, pageState: PageStateBasic | null | undefined): TabContext | null {
  if (!pageState) {
    return null;
  }

  return {
    tabId,
    windowId: null,
    url: pageState.url,
    title: pageState.title,
    pageKind: pageState.pageKind,
    siteAdapterId: pageState.siteAdapterId ?? null,
    siteAdapterLabel: pageState.siteAdapterLabel ?? null,
    snapshotId: null,
    capturedAt: pageState.updatedAt,
  };
}

export function buildTabContextFromTrackedTab(tab: Pick<TrackedTabState, "tabId" | "windowId" | "url" | "title" | "pageState" | "snapshot">): TabContext | null {
  if (tab.snapshot) {
    return {
      ...buildTabContextFromSnapshot(tab.snapshot),
      windowId: tab.windowId,
    };
  }

  const pageStateContext = buildTabContextFromPageState(tab.tabId, tab.pageState);
  if (pageStateContext) {
    return {
      ...pageStateContext,
      windowId: tab.windowId,
    };
  }

  if (!tab.url && !tab.title) {
    return null;
  }

  return {
    tabId: tab.tabId,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
    pageKind: "unknown",
    siteAdapterId: null,
    siteAdapterLabel: null,
    snapshotId: null,
    capturedAt: null,
  };
}

export function normalizeTabContext(value: unknown): TabContext | null {
  if (!isRecord(value)) {
    return null;
  }

  const tabId = normalizeNumber(value.tabId, -1);
  if (!isValidTabId(tabId)) {
    return null;
  }

  return {
    tabId,
    windowId: typeof value.windowId === "number" && Number.isFinite(value.windowId) ? value.windowId : null,
    url: normalizeString(value.url),
    title: normalizeString(value.title),
    pageKind: isPageKind(value.pageKind) ? value.pageKind : "unknown",
    siteAdapterId: typeof value.siteAdapterId === "string" ? value.siteAdapterId : null,
    siteAdapterLabel: typeof value.siteAdapterLabel === "string" ? value.siteAdapterLabel : null,
    snapshotId: typeof value.snapshotId === "string" ? value.snapshotId : null,
    capturedAt: typeof value.capturedAt === "string" ? value.capturedAt : null,
  };
}

export function describeTabContext(tabContext: TabContext): string {
  return tabContext.siteAdapterLabel || tabContext.title || tabContext.url || `Tab ${tabContext.tabId}`;
}

export function formatTabContext(tabContext: TabContext): string {
  return `${describeTabContext(tabContext)} · tab ${tabContext.tabId}`;
}

export function attachTabContextToAction(action: ActionRequest, tabContext: TabContext): ActionRequest {
  return {
    ...action,
    tabContext,
  };
}

export function attachTabContextToRequest<T extends SuggestedRequest>(request: T, tabContext: TabContext): T {
  if (request.kind === "request-action") {
    return {
      ...request,
      tabContext,
      action: attachTabContextToAction(request.action, tabContext),
    } as T;
  }

  return {
    ...request,
    tabContext,
  } as T;
}

export function resolveSuggestedRequestTabId(request: SuggestedRequest | null | undefined): number | null {
  if (!request) {
    return null;
  }

  if (request.kind === "request-action") {
    const contextTabId = request.action.tabContext?.tabId;
    if (isValidTabId(contextTabId)) {
      return contextTabId;
    }

    return isValidTabId(request.action.tabId) ? request.action.tabId : null;
  }

  const contextTabId = request.tabContext?.tabId;
  return isValidTabId(contextTabId) ? contextTabId : null;
}

export function resolveActionTabId(action: ActionRequest | null | undefined): number | null {
  if (!action) {
    return null;
  }

  const contextTabId = action.tabContext?.tabId;
  if (isValidTabId(contextTabId)) {
    return contextTabId;
  }

  return isValidTabId(action.tabId) ? action.tabId : null;
}

export function resolveSuggestedActionTabContext(suggestion: SuggestedAction): TabContext {
  return suggestion.tabContext;
}
