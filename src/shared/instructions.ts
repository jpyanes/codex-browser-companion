import { DEFAULT_SCROLL_AMOUNT } from "./constants";
import { attachTabContextToRequest, buildTabContextFromSnapshot } from "./tab-context";
import type { ActionRequest, InteractiveElementSummary, PageSnapshot, SuggestedRequest, SuggestedRequestAction } from "./types";

export interface ParsedInstruction {
  request: SuggestedRequest;
  explanation: string;
  confidence: number;
}

function normalize(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

function normalizeComparable(input: string): string {
  return normalize(input).toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function scoreCandidate(candidates: string[], query: string): number {
  let best = 0;
  const normalizedQuery = normalizeComparable(query);

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeComparable(candidate);
    if (!normalizedCandidate) {
      continue;
    }

    if (normalizedCandidate === normalizedQuery) {
      best = Math.max(best, 100);
      continue;
    }

    if (normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate)) {
      best = Math.max(best, 80);
      continue;
    }

    const queryWords = normalizedQuery.split(" ").filter(Boolean);
    const candidateWords = normalizedCandidate.split(" ").filter(Boolean);
    const overlap = queryWords.filter((word) => candidateWords.includes(word)).length;
    if (overlap > 0) {
      best = Math.max(best, Math.min(30 + overlap * 12, 70));
    }
  }

  return best;
}

function findInteractiveElement(
  snapshot: PageSnapshot,
  query: string,
  options: { tags?: string[]; requireSensitiveBlock?: boolean } = {},
): PageSnapshot["interactiveElements"][number] | null {
  const tags = options.tags?.map((tag) => tag.toLowerCase()) ?? [];
  const queryScore = normalizeComparable(query);
  let best: { element: PageSnapshot["interactiveElements"][number]; score: number } | null = null;

  for (const element of snapshot.interactiveElements) {
    const tagName = element.tagName.toLowerCase();
    if (tags.length > 0 && !tags.includes(tagName)) {
      continue;
    }

    if (options.requireSensitiveBlock && element.isSensitive) {
      continue;
    }

    const score = scoreCandidate(
      [element.label, element.text, element.name ?? "", element.placeholder ?? "", element.selector, element.type ?? ""],
      queryScore,
    );

    if (!score) {
      continue;
    }

    if (!best || score > best.score) {
      best = { element, score };
    }
  }

  return best && best.score >= 40 ? best.element : null;
}

function findEditableElement(snapshot: PageSnapshot): InteractiveElementSummary | null {
  return (
    snapshot.interactiveElements.find((element) => {
      const tagName = element.tagName.toLowerCase();
      return !element.isSensitive && (element.contentEditable === true || tagName === "textarea" || element.role.toLowerCase() === "textbox");
    }) ?? null
  );
}

function parseScrollInstruction(input: string): SuggestedRequestAction | null {
  const match = normalize(input).match(/^(?:scroll|page scroll|move page)\s+(up|down|left|right)(?:\s+(\d+))?$/i);
  if (!match) {
    return null;
  }

  const mode = match[1]!.toLowerCase() as "up" | "down" | "left" | "right";
  const amount = Number.parseInt(match[2] ?? "", 10);
  return {
    kind: "request-action",
    action: {
      actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      tabId: -1,
      kind: "scroll",
      direction: mode,
      amount: Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_SCROLL_AMOUNT,
    },
  };
}

function parseBackForwardRefresh(input: string): SuggestedRequestAction | null {
  const normalized = normalizeComparable(input);
  if (/^(go )?back$/.test(normalized)) {
    return {
      kind: "request-action",
      action: {
        actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        tabId: -1,
        kind: "navigate-back",
      },
    };
  }

  if (/^(go )?forward$/.test(normalized)) {
    return {
      kind: "request-action",
      action: {
        actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        tabId: -1,
        kind: "navigate-forward",
      },
    };
  }

  if (/^(refresh|reload)$/.test(normalized)) {
    return {
      kind: "request-action",
      action: {
        actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        tabId: -1,
        kind: "refresh",
      },
    };
  }

  return null;
}

function withSnapshotTabContext<T extends SuggestedRequest>(request: T, snapshot: PageSnapshot | null): T {
  if (!snapshot) {
    return request;
  }

  return attachTabContextToRequest(request, buildTabContextFromSnapshot(snapshot));
}

export function parseInstruction(input: string, snapshot: PageSnapshot | null): ParsedInstruction | null {
  const trimmed = normalize(input);
  if (!trimmed) {
    return null;
  }

  const comparable = normalizeComparable(trimmed);

  if (/^(scan|scan page|rescan|capture page)(?:\s+(full|summary|interactive|suggestions))?$/.test(comparable)) {
    const mode = (trimmed.match(/\b(full|summary|interactive|suggestions)\b/i)?.[1]?.toLowerCase() ?? "full") as
      | "full"
      | "summary"
      | "interactive"
      | "suggestions";
    return {
      request: withSnapshotTabContext({ kind: "scan-page", mode }, snapshot),
      explanation: `Queue a ${mode} scan of the current page.`,
      confidence: 0.96,
    };
  }

  if (/^(summarize|summary)( page)?$/.test(comparable)) {
    return {
      request: withSnapshotTabContext({ kind: "scan-page", mode: "summary" }, snapshot),
      explanation: "Summarize the current page.",
      confidence: 0.98,
    };
  }

  if (/^(list|show|inspect) (interactive|controls|elements)( on page)?$/.test(comparable) || comparable === "interactive elements") {
    return {
      request: withSnapshotTabContext({ kind: "scan-page", mode: "interactive" }, snapshot),
      explanation: "List the page's interactive controls and form fields.",
      confidence: 0.96,
    };
  }

  if (/^(suggest|suggest next actions|next actions)$/.test(comparable)) {
    return {
      request: withSnapshotTabContext({ kind: "scan-page", mode: "suggestions" }, snapshot),
      explanation: "Generate suggested next actions from the current page.",
      confidence: 0.94,
    };
  }

  if (snapshot?.siteAdapter?.id === "linkedin-feed" && /^(like|react)\s+(?:the\s+)?(?:very\s+)?first\s+post$/.test(comparable)) {
    const element = findInteractiveElement(snapshot, "like", { tags: ["button", "a", "summary", "input"] });
    if (element) {
      return {
        request: withSnapshotTabContext({
          kind: "request-action",
          action: {
            actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            tabId: snapshot.tabId,
            kind: "click",
            elementId: element.elementId,
            label: element.label || element.text || "Like",
            selector: element.selector,
          },
        }, snapshot),
        explanation: 'Click the first visible Like control in the LinkedIn feed.',
        confidence: 0.88,
      };
    }
  }

  if (
    snapshot?.siteAdapter?.id === "google-docs" &&
    /^(write|type|enter)\s+(.+)$/.test(trimmed) &&
    !/\b(?:into|in|on)\b/.test(comparable)
  ) {
    const match = trimmed.match(/^(write|type|enter)\s+(.+)$/i);
    if (match) {
      const text = match[2]!.trim();
      const element = findEditableElement(snapshot);
      if (element) {
        return {
          request: withSnapshotTabContext({
            kind: "request-action",
            action: {
              actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
              tabId: snapshot.tabId,
              kind: "type",
              elementId: element.elementId,
              text,
              clearBeforeTyping: false,
            },
          }, snapshot),
          explanation: "Type into the Google Docs editor surface.",
          confidence: 0.86,
        };
      }
    }
  }

  if (
    snapshot?.siteAdapter?.id === "google-drive" &&
    /^(new doc(?:ument)?|create doc(?:ument)?|open new doc(?:ument)?)$/.test(comparable)
  ) {
    const element = findInteractiveElement(snapshot, "new", { tags: ["button", "a", "summary"] }) ?? findInteractiveElement(snapshot, "blank", { tags: ["button", "a", "summary"] });
    if (element) {
      return {
        request: withSnapshotTabContext({
          kind: "request-action",
          action: {
            actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            tabId: snapshot.tabId,
            kind: "click",
            elementId: element.elementId,
            label: element.label || element.text || "New",
            selector: element.selector,
          },
        }, snapshot),
        explanation: "Open the Google Drive New menu to create a new document.",
        confidence: 0.82,
      };
    }
  }

  const scroll = parseScrollInstruction(trimmed);
  if (scroll) {
    return {
      request: scroll,
      explanation: "Scroll the current page.",
      confidence: 0.9,
    };
  }

  const backForwardRefresh = parseBackForwardRefresh(trimmed);
  if (backForwardRefresh) {
    return {
      request: backForwardRefresh,
      explanation: "Run a simple navigation action.",
      confidence: 0.95,
    };
  }

  if (/^(click|press|tap|open)\s+(.+)$/i.test(trimmed)) {
    if (!snapshot) {
      return null;
    }

    const target = trimmed.replace(/^(click|press|tap|open)\s+/i, "").trim();
    const element = findInteractiveElement(snapshot, target, { tags: ["button", "a", "summary", "input"] });
    if (!element) {
      return null;
    }

    return {
      request: withSnapshotTabContext({
        kind: "request-action",
        action: {
          actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          tabId: snapshot.tabId,
          kind: "click",
          elementId: element.elementId,
          label: element.label || element.text || target,
        },
      }, snapshot),
      explanation: `Click the control that best matches "${target}".`,
      confidence: 0.82,
    };
  }

  if (/^(type|enter|fill)\s+(.+?)\s+(?:into|in|on)\s+(.+)$/i.test(trimmed)) {
    if (!snapshot) {
      return null;
    }

    const match = trimmed.match(/^(type|enter|fill)\s+(.+?)\s+(?:into|in|on)\s+(.+)$/i);
    if (!match) {
      return null;
    }

    const text = match[2]!.trim();
    const target = match[3]!.trim();
    const element = findInteractiveElement(snapshot, target, { tags: ["input", "textarea", "div"] });
    if (!element || element.isSensitive) {
      return null;
    }

    return {
      request: withSnapshotTabContext({
        kind: "request-action",
        action: {
          actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          tabId: snapshot.tabId,
          kind: "type",
          elementId: element.elementId,
          text,
          clearBeforeTyping: true,
        },
      }, snapshot),
      explanation: `Type text into the field that best matches "${target}".`,
      confidence: 0.84,
    };
  }

  if (/^(select|choose|pick)\s+(.+?)\s+(?:in|on|for)\s+(.+)$/i.test(trimmed)) {
    if (!snapshot) {
      return null;
    }

    const match = trimmed.match(/^(select|choose|pick)\s+(.+?)\s+(?:in|on|for)\s+(.+)$/i);
    if (!match) {
      return null;
    }

    const optionText = match[2]!.trim();
    const target = match[3]!.trim();
    const element = findInteractiveElement(snapshot, target, { tags: ["select"] });
    if (!element) {
      return null;
    }

    return {
      request: withSnapshotTabContext({
        kind: "request-action",
        action: {
          actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          tabId: snapshot.tabId,
          kind: "select",
          elementId: element.elementId,
          selection: { by: "label", value: optionText },
        },
      }, snapshot),
      explanation: `Select "${optionText}" in the dropdown that best matches "${target}".`,
      confidence: 0.84,
    };
  }

  if (/^(submit|submit form)\s+(.+)?$/i.test(trimmed)) {
    if (!snapshot) {
      return null;
    }

    const target = trimmed.replace(/^(submit|submit form)\s+/i, "").trim();
    const element = target ? findInteractiveElement(snapshot, target, { tags: ["button", "input"] }) : snapshot.interactiveElements.find((entry) => entry.tagName.toLowerCase() === "button" || entry.type === "submit");
    if (!element) {
      return null;
    }

    return {
      request: withSnapshotTabContext({
        kind: "request-action",
        action: {
          actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          tabId: snapshot.tabId,
          kind: "submit-form",
          elementId: element.elementId,
          label: element.label || element.text || target,
        },
      }, snapshot),
      explanation: `Submit the form control that best matches "${target || element.label || element.text}".`,
      confidence: 0.78,
    };
  }

  return null;
}
