"use strict";
(() => {
  // src/shared/constants.ts
  var DEFAULT_SCROLL_AMOUNT = 600;
  var DEFAULT_UI_POLL_MS = 1e3;

  // src/shared/bridge.ts
  function bridgeStatusTone(status) {
    switch (status) {
      case "connected":
        return "success";
      case "connecting":
        return "warning";
      case "error":
      case "disconnected":
        return "danger";
    }
  }
  function bridgeStatusLabel(status) {
    switch (status) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Connecting";
      case "error":
        return "Error";
      case "disconnected":
        return "Disconnected";
    }
  }
  function summarizeBridgeState(state) {
    if (state.status === "connected" && state.activeExtension) {
      const profile = state.activeExtension.profile?.email ?? state.activeExtension.browser ?? "your Chrome session";
      return `Connected to ${profile} with ${state.activeTargetCount} active target${state.activeTargetCount === 1 ? "" : "s"}.`;
    }
    if (state.status === "connecting") {
      return state.relayVersion ? `Playwriter relay ${state.relayVersion} is up, waiting for a Chrome tab to connect.` : `Waiting for the local Playwriter bridge at ${state.endpoint}.`;
    }
    if (state.status === "error") {
      return state.lastError?.message ?? `The bridge at ${state.endpoint} reported an error.`;
    }
    return `No Playwriter bridge detected at ${state.endpoint}. Run \`npm run bridge\` to start one.`;
  }

  // src/shared/logger.ts
  function nowIso() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }

  // src/shared/action-policy.ts
  var DANGEROUS_KEYWORDS = [
    "delete",
    "remove",
    "submit",
    "confirm",
    "purchase",
    "pay",
    "checkout",
    "unsubscribe",
    "sign out",
    "log out",
    "logoff",
    "close account",
    "cancel",
    "post",
    "publish"
  ];
  function requiresApproval(action) {
    return action.kind === "click" || action.kind === "type" || action.kind === "select" || action.kind === "submit-form";
  }
  function isLikelySensitiveSnapshot(snapshot) {
    return Boolean(snapshot?.meta.hasSensitiveInputs || snapshot?.pageKind === "login");
  }
  function classifyDanger(action, snapshot) {
    if (action.kind === "submit-form") {
      return "high";
    }
    if (action.kind === "type") {
      return isLikelySensitiveSnapshot(snapshot) ? "high" : "medium";
    }
    if (action.kind === "select") {
      return "medium";
    }
    if (action.kind === "click") {
      const label = (action.label ?? "").toLowerCase();
      if (DANGEROUS_KEYWORDS.some((keyword) => label.includes(keyword))) {
        return "high";
      }
      return "medium";
    }
    return "low";
  }

  // src/shared/semantic.ts
  function semanticStatusTone(status) {
    switch (status) {
      case "ready":
        return "success";
      case "disabled":
        return "warning";
      case "error":
        return "danger";
      case "disconnected":
        return "neutral";
    }
  }
  function semanticStatusLabel(status) {
    switch (status) {
      case "ready":
        return "Ready";
      case "disabled":
        return "Disabled";
      case "error":
        return "Error";
      case "disconnected":
        return "Disconnected";
    }
  }
  function summarizeSemanticState(state) {
    if (state.status === "ready") {
      const model = state.model ?? "configured model";
      const page = state.pageTitle || state.pageUrl || "the active page";
      const count = state.suggestionCount;
      return `Stagehand semantic bridge is ready with ${model}. Last observation covered ${page} and produced ${count} suggestion${count === 1 ? "" : "s"}.`;
    }
    if (state.status === "disabled") {
      return state.disabledReason ? `Stagehand semantic bridge is disabled: ${state.disabledReason}` : "Stagehand semantic bridge is disabled until a model is configured.";
    }
    if (state.status === "error") {
      return state.lastError?.message ?? "Stagehand semantic bridge reported an error.";
    }
    return `No Stagehand semantic bridge detected at ${state.endpoint}. Run \`npm run semantic\` to start one.`;
  }

  // src/shared/tab-orchestration.ts
  function normalize(input) {
    return input.trim().replace(/\s+/g, " ");
  }
  function pendingApprovalCount(tab) {
    return tab.approvals.filter((approval) => approval.status === "pending" || approval.status === "executing").length;
  }
  function sortTrackedTabs(tabs, activeTabId) {
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
  function tabStatusTone(tab, activeTabId) {
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
  function tabStatusLabel(tab, activeTabId) {
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
  function summarizeTrackedTab(tab) {
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
      pieces.push(`${tab.pageState.interactiveCount} interactive`);
    }
    return pieces.join(" · ");
  }

  // src/shared/tab-intelligence.ts
  function normalize2(input) {
    return input.trim().replace(/\s+/g, " ").toLowerCase();
  }
  function scoreCandidate(candidate, query) {
    const normalizedCandidate = normalize2(candidate);
    const normalizedQuery = normalize2(query);
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
  function collectSearchFields(tab) {
    const fields = [
      { value: tab.pageState?.siteAdapterLabel || "", reason: "site adapter", bias: 20 },
      { value: tab.snapshot?.siteAdapter?.summary || "", reason: "site adapter summary", bias: 15 },
      { value: tab.snapshot?.siteAdapter?.notes.join(" ") || "", reason: "site adapter note", bias: 10 },
      { value: tab.snapshot?.summary || "", reason: "page summary", bias: 8 },
      { value: tab.snapshot?.visibleTextExcerpt || "", reason: "visible text", bias: 6 },
      { value: tab.snapshot?.headings.map((heading) => heading.text).join(" ") || "", reason: "headings", bias: 4 },
      { value: tab.snapshot?.interactiveElements.map((element) => [element.label, element.text, element.placeholder].filter(Boolean).join(" ")).join(" ") || "", reason: "interactive controls", bias: 2 },
      { value: tab.title || "", reason: "title", bias: 0 },
      { value: tab.url || "", reason: "URL", bias: 0 },
      { value: tab.pageState?.pageKind || "", reason: "page kind", bias: 0 }
    ];
    return fields.filter((field) => Boolean(field.value));
  }
  function searchTrackedTabs(tabs, query, activeTabId) {
    const normalizedQuery = normalize2(query);
    const sorted = sortTrackedTabs(tabs, activeTabId);
    if (!normalizedQuery) {
      return sorted.map((tab) => ({ tab, score: 0, reason: "" }));
    }
    const ranked = sorted.map((tab) => {
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
    }).filter((result) => result.score > 0 || result.tab.tabId === activeTabId);
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

  // src/shared/instructions.ts
  function normalize3(input) {
    return input.trim().replace(/\s+/g, " ");
  }
  function normalizeComparable(input) {
    return normalize3(input).toLowerCase().replace(/[^a-z0-9]+/g, " ");
  }
  function scoreCandidate2(candidates, query) {
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
  function findInteractiveElement(snapshot, query, options = {}) {
    const tags = options.tags?.map((tag) => tag.toLowerCase()) ?? [];
    const queryScore = normalizeComparable(query);
    let best = null;
    for (const element of snapshot.interactiveElements) {
      const tagName = element.tagName.toLowerCase();
      if (tags.length > 0 && !tags.includes(tagName)) {
        continue;
      }
      if (options.requireSensitiveBlock && element.isSensitive) {
        continue;
      }
      const score = scoreCandidate2(
        [element.label, element.text, element.name ?? "", element.placeholder ?? "", element.selector, element.type ?? ""],
        queryScore
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
  function findEditableElement(snapshot) {
    return snapshot.interactiveElements.find((element) => {
      const tagName = element.tagName.toLowerCase();
      return !element.isSensitive && (element.contentEditable === true || tagName === "textarea" || element.role.toLowerCase() === "textbox");
    }) ?? null;
  }
  function parseScrollInstruction(input) {
    const match = normalize3(input).match(/^(?:scroll|page scroll|move page)\s+(up|down|left|right)(?:\s+(\d+))?$/i);
    if (!match) {
      return null;
    }
    const mode = match[1].toLowerCase();
    const amount = Number.parseInt(match[2] ?? "", 10);
    return {
      kind: "request-action",
      action: {
        actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        tabId: -1,
        kind: "scroll",
        direction: mode,
        amount: Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_SCROLL_AMOUNT
      }
    };
  }
  function parseBackForwardRefresh(input) {
    const normalized = normalizeComparable(input);
    if (/^(go )?back$/.test(normalized)) {
      return {
        kind: "request-action",
        action: {
          actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          tabId: -1,
          kind: "navigate-back"
        }
      };
    }
    if (/^(go )?forward$/.test(normalized)) {
      return {
        kind: "request-action",
        action: {
          actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          tabId: -1,
          kind: "navigate-forward"
        }
      };
    }
    if (/^(refresh|reload)$/.test(normalized)) {
      return {
        kind: "request-action",
        action: {
          actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          tabId: -1,
          kind: "refresh"
        }
      };
    }
    return null;
  }
  function parseInstruction(input, snapshot) {
    const trimmed = normalize3(input);
    if (!trimmed) {
      return null;
    }
    const comparable = normalizeComparable(trimmed);
    if (/^(scan|scan page|rescan|capture page)(?:\s+(full|summary|interactive|suggestions))?$/.test(comparable)) {
      const mode = trimmed.match(/\b(full|summary|interactive|suggestions)\b/i)?.[1]?.toLowerCase() ?? "full";
      return {
        request: { kind: "scan-page", mode },
        explanation: `Queue a ${mode} scan of the current page.`,
        confidence: 0.96
      };
    }
    if (/^(summarize|summary)( page)?$/.test(comparable)) {
      return {
        request: { kind: "scan-page", mode: "summary" },
        explanation: "Summarize the current page.",
        confidence: 0.98
      };
    }
    if (/^(list|show|inspect) (interactive|controls|elements)( on page)?$/.test(comparable) || comparable === "interactive elements") {
      return {
        request: { kind: "scan-page", mode: "interactive" },
        explanation: "List the page's interactive controls and form fields.",
        confidence: 0.96
      };
    }
    if (/^(suggest|suggest next actions|next actions)$/.test(comparable)) {
      return {
        request: { kind: "scan-page", mode: "suggestions" },
        explanation: "Generate suggested next actions from the current page.",
        confidence: 0.94
      };
    }
    if (snapshot?.siteAdapter?.id === "linkedin-feed" && /^(like|react)\s+(?:the\s+)?(?:very\s+)?first\s+post$/.test(comparable)) {
      const element = findInteractiveElement(snapshot, "like", { tags: ["button", "a", "summary", "input"] });
      if (element) {
        return {
          request: {
            kind: "request-action",
            action: {
              actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
              tabId: snapshot.tabId,
              kind: "click",
              elementId: element.elementId,
              label: element.label || element.text || "Like",
              selector: element.selector
            }
          },
          explanation: "Click the first visible Like control in the LinkedIn feed.",
          confidence: 0.88
        };
      }
    }
    if (snapshot?.siteAdapter?.id === "google-docs" && /^(write|type|enter)\s+(.+)$/.test(trimmed) && !/\b(?:into|in|on)\b/.test(comparable)) {
      const match = trimmed.match(/^(write|type|enter)\s+(.+)$/i);
      if (match) {
        const text = match[2].trim();
        const element = findEditableElement(snapshot);
        if (element) {
          return {
            request: {
              kind: "request-action",
              action: {
                actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
                tabId: snapshot.tabId,
                kind: "type",
                elementId: element.elementId,
                text,
                clearBeforeTyping: false
              }
            },
            explanation: "Type into the Google Docs editor surface.",
            confidence: 0.86
          };
        }
      }
    }
    if (snapshot?.siteAdapter?.id === "google-drive" && /^(new doc(?:ument)?|create doc(?:ument)?|open new doc(?:ument)?)$/.test(comparable)) {
      const element = findInteractiveElement(snapshot, "new", { tags: ["button", "a", "summary"] }) ?? findInteractiveElement(snapshot, "blank", { tags: ["button", "a", "summary"] });
      if (element) {
        return {
          request: {
            kind: "request-action",
            action: {
              actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
              tabId: snapshot.tabId,
              kind: "click",
              elementId: element.elementId,
              label: element.label || element.text || "New",
              selector: element.selector
            }
          },
          explanation: "Open the Google Drive New menu to create a new document.",
          confidence: 0.82
        };
      }
    }
    const scroll = parseScrollInstruction(trimmed);
    if (scroll) {
      return {
        request: scroll,
        explanation: "Scroll the current page.",
        confidence: 0.9
      };
    }
    const backForwardRefresh = parseBackForwardRefresh(trimmed);
    if (backForwardRefresh) {
      return {
        request: backForwardRefresh,
        explanation: "Run a simple navigation action.",
        confidence: 0.95
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
        request: {
          kind: "request-action",
          action: {
            actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            tabId: snapshot.tabId,
            kind: "click",
            elementId: element.elementId,
            label: element.label || element.text || target
          }
        },
        explanation: `Click the control that best matches "${target}".`,
        confidence: 0.82
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
      const text = match[2].trim();
      const target = match[3].trim();
      const element = findInteractiveElement(snapshot, target, { tags: ["input", "textarea", "div"] });
      if (!element || element.isSensitive) {
        return null;
      }
      return {
        request: {
          kind: "request-action",
          action: {
            actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            tabId: snapshot.tabId,
            kind: "type",
            elementId: element.elementId,
            text,
            clearBeforeTyping: true
          }
        },
        explanation: `Type text into the field that best matches "${target}".`,
        confidence: 0.84
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
      const optionText = match[2].trim();
      const target = match[3].trim();
      const element = findInteractiveElement(snapshot, target, { tags: ["select"] });
      if (!element) {
        return null;
      }
      return {
        request: {
          kind: "request-action",
          action: {
            actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            tabId: snapshot.tabId,
            kind: "select",
            elementId: element.elementId,
            selection: { by: "label", value: optionText }
          }
        },
        explanation: `Select "${optionText}" in the dropdown that best matches "${target}".`,
        confidence: 0.84
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
        request: {
          kind: "request-action",
          action: {
            actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            tabId: snapshot.tabId,
            kind: "submit-form",
            elementId: element.elementId,
            label: element.label || element.text || target
          }
        },
        explanation: `Submit the form control that best matches "${target || element.label || element.text}".`,
        confidence: 0.78
      };
    }
    return null;
  }

  // src/shared/workflow.ts
  function makeId(prefix) {
    return globalThis.crypto?.randomUUID?.() ?? `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
  function normalize4(input) {
    return input.trim().replace(/\s+/g, " ");
  }
  function normalizeComparable2(input) {
    return normalize4(input).toLowerCase().replace(/[^a-z0-9]+/g, " ");
  }
  function cloneRequestWithWorkflowContext(request, workflowId, workflowStepId) {
    if (request.kind === "request-action") {
      return {
        ...request,
        action: {
          ...request.action,
          workflowId,
          workflowStepId
        }
      };
    }
    return {
      ...request,
      workflowId,
      workflowStepId
    };
  }
  function isResumeInstruction(input) {
    const comparable = normalizeComparable2(input);
    return comparable === "continue" || comparable === "resume" || comparable === "next" || comparable === "next step" || comparable === "keep going";
  }
  function splitWorkflowClauses(input) {
    const chunks = normalize4(input).replace(/\r\n/g, "\n").split(/\n+|;/).map((chunk) => chunk.trim()).filter(Boolean);
    const clauses = [];
    for (const chunk of chunks) {
      const parts = chunk.split(/\b(?:and then|then|next|after that|finally)\b/i).map((part) => part.trim()).filter(Boolean);
      if (parts.length === 0) {
        continue;
      }
      clauses.push(...parts);
    }
    return clauses.length > 0 ? clauses : [normalize4(input)];
  }
  function getWorkflowNextStep(plan) {
    if (!plan) {
      return null;
    }
    const step = plan.steps[plan.currentStepIndex] ?? null;
    if (!step) {
      return null;
    }
    if (step.status === "completed" || step.status === "failed") {
      return null;
    }
    return step;
  }
  function buildStepFromParsedInstruction(workflowId, clause, parsed) {
    if (!parsed) {
      return null;
    }
    const stepId = makeId("workflow-step");
    const request = cloneRequestWithWorkflowContext(parsed.request, workflowId, stepId);
    if (request.kind === "request-action") {
      request.action.workflowId = workflowId;
      request.action.workflowStepId = stepId;
    }
    const approvalRequired = request.kind === "request-action" ? requiresApproval(request.action) : false;
    const dangerLevel = request.kind === "request-action" ? classifyDanger(request.action, null) : "low";
    return {
      stepId,
      title: parsed.explanation,
      description: parsed.explanation,
      source: "command",
      request,
      approvalRequired,
      dangerLevel,
      confidence: parsed.confidence,
      status: "pending",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: null,
      resultSummary: null,
      notes: normalize4(clause)
    };
  }
  function buildBlockedStep(clause) {
    return {
      stepId: makeId("workflow-step"),
      title: `Unsupported step: ${normalize4(clause)}`,
      description: `CBC could not translate "${normalize4(clause)}" into a safe browser action in v1.`,
      source: "planner",
      request: null,
      approvalRequired: false,
      dangerLevel: "low",
      confidence: 0.1,
      status: "blocked",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: null,
      resultSummary: null,
      notes: normalize4(clause)
    };
  }
  function countBlockedSteps(steps) {
    return steps.filter((step) => step.status === "blocked").length;
  }
  function countCompletedSteps(steps) {
    return steps.filter((step) => step.status === "completed").length;
  }
  function planExplanation(stepCount, blockedCount) {
    const blockedSuffix = blockedCount > 0 ? ` ${blockedCount} step${blockedCount === 1 ? "" : "s"} need a manual follow-up.` : "";
    return stepCount > 1 ? `Planned ${stepCount} workflow steps.${blockedSuffix}` : `Planned 1 workflow step.${blockedSuffix}`;
  }
  function firstActionableRequest(steps) {
    for (const step of steps) {
      if (step.status === "blocked" || !step.request) {
        return null;
      }
      return step.request;
    }
    return null;
  }
  function buildWorkflowPlanFromInstruction(input, snapshot, activeWorkflow) {
    const trimmed = normalize4(input);
    if (!trimmed) {
      return null;
    }
    const workflowId = makeId("workflow");
    const clauses = splitWorkflowClauses(trimmed);
    const steps = [];
    if (isResumeInstruction(trimmed) && activeWorkflow) {
      const existingNextStep = getWorkflowNextStep(activeWorkflow);
      if (!existingNextStep) {
        return null;
      }
      const resumedStep = {
        ...existingNextStep,
        stepId: existingNextStep.stepId,
        title: `Resume workflow: ${existingNextStep.title}`,
        description: `Continue the active workflow at step ${activeWorkflow.currentStepIndex + 1}.`,
        source: "memory",
        request: existingNextStep.request ? cloneRequestWithWorkflowContext(existingNextStep.request, activeWorkflow.workflowId, existingNextStep.stepId) : null,
        status: existingNextStep.status === "completed" ? "pending" : existingNextStep.status,
        updatedAt: nowIso(),
        notes: existingNextStep.notes
      };
      return {
        workflow: {
          ...activeWorkflow,
          updatedAt: nowIso(),
          status: "active"
        },
        primaryRequest: resumedStep.request,
        explanation: `Resuming the active workflow: ${activeWorkflow.objective}.`,
        confidence: 0.88,
        blockedStepCount: countBlockedSteps(activeWorkflow.steps)
      };
    }
    for (const clause of clauses) {
      const parsed = parseInstruction(clause, snapshot);
      const step = parsed ? buildStepFromParsedInstruction(workflowId, clause, parsed) : buildBlockedStep(clause);
      if (step) {
        steps.push(step);
      }
    }
    if (steps.length === 0) {
      return null;
    }
    const workflow = {
      workflowId,
      objective: trimmed,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: "active",
      originTabId: snapshot?.tabId ?? -1,
      originUrl: snapshot?.url ?? "",
      originTitle: snapshot?.title ?? "",
      currentStepIndex: 0,
      lastPageUrl: snapshot?.url ?? null,
      lastPageTitle: snapshot?.title ?? null,
      lastSummary: snapshot?.summary ?? null,
      steps
    };
    const primaryRequest = firstActionableRequest(steps);
    const blockedStepCount = countBlockedSteps(steps);
    return {
      workflow,
      primaryRequest,
      explanation: planExplanation(steps.length, blockedStepCount),
      confidence: Math.max(...steps.map((step) => step.confidence), 0.5),
      blockedStepCount
    };
  }
  function summarizeWorkflowState(state) {
    const workflow = state.activeWorkflow;
    if (!workflow) {
      return "No active workflow plan.";
    }
    const currentStep = workflow.steps[workflow.currentStepIndex] ?? null;
    const completed = countCompletedSteps(workflow.steps);
    const total = workflow.steps.length;
    if (workflow.status === "paused") {
      return currentStep ? `Workflow "${workflow.objective}" is paused on step ${workflow.currentStepIndex + 1}/${total}: ${currentStep.title}.` : `Workflow "${workflow.objective}" is paused after completing ${completed}/${total} steps.`;
    }
    if (workflow.status === "completed") {
      return `Workflow "${workflow.objective}" is complete.`;
    }
    if (!currentStep) {
      return `Workflow "${workflow.objective}" is active with ${completed}/${total} steps complete.`;
    }
    return `Workflow "${workflow.objective}" is active at step ${workflow.currentStepIndex + 1}/${total}: ${currentStep.title}.`;
  }
  function workflowStatusTone(status) {
    switch (status) {
      case "active":
        return "warning";
      case "paused":
        return "neutral";
      case "completed":
        return "success";
      case "abandoned":
        return "neutral";
      case "failed":
        return "danger";
    }
  }
  function workflowStatusLabel(status) {
    switch (status) {
      case "active":
        return "Active";
      case "paused":
        return "Paused";
      case "completed":
        return "Completed";
      case "abandoned":
        return "Abandoned";
      case "failed":
        return "Failed";
    }
  }
  function workflowStepStatusTone(status) {
    switch (status) {
      case "pending":
        return "neutral";
      case "queued":
        return "warning";
      case "completed":
        return "success";
      case "blocked":
        return "danger";
      case "failed":
        return "danger";
    }
  }
  function workflowStepStatusLabel(status) {
    switch (status) {
      case "pending":
        return "Pending";
      case "queued":
        return "Queued";
      case "completed":
        return "Done";
      case "blocked":
        return "Blocked";
      case "failed":
        return "Failed";
    }
  }
  function workflowProgress(state) {
    const workflow = state?.activeWorkflow ?? null;
    if (!workflow) {
      return { completed: 0, total: 0, blocked: 0 };
    }
    return {
      completed: countCompletedSteps(workflow.steps),
      total: workflow.steps.length,
      blocked: countBlockedSteps(workflow.steps)
    };
  }
  function getActiveWorkflowNextStep(state) {
    return getWorkflowNextStep(state?.activeWorkflow ?? null);
  }

  // src/ui/app.ts
  function escapeHtml(input) {
    return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function safeAttr(input) {
    return escapeHtml(input).replace(/`/g, "&#96;");
  }
  function formatTime(timestamp) {
    try {
      return new Intl.DateTimeFormat(void 0, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit"
      }).format(new Date(timestamp));
    } catch {
      return timestamp;
    }
  }
  function formatRelative(timestamp) {
    const diffMs = Date.now() - new Date(timestamp).getTime();
    if (!Number.isFinite(diffMs) || diffMs < 0) {
      return "just now";
    }
    const seconds = Math.floor(diffMs / 1e3);
    if (seconds < 60) {
      return `${seconds}s ago`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
  function limit(items, max) {
    return items.slice(0, max);
  }
  function statusLabel(status) {
    switch (status) {
      case "idle":
        return "Idle";
      case "connected":
        return "Connected";
      case "running":
        return "Running";
      case "awaiting-approval":
        return "Awaiting approval";
      case "error":
        return "Error";
    }
  }
  function statusClass(status) {
    return `status-chip--${status}`;
  }
  function commandHint(mode) {
    return mode === "popup" ? 'Try: "click save", "click save then summarize page", "type hello into search", or "scroll down 600".' : 'Try: "click save", "click save then summarize page", "type hello into search", or "scroll down 600".';
  }
  function getPageState(tab) {
    return tab?.snapshot ?? null;
  }
  function renderChip(label, tone = "neutral") {
    return `<span class="chip chip--${tone}">${escapeHtml(label)}</span>`;
  }
  function renderList(items, emptyLabel, className = "list list--compact") {
    if (items.length === 0) {
      return `<p class="empty">${escapeHtml(emptyLabel)}</p>`;
    }
    return `<ul class="${className}">${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
  }
  function renderLogEntries(tab, maxItems) {
    const entries = limit(tab?.activityLog ?? [], maxItems);
    if (entries.length === 0) {
      return `<p class="empty">No activity yet. Scan the page or run a command to get started.</p>`;
    }
    return `<ul class="activity-log">${entries.map(
      (entry) => `
        <li class="log log--${entry.level}">
          <div class="log__meta">
            <span class="log__level">${escapeHtml(entry.level)}</span>
            <span class="log__time">${escapeHtml(formatRelative(entry.timestamp))}</span>
          </div>
          <div class="log__message">${escapeHtml(entry.message)}</div>
          ${entry.details ? `<pre class="log__details">${escapeHtml(entry.details)}</pre>` : ""}
        </li>`
    ).join("")}</ul>`;
  }
  function renderApprovals(tab) {
    const approvals = tab?.approvals ?? [];
    if (approvals.length === 0) {
      return `<p class="empty">No pending approvals.</p>`;
    }
    return `<ul class="approval-list">${approvals.slice().reverse().map((approval) => {
      const pending = approval.status === "pending" || approval.status === "approved" || approval.status === "executing";
      const tone = approval.dangerLevel === "high" ? "danger" : approval.dangerLevel === "medium" ? "warning" : "neutral";
      return `
        <li class="approval approval--${tone}">
          <div class="approval__header">
            <div>
              <div class="approval__title">${escapeHtml(approval.title)}</div>
              <div class="approval__description">${escapeHtml(approval.description)}</div>
            </div>
            ${renderChip(approval.status, tone)}
          </div>
          <div class="approval__meta">
            <span>${escapeHtml(approval.dangerLevel)} risk</span>
            <span>${escapeHtml(formatTime(approval.createdAt))}</span>
          </div>
          ${pending ? `
                <div class="approval__actions">
                  <button class="btn btn--primary" data-approval-action="approve" data-approval-id="${safeAttr(approval.approvalId)}">Approve</button>
                  <button class="btn btn--ghost" data-approval-action="reject" data-approval-id="${safeAttr(approval.approvalId)}">Reject</button>
                </div>` : ""}
        </li>`;
    }).join("")}</ul>`;
  }
  function renderSuggestions(snapshot) {
    const suggestions = snapshot?.suggestedActions ?? [];
    if (suggestions.length === 0) {
      return `<p class="empty">Scan the page to generate suggested next actions.</p>`;
    }
    return `<div class="suggestions">${suggestions.map((suggestion) => renderSuggestionCard(suggestion)).join("")}</div>`;
  }
  function renderSuggestionCard(suggestion) {
    const tone = suggestion.dangerLevel === "high" ? "danger" : suggestion.dangerLevel === "medium" ? "warning" : "neutral";
    const sourceLabel = suggestion.source === "workflow" ? "Workflow" : suggestion.source === "stagehand" ? "Stagehand" : suggestion.source === "site" ? "Site" : "DOM";
    const confidenceLabel = typeof suggestion.confidence === "number" && Number.isFinite(suggestion.confidence) ? `${Math.round(suggestion.confidence * 100)}%` : "";
    return `
    <button class="suggestion" data-suggestion-id="${safeAttr(suggestion.id)}">
      <div class="suggestion__top">
        <div class="suggestion__title">${escapeHtml(suggestion.title)}</div>
        <div class="suggestion__chips">
          ${renderChip(sourceLabel, "neutral")}
          ${renderChip(suggestion.dangerLevel, tone)}
          ${confidenceLabel ? renderChip(confidenceLabel, "neutral") : ""}
        </div>
      </div>
      <div class="suggestion__description">${escapeHtml(suggestion.description)}</div>
      ${suggestion.selector ? `<div class="suggestion__selector">${escapeHtml(suggestion.selector)}</div>` : ""}
      <div class="suggestion__cta">${escapeHtml(suggestion.buttonLabel)}</div>
    </button>`;
  }
  function renderInteractiveElements(tab, maxItems) {
    const snapshot = getPageState(tab);
    const elements = limit(snapshot?.interactiveElements ?? [], maxItems);
    if (elements.length === 0) {
      return `<p class="empty">No interactive elements captured yet.</p>`;
    }
    return `<ul class="element-list">${elements.map(
      (element) => `
        <li class="element">
          <div class="element__top">
            <span class="element__label">${escapeHtml(element.label || element.text || element.tagName)}</span>
            ${renderChip(element.tagName, element.isSensitive ? "danger" : "neutral")}
          </div>
          <div class="element__meta">
            <span>${escapeHtml(element.role)}</span>
            <span>${escapeHtml(element.type || "")}</span>
            <span>${escapeHtml(element.disabled ? "disabled" : "enabled")}</span>
          </div>
          <div class="element__selector">${escapeHtml(element.selector)}</div>
        </li>`
    ).join("")}</ul>`;
  }
  function renderHeadings(snapshot) {
    const headings = snapshot?.headings ?? [];
    if (headings.length === 0) {
      return `<p class="empty">No headings were detected.</p>`;
    }
    return `<ol class="heading-list">${limit(headings, 8).map((heading) => `<li><span class="heading-list__level">H${heading.level}</span> ${escapeHtml(heading.text)}</li>`).join("")}</ol>`;
  }
  function renderOutline(snapshot) {
    const outline = snapshot?.semanticOutline ?? [];
    if (outline.length === 0) {
      return `<p class="empty">No semantic outline was captured.</p>`;
    }
    return `<ul class="outline">${limit(outline, 8).map((node) => {
      const prefix = node.kind === "heading" ? `H${node.level ?? ""}` : node.role || node.kind;
      return `<li><span class="outline__prefix">${escapeHtml(prefix)}</span> ${escapeHtml(node.text)}</li>`;
    }).join("")}</ul>`;
  }
  function renderSummary(tab, snapshot, mode) {
    if (!tab) {
      return `<section class="panel panel--empty"><p class="empty">No active tab detected. Open a web page and reopen the extension.</p></section>`;
    }
    const pageState = tab.pageState;
    const freshState = tab.snapshotFresh ? "Fresh" : "Stale";
    const freshnessTone = tab.snapshotFresh ? "success" : "warning";
    const adapterLabel = pageState?.siteAdapterLabel || snapshot?.siteAdapter?.label || "";
    const kinds = [
      pageState ? renderChip(pageState.pageKind, "neutral") : "",
      pageState ? renderChip(pageState.navigationMode, "neutral") : "",
      adapterLabel ? renderChip(adapterLabel, "neutral") : "",
      tab.contentReady ? renderChip("Content ready", "success") : renderChip("No content script", "warning"),
      tab.busy ? renderChip("Busy", "warning") : "",
      tab.lastError ? renderChip("Error present", "danger") : ""
    ].filter(Boolean).join(" ");
    const links = snapshot?.meta.linkCount ?? 0;
    const forms = snapshot?.meta.formCount ?? pageState?.formCount ?? 0;
    const interactive = snapshot?.meta.interactiveCount ?? pageState?.interactiveCount ?? 0;
    const textLength = snapshot?.meta.visibleTextLength ?? pageState?.visibleTextLength ?? 0;
    const summaryLine = snapshot?.summary ? snapshot.summary : pageState ? `${pageState.pageKind ?? "page"} context is ready.` : "Scan the page to build a structured summary.";
    return `
    <section class="panel">
      <div class="section-head">
        <h2>Current tab</h2>
        <span class="section-note">${escapeHtml(
      statusLabel(tab.busy ? "running" : tab.approvals.some((approval) => approval.status === "pending") ? "awaiting-approval" : tab.lastError ? "error" : tab.contentReady ? "connected" : "idle")
    )}</span>
      </div>
      <div class="tab-card">
        <div class="tab-card__title">${escapeHtml(tab.title || "Untitled page")}</div>
        <div class="tab-card__url">${escapeHtml(tab.url || "Unknown url")}</div>
        <div class="tab-card__chips">${kinds}</div>
      </div>
      <div class="meta-grid">
        <div class="meta">
          <span class="meta__label">Freshness</span>
          <span class="meta__value">${renderChip(freshState, freshnessTone)}</span>
        </div>
        <div class="meta">
          <span class="meta__label">Ready state</span>
          <span class="meta__value">${escapeHtml(pageState?.readyState || document.readyState)}</span>
        </div>
        <div class="meta">
          <span class="meta__label">Interactive</span>
          <span class="meta__value">${interactive}</span>
        </div>
        <div class="meta">
          <span class="meta__label">Forms</span>
          <span class="meta__value">${forms}</span>
        </div>
        <div class="meta">
          <span class="meta__label">Links</span>
          <span class="meta__value">${links}</span>
        </div>
        <div class="meta">
          <span class="meta__label">Visible text</span>
          <span class="meta__value">${textLength.toLocaleString()}</span>
        </div>
      </div>
      <p class="summary-note">${escapeHtml(summaryLine)}</p>
      ${tab.snapshotFresh ? "" : `<div class="stale-banner">The page changed after the last scan. Run another scan before approving actions.</div>`}
    </section>

    <section class="panel">
      <div class="section-head">
        <h2>Page summary</h2>
        <span class="section-note">${mode === "popup" ? "Condensed view" : "Structured page context"}</span>
      </div>
      <p class="summary-body">${escapeHtml(snapshot?.summary || "No snapshot yet. Use Scan page to capture the current page.")}</p>
      ${snapshot?.visibleTextExcerpt ? `<pre class="excerpt">${escapeHtml(snapshot.visibleTextExcerpt)}</pre>` : `<p class="empty">No visible text excerpt captured yet.</p>`}
      <div class="section-split">
        <div>
          <h3>Headings</h3>
          ${renderHeadings(snapshot)}
        </div>
        <div>
          <h3>Semantic outline</h3>
          ${mode === "popup" ? renderList(limit(snapshot?.semanticOutline ?? [], 4).map((node) => escapeHtml(node.text)), "No outline yet.") : renderOutline(snapshot)}
        </div>
      </div>
    </section>
  `;
  }
  function renderBridgePanel(bridge) {
    if (!bridge) {
      return `<section class="panel panel--bridge"><p class="empty">No bridge state available yet.</p></section>`;
    }
    const tone = bridgeStatusTone(bridge.status);
    const label = bridgeStatusLabel(bridge.status);
    const active = bridge.activeExtension;
    const activeSummary = active ? `${active.browser || "Chrome"} · ${active.profile?.email || "unknown profile"} · ${bridge.activeTargetCount} active target${bridge.activeTargetCount === 1 ? "" : "s"}` : "No Playwriter-enabled tab detected yet.";
    return `
    <section class="panel panel--bridge">
      <div class="section-head">
        <h2>Live bridge</h2>
        <span class="section-note">Playwriter relay on localhost</span>
      </div>
      <div class="bridge-card">
        <div class="bridge-card__top">
          <div>
            <div class="bridge-card__label">Bridge state</div>
            <div class="bridge-card__summary">${escapeHtml(summarizeBridgeState(bridge))}</div>
          </div>
          <span class="status-chip status-chip--${tone}">${escapeHtml(label)}</span>
        </div>
        <div class="bridge-card__meta">
          <span>Endpoint: ${escapeHtml(bridge.endpoint)}</span>
          <span>Relay: ${escapeHtml(bridge.relayVersion || "not detected")}</span>
          <span>${escapeHtml(activeSummary)}</span>
          <span>Checked: ${bridge.checkedAt ? escapeHtml(formatTime(bridge.checkedAt)) : "unknown"}</span>
        </div>
        ${bridge.lastError ? `
              <div class="bridge-card__error">
                <div class="bridge-card__error-title">${escapeHtml(bridge.lastError.message)}</div>
                <div class="bridge-card__error-meta">${escapeHtml(bridge.lastError.code)}</div>
              </div>` : ""}
      </div>
    </section>
  `;
  }
  function renderSemanticPanel(semantic) {
    if (!semantic) {
      return `<section class="panel panel--semantic"><p class="empty">No semantic bridge state available yet.</p></section>`;
    }
    const tone = semanticStatusTone(semantic.status);
    const label = semanticStatusLabel(semantic.status);
    return `
    <section class="panel panel--semantic">
      <div class="section-head">
        <h2>Semantic layer</h2>
        <span class="section-note">Stagehand observe on the live Chrome session</span>
      </div>
      <div class="bridge-card">
        <div class="bridge-card__top">
          <div>
            <div class="bridge-card__label">Semantic state</div>
            <div class="bridge-card__summary">${escapeHtml(summarizeSemanticState(semantic))}</div>
          </div>
          <span class="status-chip status-chip--${tone}">${escapeHtml(label)}</span>
        </div>
        <div class="bridge-card__meta">
          <span>Endpoint: ${escapeHtml(semantic.endpoint)}</span>
          <span>Browser: ${escapeHtml(semantic.browserEndpoint || "not detected")}</span>
          <span>Model: ${escapeHtml(semantic.model || "not configured")}</span>
          <span>Suggestions: ${semantic.suggestionCount}</span>
          <span>Observed: ${semantic.observedAt ? escapeHtml(formatTime(semantic.observedAt)) : "never"}</span>
        </div>
        ${semantic.pageTitle || semantic.pageUrl ? `<div class="bridge-card__meta"><span>Page: ${escapeHtml(semantic.pageTitle || semantic.pageUrl || "")}</span></div>` : ""}
        ${semantic.disabledReason ? `
              <div class="bridge-card__error">
                <div class="bridge-card__error-title">${escapeHtml(semantic.disabledReason)}</div>
                <div class="bridge-card__error-meta">Configure STAGEHAND_MODEL and the matching provider API key, then run npm run semantic.</div>
              </div>` : ""}
        ${semantic.lastError ? `
              <div class="bridge-card__error">
                <div class="bridge-card__error-title">${escapeHtml(semantic.lastError.message)}</div>
                <div class="bridge-card__error-meta">${escapeHtml(semantic.lastError.code)}</div>
              </div>` : ""}
      </div>
    </section>
  `;
  }
  function renderTabOrchestrationPanel(tabs, activeTabId, mode, searchQuery) {
    const sorted = sortTrackedTabs(tabs, activeTabId);
    const query = searchQuery.trim();
    const searchResults = searchTrackedTabs(tabs, searchQuery, activeTabId);
    const visibleResults = limit(searchResults, mode === "popup" ? 5 : 10);
    return `
    <section class="panel panel--tabs">
      <div class="section-head">
        <h2>Tab intelligence</h2>
        <span class="section-note">MCP-style cross-tab search and focus</span>
      </div>
      <div class="tabs-toolbar">
        <label class="tabs-toolbar__search">
          <span class="tabs-toolbar__search-label">Search tabs</span>
          <input
            class="tabs-toolbar__search-input"
            data-tab-search
            type="search"
            placeholder="Search titles, URLs, summaries, or site adapters"
            value="${safeAttr(searchQuery)}"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
        <button class="btn btn--ghost" data-action="refresh-tabs" type="button">Refresh tabs</button>
        <span class="section-note">${query ? `${searchResults.length} match${searchResults.length === 1 ? "" : "es"} for "${escapeHtml(query)}"` : `${sorted.length} tracked tab${sorted.length === 1 ? "" : "s"}`}</span>
      </div>
      ${visibleResults.length === 0 ? `<p class="empty">No tracked tabs matched the current search. Refresh tabs to rebuild the inventory.</p>` : `<ul class="tab-list">${visibleResults.map((result) => {
      const tab = result.tab;
      const isCurrent = tab.tabId === activeTabId;
      const statusTone = tabStatusTone(tab, activeTabId);
      const statusLabel2 = tabStatusLabel(tab, activeTabId);
      const approvals = tab.approvals.filter((approval) => approval.status === "pending" || approval.status === "executing").length;
      const interactiveCount = tab.pageState?.interactiveCount ?? 0;
      const adapterLabel = tab.pageState?.siteAdapterLabel || tab.snapshot?.siteAdapter?.label || "";
      return `
                  <li class="tab-row${isCurrent ? " tab-row--active" : ""}">
                    <div class="tab-row__top">
                      <div>
                        <div class="tab-row__title">${escapeHtml(tab.title || "Untitled page")}</div>
                        <div class="tab-row__url">${escapeHtml(tab.url || "Unknown url")}</div>
                      </div>
                      ${renderChip(statusLabel2, statusTone)}
                    </div>
                    <div class="tab-row__meta">
                      <span>${escapeHtml(`Window ${tab.windowId}`)}</span>
                      <span>${tab.contentReady ? "Content ready" : "No content script"}</span>
                      <span>${tab.snapshotFresh ? "Snapshot fresh" : "Snapshot stale"}</span>
                      <span>${approvals > 0 ? `${approvals} approval${approvals === 1 ? "" : "s"}` : "No approvals"}</span>
                      ${adapterLabel ? `<span>Adapter: ${escapeHtml(adapterLabel)}</span>` : ""}
                      ${query ? `<span>Match: ${escapeHtml(result.reason)}</span>` : ""}
                    </div>
                    <div class="tab-row__summary">${escapeHtml(summarizeTrackedTab(tab))}</div>
                    <div class="tab-row__footer">
                      <span>Interactive controls: ${interactiveCount}</span>
                      <span>Last seen ${escapeHtml(formatRelative(tab.lastSeenAt))}</span>
                    </div>
                    <div class="tab-row__actions">
                      ${isCurrent ? `<span class="tab-row__current">Current tab</span>` : `<button class="btn btn--ghost" data-tab-action="focus" data-tab-id="${safeAttr(String(tab.tabId))}" type="button">Focus</button>`}
                      <button class="btn btn--ghost" data-tab-action="scan" data-mode="full" data-tab-id="${safeAttr(String(tab.tabId))}" type="button">Scan</button>
                      <button class="btn btn--ghost" data-tab-action="scan" data-mode="summary" data-tab-id="${safeAttr(String(tab.tabId))}" type="button">Summary</button>
                    </div>
                  </li>`;
    }).join("")}</ul>`}
      ${sorted.length > visibleResults.length ? `<p class="section-note">Showing ${visibleResults.length} of ${sorted.length} tracked tabs${query ? " after search filtering" : ""}.</p>` : ""}
    </section>
  `;
  }
  function renderWorkflowSteps(workflow) {
    const active = workflow?.activeWorkflow;
    if (!active) {
      return `<p class="empty">No active workflow plan yet. Enter a multi-step command to create one.</p>`;
    }
    if (active.steps.length === 0) {
      return `<p class="empty">This workflow does not have any steps yet.</p>`;
    }
    return `<ol class="workflow-step-list">${active.steps.map((step, index) => {
      const tone = workflowStepStatusTone(step.status);
      const badge = workflowStepStatusLabel(step.status);
      const current = index === active.currentStepIndex ? " workflow-step--current" : "";
      return `
        <li class="workflow-step${current}">
          <div class="workflow-step__header">
            <div class="workflow-step__title">${escapeHtml(step.title)}</div>
            ${renderChip(badge, tone)}
          </div>
          <div class="workflow-step__description">${escapeHtml(step.description)}</div>
          ${step.notes ? `<div class="workflow-step__notes">${escapeHtml(step.notes)}</div>` : ""}
        </li>`;
    }).join("")}</ol>`;
  }
  function renderWorkflowPanel(workflow) {
    if (!workflow) {
      return `<section class="panel panel--workflow"><p class="empty">No workflow memory available yet.</p></section>`;
    }
    const active = workflow.activeWorkflow;
    const progress = workflowProgress(workflow);
    const tone = active ? workflowStatusTone(active.status) : "neutral";
    const label = active ? workflowStatusLabel(active.status) : "Idle";
    const nextStep = getActiveWorkflowNextStep(workflow);
    const nextRequest = nextStep?.request ?? null;
    const nextSummary = nextStep ? `${nextStep.title}${nextStep.request?.kind === "request-action" ? " (approval queued before execution)" : ""}` : "No active step is ready to continue.";
    const recent = workflow.recentWorkflows.slice().reverse();
    return `
    <section class="panel panel--workflow">
      <div class="section-head">
        <h2>Workflow memory</h2>
        <span class="section-note">Planner state and recent outcomes</span>
      </div>
      <div class="bridge-card workflow-card">
        <div class="bridge-card__top">
          <div>
            <div class="bridge-card__label">Workflow state</div>
            <div class="bridge-card__summary">${escapeHtml(summarizeWorkflowState(workflow))}</div>
          </div>
          <span class="status-chip status-chip--${tone}">${escapeHtml(label)}</span>
        </div>
        <div class="bridge-card__meta">
          <span>Completed: ${progress.completed}/${progress.total || 0}</span>
          <span>Blocked: ${progress.blocked}</span>
          <span>Last instruction: ${escapeHtml(workflow.lastInstruction || "none")}</span>
          <span>Last objective: ${escapeHtml(workflow.lastObjective || "none")}</span>
        </div>
        ${active ? `
              <div class="workflow-card__focus">
                <div class="workflow-card__focus-label">Current workflow</div>
                <div class="workflow-card__focus-title">${escapeHtml(active.objective)}</div>
                <div class="workflow-card__focus-meta">Step ${Math.min(active.currentStepIndex + 1, active.steps.length || 1)} of ${active.steps.length || 1}</div>
                <div class="workflow-card__focus-next">${escapeHtml(nextSummary)}</div>
                ${active.status === "paused" ? `<div class="workflow-card__blocked">The current step is blocked or unsupported. Start a new command to replace the workflow, or continue manually if the page changed.</div>` : ""}
                ${nextRequest ? `<div class="approval-dialog__actions"><button class="btn btn--primary" data-action="continue-workflow" type="button">Continue workflow</button></div>` : ""}
              </div>` : ""}
      </div>
      <div class="section-split">
        <div>
          <h3>Steps</h3>
          ${renderWorkflowSteps(workflow)}
        </div>
        <div>
          <h3>Memory notes</h3>
          ${workflow.memoryNotes.length > 0 ? `<ul class="workflow-note-list">${workflow.memoryNotes.slice().reverse().map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : `<p class="empty">No workflow notes yet.</p>`}
          <h3>Recent workflows</h3>
          ${recent.length > 0 ? `<ul class="workflow-history-list">${recent.map((entry) => `
                    <li class="workflow-history-item">
                      <div class="workflow-history-item__top">
                        <span class="workflow-history-item__title">${escapeHtml(entry.objective)}</span>
                        ${renderChip(workflowStatusLabel(entry.status), workflowStatusTone(entry.status))}
                      </div>
                      <div class="workflow-history-item__meta">
                        <span>${entry.completedStepCount}/${entry.stepCount} steps</span>
                        <span>${escapeHtml(entry.originTitle || entry.originUrl || "unknown page")}</span>
                      </div>
                    </li>`).join("")}</ul>` : `<p class="empty">No recent workflows yet.</p>`}
        </div>
      </div>
    </section>
  `;
  }
  function renderPanels(tab, snapshot, bridge, semantic, workflow, tabs, activeTabId, tabSearchQuery, mode) {
    const maxInteractive = mode === "popup" ? 6 : 14;
    const maxLogs = mode === "popup" ? 6 : 12;
    return `
    ${renderSummary(tab, snapshot, mode)}
    ${renderTabOrchestrationPanel(tabs, activeTabId, mode, tabSearchQuery)}
    ${renderBridgePanel(bridge)}
    ${renderSemanticPanel(semantic)}
    ${renderWorkflowPanel(workflow)}
    <section class="panel">
      <div class="section-head">
        <h2>Suggested next actions</h2>
        <span class="section-note">Generated from the current page</span>
      </div>
      ${renderSuggestions(snapshot)}
    </section>

    <section class="panel">
      <div class="section-head">
        <h2>Interactive elements</h2>
        <span class="section-note">${snapshot?.interactiveElements.length ?? 0} captured</span>
      </div>
      ${renderInteractiveElements(tab, maxInteractive)}
    </section>

    <section class="panel">
      <div class="section-head">
        <h2>Approval queue</h2>
        <span class="section-note">Explicit confirmation required for click, type, select, and submit actions</span>
      </div>
      ${renderApprovals(tab)}
    </section>

    <section class="panel">
      <div class="section-head">
        <h2>Activity log</h2>
        <span class="section-note">${tab?.activityLog.length ?? 0} entries</span>
      </div>
      ${renderLogEntries(tab, maxLogs)}
    </section>

    <section class="panel panel--error">
      <div class="section-head">
        <h2>Error panel</h2>
        <span class="section-note">Latest recoverable issue</span>
      </div>
      ${tab?.lastError ? `
            <div class="error-box">
              <div class="error-box__title">${escapeHtml(tab.lastError.message)}</div>
              <div class="error-box__meta">${escapeHtml(tab.lastError.code)} ${tab.lastError.recoverable ? "(recoverable)" : "(blocking)"}</div>
              ${tab.lastError.details ? `<pre class="error-box__details">${escapeHtml(tab.lastError.details)}</pre>` : ""}
            </div>` : `<p class="empty">No errors to report. If something fails, the message will appear here.</p>`}
    </section>
  `;
  }
  var BrowserCompanionApp = class {
    constructor(root2, mode) {
      this.root = root2;
      this.mode = mode;
      this.root.classList.add("app-shell");
      this.root.dataset.mode = mode;
      this.renderShell();
      this.rootShell = this.root;
      this.stateRoot = this.rootShell.querySelector("#state-root");
      this.commandInput = this.rootShell.querySelector("#command-input");
      this.commandForm = this.rootShell.querySelector("#command-form");
      this.commandFeedbackNode = this.rootShell.querySelector("#command-feedback");
      this.statusChip = this.rootShell.querySelector("#status-chip");
      this.statusSubline = this.rootShell.querySelector("#status-subline");
      this.approvalDialog = this.rootShell.querySelector("#approval-dialog");
      this.approvalTitle = this.rootShell.querySelector("#approval-title");
      this.approvalDescription = this.rootShell.querySelector("#approval-description");
      this.approvalMeta = this.rootShell.querySelector("#approval-meta");
      this.approvalTarget = this.rootShell.querySelector("#approval-target");
      this.approvalDanger = this.rootShell.querySelector("#approval-danger");
      this.bindEvents();
      this.connect();
    }
    state = null;
    port = null;
    reconnectTimer = null;
    currentApproval = null;
    commandFeedback = "";
    tabSearchQuery = "";
    suggestionLookup = /* @__PURE__ */ new Map();
    rootShell;
    stateRoot;
    commandInput;
    commandForm;
    commandFeedbackNode;
    statusChip;
    statusSubline;
    approvalDialog;
    approvalTitle;
    approvalDescription;
    approvalMeta;
    approvalTarget;
    approvalDanger;
    renderShell() {
      const logoUrl = chrome.runtime.getURL("icons/icon-128.png");
      this.root.innerHTML = `
      <div class="app-shell__frame">
        <header class="hero">
          <div class="hero__brand">
            <img class="hero__logo" src="${escapeHtml(logoUrl)}" alt="Codex logo" />
            <div class="hero__copy">
              <p class="eyebrow">Codex Browser Companion</p>
              <h1>Active tab control</h1>
              <p class="lede">Inspect the current page, queue approved actions, and keep Codex tied to the active tab.</p>
            </div>
          </div>
          <div class="hero__status">
            <div id="status-chip" class="status-chip status-chip--idle">Idle</div>
            <p id="status-subline" class="hero__status-subline">Waiting for a page.</p>
          </div>
        </header>

        <section class="panel panel--command">
          <div class="section-head">
            <h2>Command</h2>
            <span class="section-note">Use a simple page command or browser action.</span>
          </div>
          <form id="command-form" class="command-form">
            <input id="command-input" type="text" placeholder="click save, type hello into search, summarize page" autocomplete="off" spellcheck="false" />
            <button class="btn btn--primary" type="submit">Run</button>
          </form>
          <div id="command-feedback" class="command-feedback"></div>
          <div class="quick-actions">
            <button class="btn btn--ghost" data-action="scan-page" data-mode="full" type="button">Scan page</button>
            <button class="btn btn--ghost" data-action="scan-page" data-mode="interactive" type="button">List interactive</button>
            <button class="btn btn--ghost" data-action="scan-page" data-mode="summary" type="button">Summarize</button>
            <button class="btn btn--ghost" data-action="scan-page" data-mode="suggestions" type="button">Suggest next</button>
            <button class="btn btn--ghost" data-action="refresh-bridge" type="button">Refresh bridge</button>
            <button class="btn btn--ghost" data-action="refresh-semantic" type="button">Refresh semantic</button>
            <button class="btn btn--ghost" data-action="refresh-tabs" type="button">Refresh tabs</button>
            <button class="btn btn--ghost" data-action="open-sidepanel" type="button">Open side panel</button>
            <button class="btn btn--ghost" data-action="clear-log" type="button">Clear log</button>
          </div>
          <p class="hint">${escapeHtml(commandHint(this.mode))}</p>
        </section>

        <div id="state-root" class="state-root"></div>
      </div>

      <dialog id="approval-dialog" class="approval-dialog">
        <form method="dialog" class="approval-dialog__card">
          <div class="approval-dialog__top">
            <div>
              <p class="eyebrow">Approval required</p>
              <h2 id="approval-title">Action review</h2>
            </div>
            <div id="approval-danger" class="status-chip status-chip--warning">medium</div>
          </div>
          <p id="approval-description" class="approval-dialog__description"></p>
          <div id="approval-target" class="approval-dialog__target"></div>
          <div id="approval-meta" class="approval-dialog__meta"></div>
          <div class="approval-dialog__actions">
            <button class="btn btn--primary" data-approval-action="approve" data-approval-id="" value="approve">Approve</button>
            <button class="btn btn--ghost" data-approval-action="reject" data-approval-id="" value="reject">Reject</button>
            <button class="btn btn--ghost" value="cancel">Cancel</button>
          </div>
        </form>
      </dialog>
    `;
    }
    bindEvents() {
      this.root.addEventListener("click", (event) => {
        const target = event.target;
        if (!target) {
          return;
        }
        const approvalButton = target.closest("[data-approval-action][data-approval-id]");
        if (approvalButton) {
          const approvalId = approvalButton.dataset.approvalId;
          const approvalAction = approvalButton.dataset.approvalAction;
          if (approvalId && approvalAction) {
            event.preventDefault();
            this.send({
              kind: approvalAction === "approve" ? "approve-action" : "reject-action",
              approvalId
            });
          }
          return;
        }
        const suggestionButton = target.closest("[data-suggestion-id]");
        if (suggestionButton) {
          const suggestionId = suggestionButton.dataset.suggestionId;
          const suggestion = suggestionId ? this.suggestionLookup.get(suggestionId) : null;
          if (suggestion) {
            event.preventDefault();
            this.sendSuggestion(suggestion.request);
            this.setFeedback(`Queued suggestion: ${suggestion.title}`, "success");
          }
          return;
        }
        const tabActionButton = target.closest("[data-tab-action][data-tab-id]");
        if (tabActionButton) {
          const tabAction = tabActionButton.dataset.tabAction;
          const tabId = Number.parseInt(tabActionButton.dataset.tabId ?? "", 10);
          if (!tabAction || !Number.isFinite(tabId)) {
            return;
          }
          event.preventDefault();
          if (tabAction === "focus") {
            this.send({ kind: "focus-tab", tabId });
          } else if (tabAction === "scan") {
            const mode = tabActionButton.dataset.mode ?? "full";
            this.send({ kind: "scan-tab", tabId, mode });
          }
          return;
        }
        const quickAction = target.closest("[data-action]");
        if (quickAction) {
          const action = quickAction.dataset.action;
          if (!action) {
            return;
          }
          event.preventDefault();
          if (action === "scan-page") {
            const mode = quickAction.dataset.mode ?? "full";
            this.send({ kind: "scan-page", mode });
          } else if (action === "refresh-bridge") {
            this.send({ kind: "refresh-bridge" });
          } else if (action === "refresh-semantic") {
            this.send({ kind: "refresh-semantic" });
          } else if (action === "refresh-tabs") {
            this.send({ kind: "refresh-tabs" });
          } else if (action === "open-sidepanel") {
            this.send({ kind: "open-sidepanel" });
          } else if (action === "continue-workflow") {
            const nextStep = getActiveWorkflowNextStep(this.state?.workflow ?? null);
            if (nextStep?.request) {
              this.sendSuggestion(nextStep.request);
              this.setFeedback(`Continuing workflow: ${nextStep.title}`, "info");
            } else {
              this.setFeedback("No workflow step is ready to continue yet.", "warning");
            }
          } else if (action === "clear-log") {
            this.send({ kind: "clear-log" });
          }
        }
      });
      this.root.addEventListener("input", (event) => {
        const target = event.target;
        if (!target) {
          return;
        }
        const tabSearchInput = target.closest("[data-tab-search]");
        if (tabSearchInput && tabSearchInput === target) {
          this.tabSearchQuery = tabSearchInput.value;
          this.renderState();
        }
      });
      this.commandForm.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.handleCommandSubmit();
      });
      this.commandInput.addEventListener("input", () => {
        this.commandFeedback = "";
        this.commandFeedbackNode.textContent = "";
      });
      this.approvalDialog.addEventListener("click", (event) => {
        const target = event.target;
        if (!target) {
          return;
        }
        if (target instanceof HTMLDialogElement || target.classList.contains("approval-dialog")) {
          return;
        }
        const button = target.closest("button[value]");
        if (button?.value === "cancel") {
          this.closeApprovalDialog();
        }
      });
    }
    connect() {
      this.port?.disconnect();
      this.port = chrome.runtime.connect({ name: "codex-ui" });
      this.port.postMessage({ kind: "get-state" });
      this.port.onMessage.addListener((message) => {
        if (!this.isAppMessage(message)) {
          return;
        }
        this.handleMessage(message);
      });
      this.port.onDisconnect.addListener(() => {
        this.setFeedback("Connection lost. Reconnecting...", "warning");
        if (this.reconnectTimer !== null) {
          clearTimeout(this.reconnectTimer);
        }
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, DEFAULT_UI_POLL_MS);
      });
    }
    isAppMessage(message) {
      return typeof message === "object" && message !== null && "kind" in message;
    }
    handleMessage(message) {
      switch (message.kind) {
        case "state":
          this.state = message.state;
          this.renderState();
          break;
        case "approval-requested":
          this.openApprovalDialog(message.approval);
          break;
        case "approval-updated":
          if (this.currentApproval?.approvalId === message.approval.approvalId) {
            this.currentApproval = message.approval;
            this.renderApprovalDialog();
            if (message.approval.status === "rejected" || message.approval.status === "succeeded" || message.approval.status === "failed") {
              this.closeApprovalDialog();
            }
          }
          this.setFeedback(`Approval ${message.approval.status}: ${message.approval.title}`, message.approval.status === "failed" ? "error" : "info");
          break;
        case "page-snapshot":
          if (this.state && this.state.tabs[message.tabId]) {
            const currentTab = this.state.tabs[message.tabId];
            const updatedTab = {
              tabId: currentTab.tabId,
              windowId: currentTab.windowId,
              active: currentTab.active,
              url: currentTab.url,
              title: currentTab.title,
              snapshot: message.snapshot,
              pageState: {
                url: message.snapshot.url,
                title: message.snapshot.title,
                readyState: message.snapshot.meta.readyState,
                navigationMode: message.snapshot.navigationMode,
                pageKind: message.snapshot.pageKind,
                interactiveCount: message.snapshot.meta.interactiveCount,
                formCount: message.snapshot.meta.formCount,
                visibleTextLength: message.snapshot.meta.visibleTextLength,
                hasSensitiveInputs: message.snapshot.meta.hasSensitiveInputs,
                siteAdapterId: message.snapshot.siteAdapter?.id ?? null,
                siteAdapterLabel: message.snapshot.siteAdapter?.label ?? null,
                updatedAt: message.snapshot.capturedAt
              },
              snapshotFresh: true,
              contentReady: currentTab.contentReady,
              busy: currentTab.busy,
              approvals: currentTab.approvals,
              activityLog: currentTab.activityLog,
              lastError: null,
              lastSeenAt: nowIso()
            };
            this.state = {
              ...this.state,
              tabs: {
                ...this.state.tabs,
                [message.tabId]: updatedTab
              }
            };
            this.renderState();
          }
          this.setFeedback(`Captured ${message.snapshot.captureMode} snapshot.`, "success");
          break;
        case "action-result":
          this.setFeedback(message.result.message, message.result.success ? "success" : "error");
          this.renderState();
          break;
        case "error":
          this.setFeedback(message.error.message, "error");
          this.renderState();
          break;
      }
    }
    activeTab() {
      if (!this.state || this.state.activeTabId === null) {
        return null;
      }
      return this.state.tabs[this.state.activeTabId] ?? null;
    }
    snapshot() {
      return getPageState(this.activeTab());
    }
    renderState() {
      const activeTab = this.activeTab();
      const snapshot = this.snapshot();
      this.statusChip.className = `status-chip ${statusClass(this.state?.status ?? "idle")}`;
      this.statusChip.textContent = statusLabel(this.state?.status ?? "idle");
      this.statusSubline.textContent = activeTab ? `${activeTab.title || "Untitled page"}${activeTab.snapshotFresh ? " - snapshot fresh" : " - snapshot stale"}` : "Waiting for a page.";
      this.stateRoot.innerHTML = renderPanels(
        activeTab,
        snapshot,
        this.state?.bridge ?? null,
        this.state?.semantic ?? null,
        this.state?.workflow ?? null,
        Object.values(this.state?.tabs ?? {}),
        this.state?.activeTabId ?? null,
        this.tabSearchQuery,
        this.mode
      );
      this.suggestionLookup = new Map((snapshot?.suggestedActions ?? []).map((suggestion) => [suggestion.id, suggestion]));
      if (this.currentApproval) {
        this.renderApprovalDialog();
      }
    }
    renderApprovalDialog() {
      if (!this.currentApproval) {
        return;
      }
      const approval = this.currentApproval;
      const tone = approval.dangerLevel === "high" ? "danger" : approval.dangerLevel === "medium" ? "warning" : "neutral";
      this.approvalTitle.textContent = approval.title;
      this.approvalDescription.textContent = approval.description;
      this.approvalDanger.className = `status-chip status-chip--${tone}`;
      this.approvalDanger.textContent = approval.dangerLevel;
      this.approvalTarget.textContent = approval.targetLabel ? `Target: ${approval.targetLabel}` : "Target: current page context";
      this.approvalMeta.textContent = `Requested ${formatTime(approval.createdAt)} | ${approval.status}`;
      const approveButton = this.approvalDialog.querySelector('[data-approval-action="approve"]');
      const rejectButton = this.approvalDialog.querySelector('[data-approval-action="reject"]');
      if (approveButton) {
        approveButton.dataset.approvalId = approval.approvalId;
      }
      if (rejectButton) {
        rejectButton.dataset.approvalId = approval.approvalId;
      }
      if (!this.approvalDialog.open) {
        this.approvalDialog.showModal();
      }
    }
    openApprovalDialog(approval) {
      this.currentApproval = approval;
      this.renderApprovalDialog();
      this.setFeedback(`Action requires approval: ${approval.title}`, approval.dangerLevel === "high" ? "warning" : "info");
    }
    closeApprovalDialog() {
      this.currentApproval = null;
      if (this.approvalDialog.open) {
        this.approvalDialog.close();
      }
    }
    setFeedback(message, tone) {
      this.commandFeedback = message;
      this.commandFeedbackNode.className = `command-feedback command-feedback--${tone}`;
      this.commandFeedbackNode.textContent = message;
      if (tone === "success" || tone === "error") {
        window.setTimeout(() => {
          if (this.commandFeedbackNode.textContent === message) {
            this.commandFeedbackNode.textContent = "";
            this.commandFeedbackNode.className = "command-feedback";
          }
        }, 3e3);
      }
    }
    send(request) {
      this.port?.postMessage(request);
    }
    sendSuggestion(request) {
      this.port?.postMessage(request);
    }
    async handleCommandSubmit() {
      const value = this.commandInput.value.trim();
      if (!value) {
        this.setFeedback("Type a command before running it.", "warning");
        return;
      }
      const preview = buildWorkflowPlanFromInstruction(value, this.snapshot(), this.state?.workflow?.activeWorkflow ?? null);
      if (!preview) {
        this.setFeedback("Could not parse that command. Try: click save, type hello into search, scroll down 600, summarize page.", "error");
        return;
      }
      this.commandInput.value = "";
      this.setFeedback(preview.explanation, "info");
      const activeWorkflowId = this.state?.workflow?.activeWorkflow?.workflowId ?? null;
      const isResumingActiveWorkflow = activeWorkflowId !== null && preview.workflow.workflowId === activeWorkflowId;
      if (!isResumingActiveWorkflow) {
        this.port?.postMessage({ kind: "plan-workflow", workflow: preview.workflow });
      }
      if (preview.primaryRequest) {
        const request = preview.primaryRequest;
        if (request.kind === "request-action") {
          const activeTab = this.activeTab();
          if (activeTab) {
            request.action.tabId = activeTab.tabId;
          }
        }
        window.setTimeout(() => {
          this.port?.postMessage(request);
        }, 0);
      }
    }
  };
  function mountBrowserCompanionApp(root2, mode) {
    return new BrowserCompanionApp(root2, mode);
  }

  // src/ui/popup/popup.ts
  var root = document.getElementById("app");
  if (!root) {
    throw new Error("Popup root element not found.");
  }
  mountBrowserCompanionApp(root, "popup");
})();
//# sourceMappingURL=popup.js.map
