import { describe, expect, it } from "vitest";
import {
  buildLiveTakeoverState,
  chooseLiveTakeoverTab,
  claimNextLiveTakeoverCommand,
  createInitialLiveTakeoverServerState,
  createDisconnectedLiveTakeoverState,
  normalizeLiveTakeoverCommandResult,
  normalizeLiveTakeoverServerState,
  recordLiveTakeoverResult,
  summarizeLiveTakeoverState,
  shouldAutoEnableLiveTakeover,
} from "../src/shared/live-takeover";

describe("live takeover helpers", () => {
  it("creates an initial queue state", () => {
    const state = createInitialLiveTakeoverServerState();

    expect(state.queue).toHaveLength(0);
    expect(state.results).toEqual({});
    expect(state.activeTab).toEqual({
      tabId: null,
      windowId: null,
      url: null,
      title: null,
      ts: null,
    });
  });

  it("claims and records matching commands", () => {
    const state = createInitialLiveTakeoverServerState();
    state.queue.push(
      {
        id: "skip",
        type: "click",
        payload: {},
        createdAt: "2026-04-16T00:00:00.000Z",
        tabId: 22,
        url: "https://example.com/other",
      },
      {
        id: "match",
        type: "fill",
        payload: {},
        createdAt: "2026-04-16T00:00:01.000Z",
        tabId: 12,
        url: "https://example.com/page",
      },
    );

    const claimed = claimNextLiveTakeoverCommand(state, 12, "https://example.com/page");
    expect(claimed?.id).toBe("match");
    expect(claimed?.claimedAt).toBeTruthy();

    const result = normalizeLiveTakeoverCommandResult({
      commandId: "match",
      ok: true,
      result: { message: "done" },
      ts: "2026-04-16T00:00:02.000Z",
    });

    expect(result).not.toBeNull();

    const next = recordLiveTakeoverResult(state, result!);
    expect(next.queue.map((command) => command.id)).toEqual(["skip"]);
    expect(next.results.match).toEqual(result);
  });

  it("normalizes malformed server state safely", () => {
    const state = normalizeLiveTakeoverServerState({
      startedAt: 123,
      lastHeartbeat: "2026-04-16T00:00:00.000Z",
      activeTab: { tabId: "not-a-number" },
      queue: [{ id: "broken" }],
      results: { broken: { commandId: 99 } },
    });

    expect(state.startedAt).toBeTruthy();
    expect(state.queue).toHaveLength(0);
    expect(state.results).toEqual({});
    expect(state.activeTab).toEqual({
      tabId: null,
      windowId: null,
      url: null,
      title: null,
      ts: null,
    });
  });

  it("builds readable takeover summaries", () => {
    const connected = buildLiveTakeoverState(
      {
        startedAt: "2026-04-16T00:00:00.000Z",
        lastHeartbeat: "2026-04-16T00:00:05.000Z",
        activeTab: {
          tabId: 7,
          windowId: 1,
          url: "https://example.com",
          title: "Example",
          ts: "2026-04-16T00:00:05.000Z",
        },
        queueLength: 2,
        checkedAt: "2026-04-16T00:00:06.000Z",
      },
      { enabled: true, endpoint: "http://127.0.0.1:47123" },
    );

    expect(connected.status).toBe("connected");
    expect(summarizeLiveTakeoverState(connected)).toContain("Example");
    expect(summarizeLiveTakeoverState(connected)).toContain("2 queued commands");

    const disabled = createDisconnectedLiveTakeoverState("http://127.0.0.1:47123", false);
    expect(disabled.status).toBe("disabled");
    expect(summarizeLiveTakeoverState(disabled)).toContain("disabled");
  });

  it("auto-enables only the first time a takeover state is initialized", () => {
    const fresh = createDisconnectedLiveTakeoverState("http://127.0.0.1:47123", false);
    expect(shouldAutoEnableLiveTakeover(fresh)).toBe(true);

    const explicitlyDisabled = createDisconnectedLiveTakeoverState("http://127.0.0.1:47123", false, null, "2026-04-16T00:00:00.000Z", true);
    expect(shouldAutoEnableLiveTakeover(explicitlyDisabled)).toBe(false);

    const enabled = createDisconnectedLiveTakeoverState("http://127.0.0.1:47123", true);
    expect(shouldAutoEnableLiveTakeover(enabled)).toBe(false);
  });

  it("prefers a visible content tab over extension UI tabs", () => {
    const target = chooseLiveTakeoverTab(
      [
        {
          tabId: 1,
          windowId: 1,
          active: true,
          url: "chrome-extension://abc123/popup/index.html",
          title: "Codex Browser Companion",
          pageState: null,
          snapshot: null,
          snapshotFresh: false,
          contentReady: false,
          busy: false,
          approvals: [],
          activityLog: [],
          lastError: null,
          lastSeenAt: "2026-04-16T00:00:00.000Z",
        },
        {
          tabId: 2,
          windowId: 1,
          active: false,
          url: "https://www.linkedin.com/feed/",
          title: "LinkedIn",
          pageState: null,
          snapshot: null,
          snapshotFresh: true,
          contentReady: true,
          busy: false,
          approvals: [],
          activityLog: [],
          lastError: null,
          lastSeenAt: "2026-04-16T00:00:05.000Z",
        },
      ],
      null,
    );

    expect(target?.tabId).toBe(2);
  });
});
