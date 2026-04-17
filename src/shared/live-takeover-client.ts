import {
  DEFAULT_LIVE_TAKEOVER_ENDPOINT,
  LIVE_TAKEOVER_REQUEST_TIMEOUT_MS,
} from "./constants";
import {
  buildLiveTakeoverState,
  createDisconnectedLiveTakeoverState,
  normalizeLiveTakeoverError,
} from "./live-takeover";
import type {
  LiveTakeoverCommand,
  LiveTakeoverCommandResult,
  LiveTakeoverHealthSnapshot,
  LiveTakeoverState,
  LiveTakeoverActiveTab,
} from "./types";
import { nowIso } from "./logger";

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request to ${url} failed with HTTP ${response.status}.`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeActiveTab(value: unknown): LiveTakeoverActiveTab {
  if (typeof value !== "object" || value === null) {
    return {
      tabId: null,
      windowId: null,
      url: null,
      title: null,
      ts: null,
    };
  }

  const record = value as Record<string, unknown>;
  return {
    tabId: typeof record.tabId === "number" && Number.isFinite(record.tabId) ? record.tabId : null,
    windowId: typeof record.windowId === "number" && Number.isFinite(record.windowId) ? record.windowId : null,
    url: typeof record.url === "string" && record.url.trim() ? record.url : null,
    title: typeof record.title === "string" && record.title.trim() ? record.title : null,
    ts: typeof record.ts === "string" && record.ts.trim() ? record.ts : null,
  };
}

function normalizeHealthSnapshot(value: unknown): LiveTakeoverHealthSnapshot | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const startedAt = typeof record.startedAt === "string" && record.startedAt.trim() ? record.startedAt : null;
  const checkedAt = typeof record.checkedAt === "string" && record.checkedAt.trim() ? record.checkedAt : null;
  if (!startedAt || !checkedAt) {
    return null;
  }

  return {
    startedAt,
    lastHeartbeat: typeof record.lastHeartbeat === "string" && record.lastHeartbeat.trim() ? record.lastHeartbeat : null,
    activeTab: normalizeActiveTab(record.activeTab),
    queueLength: typeof record.queueLength === "number" && Number.isFinite(record.queueLength) ? record.queueLength : 0,
    checkedAt,
  };
}

export async function fetchLiveTakeoverState(
  endpoint = DEFAULT_LIVE_TAKEOVER_ENDPOINT,
  options: { enabled?: boolean; hasBeenInitialized?: boolean } = {},
): Promise<LiveTakeoverState> {
  try {
    const health = await fetchJson<unknown>(`${endpoint}/health`, LIVE_TAKEOVER_REQUEST_TIMEOUT_MS);
    const snapshot = normalizeHealthSnapshot(health);
    if (!snapshot) {
      throw new Error("Invalid live takeover health response.");
    }

    return buildLiveTakeoverState(snapshot, {
      endpoint,
      enabled: options.enabled ?? true,
      hasBeenInitialized: options.hasBeenInitialized ?? false,
    });
  } catch (error) {
    return createDisconnectedLiveTakeoverState(
      endpoint,
      options.enabled ?? true,
      normalizeLiveTakeoverError(error, "LIVE_TAKEOVER_UNAVAILABLE", { recoverable: true }),
      nowIso(),
      options.hasBeenInitialized ?? false,
    );
  }
}

export async function postLiveTakeoverHeartbeat(
  endpoint = DEFAULT_LIVE_TAKEOVER_ENDPOINT,
  heartbeat: { tabId: number | null; windowId: number | null; url: string | null; title: string | null; ts: string },
  options: { keepalive?: boolean } = {},
): Promise<void> {
  const response = await fetch(`${endpoint}/v1/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(heartbeat),
    keepalive: options.keepalive ?? false,
  });

  if (!response.ok) {
    throw new Error(`Heartbeat failed (${response.status}).`);
  }
}

export async function getNextLiveTakeoverCommand(
  endpoint = DEFAULT_LIVE_TAKEOVER_ENDPOINT,
  tabId: number | null,
  url: string | null,
): Promise<LiveTakeoverCommand | null> {
  const requestUrl = new URL(`${endpoint}/v1/commands/next`);
  if (typeof tabId === "number" && Number.isFinite(tabId)) {
    requestUrl.searchParams.set("tabId", String(tabId));
  }
  if (url) {
    requestUrl.searchParams.set("url", url);
  }

  const response = await fetch(requestUrl.toString(), { method: "GET" });
  if (response.status === 204) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Command poll failed (${response.status}).`);
  }

  const body = (await response.json()) as { command?: LiveTakeoverCommand | null };
  return body.command ?? null;
}

export async function postLiveTakeoverResult(
  endpoint = DEFAULT_LIVE_TAKEOVER_ENDPOINT,
  result: LiveTakeoverCommandResult,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  const response = await fetch(`${endpoint}/v1/results`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
    keepalive: options.keepalive ?? false,
  });

  if (!response.ok) {
    throw new Error(`Result post failed (${response.status}).`);
  }
}

export async function enqueueLiveTakeoverCommand(
  endpoint = DEFAULT_LIVE_TAKEOVER_ENDPOINT,
  command: Omit<LiveTakeoverCommand, "id" | "createdAt"> & { payload?: Record<string, unknown> },
): Promise<LiveTakeoverCommand> {
  const response = await fetch(`${endpoint}/v1/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    throw new Error(`Command enqueue failed (${response.status}).`);
  }

  const body = (await response.json()) as { command?: LiveTakeoverCommand | null };
  if (!body.command) {
    throw new Error("The live takeover bridge did not return a command payload.");
  }

  return body.command;
}

export async function getLiveTakeoverResult(
  endpoint = DEFAULT_LIVE_TAKEOVER_ENDPOINT,
  commandId: string,
): Promise<LiveTakeoverCommandResult | null> {
  const response = await fetch(`${endpoint}/v1/results/${encodeURIComponent(commandId)}`, { method: "GET" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Result lookup failed (${response.status}).`);
  }

  const body = (await response.json()) as LiveTakeoverCommandResult;
  return body;
}
