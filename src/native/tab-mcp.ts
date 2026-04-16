import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ensureRelayServer, getExtensionStatus, RELAY_PORT } from "playwriter/dist/relay-client.js";
import { PlaywrightExecutor } from "playwriter/dist/executor.js";
import { buildNativeTabInventoryEntry, buildNativeTrackedTab, normalizeNativeBrowserTabSummary, resolveNativeTabContextTarget, type NativeBrowserTabSummary, type NativeTabInventoryEntry, type NativeTabMatchTarget } from "../shared/native-tab-context";
import { normalizeTabContext } from "../shared/tab-context";
import { nowIso } from "../shared/logger";
import { searchTrackedTabs } from "../shared/tab-intelligence";
import { sortTrackedTabs } from "../shared/tab-orchestration";
import type { TrackedTabState } from "../shared/types";

const server = new McpServer({
  name: "codex-native-tab-bridge",
  title: "Codex native tab bridge",
  version: "0.1.0",
});

let executor: PlaywrightExecutor | null = null;
let executorInit: Promise<PlaywrightExecutor> | null = null;
let lastFocusedTabKey: string | null = null;

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

function getCdpConfig() {
  const host = process.env.PLAYWRITER_HOST?.trim() || "127.0.0.1";
  const port = Number.parseInt(process.env.PLAYWRITER_PORT ?? String(RELAY_PORT), 10);
  const token = process.env.PLAYWRITER_TOKEN?.trim();

  return {
    host,
    port: Number.isFinite(port) ? port : RELAY_PORT,
    ...(token ? { token } : {}),
  };
}

function nativeTabKey(tab: NativeBrowserTabSummary): string {
  return tab.browserTargetId ?? `tab-${tab.tabId}`;
}

function attachFocusState(tab: NativeBrowserTabSummary): NativeBrowserTabSummary {
  const tabKey = nativeTabKey(tab);
  return {
    ...tab,
    active: tab.active || (lastFocusedTabKey !== null && lastFocusedTabKey === tabKey),
  };
}

async function ensureLocalRelayIfNeeded(): Promise<void> {
  if (process.env.PLAYWRITER_HOST) {
    return;
  }

  await ensureRelayServer({ logger: console, env: { PLAYWRITER_AUTO_ENABLE: "1" } });
}

async function getExecutor(): Promise<PlaywrightExecutor> {
  if (executor) {
    return executor;
  }

  if (!executorInit) {
    executorInit = (async () => {
      await ensureLocalRelayIfNeeded();
      return new PlaywrightExecutor({
        cdpConfig: getCdpConfig(),
        logger: console,
        cwd: process.cwd(),
      });
    })()
      .then((instance) => {
        executor = instance;
        return instance;
      })
      .catch((error) => {
        executorInit = null;
        throw error;
      });
  }

  return executorInit;
}

async function executeBrowserJson<T>(code: string, timeoutMs = 15000): Promise<T> {
  const browserExecutor = await getExecutor();
  const result = await browserExecutor.execute(code, timeoutMs);

  if (result.isError) {
    throw new Error(result.text || "The browser bridge reported an error.");
  }

  const text = result.text.trim();
  if (!text) {
    throw new Error("The browser bridge returned an empty response.");
  }

  return JSON.parse(text) as T;
}

async function collectNativeTabSummaries(): Promise<NativeBrowserTabSummary[]> {
  const summaries = await executeBrowserJson<unknown>(
    `(async () => {
      const pages = context.pages().filter((current) => {
        try {
          const url = current.url();
          return url.startsWith("http:") || url.startsWith("https:") || url.startsWith("file:") || url.startsWith("about:");
        } catch {
          return false;
        }
      });

      const activePage = page;
      const entries = [];
      for (let index = 0; index < pages.length; index += 1) {
        const current = pages[index];
        let title = "";
        try {
          title = await current.title();
        } catch {
          title = "";
        }

        const browserTargetId = typeof current.targetId === "function"
          ? current.targetId()
          : ((current)._guid ?? null);

        const browserState = await current.evaluate(() => {
          const visibleText = typeof document.body?.innerText === "string" ? document.body.innerText.slice(0, 6000) : "";
          const interactive = document.querySelectorAll("button, a[href], input:not([type='hidden']), select, textarea, summary, [role='button'], [role='link'], [contenteditable='true']");
          const forms = document.querySelectorAll("form");
          const hasSensitiveInputs = document.querySelectorAll("input[type='password'], input[type='file']").length > 0
            || Array.from(document.querySelectorAll("input")).some((element) => {
              const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
              return autocomplete.includes("password") || autocomplete.includes("cc-") || autocomplete.includes("one-time-code");
            });

          return {
            readyState: document.readyState,
            interactiveCount: interactive.length,
            formCount: forms.length,
            visibleTextLength: visibleText.length,
            hasSensitiveInputs,
          };
        }).catch(() => ({
          readyState: "complete",
          interactiveCount: 0,
          formCount: 0,
          visibleTextLength: 0,
          hasSensitiveInputs: false,
        }));

        entries.push({
          tabId: index + 1,
          browserTargetId: typeof browserTargetId === "string" && browserTargetId.trim() ? browserTargetId : null,
          url: current.url(),
          title,
          active: current === activePage,
          capturedAt: new Date().toISOString(),
          ...browserState,
        });
      }

      return JSON.stringify(entries);
    })()`,
    20000,
  );

  const parsed = Array.isArray(summaries) ? summaries : [];
  return parsed.map((entry) => normalizeNativeBrowserTabSummary(entry)).filter((entry): entry is NativeBrowserTabSummary => entry !== null);
}

function buildTrackedTabs(summaries: NativeBrowserTabSummary[]): TrackedTabState[] {
  const activeSummary = summaries.find((summary) => summary.active) ?? null;
  if (activeSummary) {
    lastFocusedTabKey = nativeTabKey(activeSummary);
  }

  return summaries
    .map((summary) => attachFocusState(summary))
    .map((summary) => buildNativeTrackedTab(summary));
}

function buildInventoryEntries(summaries: NativeBrowserTabSummary[]): NativeTabInventoryEntry[] {
  return summaries.map((summary) => buildNativeTabInventoryEntry(attachFocusState(summary)));
}

function resolveTabTargetFromArgs(args: { tabContext?: unknown; tabId?: number | undefined }): NativeTabMatchTarget | null {
  const tabContext = normalizeTabContext(args.tabContext);
  if (tabContext) {
    return {
      tabId: tabContext.tabId,
      browserTargetId: tabContext.browserTargetId ?? null,
      url: tabContext.url,
      title: tabContext.title,
    };
  }

  if (typeof args.tabId === "number" && Number.isFinite(args.tabId)) {
    return { tabId: args.tabId };
  }

  return null;
}

async function getInventory() {
  const relayStatus = await getExtensionStatus(RELAY_PORT).catch(() => null);
  if (!relayStatus?.connected) {
    return {
      connected: false,
      relayStatus,
      executorStatus: null,
      sessionMetadata: null,
      activeTabId: null,
      activeTabContext: null,
      tabs: [] as NativeTabInventoryEntry[],
      trackedTabs: [] as TrackedTabState[],
      checkedAt: nowIso(),
    };
  }

  const summaries = await collectNativeTabSummaries();
  const trackedTabs = buildTrackedTabs(summaries);
  const entries = buildInventoryEntries(summaries);
  const activeTabId = trackedTabs.find((tab) => tab.active)?.tabId ?? null;
  const activeTabContext = entries.find((entry) => entry.active)?.tabContext ?? null;
  const entriesByTabId = new Map(entries.map((entry) => [entry.tabContext.tabId, entry] as const));

  const browserExecutor = await getExecutor();
  const executorStatus = browserExecutor.getStatus();
  const sessionMetadata = browserExecutor.getSessionMetadata();

  return {
    connected: true,
    relayStatus,
    executorStatus,
    sessionMetadata,
    activeTabId,
    activeTabContext,
    tabs: sortTrackedTabs(trackedTabs, activeTabId).map((tab) => {
      const entry = entriesByTabId.get(tab.tabId);
      if (entry) {
        return entry;
      }

      return buildNativeTabInventoryEntry({
        tabId: tab.tabId,
        browserTargetId: null,
        url: tab.url,
        title: tab.title,
        readyState: tab.pageState?.readyState ?? "complete",
        interactiveCount: tab.pageState?.interactiveCount ?? 0,
        formCount: tab.pageState?.formCount ?? 0,
        visibleTextLength: tab.pageState?.visibleTextLength ?? 0,
        hasSensitiveInputs: tab.pageState?.hasSensitiveInputs ?? false,
        active: tab.active,
        capturedAt: tab.lastSeenAt,
      });
    }),
    trackedTabs,
    checkedAt: nowIso(),
  };
}

async function refreshSessionStatus() {
  const relayStatus = await getExtensionStatus(RELAY_PORT).catch(() => null);
  if (!relayStatus?.connected) {
    return {
      connected: false,
      relayStatus,
      executorStatus: null,
      sessionMetadata: null,
      activeTabId: null,
      activeTabContext: null,
      tabs: [] as NativeTabInventoryEntry[],
      trackedTabs: [] as TrackedTabState[],
      checkedAt: nowIso(),
    };
  }

  return getInventory();
}

async function focusNativeTab(target: NativeTabMatchTarget): Promise<NativeTabInventoryEntry> {
  const browserExecutor = await getExecutor();
  const summaries = await collectNativeTabSummaries();
  const match = resolveNativeTabContextTarget(summaries, target);

  if (!match) {
    throw new Error("The requested tab could not be found in the live browser session.");
  }

  const focusCode = `(async () => {
    const target = JSON.parse(${JSON.stringify(JSON.stringify(target))});
    const pages = context.pages().filter((current) => {
      try {
        const url = current.url();
        return url.startsWith("http:") || url.startsWith("https:") || url.startsWith("file:") || url.startsWith("about:");
      } catch {
        return false;
      }
    });

    let matched = null;
    for (let index = 0; index < pages.length; index += 1) {
      const current = pages[index];
      const currentTargetId = typeof current.targetId === "function" ? current.targetId() : ((current)._guid ?? null);
      let currentTitle = "";
      try {
        currentTitle = await current.title();
      } catch {
        currentTitle = "";
      }

      const matches =
        (target.browserTargetId && currentTargetId === target.browserTargetId) ||
        (typeof target.tabId === "number" && index + 1 === target.tabId) ||
        (target.url && current.url() === target.url) ||
        (target.title && currentTitle.trim().toLowerCase() === String(target.title).trim().toLowerCase());

      if (matches) {
        await current.bringToFront().catch(() => undefined);
        matched = {
          tabId: index + 1,
          browserTargetId: typeof currentTargetId === "string" && currentTargetId.trim() ? currentTargetId : null,
          url: current.url(),
          title: currentTitle,
          active: true,
        };
        break;
      }
    }

    return JSON.stringify({ matched });
  })()`;

  const result = await browserExecutor.execute(focusCode, 15000);
  if (result.isError) {
    throw new Error(result.text || "The browser bridge failed while focusing the tab.");
  }

  const payload = JSON.parse(result.text.trim()) as { matched?: { tabId: number; browserTargetId: string | null; url: string; title: string; active: boolean } | null };
  if (!payload.matched) {
    throw new Error("The requested tab could not be focused.");
  }

  lastFocusedTabKey = nativeTabKey({
    ...match,
    active: true,
  });

  const focusedSummary = attachFocusState({
    ...match,
    active: true,
  });

  return buildNativeTabInventoryEntry(focusedSummary);
}

async function inspectNativeTab(target: NativeTabMatchTarget): Promise<NativeTabInventoryEntry> {
  const summaries = await collectNativeTabSummaries();
  const match = resolveNativeTabContextTarget(summaries, target);

  if (!match) {
    throw new Error("The requested tab could not be found in the live browser session.");
  }

  return buildNativeTabInventoryEntry(attachFocusState(match));
}

function inventoryToText(inventory: Awaited<ReturnType<typeof getInventory>>): string {
  return JSON.stringify(
    {
      connected: inventory.connected,
      relayStatus: inventory.relayStatus,
      executorStatus: inventory.executorStatus,
      sessionMetadata: inventory.sessionMetadata,
      activeTabId: inventory.activeTabId,
      activeTabContext: inventory.activeTabContext,
      tabs: inventory.tabs,
      checkedAt: inventory.checkedAt,
    },
    null,
    2,
  );
}

server.tool(
  "session_status",
  "Inspect the live browser bridge connection, session metadata, and tab inventory state.",
  {},
  async () => {
    const inventory = await refreshSessionStatus();
    return {
      content: [
        {
          type: "text",
          text: inventoryToText(inventory),
        },
      ],
    };
  },
);

server.tool(
  "list_tabs",
  "List the live browser tabs as tab-context records with page summaries.",
  {},
  async () => {
    const inventory = await getInventory();
    if (!inventory.connected) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                connected: false,
                relayStatus: inventory.relayStatus,
                tabs: [],
                checkedAt: inventory.checkedAt,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: inventoryToText(inventory),
        },
      ],
    };
  },
);

server.tool(
  "search_tabs",
  "Search the live browser tabs using the shared tab-context ranking model.",
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(20).optional(),
  },
  async ({ query, limit }) => {
    const inventory = await getInventory();
    if (!inventory.connected) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                connected: false,
                relayStatus: inventory.relayStatus,
                query,
                results: [],
                checkedAt: inventory.checkedAt,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const ranked = searchTrackedTabs(inventory.trackedTabs, query, inventory.activeTabId).slice(0, limit ?? 10);
    const entriesByTabId = new Map(inventory.tabs.map((entry) => [entry.tabContext.tabId, entry] as const));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              connected: true,
              query,
              activeTabId: inventory.activeTabId,
              results: ranked.map((result) => {
                const entry = entriesByTabId.get(result.tab.tabId) ?? buildNativeTabInventoryEntry({
                  tabId: result.tab.tabId,
                  browserTargetId: null,
                  url: result.tab.url,
                  title: result.tab.title,
                  readyState: result.tab.pageState?.readyState ?? "complete",
                  interactiveCount: result.tab.pageState?.interactiveCount ?? 0,
                  formCount: result.tab.pageState?.formCount ?? 0,
                  visibleTextLength: result.tab.pageState?.visibleTextLength ?? 0,
                  hasSensitiveInputs: result.tab.pageState?.hasSensitiveInputs ?? false,
                  active: result.tab.active,
                  capturedAt: result.tab.lastSeenAt,
                });

                return {
                  score: result.score,
                  reason: result.reason,
                  ...entry,
                };
              }),
              checkedAt: inventory.checkedAt,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  "inspect_tab",
  "Inspect a specific browser tab by tab context or numeric tab id.",
  {
    tabContext: z.unknown().optional(),
    tabId: z.number().int().nonnegative().optional(),
  },
  async (args) => {
    const inventory = await getInventory();
    if (!inventory.connected) {
      return errorResult("The live browser bridge is not connected. Start the Playwriter bridge and attach a tab first.");
    }

    const target = resolveTabTargetFromArgs(args);
    if (!target) {
      return errorResult("Provide a tabContext or tabId so the bridge can inspect a specific tab.");
    }

    const match = resolveNativeTabContextTarget(
      inventory.tabs.map((entry) => ({
        tabId: entry.tabContext.tabId,
        browserTargetId: entry.browserTargetId,
        url: entry.tabContext.url,
        title: entry.tabContext.title,
        readyState: entry.pageState.readyState,
        interactiveCount: entry.pageState.interactiveCount,
        formCount: entry.pageState.formCount,
        visibleTextLength: entry.pageState.visibleTextLength,
        hasSensitiveInputs: entry.pageState.hasSensitiveInputs,
        active: entry.active,
        capturedAt: entry.pageState.updatedAt,
      })),
      target,
    );

    if (!match) {
      return errorResult("The requested tab could not be found in the live browser session.");
    }

    const entry = buildNativeTabInventoryEntry(attachFocusState(match));
    return textResult(
      JSON.stringify(
        {
          connected: true,
          target,
          tab: entry,
          checkedAt: nowIso(),
        },
        null,
        2,
      ),
    );
  },
);

server.tool(
  "focus_tab",
  "Bring a specific browser tab to the front using its tab context.",
  {
    tabContext: z.unknown().optional(),
    tabId: z.number().int().nonnegative().optional(),
  },
  async (args) => {
    const inventory = await getInventory();
    if (!inventory.connected) {
      return errorResult("The live browser bridge is not connected. Start the Playwriter bridge and attach a tab first.");
    }

    const target = resolveTabTargetFromArgs(args);
    if (!target) {
      return errorResult("Provide a tabContext or tabId so the bridge can focus a specific tab.");
    }

    try {
      const focused = await focusNativeTab(target);
      return textResult(
        JSON.stringify(
          {
            connected: true,
            target,
            focused,
            checkedAt: nowIso(),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "The browser bridge could not focus the requested tab.";
      return errorResult(message);
    }
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

await main();
