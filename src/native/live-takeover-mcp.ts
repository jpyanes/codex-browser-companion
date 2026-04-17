import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DEFAULT_LIVE_TAKEOVER_ENDPOINT } from "../shared/constants";
import {
  enqueueLiveTakeoverCommand,
  fetchLiveTakeoverState,
  getLiveTakeoverResult,
} from "../shared/live-takeover-client";
import { normalizeTabContext } from "../shared/tab-context";
import { nowIso } from "../shared/logger";
import type { LiveTakeoverCommand, LiveTakeoverCommandResult, LiveTakeoverState, TabContext } from "../shared/types";

const server = new McpServer({
  name: "codex-live-takeover",
  title: "Codex live takeover bridge",
  version: "0.1.0",
});

const DEFAULT_TIMEOUT_MS = 30000;

function textResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function resolveTabContext(args: { tabContext?: unknown; tabId?: number | undefined; url?: string | undefined; title?: string | undefined }): TabContext | null {
  const tabContext = normalizeTabContext(args.tabContext);
  if (tabContext) {
    return tabContext;
  }

  if (typeof args.tabId === "number" && Number.isFinite(args.tabId) && args.tabId >= 0) {
    return {
      tabId: args.tabId,
      windowId: null,
      browserTargetId: null,
      url: typeof args.url === "string" ? args.url : "",
      title: typeof args.title === "string" ? args.title : "",
      pageKind: "unknown",
      siteAdapterId: null,
      siteAdapterLabel: null,
      snapshotId: null,
      capturedAt: null,
    };
  }

  return null;
}

async function waitForLiveTakeoverResult(endpoint: string | undefined, commandId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<LiveTakeoverCommandResult> {
  const liveEndpoint = endpoint ?? DEFAULT_LIVE_TAKEOVER_ENDPOINT;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await getLiveTakeoverResult(liveEndpoint, commandId);
    if (result) {
      return result;
    }

    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for live takeover result ${commandId}`);
}

async function queueAndWait(
  endpoint: string | undefined,
  command: Omit<LiveTakeoverCommand, "id" | "createdAt"> & { payload?: Record<string, unknown> },
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<LiveTakeoverCommandResult> {
  const liveEndpoint = endpoint ?? DEFAULT_LIVE_TAKEOVER_ENDPOINT;
  const queued = await enqueueLiveTakeoverCommand(liveEndpoint, command);
  return waitForLiveTakeoverResult(endpoint, queued.id, timeoutMs);
}

async function getStatus(endpoint: string | undefined): Promise<LiveTakeoverState> {
  return fetchLiveTakeoverState(endpoint ?? DEFAULT_LIVE_TAKEOVER_ENDPOINT, { enabled: true });
}

server.tool(
  "session_status",
  "Inspect the live takeover bridge state for the visible Chrome session.",
  {
    endpoint: z.string().url().optional(),
  },
  async ({ endpoint }) => {
    try {
      const state = await getStatus(endpoint);
      return textResult(
        JSON.stringify(
          {
            endpoint: state.endpoint,
            status: state.status,
            enabled: state.enabled,
            activeTabId: state.activeTabId,
            activeUrl: state.activeUrl,
            activeTitle: state.activeTitle,
            queueLength: state.queueLength,
            lastHeartbeat: state.lastHeartbeat,
            checkedAt: state.checkedAt,
            summary: state.enabled
              ? state.status === "connected"
                ? `Attached to ${state.activeTitle || state.activeUrl || `tab ${state.activeTabId ?? "unknown"}`}.`
                : state.status === "connecting"
                  ? "Waiting for the visible Chrome tab to heartbeat."
                  : `Live takeover is ${state.status}.`
              : "Live takeover mode is disabled.",
          },
          null,
          2,
        ),
      );
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
);

server.tool(
  "snapshot_tab",
  "Capture a structured snapshot of the current visible tab through live takeover.",
  {
    endpoint: z.string().url().optional(),
    tabContext: z.unknown().optional(),
    tabId: z.number().int().nonnegative().optional(),
    mode: z.enum(["full", "interactive", "summary", "suggestions"]).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  },
  async ({ endpoint, tabContext, tabId, mode, timeoutMs }) => {
    const target = resolveTabContext({ tabContext, tabId });
    if (!target && typeof tabId !== "number") {
      return errorResult("Provide a tabContext or tabId so the bridge can target a visible tab.");
    }

    try {
      const result = await queueAndWait(
        endpoint,
        {
          type: "snapshot",
          payload: { mode: mode || "full" },
          tabId: target?.tabId ?? tabId ?? null,
          ...(target?.url ? { url: target.url } : {}),
        },
        timeoutMs,
      );
      return textResult(JSON.stringify(result, null, 2));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
);

server.tool(
  "click_element",
  "Click an element in the current visible tab through live takeover.",
  {
    endpoint: z.string().url().optional(),
    tabContext: z.unknown().optional(),
    tabId: z.number().int().nonnegative().optional(),
    selector: z.string().optional(),
    bridgeId: z.string().optional(),
    label: z.string().optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  },
  async ({ endpoint, tabContext, tabId, selector, bridgeId, label, timeoutMs }) => {
    const target = resolveTabContext({ tabContext, tabId });
    try {
      const result = await queueAndWait(
        endpoint,
        {
          type: "click",
          payload: {
            selector,
            bridgeId,
            label,
          },
          tabId: target?.tabId ?? tabId ?? null,
          ...(target?.url ? { url: target.url } : {}),
        },
        timeoutMs,
      );
      return textResult(JSON.stringify(result, null, 2));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
);

server.tool(
  "fill_field",
  "Type into a field in the current visible tab through live takeover.",
  {
    endpoint: z.string().url().optional(),
    tabContext: z.unknown().optional(),
    tabId: z.number().int().nonnegative().optional(),
    selector: z.string().optional(),
    bridgeId: z.string().optional(),
    value: z.string(),
    clearBeforeTyping: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  },
  async ({ endpoint, tabContext, tabId, selector, bridgeId, value, clearBeforeTyping, timeoutMs }) => {
    const target = resolveTabContext({ tabContext, tabId });
    try {
      const result = await queueAndWait(
        endpoint,
        {
          type: "fill",
          payload: {
            selector,
            bridgeId,
            value,
            clearBeforeTyping,
          },
          tabId: target?.tabId ?? tabId ?? null,
          ...(target?.url ? { url: target.url } : {}),
        },
        timeoutMs,
      );
      return textResult(JSON.stringify(result, null, 2));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
);

server.tool(
  "press_key",
  "Send a key press to the current visible tab through live takeover.",
  {
    endpoint: z.string().url().optional(),
    tabContext: z.unknown().optional(),
    tabId: z.number().int().nonnegative().optional(),
    selector: z.string().optional(),
    bridgeId: z.string().optional(),
    key: z.string().optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  },
  async ({ endpoint, tabContext, tabId, selector, bridgeId, key, timeoutMs }) => {
    const target = resolveTabContext({ tabContext, tabId });
    try {
      const result = await queueAndWait(
        endpoint,
        {
          type: "press",
          payload: {
            selector,
            bridgeId,
            key: key || "Enter",
          },
          tabId: target?.tabId ?? tabId ?? null,
          ...(target?.url ? { url: target.url } : {}),
        },
        timeoutMs,
      );
      return textResult(JSON.stringify(result, null, 2));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
);

server.tool(
  "navigate_tab",
  "Navigate the current visible tab to a URL through live takeover.",
  {
    endpoint: z.string().url().optional(),
    tabContext: z.unknown().optional(),
    tabId: z.number().int().nonnegative().optional(),
    url: z.string().url(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  },
  async ({ endpoint, tabContext, tabId, url, timeoutMs }) => {
    const target = resolveTabContext({ tabContext, tabId });
    try {
      const result = await queueAndWait(
        endpoint,
        {
          type: "navigate",
          payload: { url },
          tabId: target?.tabId ?? tabId ?? null,
          ...(target?.url ? { url: target.url } : {}),
        },
        timeoutMs,
      );
      return textResult(JSON.stringify(result, null, 2));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

await main();
