import { nowIso } from "../src/shared/logger";
import { buildNativePageState, buildNativeTabContext, buildNativeTabInventoryEntry, buildNativeTrackedTab, resolveNativeTabContextTarget } from "../src/shared/native-tab-context";
import { searchTrackedTabs } from "../src/shared/tab-intelligence";
import type { NativeBrowserTabSummary } from "../src/shared/native-tab-context";

function makeSummary(partial: Partial<NativeBrowserTabSummary> & Pick<NativeBrowserTabSummary, "tabId" | "url" | "title">): NativeBrowserTabSummary {
  return {
    tabId: partial.tabId,
    browserTargetId: partial.browserTargetId ?? null,
    url: partial.url,
    title: partial.title,
    readyState: partial.readyState ?? "complete",
    interactiveCount: partial.interactiveCount ?? 0,
    formCount: partial.formCount ?? 0,
    visibleTextLength: partial.visibleTextLength ?? 0,
    hasSensitiveInputs: partial.hasSensitiveInputs ?? false,
    active: partial.active ?? false,
    capturedAt: partial.capturedAt ?? nowIso(),
  };
}

describe("native tab context", () => {
  it("preserves browser target ids and login handoff state in native tab contexts", () => {
    const summary = makeSummary({
      tabId: 1,
      browserTargetId: "target-login",
      url: "https://accounts.google.com/",
      title: "Sign in - Google Accounts",
      interactiveCount: 3,
      formCount: 1,
      visibleTextLength: 120,
      hasSensitiveInputs: true,
    });

    const pageState = buildNativePageState(summary);
    const tabContext = buildNativeTabContext(summary);
    const entry = buildNativeTabInventoryEntry(summary);

    expect(pageState.pageKind).toBe("login");
    expect(pageState.siteAdapterLabel).toBe("Google sign-in");
    expect(pageState.userInterventionKind).toBe("login");
    expect(tabContext.browserTargetId).toBe("target-login");
    expect(tabContext.snapshotId).toBe("native-target-login");
    expect(entry.summary).toContain("Google sign-in");
    expect(entry.pageState.userInterventionMessage).toContain("manually");
  });

  it("prefers browser target ids when resolving a native tab context", () => {
    const tabs = [
      makeSummary({
        tabId: 1,
        browserTargetId: "target-a",
        url: "https://www.linkedin.com/feed/",
        title: "LinkedIn Feed",
        active: false,
      }),
      makeSummary({
        tabId: 2,
        browserTargetId: "target-b",
        url: "https://docs.google.com/document/d/abc/edit",
        title: "Untitled document - Google Docs",
        active: true,
      }),
    ];

    const matchByTarget = resolveNativeTabContextTarget(tabs, { browserTargetId: "target-b" });
    const matchByUrl = resolveNativeTabContextTarget(tabs, { url: "https://docs.google.com/document/d/abc/edit" });

    expect(matchByTarget?.tabId).toBe(2);
    expect(matchByUrl?.tabId).toBe(2);
  });

  it("feeds native tracked tabs into the shared search ranking", () => {
    const tabs = [
      buildNativeTrackedTab(
        makeSummary({
          tabId: 1,
          browserTargetId: "target-linkedin",
          url: "https://www.linkedin.com/feed/",
          title: "LinkedIn Feed",
        }),
      ),
      buildNativeTrackedTab(
        makeSummary({
          tabId: 2,
          browserTargetId: "target-docs",
          url: "https://docs.google.com/document/d/abc/edit",
          title: "Untitled document - Google Docs",
          active: true,
          interactiveCount: 3,
          formCount: 0,
          visibleTextLength: 200,
        }),
      ),
    ];

    const results = searchTrackedTabs(tabs, "google docs", 2);

    expect(results[0]?.tab.tabId).toBe(2);
    expect(results[0]?.reason).toBe("site adapter");
  });
});
