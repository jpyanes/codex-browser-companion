import { nowIso } from "../src/shared/logger";
import { sortTrackedTabs, summarizeTrackedTab, tabStatusLabel, tabStatusTone } from "../src/shared/tab-orchestration";
import type { TrackedTabState } from "../src/shared/types";

function makeTab(partial: Partial<TrackedTabState> & Pick<TrackedTabState, "tabId">): TrackedTabState {
  return {
    tabId: partial.tabId,
    windowId: partial.windowId ?? 1,
    active: partial.active ?? false,
    url: partial.url ?? `https://example.com/${partial.tabId}`,
    title: partial.title ?? `Tab ${partial.tabId}`,
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

describe("tab orchestration helpers", () => {
  it("sorts the active tab first and then by recency", () => {
    const tabs = [
      makeTab({ tabId: 3, windowId: 2, lastSeenAt: "2026-04-15T00:00:03.000Z", title: "Later tab" }),
      makeTab({ tabId: 1, windowId: 1, active: true, contentReady: true, snapshotFresh: true, lastSeenAt: "2026-04-15T00:00:01.000Z" }),
      makeTab({ tabId: 2, windowId: 1, contentReady: true, snapshotFresh: true, lastSeenAt: "2026-04-15T00:00:02.000Z", title: "Middle tab" }),
    ];

    const sorted = sortTrackedTabs(tabs, 1);

    expect(sorted.map((tab) => tab.tabId)).toEqual([1, 2, 3]);
  });

  it("describes tab status consistently for orchestration cards", () => {
    const current = makeTab({ tabId: 1, active: true, contentReady: true, snapshotFresh: true });
    const stale = makeTab({ tabId: 2, contentReady: true, snapshotFresh: false });
    const detached = makeTab({ tabId: 3, contentReady: false, snapshotFresh: false });
    const errored = makeTab({ tabId: 4, lastError: { code: "TAB_ERROR", message: "Broken", details: undefined, recoverable: true, tabId: 4, occurredAt: nowIso() } });

    expect(tabStatusLabel(current, 1)).toBe("Current");
    expect(tabStatusTone(current, 1)).toBe("success");
    expect(tabStatusLabel(stale, 1)).toBe("Stale");
    expect(tabStatusTone(stale, 1)).toBe("warning");
    expect(tabStatusLabel(detached, 1)).toBe("Detached");
    expect(tabStatusTone(detached, 1)).toBe("neutral");
    expect(tabStatusLabel(errored, 1)).toBe("Error");
    expect(tabStatusTone(errored, 1)).toBe("danger");
  });

  it("summarizes tab context for the orchestration panel", () => {
    const tab = makeTab({
      tabId: 7,
      windowId: 3,
      title: "Workflow tab",
      url: "https://example.com/workflow",
      pageState: {
        url: "https://example.com/workflow",
        title: "Workflow tab",
        readyState: "complete",
        navigationMode: "document",
        pageKind: "mixed",
        interactiveCount: 4,
        formCount: 1,
        visibleTextLength: 250,
        hasSensitiveInputs: false,
        siteAdapterId: null,
        siteAdapterLabel: null,
        updatedAt: nowIso(),
      },
    });

    const summary = summarizeTrackedTab(tab);
    expect(summary).toContain("Workflow tab");
    expect(summary).toContain("Window 3");
    expect(summary).toContain("mixed");
  });
});
