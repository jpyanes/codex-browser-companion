import { sortTrackedTabs } from "./tab-orchestration";
import type { TrackedTabState } from "./types";

export interface TabSearchResult {
  tab: TrackedTabState;
  score: number;
  reason: string;
}

function normalize(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

function scoreCandidate(candidate: string, query: string): number {
  const normalizedCandidate = normalize(candidate);
  const normalizedQuery = normalize(query);
  if (!normalizedCandidate || !normalizedQuery) {
    return 0;
  }

  if (normalizedCandidate === normalizedQuery) {
    return 100;
  }

  if (normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate)) {
    return 80;
  }

  const queryWords = normalizedQuery.split(" ").filter(Boolean);
  const candidateWords = normalizedCandidate.split(" ").filter(Boolean);
  const overlap = queryWords.filter((word) => candidateWords.includes(word)).length;
  if (overlap > 0) {
    return Math.min(30 + overlap * 12, 70);
  }

  return 0;
}

function collectSearchFields(tab: TrackedTabState): Array<{ value: string; reason: string; bias: number }> {
  const fields: Array<{ value: string; reason: string; bias: number }> = [
    { value: tab.pageState?.siteAdapterLabel || "", reason: "site adapter", bias: 20 },
    { value: tab.snapshot?.siteAdapter?.summary || "", reason: "site adapter summary", bias: 15 },
    { value: tab.snapshot?.siteAdapter?.notes.join(" ") || "", reason: "site adapter note", bias: 10 },
    { value: tab.snapshot?.summary || "", reason: "page summary", bias: 8 },
    { value: tab.snapshot?.visibleTextExcerpt || "", reason: "visible text", bias: 6 },
    { value: tab.snapshot?.headings.map((heading) => heading.text).join(" ") || "", reason: "headings", bias: 4 },
    { value: tab.snapshot?.interactiveElements.map((element) => [element.label, element.text, element.placeholder].filter(Boolean).join(" ")).join(" ") || "", reason: "interactive controls", bias: 2 },
    { value: tab.title || "", reason: "title", bias: 0 },
    { value: tab.url || "", reason: "URL", bias: 0 },
    { value: tab.pageState?.pageKind || "", reason: "page kind", bias: 0 },
  ];

  return fields.filter((field) => Boolean(field.value));
}

export function searchTrackedTabs(tabs: TrackedTabState[], query: string, activeTabId: number | null): TabSearchResult[] {
  const normalizedQuery = normalize(query);
  const sorted = sortTrackedTabs(tabs, activeTabId);

  if (!normalizedQuery) {
    return sorted.map((tab) => ({ tab, score: 0, reason: "" }));
  }

  const ranked = sorted
    .map((tab) => {
      let bestScore = 0;
      let bestReason = "";

      for (const field of collectSearchFields(tab)) {
        const score = scoreCandidate(field.value, normalizedQuery) + field.bias;
        if (score > bestScore) {
          bestScore = score;
          bestReason = field.reason;
        }
      }

      return { tab, score: bestScore, reason: bestScore > 0 ? bestReason : tab.tabId === activeTabId ? "current tab" : "tab metadata" };
    })
    .filter((result) => result.score > 0 || result.tab.tabId === activeTabId);

  return ranked.sort((left, right) => {
    if (left.tab.tabId === activeTabId && right.tab.tabId !== activeTabId) {
      return -1;
    }

    if (right.tab.tabId === activeTabId && left.tab.tabId !== activeTabId) {
      return 1;
    }

    if (left.score !== right.score) {
      return right.score - left.score;
    }

    return left.tab.lastSeenAt < right.tab.lastSeenAt ? 1 : -1;
  });
}
