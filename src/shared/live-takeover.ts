import { DEFAULT_LIVE_TAKEOVER_ENDPOINT } from "./constants";
import { nowIso, normalizeError } from "./logger";
import type {
  AppError,
  LiveTakeoverActiveTab,
  LiveTakeoverCommand,
  LiveTakeoverCommandResult,
  LiveTakeoverConnectionState,
  LiveTakeoverHealthSnapshot,
  LiveTakeoverState,
  TrackedTabState,
} from "./types";

export interface LiveTakeoverServerState {
  startedAt: string;
  lastHeartbeat: string | null;
  activeTab: LiveTakeoverActiveTab;
  queue: LiveTakeoverCommand[];
  results: Record<string, LiveTakeoverCommandResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

export function isLiveTakeoverCommandType(value: unknown): value is LiveTakeoverCommand["type"] {
  return value === "snapshot" || value === "click" || value === "fill" || value === "press" || value === "navigate";
}

export function createInitialLiveTakeoverServerState(): LiveTakeoverServerState {
  return {
    startedAt: nowIso(),
    lastHeartbeat: null,
    activeTab: {
      tabId: null,
      windowId: null,
      url: null,
      title: null,
      ts: null,
    },
    queue: [],
    results: {},
  };
}

export function normalizeLiveTakeoverCommand(value: unknown): LiveTakeoverCommand | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = toStringOrNull(value.id);
  const type = isLiveTakeoverCommandType(value.type) ? value.type : null;
  const createdAt = toStringOrNull(value.createdAt);
  const claimedAt = toStringOrNull(value.claimedAt);
  if (!id || !type || !createdAt) {
    return null;
  }

  return {
    id,
    type,
    payload: isRecord(value.payload) ? { ...value.payload } : {},
    createdAt,
    ...(claimedAt ? { claimedAt } : {}),
    tabId: toNumberOrNull(value.tabId),
    url: toStringOrNull(value.url),
  };
}

export function normalizeLiveTakeoverCommandResult(value: unknown): LiveTakeoverCommandResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const commandId = toStringOrNull(value.commandId);
  const ts = toStringOrNull(value.ts);
  if (!commandId || !ts) {
    return null;
  }

  return {
    commandId,
    ok: typeof value.ok === "boolean" ? value.ok : false,
    result: "result" in value ? value.result : null,
    ts,
  };
}

export function normalizeLiveTakeoverServerState(value: unknown): LiveTakeoverServerState {
  const fallback = createInitialLiveTakeoverServerState();
  if (!isRecord(value)) {
    return fallback;
  }

  const queue = Array.isArray(value.queue)
    ? value.queue.map((entry) => normalizeLiveTakeoverCommand(entry)).filter((entry): entry is LiveTakeoverCommand => entry !== null)
    : [];
  const results: Record<string, LiveTakeoverCommandResult> = {};
  if (isRecord(value.results)) {
    for (const [key, entry] of Object.entries(value.results)) {
      const normalized = normalizeLiveTakeoverCommandResult(entry);
      if (normalized) {
        results[key] = normalized;
      }
    }
  }

  return {
    startedAt: toStringOrNull(value.startedAt) ?? fallback.startedAt,
    lastHeartbeat: toStringOrNull(value.lastHeartbeat),
    activeTab: {
      tabId: isRecord(value.activeTab) ? toNumberOrNull(value.activeTab.tabId) : null,
      windowId: isRecord(value.activeTab) ? toNumberOrNull(value.activeTab.windowId) : null,
      url: isRecord(value.activeTab) ? toStringOrNull(value.activeTab.url) : null,
      title: isRecord(value.activeTab) ? toStringOrNull(value.activeTab.title) : null,
      ts: isRecord(value.activeTab) ? toStringOrNull(value.activeTab.ts) : null,
    },
    queue,
    results,
  };
}

export function buildLiveTakeoverHealthSnapshot(state: LiveTakeoverServerState): LiveTakeoverHealthSnapshot {
  return {
    startedAt: state.startedAt,
    lastHeartbeat: state.lastHeartbeat,
    activeTab: state.activeTab,
    queueLength: state.queue.filter((command) => !command.claimedAt).length,
    checkedAt: nowIso(),
  };
}

function isLiveTakeoverInspectableUrl(url: string | null | undefined): boolean {
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

function compareLiveTakeoverTabs(left: TrackedTabState, right: TrackedTabState): number {
  if (left.active !== right.active) {
    return left.active ? -1 : 1;
  }

  if (left.contentReady !== right.contentReady) {
    return left.contentReady ? -1 : 1;
  }

  if (left.snapshotFresh !== right.snapshotFresh) {
    return left.snapshotFresh ? -1 : 1;
  }

  const leftSeen = Number.isFinite(Date.parse(left.lastSeenAt)) ? Date.parse(left.lastSeenAt) : 0;
  const rightSeen = Number.isFinite(Date.parse(right.lastSeenAt)) ? Date.parse(right.lastSeenAt) : 0;
  if (leftSeen !== rightSeen) {
    return rightSeen - leftSeen;
  }

  return left.tabId - right.tabId;
}

export function chooseLiveTakeoverTab(tabs: TrackedTabState[], preferredTabId: number | null = null): TrackedTabState | null {
  const candidates = tabs.filter((tab) => isLiveTakeoverInspectableUrl(tab.url));
  if (candidates.length === 0) {
    return null;
  }

  if (typeof preferredTabId === "number" && Number.isFinite(preferredTabId)) {
    const preferred = candidates.find((tab) => tab.tabId === preferredTabId);
    if (preferred) {
      return preferred;
    }
  }

  return [...candidates].sort(compareLiveTakeoverTabs)[0] ?? null;
}

export function claimNextLiveTakeoverCommand(
  state: LiveTakeoverServerState,
  tabId: number | null,
  url: string | null,
): LiveTakeoverCommand | null {
  const command = state.queue.find((entry) => {
    if (entry.claimedAt) {
      return false;
    }

    if (entry.tabId !== null && entry.tabId !== undefined && tabId !== null && entry.tabId !== tabId) {
      return false;
    }

    if (entry.url && url && entry.url !== url) {
      return false;
    }

    if (entry.tabId !== null && entry.tabId !== undefined && tabId === null) {
      return false;
    }

    if (entry.url && !url) {
      return false;
    }

    return true;
  });

  if (!command) {
    return null;
  }

  command.claimedAt = nowIso();
  return command;
}

export function recordLiveTakeoverResult(state: LiveTakeoverServerState, result: LiveTakeoverCommandResult): LiveTakeoverServerState {
  return {
    ...state,
    results: {
      ...state.results,
      [result.commandId]: result,
    },
    queue: state.queue.filter((command) => command.id !== result.commandId),
  };
}

export function createDisconnectedLiveTakeoverState(
  endpoint = DEFAULT_LIVE_TAKEOVER_ENDPOINT,
  enabled = false,
  error: AppError | null = null,
  checkedAt: string | null = null,
  hasBeenInitialized = false,
): LiveTakeoverState {
  return {
    endpoint,
    enabled,
    status: enabled ? (error ? "error" : "disconnected") : "disabled",
    hasBeenInitialized,
    activeTabId: null,
    activeWindowId: null,
    activeUrl: null,
    activeTitle: null,
    queueLength: 0,
    checkedAt,
    lastHeartbeat: null,
    lastError: error,
  };
}

export function shouldAutoEnableLiveTakeover(state: LiveTakeoverState): boolean {
  return !state.enabled && !state.hasBeenInitialized;
}

export function buildLiveTakeoverState(
  snapshot: LiveTakeoverHealthSnapshot,
  options: { endpoint?: string; enabled?: boolean; lastError?: AppError | null; hasBeenInitialized?: boolean } = {},
): LiveTakeoverState {
  const endpoint = options.endpoint ?? DEFAULT_LIVE_TAKEOVER_ENDPOINT;
  const enabled = options.enabled ?? true;
  const activeTabId = snapshot.activeTab.tabId;
  const hasActiveTab = typeof activeTabId === "number" && Number.isFinite(activeTabId);
  const status: LiveTakeoverConnectionState = options.lastError
    ? "error"
    : !enabled
      ? "disabled"
      : hasActiveTab
        ? "connected"
        : "connecting";

  return {
    endpoint,
    enabled,
    status,
    hasBeenInitialized: options.hasBeenInitialized ?? false,
    activeTabId: hasActiveTab ? activeTabId : null,
    activeWindowId: typeof snapshot.activeTab.windowId === "number" && Number.isFinite(snapshot.activeTab.windowId) ? snapshot.activeTab.windowId : null,
    activeUrl: snapshot.activeTab.url,
    activeTitle: snapshot.activeTab.title,
    queueLength: snapshot.queueLength,
    checkedAt: snapshot.checkedAt,
    lastHeartbeat: snapshot.lastHeartbeat,
    lastError: options.lastError ?? null,
  };
}

export function liveTakeoverStatusTone(status: LiveTakeoverConnectionState): "neutral" | "warning" | "success" | "danger" {
  switch (status) {
    case "connected":
      return "success";
    case "connecting":
      return "warning";
    case "error":
    case "disconnected":
      return "danger";
    case "disabled":
      return "neutral";
  }
}

export function liveTakeoverStatusLabel(status: LiveTakeoverConnectionState): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "error":
      return "Error";
    case "disconnected":
      return "Disconnected";
    case "disabled":
      return "Disabled";
  }
}

export function summarizeLiveTakeoverState(state: LiveTakeoverState): string {
  if (!state.enabled) {
    return "Live takeover mode is disabled. Enable it to attach the visible Chrome tab to the local command queue.";
  }

  if (state.status === "error") {
    return state.lastError?.message ?? `The live takeover bridge at ${state.endpoint} reported an error.`;
  }

  if (state.status === "disconnected") {
    return `No live takeover bridge detected at ${state.endpoint}. Run \`npm run live-takeover\` to start one.`;
  }

  if (state.status === "connecting") {
    return `Live takeover bridge is up and waiting for the visible Chrome tab to heartbeat.`;
  }

  const tabLabel = state.activeTitle || state.activeUrl || `tab ${state.activeTabId ?? "unknown"}`;
  const queueLabel = state.queueLength === 1 ? "1 queued command" : `${state.queueLength} queued commands`;
  return `Attached to ${tabLabel} with ${queueLabel}.`;
}

export function normalizeLiveTakeoverError(error: unknown, code = "LIVE_TAKEOVER_ERROR", options: { recoverable?: boolean } = {}): AppError {
  return normalizeError(error, code, { recoverable: options.recoverable ?? true });
}
