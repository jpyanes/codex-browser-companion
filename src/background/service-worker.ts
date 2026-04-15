import {
  CONTENT_SCRIPT_READY_RETRIES,
  CONTENT_SCRIPT_RETRY_DELAY_MS,
  MAX_ACTIVITY_LOG_ENTRIES,
  MAX_APPROVAL_QUEUE_ENTRIES,
  STORAGE_KEY_STATE,
} from "../shared/constants";
import {
  buildApprovalRequest,
  canAutoExecute,
  describeAction,
  isBlockedSensitiveAction,
  requiresApproval,
} from "../shared/action-policy";
import { resolvePageStateFromSnapshot } from "../shared/dom";
import { createActivityLogEntry, normalizeError, nowIso } from "../shared/logger";
import { isContentEvent, isUiRequest, type ContentRequest, type ContentResponse, type UiEvent, type UiRequest } from "../shared/messages";
import { readSessionValue, writeSessionValue } from "../shared/storage";
import type {
  ActionRequest,
  AssistantConnectionState,
  ApprovalRequest,
  ExtensionState,
  PageSnapshot,
  PageStateBasic,
  ScanMode,
  TrackedTabState,
} from "../shared/types";

const uiPorts = new Set<chrome.runtime.Port>();

function makeId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function createDefaultTabState(tabId: number, partial: Partial<TrackedTabState> = {}): TrackedTabState {
  return {
    tabId,
    windowId: partial.windowId ?? 0,
    active: partial.active ?? false,
    url: partial.url ?? "",
    title: partial.title ?? "",
    pageState: partial.pageState ?? null,
    snapshot: partial.snapshot ?? null,
    snapshotFresh: partial.snapshotFresh ?? false,
    contentReady: partial.contentReady ?? false,
    busy: partial.busy ?? false,
    approvals: partial.approvals ?? [],
    activityLog: partial.activityLog ?? [],
    lastError: partial.lastError ?? null,
    lastSeenAt: partial.lastSeenAt ?? nowIso(),
  };
}

function createInitialState(): ExtensionState {
  return {
    activeTabId: null,
    tabs: {},
    status: "idle",
    lastUpdatedAt: nowIso(),
  };
}

function normalizeTabState(tabId: number, partial: Partial<TrackedTabState> | undefined): TrackedTabState {
  if (!partial) {
    return createDefaultTabState(tabId);
  }

  return createDefaultTabState(tabId, {
    ...partial,
    approvals: Array.isArray(partial.approvals) ? partial.approvals : [],
    activityLog: Array.isArray(partial.activityLog) ? partial.activityLog : [],
  });
}

function normalizeState(partial: Partial<ExtensionState> | undefined | null): ExtensionState {
  const fallback = createInitialState();
  if (!partial) {
    return fallback;
  }

  const tabs: Record<number, TrackedTabState> = {};
  for (const [key, value] of Object.entries(partial.tabs ?? {})) {
    const tabId = Number.parseInt(key, 10);
    if (!Number.isFinite(tabId)) {
      continue;
    }
    tabs[tabId] = normalizeTabState(tabId, value);
  }

  return {
    activeTabId: typeof partial.activeTabId === "number" ? partial.activeTabId : null,
    tabs,
    status: partial.status ?? "idle",
    lastUpdatedAt: typeof partial.lastUpdatedAt === "string" ? partial.lastUpdatedAt : nowIso(),
  };
}

let state: ExtensionState = createInitialState();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function getTabState(tabId: number): TrackedTabState {
  const existing = state.tabs[tabId];
  if (existing) {
    return existing;
  }

  const next = createDefaultTabState(tabId);
  state.tabs[tabId] = next;
  return next;
}

function getActiveTabState(): TrackedTabState | null {
  if (state.activeTabId === null) {
    return null;
  }

  return state.tabs[state.activeTabId] ?? null;
}

function replaceTabState(tabId: number, updater: (current: TrackedTabState) => TrackedTabState): TrackedTabState {
  const current = getTabState(tabId);
  const next = updater(current);
  state.tabs[tabId] = next;
  return next;
}

function truncateEntries<T>(entries: T[], maxEntries: number): T[] {
  if (entries.length <= maxEntries) {
    return entries;
  }

  return entries.slice(entries.length - maxEntries);
}

function deriveStatus(): AssistantConnectionState {
  const active = getActiveTabState();
  if (!active) {
    return "idle";
  }

  if (active.lastError) {
    return "error";
  }

  if (active.busy) {
    return "running";
  }

  if (active.approvals.some((approval) => approval.status === "pending" || approval.status === "executing")) {
    return "awaiting-approval";
  }

  if (active.contentReady) {
    return "connected";
  }

  return "idle";
}

async function persistState(): Promise<void> {
  await writeSessionValue(STORAGE_KEY_STATE, state);
}

function schedulePersistState(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
  }

  persistTimer = globalThis.setTimeout(() => {
    persistTimer = null;
    void persistState();
  }, 50);
}

function updateDerivedState(): void {
  state.status = deriveStatus();
  state.lastUpdatedAt = nowIso();
}

function broadcastState(): void {
  const message: UiEvent = { kind: "state", state };
  for (const port of uiPorts) {
    try {
      port.postMessage(message);
    } catch {
      // The port may have been disconnected between the snapshot and send.
    }
  }
}

function broadcastEvent(event: UiEvent): void {
  for (const port of uiPorts) {
    try {
      port.postMessage(event);
    } catch {
      // Ignore broken UI ports and let reconnect logic handle them.
    }
  }
}

function updateBadge(): void {
  const active = getActiveTabState();
  const approvalCount = active?.approvals.filter((approval) => approval.status === "pending" || approval.status === "executing").length ?? 0;
  let text = "";
  let color = "#64748b";

  if (active?.busy) {
    text = "RUN";
    color = "#0f766e";
  } else if (approvalCount > 0) {
    text = approvalCount > 99 ? "99+" : String(approvalCount);
    color = "#c2410c";
  } else if (active?.lastError) {
    text = "!";
    color = "#b91c1c";
  } else if (active?.contentReady) {
    text = "OK";
    color = "#166534";
  }

  void chrome.action.setBadgeText({ text }).catch(() => undefined);
  void chrome.action.setBadgeBackgroundColor({ color }).catch(() => undefined);
}

function commit(event?: UiEvent): void {
  updateDerivedState();
  updateBadge();
  schedulePersistState();
  broadcastState();
  if (event) {
    broadcastEvent(event);
  }
}

function setLastError(tabId: number, error: ReturnType<typeof normalizeError> | null): void {
  replaceTabState(tabId, (current) => ({
    ...current,
    lastError: error,
    lastSeenAt: nowIso(),
  }));
}

function pushLog(tabId: number, level: "debug" | "info" | "success" | "warning" | "error", message: string, details?: string): void {
  const entry = createActivityLogEntry(level, message, { tabId, details });
  replaceTabState(tabId, (current) => ({
    ...current,
    activityLog: truncateEntries([...current.activityLog, entry], MAX_ACTIVITY_LOG_ENTRIES),
    lastSeenAt: nowIso(),
  }));
}

function markBusy(tabId: number, busy: boolean): void {
  replaceTabState(tabId, (current) => ({
    ...current,
    busy,
    lastSeenAt: nowIso(),
  }));
}

function markContentReady(tabId: number, ready: boolean): void {
  replaceTabState(tabId, (current) => ({
    ...current,
    contentReady: ready,
    lastSeenAt: nowIso(),
  }));
}

function markSnapshotFresh(tabId: number, fresh: boolean): void {
  replaceTabState(tabId, (current) => ({
    ...current,
    snapshotFresh: fresh,
    lastSeenAt: nowIso(),
  }));
}

function setActiveTab(tabId: number | null): void {
  state.activeTabId = tabId;
  for (const [knownId, tabState] of Object.entries(state.tabs)) {
    const numericId = Number.parseInt(knownId, 10);
    if (!Number.isFinite(numericId)) {
      continue;
    }

    state.tabs[numericId] = {
      ...tabState,
      active: tabId === numericId,
    };
  }
}

function updateTabContextFromChromeTab(tab: chrome.tabs.Tab): TrackedTabState {
  if (typeof tab.id !== "number") {
    throw new Error("Tab is missing an id.");
  }

  const current = getTabState(tab.id);
  const nextUrl = tab.url ?? current.url;
  const nextTitle = tab.title ?? current.title;
  const urlChanged = nextUrl !== current.url;
  const titleChanged = nextTitle !== current.title;

  const next = {
    ...current,
    windowId: tab.windowId ?? current.windowId,
    active: Boolean(tab.active) || state.activeTabId === tab.id,
    url: nextUrl,
    title: nextTitle,
    pageState: current.pageState
      ? {
          ...current.pageState,
          url: nextUrl,
          title: nextTitle,
        }
      : current.pageState,
    snapshotFresh: urlChanged ? false : current.snapshotFresh,
    contentReady: urlChanged ? false : current.contentReady,
    lastSeenAt: nowIso(),
  };

  state.tabs[tab.id] = next;
  if (tab.active) {
    setActiveTab(tab.id);
  }

  if (urlChanged || titleChanged) {
    pushLog(tab.id, "info", "Tab context updated.", `${nextTitle || "Untitled"} | ${nextUrl || "unknown url"}`);
  }

  return next;
}

async function syncActiveTab(tabId: number): Promise<TrackedTabState | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const next = updateTabContextFromChromeTab(tab);
    setActiveTab(tabId);
    commit();
    return next;
  } catch (error) {
    const normalized = normalizeError(error, "TAB_SYNC_FAILED", { tabId, recoverable: true });
    setLastError(tabId, normalized);
    pushLog(tabId, "error", "Failed to sync active tab.", normalized.message);
    commit({ kind: "error", error: normalized });
    return null;
  }
}

function isInspectableUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:" || parsed.protocol === "about:";
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const pong = (await chrome.tabs.sendMessage(tabId, { kind: "ping" })) as { kind?: string } | undefined;
    if (pong && pong.kind === "ping") {
      markContentReady(tabId, true);
      return;
    }
  } catch {
    // Fall through to injection.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });

  for (let attempt = 0; attempt < CONTENT_SCRIPT_READY_RETRIES; attempt += 1) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, CONTENT_SCRIPT_RETRY_DELAY_MS));
    try {
      const pong = (await chrome.tabs.sendMessage(tabId, { kind: "ping" })) as { kind?: string } | undefined;
      if (pong && pong.kind === "ping") {
        markContentReady(tabId, true);
        return;
      }
    } catch {
      // Retry a few times in case the content script is still booting.
    }
  }

  throw new Error("The content script did not respond after injection.");
}

async function sendContentRequest(tabId: number, request: ContentRequest): Promise<ContentResponse> {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, request);
}

async function capturePageFromTab(tabId: number, mode: ScanMode): Promise<PageSnapshot> {
  const response = await sendContentRequest(tabId, { kind: "capture-page", mode });

  if (response.kind === "content-error") {
    throw new Error(response.error.message);
  }

  if (response.kind !== "page-snapshot") {
    throw new Error(`Unexpected content response: ${response.kind}`);
  }

  const snapshot = {
    ...response.snapshot,
    tabId,
  };

  return snapshot;
}

async function recordSnapshot(tabId: number, mode: ScanMode): Promise<PageSnapshot> {
  const snapshot = await capturePageFromTab(tabId, mode);
  const pageState = resolvePageStateFromSnapshot(snapshot);
  replaceTabState(tabId, (current) => ({
    ...current,
    snapshot,
    pageState,
    contentReady: true,
    snapshotFresh: true,
    lastError: null,
    lastSeenAt: nowIso(),
  }));
  pushLog(tabId, "success", `Captured ${mode} page snapshot.`, `Interactive controls: ${snapshot.interactiveElements.length}`);
  commit({ kind: "page-snapshot", tabId, snapshot });
  return snapshot;
}

async function scanActiveTab(mode: ScanMode): Promise<void> {
  const tabId = state.activeTabId;
  if (tabId === null) {
    const error = normalizeError("No active tab is available.", "NO_ACTIVE_TAB", { recoverable: true });
    commit({ kind: "error", error });
    return;
  }

  const tabState = getTabState(tabId);
  if (!isInspectableUrl(tabState.url)) {
    const error = normalizeError(`The active tab cannot be inspected: ${tabState.url || "unknown url"}`, "UNSUPPORTED_URL", {
      tabId,
      recoverable: true,
    });
    setLastError(tabId, error);
    pushLog(tabId, "warning", "Scan blocked because the current page is not inspectable.", error.message);
    commit({ kind: "error", error });
    return;
  }

  markBusy(tabId, true);
  commit();

  try {
    await recordSnapshot(tabId, mode);
  } catch (error) {
    const normalized = normalizeError(error, "CAPTURE_FAILED", { tabId, recoverable: true });
    setLastError(tabId, normalized);
    markContentReady(tabId, false);
    pushLog(tabId, "error", "Failed to capture the page.", `${normalized.message}${normalized.details ? ` | ${normalized.details}` : ""}`);
    commit({ kind: "error", error: normalized });
  } finally {
    markBusy(tabId, false);
    commit();
  }
}

function pruneApprovals(approvals: ApprovalRequest[]): ApprovalRequest[] {
  return truncateEntries(approvals, MAX_APPROVAL_QUEUE_ENTRIES);
}

async function queueActionForApproval(action: ActionRequest): Promise<void> {
  const tabId = state.activeTabId;
  if (tabId === null) {
    const error = normalizeError("No active tab is available.", "NO_ACTIVE_TAB", { recoverable: true });
    commit({ kind: "error", error });
    return;
  }

  const tabState = getTabState(tabId);
  const snapshot = tabState.snapshot;

  if (isBlockedSensitiveAction(action, snapshot)) {
    const error = normalizeError("Sensitive form fields are not supported in v1.", "SENSITIVE_FIELD_BLOCKED", {
      tabId,
      recoverable: true,
    });
    setLastError(tabId, error);
    pushLog(tabId, "warning", "Blocked an action targeting a sensitive field.", error.message);
    commit({ kind: "error", error });
    return;
  }

  action.tabId = tabId;
  const approval = buildApprovalRequest(action, tabId, snapshot);
  replaceTabState(tabId, (current) => ({
    ...current,
    approvals: pruneApprovals([...current.approvals, approval]),
    lastError: null,
    lastSeenAt: nowIso(),
  }));

  pushLog(tabId, "warning", "Queued an action for approval.", `${approval.title} | ${approval.dangerLevel}`);
  commit({ kind: "approval-requested", approval });
}

async function executeApprovedAction(tabId: number, action: ActionRequest, approvalId?: string): Promise<void> {
  const tabState = getTabState(tabId);
  const snapshot = tabState.snapshot;

  if (requiresApproval(action)) {
    // Safety net: queued actions must not reach execution without approval.
    if (!approvalId) {
      throw new Error("Action requires approval before execution.");
    }
  }

  if (!canAutoExecute(action) && !snapshot) {
    throw new Error("The page must be scanned before this action can run.");
  }

  const actionLabel = describeAction(action, snapshot).title;
  markBusy(tabId, true);
  commit();

  try {
    const response = await sendContentRequest(tabId, { kind: "perform-action", action });

    if (response.kind === "content-error") {
      throw new Error(response.error.message);
    }

    if (response.kind !== "action-result") {
      throw new Error(`Unexpected content response: ${response.kind}`);
    }

    const result = {
      ...response.result,
      actionId: action.actionId,
      approvalId: approvalId ?? undefined,
      tabId,
    };

    replaceTabState(tabId, (current) => {
      const nextApprovals = current.approvals.map((approval) =>
        approval.approvalId === approvalId ? { ...approval, status: "succeeded" as const, updatedAt: nowIso() } : approval,
      );
      return {
        ...current,
        approvals: nextApprovals,
        snapshotFresh: action.kind === "scroll" ? current.snapshotFresh : action.kind === "refresh" || action.kind === "navigate-back" || action.kind === "navigate-forward" ? false : current.snapshotFresh,
        lastError: null,
        lastSeenAt: nowIso(),
      };
    });

    pushLog(tabId, "success", `Executed ${actionLabel}.`, result.message);
    commit({ kind: "action-result", result });
  } catch (error) {
    const normalized = normalizeError(error, "ACTION_FAILED", { tabId, recoverable: true });
    setLastError(tabId, normalized);
    replaceTabState(tabId, (current) => ({
      ...current,
      approvals: current.approvals.map((approval) =>
        approval.approvalId === approvalId ? { ...approval, status: "failed" as const, updatedAt: nowIso() } : approval,
      ),
      busy: false,
      lastSeenAt: nowIso(),
    }));
    pushLog(tabId, "error", "Action execution failed.", normalized.message);
    commit({ kind: "error", error: normalized });
    return;
  } finally {
    markBusy(tabId, false);
    commit();
  }
}

async function approveAction(approvalId: string): Promise<void> {
  const tabId = state.activeTabId;
  if (tabId === null) {
    return;
  }

  const tabState = getTabState(tabId);
  const approval = tabState.approvals.find((entry) => entry.approvalId === approvalId);
  if (!approval || approval.status !== "pending") {
    return;
  }

  replaceTabState(tabId, (current) => ({
    ...current,
    approvals: current.approvals.map((entry) =>
      entry.approvalId === approvalId ? { ...entry, status: "approved" as const, updatedAt: nowIso() } : entry,
    ),
    lastSeenAt: nowIso(),
  }));
  commit({ kind: "approval-updated", approval: { ...approval, status: "approved", updatedAt: nowIso() } });

  replaceTabState(tabId, (current) => ({
    ...current,
    approvals: current.approvals.map((entry) =>
      entry.approvalId === approvalId ? { ...entry, status: "executing" as const, updatedAt: nowIso() } : entry,
    ),
    busy: true,
    lastSeenAt: nowIso(),
  }));
  commit();

  await executeApprovedAction(tabId, approval.action, approval.approvalId);
}

async function rejectAction(approvalId: string): Promise<void> {
  const tabId = state.activeTabId;
  if (tabId === null) {
    return;
  }

  const tabState = getTabState(tabId);
  const approval = tabState.approvals.find((entry) => entry.approvalId === approvalId);
  if (!approval) {
    return;
  }

  const updated: ApprovalRequest = {
    ...approval,
    status: "rejected",
    updatedAt: nowIso(),
  };

  replaceTabState(tabId, (current) => ({
    ...current,
    approvals: current.approvals.map((entry) => (entry.approvalId === approvalId ? updated : entry)),
    lastSeenAt: nowIso(),
  }));
  pushLog(tabId, "warning", "Rejected an action request.", updated.title);
  commit({ kind: "approval-updated", approval: updated });
}

async function openSidePanel(): Promise<void> {
  const tabId = state.activeTabId;
  if (tabId === null || !chrome.sidePanel) {
    return;
  }

  await chrome.sidePanel.setOptions({
    tabId,
    enabled: true,
    path: "sidepanel/index.html",
  });
  await chrome.sidePanel.open({ tabId });
  pushLog(tabId, "info", "Opened the side panel.");
  commit();
}

function clearActiveTabLog(): void {
  const tabId = state.activeTabId;
  if (tabId === null) {
    return;
  }

  replaceTabState(tabId, (current) => ({
    ...current,
    activityLog: [],
    lastError: null,
    lastSeenAt: nowIso(),
  }));
  pushLog(tabId, "info", "Cleared the activity log.");
  commit();
}

async function handleUiRequest(port: chrome.runtime.Port, request: UiRequest): Promise<void> {
  switch (request.kind) {
    case "get-state":
      port.postMessage({ kind: "state", state } satisfies UiEvent);
      return;
    case "scan-page":
      await scanActiveTab(request.mode);
      return;
    case "list-interactive-elements":
      await scanActiveTab("interactive");
      return;
    case "summarize-page":
      await scanActiveTab("summary");
      return;
    case "suggest-next-actions":
      await scanActiveTab("suggestions");
      return;
    case "request-action":
      await queueActionForApproval(request.action);
      return;
    case "approve-action":
      await approveAction(request.approvalId);
      return;
    case "reject-action":
      await rejectAction(request.approvalId);
      return;
    case "open-sidepanel":
      await openSidePanel();
      return;
    case "clear-log":
      clearActiveTabLog();
      return;
  }
}

function resolveTabIdFromSender(sender: chrome.runtime.MessageSender): number | null {
  return typeof sender.tab?.id === "number" ? sender.tab.id : null;
}

async function handleContentEvent(message: unknown, sender: chrome.runtime.MessageSender): Promise<void> {
  if (!isContentEvent(message)) {
    return;
  }

  const tabId = resolveTabIdFromSender(sender);
  if (tabId === null) {
    return;
  }

  switch (message.kind) {
    case "page-state": {
      const nextState: PageStateBasic = {
        ...message.state,
        url: message.state.url,
        title: message.state.title,
        updatedAt: nowIso(),
      };

      replaceTabState(tabId, (current) => ({
        ...current,
        pageState: nextState,
        title: nextState.title,
        url: nextState.url,
        contentReady: true,
        snapshotFresh: message.reason === "initial" ? current.snapshotFresh : false,
        lastError: null,
        lastSeenAt: nowIso(),
      }));
      commit();
      return;
    }
    case "content-error": {
      const error = message.error;
      setLastError(tabId, error);
      pushLog(tabId, "error", "Content script reported an error.", error.message);
      commit({ kind: "error", error });
      return;
    }
    case "ping":
    case "page-snapshot":
    case "action-result":
      return;
  }
}

async function boot(): Promise<void> {
  state = normalizeState(await readSessionValue(STORAGE_KEY_STATE, createInitialState()));
  commit();
}

await boot();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "codex-ui") {
    return;
  }

  uiPorts.add(port);
  port.postMessage({ kind: "state", state } satisfies UiEvent);
  port.onMessage.addListener((message: unknown) => {
    if (!isUiRequest(message)) {
      return;
    }

    void handleUiRequest(port, message).catch((error) => {
      const normalized = normalizeError(error, "UI_REQUEST_FAILED", { recoverable: true });
      port.postMessage({ kind: "error", error: normalized } satisfies UiEvent);
    });
  });
  port.onDisconnect.addListener(() => {
    uiPorts.delete(port);
  });
});

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!isContentEvent(message)) {
    return;
  }

  void handleContentEvent(message, sender).catch((error) => {
    const normalized = normalizeError(error, "CONTENT_EVENT_FAILED", { recoverable: true });
    const tabId = resolveTabIdFromSender(sender);
    if (tabId !== null) {
      setLastError(tabId, normalized);
      pushLog(tabId, "error", "Failed to process a content event.", normalized.message);
      commit({ kind: "error", error: normalized });
    }
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void syncActiveTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const tabState = getTabState(tabId);
  const urlChanged = typeof changeInfo.url === "string" && changeInfo.url !== tabState.url;
  const titleChanged = typeof changeInfo.title === "string" && changeInfo.title !== tabState.title;
  const loadingChanged = typeof changeInfo.status === "string";

  if (changeInfo.url || changeInfo.title || changeInfo.status) {
    updateTabContextFromChromeTab(tab);
  }

  if (urlChanged) {
    markContentReady(tabId, false);
    markSnapshotFresh(tabId, false);
  }

  if (loadingChanged && changeInfo.status === "loading") {
    markContentReady(tabId, false);
  }

  if (titleChanged) {
    replaceTabState(tabId, (current) => ({
      ...current,
      title: changeInfo.title ?? current.title,
      lastSeenAt: nowIso(),
    }));
  }

  if (tab.active) {
    setActiveTab(tabId);
  }

  updateDerivedState();
  updateBadge();
  schedulePersistState();
  broadcastState();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete state.tabs[tabId];
  if (state.activeTabId === tabId) {
    state.activeTabId = null;
  }
  commit();
});

chrome.runtime.onInstalled.addListener(() => {
  void persistState();
  updateBadge();
});

chrome.action.setBadgeText({ text: "" }).catch(() => undefined);
