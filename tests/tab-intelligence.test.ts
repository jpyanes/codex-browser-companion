import { nowIso } from "../src/shared/logger";
import { searchTrackedTabs } from "../src/shared/tab-intelligence";
import type { PageSnapshot, TrackedTabState } from "../src/shared/types";

function makeSnapshot(partial: Partial<PageSnapshot> & Pick<PageSnapshot, "snapshotId" | "tabId" | "url" | "title" | "pageKind" | "summary">): PageSnapshot {
  return {
    captureMode: partial.captureMode ?? "full",
    capturedAt: partial.capturedAt ?? nowIso(),
    navigationMode: partial.navigationMode ?? "document",
    visibleText: partial.visibleText ?? "",
    visibleTextExcerpt: partial.visibleTextExcerpt ?? "",
    textLength: partial.textLength ?? 0,
    meta: partial.meta ?? {
      navigationMode: partial.navigationMode ?? "document",
      readyState: "complete",
      interactiveCount: 0,
      linkCount: 0,
      formCount: 0,
      headingCount: 0,
      visibleTextLength: 0,
      hasSensitiveInputs: false,
      isArticleLike: false,
      isLoginLike: false,
      isSinglePageApp: false,
    },
    headings: partial.headings ?? [],
    links: partial.links ?? [],
    forms: partial.forms ?? [],
    interactiveElements: partial.interactiveElements ?? [],
    semanticOutline: partial.semanticOutline ?? [],
    siteAdapter: partial.siteAdapter ?? null,
    suggestedActions: partial.suggestedActions ?? [],
    snapshotId: partial.snapshotId,
    tabId: partial.tabId,
    url: partial.url,
    title: partial.title,
    pageKind: partial.pageKind,
    summary: partial.summary,
  };
}

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

describe("tab intelligence", () => {
  it("ranks tabs by site adapter and page summary text", () => {
    const tabs = [
      makeTab({
        tabId: 1,
        title: "LinkedIn Feed",
        url: "https://www.linkedin.com/feed/",
        pageState: {
          url: "https://www.linkedin.com/feed/",
          title: "LinkedIn Feed",
          readyState: "complete",
          navigationMode: "document",
          pageKind: "mixed",
          interactiveCount: 2,
          formCount: 0,
          visibleTextLength: 120,
          hasSensitiveInputs: false,
          siteAdapterId: "linkedin-feed",
          siteAdapterLabel: "LinkedIn feed",
          updatedAt: nowIso(),
        },
        snapshot: makeSnapshot({
          snapshotId: "snapshot-linkedin",
          tabId: 1,
          url: "https://www.linkedin.com/feed/",
          title: "LinkedIn Feed",
          pageKind: "mixed",
          summary: "LinkedIn feed or profile content is visible.",
          siteAdapter: {
            id: "linkedin-feed",
            label: "LinkedIn feed",
            kind: "social-feed",
            summary: "LinkedIn feed or profile content is visible.",
            capabilities: ["feed navigation"],
            notes: ["Rescan after feed changes so the active tab snapshot stays current."],
          },
        }),
      }),
      makeTab({
        tabId: 2,
        title: "Project Notes",
        url: "https://example.com/notes",
        active: true,
        pageState: {
          url: "https://example.com/notes",
          title: "Project Notes",
          readyState: "complete",
          navigationMode: "document",
          pageKind: "document",
          interactiveCount: 1,
          formCount: 0,
          visibleTextLength: 80,
          hasSensitiveInputs: false,
          siteAdapterId: null,
          siteAdapterLabel: null,
          updatedAt: nowIso(),
        },
        snapshot: makeSnapshot({
          snapshotId: "snapshot-notes",
          tabId: 2,
          url: "https://example.com/notes",
          title: "Project Notes",
          pageKind: "document",
          summary: "Project notes page.",
        }),
      }),
      makeTab({
        tabId: 3,
        title: "Google Docs",
        url: "https://docs.google.com/document/d/abc/edit",
        pageState: {
          url: "https://docs.google.com/document/d/abc/edit",
          title: "Google Docs",
          readyState: "complete",
          navigationMode: "document",
          pageKind: "document",
          interactiveCount: 3,
          formCount: 0,
          visibleTextLength: 200,
          hasSensitiveInputs: false,
          siteAdapterId: "google-docs",
          siteAdapterLabel: "Google Docs editor",
          updatedAt: nowIso(),
        },
        snapshot: makeSnapshot({
          snapshotId: "snapshot-docs",
          tabId: 3,
          url: "https://docs.google.com/document/d/abc/edit",
          title: "Google Docs",
          pageKind: "document",
          summary: "Google Docs is ready.",
          siteAdapter: {
            id: "google-docs",
            label: "Google Docs editor",
            kind: "document-editor",
            summary: "Google Docs is ready.",
            capabilities: ["document typing"],
            notes: ["If the editor is still loading, rescan after the contenteditable surface appears."],
          },
        }),
      }),
    ];

    const results = searchTrackedTabs(tabs, "google docs", null);

    expect(results[0]?.tab.tabId).toBe(3);
    expect(results[0]?.reason).toBe("site adapter");
  });

  it("pins the active tab while still showing matching cross-tab results", () => {
    const tabs = [
      makeTab({
        tabId: 1,
        title: "LinkedIn Feed",
        url: "https://www.linkedin.com/feed/",
        active: true,
        pageState: {
          url: "https://www.linkedin.com/feed/",
          title: "LinkedIn Feed",
          readyState: "complete",
          navigationMode: "document",
          pageKind: "mixed",
          interactiveCount: 2,
          formCount: 0,
          visibleTextLength: 120,
          hasSensitiveInputs: false,
          siteAdapterId: "linkedin-feed",
          siteAdapterLabel: "LinkedIn feed",
          updatedAt: nowIso(),
        },
        snapshot: makeSnapshot({
          snapshotId: "snapshot-linkedin",
          tabId: 1,
          url: "https://www.linkedin.com/feed/",
          title: "LinkedIn Feed",
          pageKind: "mixed",
          summary: "LinkedIn feed or profile content is visible.",
        }),
      }),
      makeTab({
        tabId: 2,
        title: "Google Docs",
        url: "https://docs.google.com/document/d/abc/edit",
        pageState: {
          url: "https://docs.google.com/document/d/abc/edit",
          title: "Google Docs",
          readyState: "complete",
          navigationMode: "document",
          pageKind: "document",
          interactiveCount: 3,
          formCount: 0,
          visibleTextLength: 200,
          hasSensitiveInputs: false,
          siteAdapterId: "google-docs",
          siteAdapterLabel: "Google Docs editor",
          updatedAt: nowIso(),
        },
        snapshot: makeSnapshot({
          snapshotId: "snapshot-docs",
          tabId: 2,
          url: "https://docs.google.com/document/d/abc/edit",
          title: "Google Docs",
          pageKind: "document",
          summary: "Google Docs is ready.",
          siteAdapter: {
            id: "google-docs",
            label: "Google Docs editor",
            kind: "document-editor",
            summary: "Google Docs is ready.",
            capabilities: ["document typing"],
            notes: [],
          },
        }),
      }),
    ];

    const results = searchTrackedTabs(tabs, "google docs", 1);

    expect(results[0]?.tab.tabId).toBe(1);
    expect(results.some((result) => result.tab.tabId === 2)).toBe(true);
  });
});
