import {
  BRIDGE_POLL_INTERVAL_MS,
  CONTENT_SCRIPT_READY_RETRIES,
  CONTENT_SCRIPT_RETRY_DELAY_MS,
  DEFAULT_LIVE_TAKEOVER_ENDPOINT,
  MAX_ACTIVITY_LOG_ENTRIES,
  MAX_APPROVAL_QUEUE_ENTRIES,
  LIVE_TAKEOVER_POLL_INTERVAL_MS,
  SEMANTIC_POLL_INTERVAL_MS,
  STORAGE_KEY_STATE,
} from "../shared/constants";
import { createDisconnectedBridgeState } from "../shared/bridge";
import {
  buildApprovalRequest,
  canAutoExecute,
  describeAction,
  isBlockedSensitiveAction,
  requiresApproval,
  requiresManualIntervention,
} from "../shared/action-policy";
import { refreshBridgeState } from "./bridge-client";
import {
  fetchLiveTakeoverState,
  getNextLiveTakeoverCommand,
  postLiveTakeoverHeartbeat,
  postLiveTakeoverResult,
} from "../shared/live-takeover-client";
import { createDisabledSemanticState, updateSemanticStateWithObservation } from "../shared/semantic";
import { buildSemanticSuggestions } from "../shared/semantic";
import {
  buildWorkflowSuggestions,
  createInitialWorkflowState,
  getActiveWorkflowNextRequest,
  markWorkflowRequestCompleted,
  markWorkflowRequestFailed,
  markWorkflowStepCompleted,
  markWorkflowStepFailed,
  markWorkflowStepQueued,
  normalizeWorkflowState,
  recordWorkflowPageState,
  recordWorkflowPlan,
} from "../shared/workflow";
import { summarizeTrackedTab } from "../shared/tab-orchestration";
import { resolveActionTabId, resolveSuggestedRequestTabId } from "../shared/tab-context";
import { requestSemanticObservation, refreshSemanticState } from "./semantic-client";
import { resolvePageStateFromSnapshot, resolveUserIntervention } from "../shared/dom";
import { createActivityLogEntry, normalizeError, nowIso } from "../shared/logger";
import { isContentEvent, isUiRequest, type ContentRequest, type ContentResponse, type ContentTargetPayload, type UiEvent, type UiRequest } from "../shared/messages";
import { readSessionValue, writeSessionValue } from "../shared/storage";
import type {
  ActionRequest,
  AssistantConnectionState,
  ApprovalRequest,
  ExtensionState,
  LiveTakeoverCommand,
  PageSnapshot,
  PageStateBasic,
  ScanMode,
  TrackedTabState,
} from "../shared/types";
import {
  createDisconnectedLiveTakeoverState,
  chooseLiveTakeoverTab,
  summarizeLiveTakeoverState,
  shouldAutoEnableLiveTakeover,
} from "../shared/live-takeover";

const uiPorts = new Set<chrome.runtime.Port>();

interface UpdateTabContextOptions {
  markActive?: boolean;
  logChanges?: boolean;
}

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
    bridge: createDisconnectedBridgeState(),
    semantic: createDisabledSemanticState(),
    liveTakeover: createDisconnectedLiveTakeoverState(DEFAULT_LIVE_TAKEOVER_ENDPOINT, false),
    workflow: createInitialWorkflowState(),
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
    bridge: partial.bridge ?? createDisconnectedBridgeState(),
    semantic: partial.semantic ?? createDisabledSemanticState(),
    liveTakeover: partial.liveTakeover
      ? {
          ...partial.liveTakeover,
          hasBeenInitialized:
            partial.liveTakeover.enabled ||
            (typeof partial.liveTakeover.lastHeartbeat === "string" && partial.liveTakeover.lastHeartbeat.trim())
              ? partial.liveTakeover.hasBeenInitialized ?? false
              : false,
        }
      : createDisconnectedLiveTakeoverState(DEFAULT_LIVE_TAKEOVER_ENDPOINT, false),
    workflow: normalizeWorkflowState(partial.workflow ?? createInitialWorkflowState()),
    status: partial.status ?? "idle",
    lastUpdatedAt: typeof partial.lastUpdatedAt === "string" ? partial.lastUpdatedAt : nowIso(),
  };
}

let state: ExtensionState = createInitialState();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let bridgeRefreshTimer: ReturnType<typeof setInterval> | null = null;
let bridgeRefreshInFlight = false;
let semanticRefreshTimer: ReturnType<typeof setInterval> | null = null;
let semanticRefreshInFlight = false;
let liveTakeoverPollTimer: ReturnType<typeof setInterval> | null = null;
let liveTakeoverPollInFlight = false;

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

  if (active.busy) {
    return "running";
  }

  if (getManualIntervention(active)) {
    return "awaiting-user";
  }

  if (active.lastError) {
    return "error";
  }

  if (active.approvals.some((approval) => approval.status === "pending" || approval.status === "executing")) {
    return "awaiting-approval";
  }

  return active.contentReady ? "connected" : "idle";
}

function getManualIntervention(tab: TrackedTabState | null): { kind: "login" | "payment"; message: string } | null {
  if (!tab) {
    return null;
  }

  const pageIntervention = resolveUserIntervention(tab.pageState?.userInterventionKind ?? tab.pageState?.pageKind ?? null);
  if (pageIntervention) {
    return pageIntervention;
  }

  if (!requiresManualIntervention(tab.snapshot)) {
    return null;
  }

  return resolveUserIntervention(tab.snapshot?.pageKind ?? null);
}

function isAwaitingUserIntervention(tab: TrackedTabState | null): boolean {
  return Boolean(getManualIntervention(tab));
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
  } else if (isAwaitingUserIntervention(active)) {
    text = "WAIT";
    color = "#ca8a04";
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

async function refreshBridgeStatus(): Promise<void> {
  if (bridgeRefreshInFlight) {
    return;
  }

  bridgeRefreshInFlight = true;
  try {
    state.bridge = await refreshBridgeState();
    commit();
  } finally {
    bridgeRefreshInFlight = false;
  }
}

function scheduleBridgePolling(): void {
  if (bridgeRefreshTimer !== null) {
    return;
  }

  bridgeRefreshTimer = globalThis.setInterval(() => {
    void refreshBridgeStatus();
  }, BRIDGE_POLL_INTERVAL_MS);
}

async function refreshSemanticStatus(): Promise<void> {
  if (semanticRefreshInFlight) {
    return;
  }

  semanticRefreshInFlight = true;
  try {
    state.semantic = await refreshSemanticState();
    commit();
  } finally {
    semanticRefreshInFlight = false;
  }
}

function scheduleSemanticPolling(): void {
  if (semanticRefreshTimer !== null) {
    return;
  }

  semanticRefreshTimer = globalThis.setInterval(() => {
    void refreshSemanticStatus();
  }, SEMANTIC_POLL_INTERVAL_MS);
}

async function refreshLiveTakeoverStatus(): Promise<void> {
  try {
    const nextLiveTakeover = await fetchLiveTakeoverState(state.liveTakeover.endpoint, {
      enabled: state.liveTakeover.enabled,
      hasBeenInitialized: state.liveTakeover.hasBeenInitialized,
    });
    state.liveTakeover = {
      ...nextLiveTakeover,
      hasBeenInitialized: nextLiveTakeover.hasBeenInitialized || Boolean(nextLiveTakeover.lastHeartbeat),
    };
    commit();
  } catch (error) {
    state.liveTakeover = createDisconnectedLiveTakeoverState(
      state.liveTakeover.endpoint,
      state.liveTakeover.enabled,
      normalizeError(error, "LIVE_TAKEOVER_UNAVAILABLE", { recoverable: true }),
      nowIso(),
      state.liveTakeover.hasBeenInitialized,
    );
    commit();
  }
}

function scheduleLiveTakeoverPolling(): void {
  if (!state.liveTakeover.enabled) {
    if (liveTakeoverPollTimer !== null) {
      clearInterval(liveTakeoverPollTimer);
      liveTakeoverPollTimer = null;
    }
    return;
  }

  if (liveTakeoverPollTimer !== null) {
    return;
  }

  liveTakeoverPollTimer = globalThis.setInterval(() => {
    void refreshLiveTakeoverStatus();
  }, LIVE_TAKEOVER_POLL_INTERVAL_MS);
}

function buildLiveTakeoverTargetPayload(payload: Record<string, unknown>): ContentTargetPayload {
  const target: ContentTargetPayload = {};
  if (typeof payload.selector === "string") {
    target.selector = payload.selector;
  }
  if (typeof payload.bridgeId === "string") {
    target.bridgeId = payload.bridgeId;
  }
  if (typeof payload.label === "string") {
    target.label = payload.label;
  }

  return target;
}

function setLiveTakeoverEnabled(enabled: boolean): void {
  const previousTabId = state.liveTakeover.activeTabId;
  const previousWindowId = state.liveTakeover.activeWindowId;
  state.liveTakeover = enabled
    ? {
        ...state.liveTakeover,
        enabled: true,
        status: state.liveTakeover.status === "error" ? "disconnected" : "connecting",
        lastError: null,
        hasBeenInitialized: state.liveTakeover.hasBeenInitialized,
      }
    : {
        ...createDisconnectedLiveTakeoverState(state.liveTakeover.endpoint, false, null, nowIso(), state.liveTakeover.hasBeenInitialized),
        lastHeartbeat: state.liveTakeover.lastHeartbeat,
      };
  commit();
  scheduleLiveTakeoverPolling();
  if (enabled) {
    void syncLiveTakeoverMode(true);
    void refreshLiveTakeoverStatus();
  } else {
    void syncLiveTakeoverMode(false, previousTabId, previousWindowId);
  }
}

function toggleLiveTakeoverEnabled(): void {
  setLiveTakeoverEnabled(!state.liveTakeover.enabled);
}

async function syncLiveTakeoverMode(enabled: boolean, tabIdOverride: number | null = null, windowIdOverride: number | null = null): Promise<void> {
  if (!enabled) {
    const currentTabId = tabIdOverride ?? state.liveTakeover.activeTabId;
    if (currentTabId !== null) {
      try {
        await sendContentRequest(currentTabId, {
          kind: "set-live-takeover",
          enabled: false,
          endpoint: state.liveTakeover.endpoint,
          tabId: currentTabId,
          windowId: windowIdOverride ?? state.liveTakeover.activeWindowId,
        });
      } catch {
        // Best-effort stop.
      }
    }
    return;
  }

  const targetTab = await resolveLiveTakeoverTargetTab();
  if (!targetTab || !isInspectableUrl(targetTab.url)) {
      state.liveTakeover = createDisconnectedLiveTakeoverState(
        state.liveTakeover.endpoint,
        true,
        normalizeError("No visible content tab is available for live takeover.", "LIVE_TAKEOVER_UNAVAILABLE", { recoverable: true }),
        nowIso(),
        true,
      );
      commit({ kind: "error", error: state.liveTakeover.lastError ?? normalizeError("No visible content tab is available for live takeover.", "LIVE_TAKEOVER_UNAVAILABLE", { recoverable: true }) });
      return;
  }

  const previousTabId = state.liveTakeover.activeTabId;
  if (previousTabId !== null && previousTabId !== targetTab.tabId) {
    try {
      await sendContentRequest(previousTabId, {
        kind: "set-live-takeover",
        enabled: false,
        endpoint: state.liveTakeover.endpoint,
        tabId: previousTabId,
        windowId: state.liveTakeover.activeWindowId,
      });
    } catch {
      // Ignore stale attachment cleanup.
    }
  }

  try {
    const response = await sendContentRequest(targetTab.tabId, {
      kind: "set-live-takeover",
      enabled: true,
      endpoint: state.liveTakeover.endpoint,
      tabId: targetTab.tabId,
      windowId: targetTab.windowId ?? null,
    });

    if (response.kind !== "live-takeover-state") {
      throw new Error(`Unexpected live takeover response: ${response.kind}`);
    }

    state.liveTakeover = {
      ...state.liveTakeover,
      enabled: true,
      status: "connecting",
      activeTabId: targetTab.tabId,
      activeWindowId: targetTab.windowId ?? null,
      activeUrl: targetTab.url,
      activeTitle: targetTab.title,
      checkedAt: nowIso(),
      lastHeartbeat: response.lastHeartbeat,
      lastError: null,
    };
    commit();
  } catch (error) {
    state.liveTakeover = createDisconnectedLiveTakeoverState(
      state.liveTakeover.endpoint,
      true,
      normalizeError(error, "LIVE_TAKEOVER_UNAVAILABLE", { recoverable: true }),
      nowIso(),
      true,
    );
    commit({ kind: "error", error: state.liveTakeover.lastError ?? normalizeError(error, "LIVE_TAKEOVER_UNAVAILABLE", { recoverable: true }) });
  }
}

async function executeLiveTakeoverCommand(tabId: number, command: LiveTakeoverCommand): Promise<void> {
  const tabState = getTabState(tabId);
  const liveEndpoint = state.liveTakeover.endpoint;
  const startedAt = nowIso();

  if (isAwaitingUserIntervention(tabState)) {
    const intervention = getManualIntervention(tabState);
    pushLog(tabId, "warning", "Live takeover paused for a manual browser step.", intervention?.message ?? "Complete the step manually, then type done to continue.");
    commit();
    return;
  }

  markBusy(tabId, true);
  commit();

  try {
    let result: unknown = null;
    switch (command.type) {
      case "snapshot": {
        const mode = command.payload?.mode === "interactive" || command.payload?.mode === "summary" || command.payload?.mode === "suggestions" ? command.payload.mode : "full";
        const snapshot = await recordSnapshot(tabId, mode);
        result = {
          snapshotId: snapshot.snapshotId,
          summary: snapshot.summary,
          pageKind: snapshot.pageKind,
          capturedAt: snapshot.capturedAt,
        };
        break;
      }
      case "navigate": {
        const url = typeof command.payload?.url === "string" && command.payload.url.trim() ? command.payload.url : "about:blank";
        await chrome.tabs.update(tabId, { url });
        result = { navigatedTo: url };
        break;
      }
      case "click":
      case "fill":
      case "press": {
        const payload = command.payload as ContentTargetPayload & Record<string, unknown>;
        const response = await sendContentRequest(
          tabId,
          command.type === "click"
            ? {
                kind: "click",
                tabId,
                payload: buildLiveTakeoverTargetPayload(payload),
              }
            : command.type === "fill"
              ? {
                  kind: "fill",
                  tabId,
                  payload: {
                    ...buildLiveTakeoverTargetPayload(payload),
                    value: typeof payload.value === "string" ? payload.value : "",
                    ...(typeof payload.clearBeforeTyping === "boolean" ? { clearBeforeTyping: payload.clearBeforeTyping } : {}),
                  },
                }
              : {
                  kind: "press",
                  tabId,
                  payload: {
                    ...buildLiveTakeoverTargetPayload(payload),
                    ...(typeof payload.key === "string" ? { key: payload.key } : {}),
                    ...(typeof payload.submitForm === "boolean" ? { submitForm: payload.submitForm } : {}),
                  },
                },
        );

        if (response.kind === "content-error") {
          throw new Error(response.error.message);
        }

        if (response.kind !== "action-result") {
          throw new Error(`Unexpected content response: ${response.kind}`);
        }

        result = response.result;
        break;
      }
    }

    const executionResult = {
      commandId: command.id,
      ok: true,
      result,
      ts: startedAt,
    };
    await postLiveTakeoverResult(liveEndpoint, executionResult);
    pushLog(tabId, "success", `Executed live takeover ${command.type}.`, typeof result === "string" ? result : JSON.stringify(result, null, 2));
    commit();
  } catch (error) {
    const normalized = normalizeError(error, "LIVE_TAKEOVER_COMMAND_FAILED", { tabId, recoverable: true });
    await postLiveTakeoverResult(liveEndpoint, {
      commandId: command.id,
      ok: false,
      result: {
        error: normalized.message,
        details: normalized.details ?? null,
      },
      ts: nowIso(),
    });
    setLastError(tabId, normalized);
    pushLog(tabId, "error", `Live takeover ${command.type} failed.`, normalized.message);
    commit({ kind: "error", error: normalized });
  } finally {
    markBusy(tabId, false);
    commit();
  }
}

async function resolveLiveTakeoverTargetTab(): Promise<TrackedTabState | null> {
  const preferredTabId = state.liveTakeover.activeTabId;
  const preferred = chooseLiveTakeoverTab(Object.values(state.tabs), preferredTabId);
  if (preferred) {
    return preferred;
  }

  await refreshKnownTabs();
  return chooseLiveTakeoverTab(Object.values(state.tabs), preferredTabId);
}

async function pollLiveTakeover(): Promise<void> {
  if (liveTakeoverPollInFlight || !state.liveTakeover.enabled) {
    return;
  }

  liveTakeoverPollInFlight = true;
  try {
    const targetTab = await resolveLiveTakeoverTargetTab();
    if (!targetTab || !isInspectableUrl(targetTab.url)) {
      await refreshLiveTakeoverStatus();
      return;
    }

    if (state.activeTabId !== targetTab.tabId) {
      await focusTrackedTab(targetTab.tabId);
    }

    const heartbeatTs = nowIso();
    const synced = await syncActiveTab(targetTab.tabId);
    const tabState = synced ?? getTabState(targetTab.tabId);
    if (!isInspectableUrl(tabState.url)) {
      await refreshLiveTakeoverStatus();
      return;
    }

    await postLiveTakeoverHeartbeat(state.liveTakeover.endpoint, {
      tabId: tabState.tabId,
      windowId: tabState.windowId ?? null,
      url: tabState.url ?? null,
      title: tabState.title ?? null,
      ts: heartbeatTs,
    });

    if (isAwaitingUserIntervention(tabState)) {
      await refreshLiveTakeoverStatus();
      return;
    }

    const command = await getNextLiveTakeoverCommand(state.liveTakeover.endpoint, tabState.tabId, tabState.url ?? null);
    if (command) {
      await executeLiveTakeoverCommand(tabState.tabId, command);
    }

    await refreshLiveTakeoverStatus();
  } catch (error) {
    state.liveTakeover = createDisconnectedLiveTakeoverState(
      state.liveTakeover.endpoint,
      true,
      normalizeError(error, "LIVE_TAKEOVER_UNAVAILABLE", { recoverable: true }),
      nowIso(),
      true,
    );
    pushLog(state.activeTabId ?? null, "error", "Live takeover polling failed.", summarizeLiveTakeoverState(state.liveTakeover));
    commit({ kind: "error", error: state.liveTakeover.lastError ?? normalizeError(error, "LIVE_TAKEOVER_UNAVAILABLE", { recoverable: true }) });
  } finally {
    liveTakeoverPollInFlight = false;
  }
}

async function resolveSemanticTarget(tabId: number, selector: string): Promise<{ elementId: string; label: string } | null> {
  try {
    const response = await sendContentRequest(tabId, { kind: "resolve-selector", selector });
    if (response.kind !== "resolve-selector-result" || !response.elementId) {
      return null;
    }

    return {
      elementId: response.elementId,
      label: response.label || response.tagName || selector,
    };
  } catch {
    return null;
  }
}

async function mergeSemanticSuggestions(tabId: number, snapshot: PageSnapshot): Promise<void> {
  const observation = await requestSemanticObservation(snapshot);
  state.semantic = updateSemanticStateWithObservation(state.semantic, observation);

  if (observation.status !== "ready" || observation.actions.length === 0) {
    commit();
    return;
  }

  const semanticSuggestions = await buildSemanticSuggestions(observation, snapshot, async (selector) => resolveSemanticTarget(tabId, selector));
  if (semanticSuggestions.length === 0) {
    commit();
    return;
  }

  const mergedSnapshot = {
    ...snapshot,
    suggestedActions: [...snapshot.suggestedActions, ...semanticSuggestions],
  };

  replaceTabState(tabId, (current) => ({
    ...current,
    snapshot: mergedSnapshot,
    pageState: resolvePageStateFromSnapshot(mergedSnapshot),
    snapshotFresh: true,
    lastSeenAt: nowIso(),
  }));

  state.semantic = {
    ...state.semantic,
    observedAt: observation.observedAt,
    pageUrl: observation.pageUrl,
    pageTitle: observation.pageTitle,
    suggestionCount: semanticSuggestions.length,
  };

  pushLog(tabId, "success", "Added semantic suggestions from Stagehand.", `${semanticSuggestions.length} suggestion${semanticSuggestions.length === 1 ? "" : "s"} added.`);
  commit({ kind: "page-snapshot", tabId, snapshot: mergedSnapshot });
}

function mergeWorkflowSuggestions(tabId: number, snapshot: PageSnapshot): void {
  const workflowSuggestions = buildWorkflowSuggestions(state.workflow, snapshot);
  if (workflowSuggestions.length === 0) {
    return;
  }

  const tabState = getTabState(tabId);
  const currentSnapshot = tabState.snapshot ?? snapshot;
  const mergedSnapshot = {
    ...currentSnapshot,
    suggestedActions: [...workflowSuggestions, ...currentSnapshot.suggestedActions],
  };

  replaceTabState(tabId, (current) => ({
    ...current,
    snapshot: mergedSnapshot,
    pageState: resolvePageStateFromSnapshot(mergedSnapshot),
    snapshotFresh: true,
    lastSeenAt: nowIso(),
  }));

  commit({ kind: "page-snapshot", tabId, snapshot: mergedSnapshot });
}

function setLastError(tabId: number, error: ReturnType<typeof normalizeError> | null): void {
  replaceTabState(tabId, (current) => ({
    ...current,
    lastError: error,
    lastSeenAt: nowIso(),
  }));
}

function pushLog(tabId: number | null, level: "debug" | "info" | "success" | "warning" | "error", message: string, details?: string): void {
  if (tabId === null) {
    return;
  }

  const entry = createActivityLogEntry(level, message, { tabId, details });
  replaceTabState(tabId, (current) => ({
    ...current,
    activityLog: truncateEntries([...current.activityLog, entry], MAX_ACTIVITY_LOG_ENTRIES),
    lastSeenAt: nowIso(),
  }));
}

function logManualInterventionTransition(tabId: number, previousKind: "login" | "payment" | null | undefined, pageState: PageStateBasic): void {
  if (!pageState.userInterventionKind || pageState.userInterventionKind === previousKind) {
    return;
  }

  pushLog(tabId, "warning", `Manual ${pageState.userInterventionKind} step detected.`, pageState.userInterventionMessage ?? "Please complete the step manually, then type done to continue.");
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

function updateTabContextFromChromeTab(tab: chrome.tabs.Tab, options: UpdateTabContextOptions = {}): TrackedTabState {
  if (typeof tab.id !== "number") {
    throw new Error("Tab is missing an id.");
  }

  const markActive = options.markActive ?? true;
  const current = getTabState(tab.id);
  const nextUrl = tab.url ?? current.url;
  const nextTitle = tab.title ?? current.title;
  const urlChanged = nextUrl !== current.url;
  const titleChanged = nextTitle !== current.title;

  const next = {
    ...current,
    windowId: tab.windowId ?? current.windowId,
    active: markActive ? Boolean(tab.active) || state.activeTabId === tab.id : state.activeTabId === tab.id,
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
  if (markActive && tab.active) {
    setActiveTab(tab.id);
  }

  if ((urlChanged || titleChanged) && options.logChanges !== false) {
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

async function refreshKnownTabs(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (typeof tab.id !== "number") {
        continue;
      }

      updateTabContextFromChromeTab(tab, { markActive: false, logChanges: false });
    }

    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeTab = activeTabs.find((tab): tab is chrome.tabs.Tab & { id: number } => typeof tab.id === "number") ?? null;
    if (activeTab) {
      updateTabContextFromChromeTab(activeTab, { markActive: true, logChanges: false });
    } else if (state.activeTabId !== null && !state.tabs[state.activeTabId]) {
      state.activeTabId = null;
    }

    commit();
  } catch (error) {
    const normalized = normalizeError(error, "TAB_REFRESH_FAILED", { recoverable: true });
    const tabId = state.activeTabId ?? null;
    if (tabId !== null) {
      setLastError(tabId, normalized);
      pushLog(tabId, "error", "Failed to refresh tab inventory.", normalized.message);
    }
    commit({ kind: "error", error: normalized });
  }
}

async function focusTrackedTab(tabId: number): Promise<TrackedTabState | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (typeof tab.windowId === "number") {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        // The window may already be focused or unavailable; continue to tab activation.
      }
    }

    await chrome.tabs.update(tabId, { active: true });
    const synced = await syncActiveTab(tabId);
    if (synced) {
      pushLog(tabId, "info", "Focused tab.", summarizeTrackedTab(synced));
    }

    return synced;
  } catch (error) {
    const normalized = normalizeError(error, "TAB_FOCUS_FAILED", { tabId, recoverable: true });
    setLastError(tabId, normalized);
    pushLog(tabId, "error", "Failed to focus tab.", normalized.message);
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
  const previousInterventionKind = getTabState(tabId).pageState?.userInterventionKind;
  replaceTabState(tabId, (current) => ({
    ...current,
    snapshot,
    pageState,
    contentReady: true,
    snapshotFresh: true,
    lastError: null,
    lastSeenAt: nowIso(),
  }));
  logManualInterventionTransition(tabId, previousInterventionKind, pageState);
  state.workflow = recordWorkflowPageState(state.workflow, tabId, pageState, snapshot);
  pushLog(tabId, "success", `Captured ${mode} page snapshot.`, `Interactive controls: ${snapshot.interactiveElements.length}`);
  commit({ kind: "page-snapshot", tabId, snapshot });
  return snapshot;
}

async function scanActiveTab(
  mode: ScanMode,
  workflowContext: { workflowId?: string; workflowStepId?: string } | null = null,
): Promise<void> {
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
    const snapshot = await recordSnapshot(tabId, mode);
    if (workflowContext?.workflowId && workflowContext.workflowStepId) {
      state.workflow = markWorkflowRequestCompleted(state.workflow, workflowContext, snapshot.summary);
      commit();
    }
    if (mode === "suggestions" && state.semantic.status === "ready") {
      await mergeSemanticSuggestions(tabId, snapshot);
    }
    if (mode === "suggestions") {
      mergeWorkflowSuggestions(tabId, snapshot);
    }
  } catch (error) {
    const normalized = normalizeError(error, "CAPTURE_FAILED", { tabId, recoverable: true });
    if (workflowContext?.workflowId && workflowContext.workflowStepId) {
      state.workflow = markWorkflowRequestFailed(state.workflow, workflowContext, normalized.message);
    }
    setLastError(tabId, normalized);
    markContentReady(tabId, false);
    pushLog(tabId, "error", "Failed to capture the page.", `${normalized.message}${normalized.details ? ` | ${normalized.details}` : ""}`);
    commit({ kind: "error", error: normalized });
  } finally {
    markBusy(tabId, false);
    commit();
  }
}

async function scanTrackedTab(
  tabId: number,
  mode: ScanMode,
  workflowContext: { workflowId?: string; workflowStepId?: string } | null = null,
): Promise<void> {
  const tabState = getTabState(tabId);
  if (!isInspectableUrl(tabState.url)) {
    const error = normalizeError(`The tab cannot be inspected: ${tabState.url || "unknown url"}`, "UNSUPPORTED_URL", {
      tabId,
      recoverable: true,
    });
    setLastError(tabId, error);
    pushLog(tabId, "warning", "Scan blocked because the selected tab is not inspectable.", error.message);
    commit({ kind: "error", error });
    return;
  }

  if (state.activeTabId !== tabId) {
    const focused = await focusTrackedTab(tabId);
    if (!focused) {
      return;
    }
  } else {
    await syncActiveTab(tabId);
  }

  await scanActiveTab(mode, workflowContext);
}

function pruneApprovals(approvals: ApprovalRequest[]): ApprovalRequest[] {
  return truncateEntries(approvals, MAX_APPROVAL_QUEUE_ENTRIES);
}

function findApprovalById(approvalId: string): { tabId: number; approval: ApprovalRequest } | null {
  for (const [tabKey, tabState] of Object.entries(state.tabs)) {
    const tabId = Number.parseInt(tabKey, 10);
    if (!Number.isFinite(tabId)) {
      continue;
    }

    const approval = tabState.approvals.find((entry) => entry.approvalId === approvalId);
    if (approval) {
      return { tabId, approval };
    }
  }

  return null;
}

async function queueActionForApproval(action: ActionRequest): Promise<void> {
  const tabId = resolveActionTabId(action) ?? state.activeTabId;
  if (tabId === null) {
    const error = normalizeError("No active tab is available.", "NO_ACTIVE_TAB", { recoverable: true });
    commit({ kind: "error", error });
    return;
  }

  const tabState = getTabState(tabId);
  const snapshot = tabState.snapshot;

  if (isAwaitingUserIntervention(tabState)) {
    const intervention = getManualIntervention(tabState);
    pushLog(tabId, "warning", "Paused for a manual browser step.", intervention?.message ?? "Complete the login or payment step manually, then type done to continue.");
    commit();
    return;
  }

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

  state.workflow = markWorkflowStepQueued(state.workflow, action);
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

  if (isAwaitingUserIntervention(tabState)) {
    const intervention = getManualIntervention(tabState);
    pushLog(tabId, "warning", "Paused for a manual browser step.", intervention?.message ?? "Complete the login or payment step manually, then type done to continue.");
    commit();
    return;
  }

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
    state.workflow = markWorkflowStepCompleted(state.workflow, action, result.message);

    pushLog(tabId, "success", `Executed ${actionLabel}.`, result.message);
    commit({ kind: "action-result", result });
  } catch (error) {
    const normalized = normalizeError(error, "ACTION_FAILED", { tabId, recoverable: true });
    state.workflow = markWorkflowStepFailed(state.workflow, action, normalized.message);
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
  const approvalLocation = findApprovalById(approvalId);
  if (!approvalLocation) {
    return;
  }

  const { tabId, approval } = approvalLocation;
  if (approval.status !== "pending") {
    return;
  }

  if (state.activeTabId !== tabId) {
    await focusTrackedTab(tabId);
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
  const approvalLocation = findApprovalById(approvalId);
  if (!approvalLocation) {
    return;
  }

  const { tabId, approval } = approvalLocation;

  const updated: ApprovalRequest = {
    ...approval,
    status: "rejected",
    updatedAt: nowIso(),
  };

  state.workflow = markWorkflowStepFailed(state.workflow, approval.action, "Rejected by user.");

  replaceTabState(tabId, (current) => ({
    ...current,
    approvals: current.approvals.map((entry) => (entry.approvalId === approvalId ? updated : entry)),
    lastSeenAt: nowIso(),
  }));
  pushLog(tabId, "warning", "Rejected an action request.", updated.title);
  commit({ kind: "approval-updated", approval: updated });
}

async function resumeManualIntervention(): Promise<void> {
  const tabId = state.activeTabId;
  if (tabId === null) {
    return;
  }

  await syncActiveTab(tabId);
  pushLog(tabId, "info", "Manual step completed.", "Rescanning the current page and resuming the workflow.");
  await scanActiveTab("suggestions");

  const tabState = getTabState(tabId);
  const intervention = getManualIntervention(tabState);
  if (intervention) {
    pushLog(tabId, "warning", "Manual step is still pending.", intervention.message);
    commit();
    return;
  }

  const nextRequest = state.workflow.activeWorkflow ? getActiveWorkflowNextRequest(state.workflow) : null;
  if (nextRequest?.kind === "request-action") {
    await queueActionForApproval(nextRequest.action);
  }
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
  const workflowContext =
    "workflowId" in request || "workflowStepId" in request
      ? {
          ...(typeof (request as { workflowId?: string }).workflowId === "string" ? { workflowId: (request as { workflowId?: string }).workflowId } : {}),
          ...(typeof (request as { workflowStepId?: string }).workflowStepId === "string" ? { workflowStepId: (request as { workflowStepId?: string }).workflowStepId } : {}),
        }
      : null;

  switch (request.kind) {
    case "get-state":
      await refreshKnownTabs();
      port.postMessage({ kind: "state", state } satisfies UiEvent);
      void refreshBridgeStatus();
      void refreshSemanticStatus();
      return;
    case "scan-page":
      if (resolveSuggestedRequestTabId(request) !== null) {
        await scanTrackedTab(resolveSuggestedRequestTabId(request)!, request.mode, workflowContext);
      } else {
        await scanActiveTab(request.mode, workflowContext);
      }
      return;
    case "list-interactive-elements":
      if (resolveSuggestedRequestTabId(request) !== null) {
        await scanTrackedTab(resolveSuggestedRequestTabId(request)!, "interactive", workflowContext);
      } else {
        await scanActiveTab("interactive", workflowContext);
      }
      return;
    case "summarize-page":
      if (resolveSuggestedRequestTabId(request) !== null) {
        await scanTrackedTab(resolveSuggestedRequestTabId(request)!, "summary", workflowContext);
      } else {
        await scanActiveTab("summary", workflowContext);
      }
      return;
    case "suggest-next-actions":
      if (resolveSuggestedRequestTabId(request) !== null) {
        await scanTrackedTab(resolveSuggestedRequestTabId(request)!, "suggestions", workflowContext);
      } else {
        await scanActiveTab("suggestions", workflowContext);
      }
      return;
    case "request-action":
      await queueActionForApproval(request.action);
      return;
    case "plan-workflow":
      state.workflow = recordWorkflowPlan(state.workflow, request.workflow, getActiveTabState()?.snapshot ?? null);
      if (state.activeTabId !== null) {
        pushLog(
          state.activeTabId,
          "info",
          "Planned a workflow.",
          `${request.workflow.steps.length} step${request.workflow.steps.length === 1 ? "" : "s"} · ${request.workflow.objective}`,
        );
      }
      commit();
      return;
    case "refresh-tabs":
      await refreshKnownTabs();
      return;
    case "focus-tab":
      await focusTrackedTab(request.tabId);
      return;
    case "scan-tab":
      await scanTrackedTab(
        request.tabId,
        request.mode,
        request.workflowId || request.workflowStepId
          ? {
              ...(request.workflowId ? { workflowId: request.workflowId } : {}),
              ...(request.workflowStepId ? { workflowStepId: request.workflowStepId } : {}),
            }
          : null,
      );
      return;
    case "approve-action":
      await approveAction(request.approvalId);
      return;
    case "reject-action":
      await rejectAction(request.approvalId);
      return;
    case "refresh-bridge":
      await refreshBridgeStatus();
      return;
    case "refresh-semantic":
      await refreshSemanticStatus();
      return;
    case "refresh-live-takeover":
      await refreshLiveTakeoverStatus();
      return;
    case "toggle-live-takeover":
      toggleLiveTakeoverEnabled();
      return;
    case "resume-user-intervention":
      await resumeManualIntervention();
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
      const previousInterventionKind = getTabState(tabId).pageState?.userInterventionKind;
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
      logManualInterventionTransition(tabId, previousInterventionKind, nextState);
      state.workflow = recordWorkflowPageState(state.workflow, tabId, nextState, null);
      if (state.liveTakeover.enabled && state.liveTakeover.activeTabId === tabId) {
        void syncLiveTakeoverMode(true);
      }
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
if (shouldAutoEnableLiveTakeover(state.liveTakeover)) {
  setLiveTakeoverEnabled(true);
} else {
  scheduleLiveTakeoverPolling();
  if (state.liveTakeover.enabled) {
    void refreshLiveTakeoverStatus();
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "codex-ui") {
    return;
  }

  uiPorts.add(port);
  port.postMessage({ kind: "state", state } satisfies UiEvent);
  void refreshBridgeStatus();
  void refreshSemanticStatus();
  void refreshLiveTakeoverStatus();
  scheduleBridgePolling();
  scheduleSemanticPolling();
  scheduleLiveTakeoverPolling();
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
    if (uiPorts.size === 0 && bridgeRefreshTimer !== null) {
      clearInterval(bridgeRefreshTimer);
      bridgeRefreshTimer = null;
    }
    if (uiPorts.size === 0 && semanticRefreshTimer !== null) {
      clearInterval(semanticRefreshTimer);
      semanticRefreshTimer = null;
    }
  });
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (typeof message === "object" && message !== null && (message as { kind?: unknown }).kind === "get-live-takeover-context") {
    const tabId = resolveTabIdFromSender(sender);
    const tabState = tabId !== null ? getTabState(tabId) : null;
    const visibleUrl = tabState?.url ?? sender.tab?.url ?? null;
    const autoEnable = shouldAutoEnableLiveTakeover(state.liveTakeover);
    if (autoEnable) {
      setLiveTakeoverEnabled(true);
    }

    sendResponse({
      kind: "live-takeover-context",
      enabled: state.liveTakeover.enabled || autoEnable,
      shouldStart: Boolean((state.liveTakeover.enabled || autoEnable) && tabId !== null && isInspectableUrl(visibleUrl ?? undefined)),
      endpoint: state.liveTakeover.endpoint,
      tabId,
      windowId: sender.tab?.windowId ?? tabState?.windowId ?? null,
      lastHeartbeat: state.liveTakeover.lastHeartbeat,
    });
    return;
  }

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

chrome.tabs.onCreated.addListener((tab) => {
  if (typeof tab.id !== "number") {
    return;
  }

  updateTabContextFromChromeTab(tab, { markActive: false, logChanges: false });
  commit();
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
  const wasActive = state.activeTabId === tabId;
  if (wasActive) {
    state.activeTabId = null;
  }
  commit();
  if (wasActive) {
    void refreshKnownTabs();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void persistState();
  void refreshKnownTabs();
  void refreshBridgeStatus();
  void refreshSemanticStatus();
  void refreshLiveTakeoverStatus();
  scheduleLiveTakeoverPolling();
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  void refreshKnownTabs();
  scheduleLiveTakeoverPolling();
  if (state.liveTakeover.enabled) {
    void refreshLiveTakeoverStatus();
  }
});

chrome.action.setBadgeText({ text: "" }).catch(() => undefined);
