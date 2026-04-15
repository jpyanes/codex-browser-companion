import type { TrackedTabState } from "./types";

function normalize(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

function pendingApprovalCount(tab: TrackedTabState): number {
  return tab.approvals.filter((approval) => approval.status === "pending" || approval.status === "executing").length;
}

export function sortTrackedTabs(tabs: TrackedTabState[], activeTabId: number | null): TrackedTabState[] {
  return tabs.slice().sort((left, right) => {
    if (left.tabId === activeTabId && right.tabId !== activeTabId) {
      return -1;
    }

    if (right.tabId === activeTabId && left.tabId !== activeTabId) {
      return 1;
    }

    const leftWindow = left.windowId ?? 0;
    const rightWindow = right.windowId ?? 0;
    if (leftWindow !== rightWindow) {
      return leftWindow - rightWindow;
    }

    const leftSeen = new Date(left.lastSeenAt).getTime();
    const rightSeen = new Date(right.lastSeenAt).getTime();
    if (leftSeen !== rightSeen) {
      return rightSeen - leftSeen;
    }

    const leftTitle = normalize(left.title || left.url || `Tab ${left.tabId}`).toLowerCase();
    const rightTitle = normalize(right.title || right.url || `Tab ${right.tabId}`).toLowerCase();
    return leftTitle.localeCompare(rightTitle);
  });
}

export function tabStatusTone(tab: TrackedTabState, activeTabId: number | null): "neutral" | "warning" | "success" | "danger" {
  if (tab.pageState?.userInterventionKind || tab.pageState?.pageKind === "login" || tab.pageState?.pageKind === "payment") {
    return "warning";
  }

  if (tab.lastError) {
    return "danger";
  }

  if (tab.busy || pendingApprovalCount(tab) > 0) {
    return "warning";
  }

  if (!tab.contentReady) {
    return "neutral";
  }

  if (!tab.snapshotFresh) {
    return "warning";
  }

  if (tab.tabId === activeTabId) {
    return "success";
  }

  return "success";
}

export function tabStatusLabel(tab: TrackedTabState, activeTabId: number | null): string {
  if (tab.pageState?.userInterventionKind || tab.pageState?.pageKind === "login" || tab.pageState?.pageKind === "payment") {
    return tab.tabId === activeTabId ? "Waiting for you" : "User action needed";
  }

  if (tab.lastError) {
    return "Error";
  }

  if (tab.busy) {
    return "Busy";
  }

  if (pendingApprovalCount(tab) > 0) {
    return "Awaiting approval";
  }

  if (tab.tabId === activeTabId) {
    if (!tab.contentReady) {
      return "Current";
    }

    return tab.snapshotFresh ? "Current" : "Current - stale";
  }

  if (!tab.contentReady) {
    return "Detached";
  }

  if (!tab.snapshotFresh) {
    return "Stale";
  }

  return "Ready";
}

export function summarizeTrackedTab(tab: TrackedTabState): string {
  const pieces = [tab.title || "Untitled page"];
  if (tab.url) {
    pieces.push(tab.url);
  }
  pieces.push(`Window ${tab.windowId}`);

  if (tab.pageState) {
    pieces.push(`${tab.pageState.pageKind}`);
    if (tab.pageState.siteAdapterLabel) {
      pieces.push(tab.pageState.siteAdapterLabel);
    }
    if (tab.pageState.userInterventionKind) {
      pieces.push(`waiting for ${tab.pageState.userInterventionKind}`);
    }
    pieces.push(`${tab.pageState.interactiveCount} interactive`);
  }

  return pieces.join(" · ");
}
