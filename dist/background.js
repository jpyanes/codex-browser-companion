// src/shared/constants.ts
var STORAGE_KEY_STATE = "codex-browser-companion.state";
var DEFAULT_BRIDGE_ENDPOINT = "http://localhost:19988";
var BRIDGE_REQUEST_TIMEOUT_MS = 1500;
var BRIDGE_POLL_INTERVAL_MS = 2500;
var DEFAULT_SEMANTIC_ENDPOINT = "http://localhost:19989";
var SEMANTIC_STATUS_REQUEST_TIMEOUT_MS = 1500;
var SEMANTIC_OBSERVE_REQUEST_TIMEOUT_MS = 3e4;
var SEMANTIC_POLL_INTERVAL_MS = 4e3;
var MAX_ACTIVITY_LOG_ENTRIES = 40;
var MAX_APPROVAL_QUEUE_ENTRIES = 20;
var MAX_WORKFLOW_HISTORY_ENTRIES = 6;
var MAX_WORKFLOW_NOTES = 10;
var MAX_WORKFLOW_STEPS = 8;
var CONTENT_SCRIPT_READY_RETRIES = 3;
var CONTENT_SCRIPT_RETRY_DELAY_MS = 75;
var DEFAULT_SCROLL_AMOUNT = 600;

// src/shared/bridge.ts
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function toStringOrNull(value) {
  return typeof value === "string" && value.trim() ? value : null;
}
function toNumberOrDefault(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}
function normalizeProfile(value) {
  if (!isRecord(value)) {
    return null;
  }
  const email = toStringOrNull(value.email);
  const id = toStringOrNull(value.id);
  if (!email || !id) {
    return null;
  }
  return { email, id };
}
function normalizeBridgeExtensionSummary(value, fallbackExtensionId = "default") {
  if (!isRecord(value)) {
    return null;
  }
  const extensionId = toStringOrNull(value.extensionId) ?? fallbackExtensionId;
  const browser = toStringOrNull(value.browser);
  const profile = normalizeProfile(value.profile);
  const activeTargets = toNumberOrDefault(value.activeTargets, 0);
  const playwriterVersion = toStringOrNull(value.playwriterVersion);
  return {
    extensionId,
    stableKey: toStringOrNull(value.stableKey) ?? void 0,
    browser,
    profile,
    activeTargets,
    playwriterVersion
  };
}
function createDisconnectedBridgeState(endpoint = DEFAULT_BRIDGE_ENDPOINT, error = null, checkedAt = null) {
  return {
    endpoint,
    status: error ? "error" : "disconnected",
    relayVersion: null,
    extensions: [],
    activeExtension: null,
    activeTargetCount: 0,
    checkedAt,
    lastError: error
  };
}
function buildBridgeState(snapshot, options = {}) {
  const endpoint = options.endpoint ?? DEFAULT_BRIDGE_ENDPOINT;
  const extensions = snapshot.extensions.slice();
  const activeExtension = extensions.find((extension) => extension.activeTargets > 0) ?? extensions[0] ?? null;
  const activeTargetCount = extensions.reduce((count, extension) => count + extension.activeTargets, 0);
  const status = options.lastError ? "error" : extensions.length > 0 ? "connected" : snapshot.relayVersion ? "connecting" : "disconnected";
  return {
    endpoint,
    status,
    relayVersion: snapshot.relayVersion,
    extensions,
    activeExtension,
    activeTargetCount,
    checkedAt: snapshot.checkedAt,
    lastError: options.lastError ?? null
  };
}

// src/shared/logger.ts
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function createActivityLogEntry(level, message, options = {}) {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `log_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    tabId: options.tabId ?? null,
    level,
    message,
    details: options.details,
    timestamp: nowIso()
  };
}
function normalizeError(error, code = "UNKNOWN_ERROR", options = {}) {
  if (typeof error === "object" && error !== null) {
    const maybeError = error;
    const message = typeof maybeError.message === "string" ? maybeError.message : "An unexpected error occurred.";
    const detailValue = typeof maybeError.details === "string" ? maybeError.details : error instanceof Error ? error.stack ?? error.message : void 0;
    return {
      code: typeof maybeError.code === "string" ? maybeError.code : code,
      message,
      details: detailValue,
      recoverable: options.recoverable ?? true,
      tabId: options.tabId,
      occurredAt: nowIso()
    };
  }
  return {
    code,
    message: typeof error === "string" ? error : "An unexpected error occurred.",
    details: void 0,
    recoverable: options.recoverable ?? true,
    tabId: options.tabId,
    occurredAt: nowIso()
  };
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
  return Boolean(snapshot?.meta.hasSensitiveInputs || snapshot?.pageKind === "login" || snapshot?.pageKind === "payment");
}
function requiresManualIntervention(snapshot) {
  return Boolean(snapshot && (snapshot.pageKind === "login" || snapshot.pageKind === "payment"));
}
function canAutoExecute(action) {
  return action.kind === "scroll" || action.kind === "navigate-back" || action.kind === "navigate-forward" || action.kind === "refresh";
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
function describeAction(action, snapshot) {
  const pageName = snapshot?.title || "current page";
  switch (action.kind) {
    case "click":
      return {
        title: `Click ${action.label || action.elementId}`,
        description: `Trigger a click on ${action.label || "the selected element"} on ${pageName}.`
      };
    case "type":
      return {
        title: `Type into ${action.elementId}`,
        description: `Insert the provided text into the selected field on ${pageName}. Passwords and other sensitive fields are blocked.`
      };
    case "select":
      return {
        title: `Choose an option in ${action.elementId}`,
        description: `Select an option in the target dropdown on ${pageName}.`
      };
    case "scroll":
      return {
        title: `Scroll ${action.direction}`,
        description: `Move the viewport ${action.direction} by ${action.amount || DEFAULT_SCROLL_AMOUNT}px on ${pageName}.`
      };
    case "navigate-back":
      return {
        title: "Navigate back",
        description: `Go back to the previous page in this tab from ${pageName}.`
      };
    case "navigate-forward":
      return {
        title: "Navigate forward",
        description: `Go forward to the next page in this tab from ${pageName}.`
      };
    case "refresh":
      return {
        title: "Refresh page",
        description: `Reload ${pageName} in the active tab.`
      };
    case "submit-form":
      return {
        title: `Submit ${action.label || action.elementId}`,
        description: `Submit the selected form on ${pageName}. This is the most sensitive browser action in v1 and requires explicit approval.`
      };
  }
}
function buildApprovalRequest(action, tabId, snapshot) {
  const description = describeAction(action, snapshot);
  const targetLabel = action.kind === "click" ? action.label : action.kind === "type" || action.kind === "select" || action.kind === "submit-form" ? action.elementId : void 0;
  return {
    approvalId: globalThis.crypto?.randomUUID?.() ?? `approval_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    actionId: action.actionId,
    tabId,
    action,
    title: description.title,
    description: description.description,
    dangerLevel: classifyDanger(action, snapshot),
    status: "pending",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    targetLabel,
    targetElementId: "elementId" in action ? action.elementId : void 0,
    rejectionReason: void 0
  };
}
function isBlockedSensitiveAction(action, snapshot) {
  if (action.kind === "type" && isLikelySensitiveSnapshot(snapshot)) {
    return true;
  }
  if (action.kind === "submit-form" && isLikelySensitiveSnapshot(snapshot)) {
    return true;
  }
  return false;
}

// src/background/bridge-client.ts
async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request to ${url} failed with HTTP ${response.status}.`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
async function probeExtensions(endpoint) {
  const [versionResponse, extensionsResponse, fallbackResponse] = await Promise.all([
    fetchJson(`${endpoint}/version`, BRIDGE_REQUEST_TIMEOUT_MS).catch(() => null),
    fetchJson(`${endpoint}/extensions/status`, BRIDGE_REQUEST_TIMEOUT_MS).catch(() => null),
    fetchJson(`${endpoint}/extension/status`, BRIDGE_REQUEST_TIMEOUT_MS).catch(() => null)
  ]);
  const relayVersion = typeof versionResponse?.version === "string" ? versionResponse.version : null;
  const extensions = Array.isArray(extensionsResponse?.extensions) ? extensionsResponse.extensions.map((entry, index) => normalizeBridgeExtensionSummary(entry, `extension-${index + 1}`)).filter((entry) => entry !== null) : [];
  if (extensions.length === 0 && fallbackResponse && typeof fallbackResponse.connected === "boolean" && fallbackResponse.connected) {
    const fallbackExtension = normalizeBridgeExtensionSummary(
      {
        extensionId: "default",
        browser: fallbackResponse.browser,
        profile: fallbackResponse.profile,
        activeTargets: fallbackResponse.activeTargets,
        playwriterVersion: fallbackResponse.playwriterVersion
      },
      "default"
    );
    if (fallbackExtension) {
      extensions.push(fallbackExtension);
    }
  }
  return {
    relayVersion,
    extensions,
    checkedAt: nowIso()
  };
}
async function refreshBridgeState(endpoint = DEFAULT_BRIDGE_ENDPOINT) {
  try {
    const snapshot = await probeExtensions(endpoint);
    return buildBridgeState(snapshot, { endpoint });
  } catch (error) {
    return createDisconnectedBridgeState(
      endpoint,
      normalizeError(error, "BRIDGE_UNAVAILABLE", { recoverable: true }),
      nowIso()
    );
  }
}

// src/shared/tab-context.ts
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}
function isPageKind(value) {
  return value === "unknown" || value === "document" || value === "mixed" || value === "article" || value === "form" || value === "login" || value === "payment" || value === "spa";
}
function normalizeString(value) {
  return typeof value === "string" ? value : "";
}
function normalizeNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function isValidTabId(tabId) {
  return typeof tabId === "number" && Number.isFinite(tabId) && tabId >= 0;
}
function buildTabContextFromSnapshot(snapshot) {
  return {
    tabId: snapshot.tabId,
    windowId: null,
    browserTargetId: null,
    url: snapshot.url,
    title: snapshot.title,
    pageKind: snapshot.pageKind,
    siteAdapterId: snapshot.siteAdapter?.id ?? null,
    siteAdapterLabel: snapshot.siteAdapter?.label ?? null,
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt
  };
}
function normalizeTabContext(value) {
  if (!isRecord2(value)) {
    return null;
  }
  const tabId = normalizeNumber(value.tabId, -1);
  if (!isValidTabId(tabId)) {
    return null;
  }
  return {
    tabId,
    windowId: typeof value.windowId === "number" && Number.isFinite(value.windowId) ? value.windowId : null,
    browserTargetId: typeof value.browserTargetId === "string" && value.browserTargetId.trim() ? value.browserTargetId : null,
    url: normalizeString(value.url),
    title: normalizeString(value.title),
    pageKind: isPageKind(value.pageKind) ? value.pageKind : "unknown",
    siteAdapterId: typeof value.siteAdapterId === "string" ? value.siteAdapterId : null,
    siteAdapterLabel: typeof value.siteAdapterLabel === "string" ? value.siteAdapterLabel : null,
    snapshotId: typeof value.snapshotId === "string" ? value.snapshotId : null,
    capturedAt: typeof value.capturedAt === "string" ? value.capturedAt : null
  };
}
function attachTabContextToAction(action, tabContext) {
  return {
    ...action,
    tabContext
  };
}
function attachTabContextToRequest(request, tabContext) {
  if (request.kind === "request-action") {
    return {
      ...request,
      tabContext,
      action: attachTabContextToAction(request.action, tabContext)
    };
  }
  return {
    ...request,
    tabContext
  };
}
function resolveSuggestedRequestTabId(request) {
  if (!request) {
    return null;
  }
  if (request.kind === "request-action") {
    const contextTabId2 = request.action.tabContext?.tabId;
    if (isValidTabId(contextTabId2)) {
      return contextTabId2;
    }
    return isValidTabId(request.action.tabId) ? request.action.tabId : null;
  }
  const contextTabId = request.tabContext?.tabId;
  return isValidTabId(contextTabId) ? contextTabId : null;
}
function resolveActionTabId(action) {
  if (!action) {
    return null;
  }
  const contextTabId = action.tabContext?.tabId;
  if (isValidTabId(contextTabId)) {
    return contextTabId;
  }
  return isValidTabId(action.tabId) ? action.tabId : null;
}

// src/shared/semantic.ts
function isRecord3(value) {
  return typeof value === "object" && value !== null;
}
function toStringOrNull2(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function createDisabledSemanticState(endpoint = DEFAULT_SEMANTIC_ENDPOINT, disabledReason = null) {
  return {
    endpoint,
    browserEndpoint: "",
    status: disabledReason ? "disabled" : "disconnected",
    model: null,
    observedAt: null,
    pageUrl: null,
    pageTitle: null,
    suggestionCount: 0,
    disabledReason,
    lastError: null
  };
}
function buildSemanticState(snapshot) {
  return {
    endpoint: snapshot.endpoint,
    browserEndpoint: snapshot.browserEndpoint,
    status: snapshot.status,
    model: snapshot.model,
    observedAt: snapshot.observedAt,
    pageUrl: null,
    pageTitle: null,
    suggestionCount: 0,
    disabledReason: snapshot.status === "disabled" ? snapshot.reason : null,
    lastError: snapshot.lastError
  };
}
function updateSemanticStateWithObservation(state2, observation) {
  return {
    ...state2,
    endpoint: observation.endpoint,
    browserEndpoint: observation.browserEndpoint,
    status: observation.status,
    model: observation.model,
    observedAt: observation.observedAt,
    pageUrl: observation.pageUrl,
    pageTitle: observation.pageTitle,
    suggestionCount: observation.actions.length,
    disabledReason: observation.status === "disabled" ? observation.reason : state2.disabledReason,
    lastError: observation.status === "error" ? normalizeError(observation.reason || "Stagehand reported an error.", "SEMANTIC_BRIDGE_ERROR", { recoverable: true }) : state2.lastError
  };
}
function semanticInstructionFromSnapshot(snapshot) {
  const pageSummary = snapshot.summary || "No structured summary is available.";
  const title = snapshot.title || "Untitled page";
  const pageKind = snapshot.pageKind === "unknown" ? "page" : `${snapshot.pageKind} page`;
  return [
    "Identify up to 5 high-value click actions on the current page for a browser assistant.",
    "Focus on visible buttons, links, or other obvious controls that help the user continue the task.",
    "Do not suggest typing into password or file fields.",
    "Do not suggest destructive or irreversible actions.",
    `Page title: ${title}.`,
    `Page kind: ${pageKind}.`,
    `Page summary: ${pageSummary}.`
  ].join(" ");
}
function normalizeMethod(method) {
  return method?.trim().toLowerCase() ?? "";
}
function isClickLikeAction(action) {
  const method = normalizeMethod(action.method);
  return method === "click" || method === "press" || method === "tap" || method === "open";
}
async function buildSemanticSuggestions(observation, snapshot, resolveTarget) {
  const suggestions = [];
  for (const [index, action] of observation.actions.entries()) {
    if (!isClickLikeAction(action)) {
      continue;
    }
    const selector = toStringOrNull2(action.selector);
    if (!selector) {
      continue;
    }
    const resolved = await resolveTarget(selector);
    if (!resolved) {
      continue;
    }
    const tabContext = buildTabContextFromSnapshot(snapshot);
    const actionRequest = attachTabContextToAction({
      actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      tabId: snapshot.tabId,
      kind: "click",
      elementId: resolved.elementId,
      label: resolved.label || action.description || selector,
      selector
    }, tabContext);
    suggestions.push({
      id: `stagehand-${snapshot.snapshotId}-${index}`,
      title: action.description || resolved.label || "Semantic click target",
      description: `Stagehand suggested ${action.description || "a click action"}.`,
      buttonLabel: "Queue",
      tabContext,
      request: attachTabContextToRequest({ kind: "request-action", action: actionRequest }, tabContext),
      approvalRequired: true,
      dangerLevel: classifyDanger(actionRequest, snapshot),
      source: "stagehand",
      selector,
      confidence: void 0
    });
  }
  return suggestions;
}
function normalizeSemanticHealth(value, fallbackEndpoint = DEFAULT_SEMANTIC_ENDPOINT) {
  if (!isRecord3(value)) {
    return {
      endpoint: fallbackEndpoint,
      browserEndpoint: "",
      status: "disconnected",
      model: null,
      reason: "Invalid semantic bridge response.",
      observedAt: null,
      lastError: null
    };
  }
  const status = toStringOrNull2(value.status);
  const browserEndpoint = toStringOrNull2(value.browserEndpoint) ?? "";
  const observedAt = toStringOrNull2(value.observedAt);
  const lastError = isRecord3(value.lastError) ? normalizeError(value.lastError, "SEMANTIC_BRIDGE_ERROR", { recoverable: true }) : null;
  return {
    endpoint: toStringOrNull2(value.endpoint) ?? fallbackEndpoint,
    browserEndpoint,
    status: status === "ready" || status === "disabled" || status === "error" ? status : "disconnected",
    model: toStringOrNull2(value.model),
    reason: toStringOrNull2(value.reason),
    observedAt,
    lastError
  };
}
function normalizeSemanticObservation(value, fallbackEndpoint = DEFAULT_SEMANTIC_ENDPOINT) {
  if (!isRecord3(value)) {
    return {
      endpoint: fallbackEndpoint,
      browserEndpoint: "",
      status: "disconnected",
      model: null,
      pageUrl: null,
      pageTitle: null,
      reason: "Invalid semantic observation response.",
      observedAt: nowIso(),
      actions: []
    };
  }
  const actions = Array.isArray(value.actions) ? value.actions.filter(isRecord3).map((entry) => ({
    selector: toStringOrNull2(entry.selector) ?? "",
    description: toStringOrNull2(entry.description) ?? "",
    method: toStringOrNull2(entry.method) ?? void 0,
    arguments: Array.isArray(entry.arguments) ? entry.arguments.map((argument) => toStringOrNull2(argument) ?? String(argument ?? "")).filter(Boolean) : void 0
  })).filter((entry) => Boolean(entry.selector && entry.description)) : [];
  const status = toStringOrNull2(value.status);
  return {
    endpoint: toStringOrNull2(value.endpoint) ?? fallbackEndpoint,
    browserEndpoint: toStringOrNull2(value.browserEndpoint) ?? "",
    status: status === "ready" || status === "disabled" || status === "error" ? status : "disconnected",
    model: toStringOrNull2(value.model),
    pageUrl: toStringOrNull2(value.pageUrl),
    pageTitle: toStringOrNull2(value.pageTitle),
    reason: toStringOrNull2(value.reason),
    observedAt: toStringOrNull2(value.observedAt) ?? nowIso(),
    actions
  };
}

// src/shared/workflow.ts
function makeId(prefix) {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
function isRecord4(value) {
  return typeof value === "object" && value !== null;
}
function normalize(input) {
  return input.trim().replace(/\s+/g, " ");
}
function truncate(items, max) {
  if (items.length <= max) {
    return items;
  }
  return items.slice(items.length - max);
}
function normalizeStepStatus(value) {
  if (value === "pending" || value === "queued" || value === "completed" || value === "blocked" || value === "failed") {
    return value;
  }
  return "pending";
}
function normalizeWorkflowStatus(value) {
  if (value === "active" || value === "paused" || value === "completed" || value === "abandoned" || value === "failed") {
    return value;
  }
  return "active";
}
function normalizeDangerLevel(value) {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "low";
}
function normalizeRequest(value) {
  if (!isRecord4(value) || typeof value.kind !== "string") {
    return null;
  }
  const tabContext = normalizeTabContext(value.tabContext);
  switch (value.kind) {
    case "scan-page":
      return {
        kind: "scan-page",
        mode: value.mode === "interactive" || value.mode === "summary" || value.mode === "suggestions" ? value.mode : "full",
        ...tabContext ? { tabContext } : {},
        ...typeof value.workflowId === "string" ? { workflowId: value.workflowId } : {},
        ...typeof value.workflowStepId === "string" ? { workflowStepId: value.workflowStepId } : {}
      };
    case "list-interactive-elements":
      return {
        kind: "list-interactive-elements",
        ...tabContext ? { tabContext } : {},
        ...typeof value.workflowId === "string" ? { workflowId: value.workflowId } : {},
        ...typeof value.workflowStepId === "string" ? { workflowStepId: value.workflowStepId } : {}
      };
    case "summarize-page":
      return {
        kind: "summarize-page",
        ...tabContext ? { tabContext } : {},
        ...typeof value.workflowId === "string" ? { workflowId: value.workflowId } : {},
        ...typeof value.workflowStepId === "string" ? { workflowStepId: value.workflowStepId } : {}
      };
    case "suggest-next-actions":
      return {
        kind: "suggest-next-actions",
        ...tabContext ? { tabContext } : {},
        ...typeof value.workflowId === "string" ? { workflowId: value.workflowId } : {},
        ...typeof value.workflowStepId === "string" ? { workflowStepId: value.workflowStepId } : {}
      };
    case "request-action":
      if (!isRecord4(value.action) || typeof value.action.kind !== "string" || typeof value.action.actionId !== "string" || typeof value.action.tabId !== "number") {
        return null;
      }
      const actionTabContext = normalizeTabContext(value.action.tabContext) ?? tabContext;
      const action = value.action;
      return {
        kind: "request-action",
        ...actionTabContext ? { tabContext: actionTabContext } : {},
        action: {
          ...action,
          ...actionTabContext ? { tabContext: actionTabContext } : {}
        }
      };
    default:
      return null;
  }
}
function normalizeStep(value) {
  if (!isRecord4(value)) {
    return null;
  }
  const request = normalizeRequest(value.request);
  return {
    stepId: typeof value.stepId === "string" ? value.stepId : makeId("workflow-step"),
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : "Untitled step",
    description: typeof value.description === "string" ? value.description : "",
    source: value.source === "planner" || value.source === "memory" ? value.source : "command",
    request,
    approvalRequired: typeof value.approvalRequired === "boolean" ? value.approvalRequired : false,
    dangerLevel: normalizeDangerLevel(value.dangerLevel),
    confidence: typeof value.confidence === "number" && Number.isFinite(value.confidence) ? value.confidence : 0.5,
    status: normalizeStepStatus(value.status),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
    completedAt: typeof value.completedAt === "string" ? value.completedAt : null,
    resultSummary: typeof value.resultSummary === "string" ? value.resultSummary : null,
    notes: typeof value.notes === "string" ? value.notes : null
  };
}
function normalizeHistoryEntry(value) {
  if (!isRecord4(value)) {
    return null;
  }
  return {
    workflowId: typeof value.workflowId === "string" ? value.workflowId : makeId("workflow"),
    objective: typeof value.objective === "string" ? value.objective : "Untitled workflow",
    status: normalizeWorkflowStatus(value.status),
    startedAt: typeof value.startedAt === "string" ? value.startedAt : nowIso(),
    endedAt: typeof value.endedAt === "string" ? value.endedAt : null,
    stepCount: typeof value.stepCount === "number" && Number.isFinite(value.stepCount) ? value.stepCount : 0,
    completedStepCount: typeof value.completedStepCount === "number" && Number.isFinite(value.completedStepCount) ? value.completedStepCount : 0,
    originTabId: typeof value.originTabId === "number" ? value.originTabId : -1,
    originUrl: typeof value.originUrl === "string" ? value.originUrl : "",
    originTitle: typeof value.originTitle === "string" ? value.originTitle : "",
    lastResult: typeof value.lastResult === "string" ? value.lastResult : null
  };
}
function normalizeWorkflowPlan(value) {
  if (!isRecord4(value)) {
    return null;
  }
  const steps = Array.isArray(value.steps) ? value.steps.map(normalizeStep).filter((step) => Boolean(step)).slice(0, MAX_WORKFLOW_STEPS) : [];
  return {
    workflowId: typeof value.workflowId === "string" ? value.workflowId : makeId("workflow"),
    objective: typeof value.objective === "string" ? value.objective : "Untitled workflow",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
    status: normalizeWorkflowStatus(value.status),
    originTabId: typeof value.originTabId === "number" ? value.originTabId : -1,
    originUrl: typeof value.originUrl === "string" ? value.originUrl : "",
    originTitle: typeof value.originTitle === "string" ? value.originTitle : "",
    currentStepIndex: typeof value.currentStepIndex === "number" && Number.isFinite(value.currentStepIndex) ? value.currentStepIndex : 0,
    lastPageUrl: typeof value.lastPageUrl === "string" ? value.lastPageUrl : null,
    lastPageTitle: typeof value.lastPageTitle === "string" ? value.lastPageTitle : null,
    lastSummary: typeof value.lastSummary === "string" ? value.lastSummary : null,
    steps
  };
}
function hasWorkflowContext(context) {
  return Boolean(context?.workflowId && context?.workflowStepId);
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
function isWorkflowPlanPaused(plan) {
  const step = plan.steps[plan.currentStepIndex] ?? null;
  return Boolean(step && (step.status === "blocked" || !step.request));
}
function isWorkflowPlanComplete(plan) {
  return plan.currentStepIndex >= plan.steps.length;
}
function summarizePlanEntry(plan) {
  const completedStepCount = plan.steps.filter((step) => step.status === "completed").length;
  const lastResult = [...plan.steps].reverse().find((step) => step.resultSummary)?.resultSummary ?? null;
  return {
    workflowId: plan.workflowId,
    objective: plan.objective,
    status: plan.status,
    startedAt: plan.createdAt,
    endedAt: plan.status === "active" ? null : plan.updatedAt,
    stepCount: plan.steps.length,
    completedStepCount,
    originTabId: plan.originTabId,
    originUrl: plan.originUrl,
    originTitle: plan.originTitle,
    lastResult
  };
}
function maybeArchiveWorkflow(state2, workflow) {
  const nextWorkflow = {
    ...workflow,
    updatedAt: nowIso()
  };
  if (isWorkflowPlanComplete(nextWorkflow)) {
    return archiveActiveWorkflow(
      {
        ...state2,
        activeWorkflow: nextWorkflow
      },
      "completed",
      { resultSummary: nextWorkflow.lastSummary }
    );
  }
  if (isWorkflowPlanPaused(nextWorkflow)) {
    return {
      ...state2,
      activeWorkflow: {
        ...nextWorkflow,
        status: "paused"
      },
      lastUpdatedAt: nowIso()
    };
  }
  return {
    ...state2,
    activeWorkflow: {
      ...nextWorkflow,
      status: "active"
    },
    lastUpdatedAt: nowIso()
  };
}
function appendNote(state2, note) {
  const normalized = normalize(note);
  if (!normalized) {
    return state2;
  }
  return {
    ...state2,
    memoryNotes: truncate([...state2.memoryNotes, normalized], MAX_WORKFLOW_NOTES),
    lastUpdatedAt: nowIso()
  };
}
function archiveActiveWorkflow(state2, status, options = {}) {
  if (!state2.activeWorkflow) {
    return options.note ? appendNote(state2, options.note) : state2;
  }
  const nextWorkflow = {
    ...state2.activeWorkflow,
    status,
    updatedAt: nowIso()
  };
  const historyEntry = {
    ...summarizePlanEntry(nextWorkflow),
    lastResult: options.resultSummary ?? summarizePlanEntry(nextWorkflow).lastResult
  };
  const nextState = {
    ...state2,
    activeWorkflow: null,
    recentWorkflows: truncate([...state2.recentWorkflows, historyEntry], MAX_WORKFLOW_HISTORY_ENTRIES),
    lastUpdatedAt: nowIso()
  };
  return options.note ? appendNote(nextState, options.note) : nextState;
}
function updateWorkflowStepByContext(state2, context, status, resultSummary) {
  if (!hasWorkflowContext(context) || !state2.activeWorkflow || context.workflowId !== state2.activeWorkflow.workflowId) {
    return state2;
  }
  const workflow = state2.activeWorkflow;
  const stepIndex = workflow.steps.findIndex((step2) => step2.stepId === context.workflowStepId);
  if (stepIndex < 0) {
    return state2;
  }
  const step = workflow.steps[stepIndex];
  const updatedStep = {
    ...step,
    status,
    updatedAt: nowIso(),
    completedAt: status === "completed" ? nowIso() : step.completedAt,
    resultSummary: resultSummary ?? step.resultSummary
  };
  let nextWorkflow = {
    ...workflow,
    steps: workflow.steps.map((entry, index) => index === stepIndex ? updatedStep : entry),
    currentStepIndex: Math.max(workflow.currentStepIndex, status === "completed" ? stepIndex + 1 : stepIndex),
    updatedAt: nowIso(),
    lastSummary: resultSummary ?? workflow.lastSummary
  };
  if (status === "failed") {
    const archived = archiveActiveWorkflow(
      {
        ...state2,
        activeWorkflow: nextWorkflow
      },
      "failed",
      { resultSummary }
    );
    return appendNote(archived, `Workflow step failed: ${step.title}`);
  }
  const nextState = {
    ...state2,
    activeWorkflow: nextWorkflow,
    lastUpdatedAt: nowIso()
  };
  if (status === "queued") {
    return appendNote(nextState, `Queued workflow step: ${step.title}`);
  }
  if (status === "completed") {
    nextWorkflow = {
      ...nextWorkflow,
      currentStepIndex: stepIndex + 1
    };
    const finalizedState = maybeArchiveWorkflow(
      {
        ...nextState,
        activeWorkflow: nextWorkflow
      },
      nextWorkflow
    );
    if (finalizedState.activeWorkflow) {
      const cursorStep = finalizedState.activeWorkflow.steps[finalizedState.activeWorkflow.currentStepIndex] ?? null;
      if (cursorStep && finalizedState.activeWorkflow.status === "paused") {
        return appendNote(finalizedState, `Workflow "${finalizedState.activeWorkflow.objective}" is paused on "${cursorStep.title}".`);
      }
    }
    return finalizedState;
  }
  return maybeArchiveWorkflow(nextState, nextWorkflow);
}
function createInitialWorkflowState() {
  return {
    activeWorkflow: null,
    recentWorkflows: [],
    memoryNotes: [],
    lastInstruction: null,
    lastObjective: null,
    lastUpdatedAt: nowIso()
  };
}
function normalizeWorkflowState(partial) {
  const fallback = createInitialWorkflowState();
  if (!partial) {
    return fallback;
  }
  const activeWorkflow = normalizeWorkflowPlan(partial.activeWorkflow);
  const recentWorkflows = Array.isArray(partial.recentWorkflows) ? partial.recentWorkflows.map(normalizeHistoryEntry).filter((entry) => Boolean(entry)).slice(-MAX_WORKFLOW_HISTORY_ENTRIES) : [];
  return {
    activeWorkflow,
    recentWorkflows,
    memoryNotes: Array.isArray(partial.memoryNotes) ? partial.memoryNotes.filter((note) => typeof note === "string" && note.trim().length > 0).slice(-MAX_WORKFLOW_NOTES) : [],
    lastInstruction: typeof partial.lastInstruction === "string" ? partial.lastInstruction : null,
    lastObjective: typeof partial.lastObjective === "string" ? partial.lastObjective : null,
    lastUpdatedAt: typeof partial.lastUpdatedAt === "string" ? partial.lastUpdatedAt : nowIso()
  };
}
function requestLabelForStep(step, stepNumber, workflow) {
  if (step.request?.kind === "request-action") {
    return `Step ${stepNumber}: ${step.title}`;
  }
  if (step.request?.kind === "scan-page") {
    return `Step ${stepNumber}: ${step.title}`;
  }
  return `Step ${stepNumber}: ${step.title}`;
}
function buildWorkflowStepSuggestion(workflow, step, index, snapshot) {
  if (!step.request || step.status === "blocked") {
    return null;
  }
  const tabContext = step.request.tabContext ?? (step.request.kind === "request-action" ? step.request.action.tabContext : null) ?? buildTabContextFromSnapshot(snapshot);
  return {
    id: `workflow-${workflow.workflowId}-${step.stepId}`,
    title: requestLabelForStep(step, index + 1, workflow),
    description: step.description || `Continue the workflow "${workflow.objective}".`,
    buttonLabel: step.request.kind === "request-action" ? "Queue step" : "Run step",
    request: step.request,
    tabContext,
    approvalRequired: step.approvalRequired,
    dangerLevel: step.dangerLevel,
    source: "workflow",
    selector: void 0,
    confidence: step.confidence
  };
}
function buildWorkflowRescanSuggestion(workflow, snapshot) {
  const changedPage = workflow.lastPageUrl && workflow.lastPageUrl !== snapshot.url;
  if (!changedPage) {
    return null;
  }
  const tabContext = buildTabContextFromSnapshot(snapshot);
  return {
    id: `workflow-rescan-${workflow.workflowId}-${snapshot.snapshotId}`,
    title: `Rescan before continuing "${workflow.objective}"`,
    description: `The workflow was last observed on ${workflow.lastPageTitle || workflow.lastPageUrl || "a previous page"} and the active tab has changed.`,
    buttonLabel: "Rescan",
    tabContext,
    request: attachTabContextToRequest({
      kind: "scan-page",
      mode: "suggestions",
      workflowId: workflow.workflowId
    }, tabContext),
    approvalRequired: false,
    dangerLevel: "low",
    source: "workflow",
    selector: void 0,
    confidence: 0.8
  };
}
function buildWorkflowSuggestions(workflowState, snapshot) {
  const workflow = workflowState.activeWorkflow;
  if (!workflow) {
    return [];
  }
  const suggestions = [];
  const rescanSuggestion = buildWorkflowRescanSuggestion(workflow, snapshot);
  if (rescanSuggestion) {
    suggestions.push(rescanSuggestion);
  }
  const nextStep = getWorkflowNextStep(workflow);
  if (nextStep) {
    const stepSuggestion = buildWorkflowStepSuggestion(workflow, nextStep, workflow.currentStepIndex, snapshot);
    if (stepSuggestion) {
      suggestions.push(stepSuggestion);
    }
  }
  return suggestions;
}
function recordWorkflowPlan(state2, plan, snapshot) {
  const nextState = state2.activeWorkflow ? archiveActiveWorkflow(state2, "abandoned", { note: `Replaced active workflow "${state2.activeWorkflow.objective}".` }) : state2;
  const workflow = {
    ...plan,
    createdAt: plan.createdAt || nowIso(),
    updatedAt: nowIso(),
    status: "active",
    originTabId: snapshot?.tabId ?? plan.originTabId,
    originUrl: snapshot?.url ?? plan.originUrl,
    originTitle: snapshot?.title ?? plan.originTitle,
    lastPageUrl: snapshot?.url ?? plan.lastPageUrl,
    lastPageTitle: snapshot?.title ?? plan.lastPageTitle,
    lastSummary: snapshot?.summary ?? plan.lastSummary,
    steps: plan.steps.slice(0, MAX_WORKFLOW_STEPS),
    currentStepIndex: Math.max(0, Math.min(plan.currentStepIndex, plan.steps.length))
  };
  const note = `Planned workflow: ${workflow.objective}`;
  return {
    ...nextState,
    activeWorkflow: workflow,
    recentWorkflows: nextState.recentWorkflows,
    memoryNotes: truncate([...nextState.memoryNotes, note], MAX_WORKFLOW_NOTES),
    lastInstruction: workflow.objective,
    lastObjective: workflow.objective,
    lastUpdatedAt: nowIso()
  };
}
function recordWorkflowPageState(state2, tabId, pageState, snapshot) {
  if (!state2.activeWorkflow) {
    return state2;
  }
  const workflow = state2.activeWorkflow;
  const nextUrl = snapshot?.url ?? pageState?.url ?? workflow.lastPageUrl;
  const nextTitle = snapshot?.title ?? pageState?.title ?? workflow.lastPageTitle;
  const nextSummary = snapshot?.summary ?? workflow.lastSummary;
  const changed = Boolean(nextUrl && workflow.lastPageUrl && nextUrl !== workflow.lastPageUrl) || Boolean(nextTitle && workflow.lastPageTitle && nextTitle !== workflow.lastPageTitle);
  const nextWorkflow = {
    ...workflow,
    lastPageUrl: nextUrl ?? null,
    lastPageTitle: nextTitle ?? null,
    lastSummary: nextSummary ?? null,
    updatedAt: nowIso()
  };
  let nextState = {
    ...state2,
    activeWorkflow: nextWorkflow,
    lastUpdatedAt: nowIso()
  };
  if (changed) {
    nextState = appendNote(
      nextState,
      `Workflow "${workflow.objective}" observed tab ${tabId} change to ${nextTitle || nextUrl || "unknown page"}.`
    );
  }
  return nextState;
}
function markWorkflowStepQueued(state2, action) {
  return updateWorkflowStepByContext(state2, action, "queued", null);
}
function markWorkflowStepCompleted(state2, action, resultSummary) {
  return updateWorkflowStepByContext(state2, action, "completed", resultSummary);
}
function markWorkflowStepFailed(state2, action, reason) {
  return updateWorkflowStepByContext(state2, action, "failed", reason);
}
function markWorkflowRequestCompleted(state2, context, resultSummary) {
  return updateWorkflowStepByContext(state2, context, "completed", resultSummary);
}
function markWorkflowRequestFailed(state2, context, reason) {
  return updateWorkflowStepByContext(state2, context, "failed", reason);
}
function getActiveWorkflowNextRequest(state2) {
  return getWorkflowNextStep(state2?.activeWorkflow ?? null)?.request ?? null;
}

// src/shared/tab-orchestration.ts
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
    if (tab.pageState.userInterventionKind) {
      pieces.push(`waiting for ${tab.pageState.userInterventionKind}`);
    }
    pieces.push(`${tab.pageState.interactiveCount} interactive`);
  }
  return pieces.join(" · ");
}

// src/background/semantic-client.ts
async function fetchJson2(url, timeoutMs, init) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...init?.headers ?? {}
      }
    });
    if (!response.ok) {
      throw new Error(`Request to ${url} failed with HTTP ${response.status}.`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
async function probeSemanticBridge(endpoint) {
  try {
    const response = await fetchJson2(`${endpoint}/health`, SEMANTIC_STATUS_REQUEST_TIMEOUT_MS);
    return normalizeSemanticHealth(response, endpoint);
  } catch (error) {
    return {
      endpoint,
      browserEndpoint: "",
      status: "error",
      model: null,
      reason: normalizeError(error, "SEMANTIC_BRIDGE_UNAVAILABLE", { recoverable: true }).message,
      observedAt: nowIso(),
      lastError: normalizeError(error, "SEMANTIC_BRIDGE_UNAVAILABLE", { recoverable: true })
    };
  }
}
async function refreshSemanticState(endpoint = DEFAULT_SEMANTIC_ENDPOINT) {
  const health = await probeSemanticBridge(endpoint);
  return buildSemanticState(health);
}
async function requestSemanticObservation(snapshot, endpoint = DEFAULT_SEMANTIC_ENDPOINT) {
  const instruction = semanticInstructionFromSnapshot(snapshot);
  const payload = {
    instruction,
    pageUrl: snapshot.url,
    pageTitle: snapshot.title,
    snapshotSummary: snapshot.summary,
    limit: 5
  };
  try {
    const response = await fetchJson2(`${endpoint}/observe`, SEMANTIC_OBSERVE_REQUEST_TIMEOUT_MS, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    return normalizeSemanticObservation(response, endpoint);
  } catch (error) {
    return normalizeSemanticObservation(
      {
        endpoint,
        browserEndpoint: "",
        status: "error",
        model: null,
        pageUrl: snapshot.url,
        pageTitle: snapshot.title,
        reason: normalizeError(error, "SEMANTIC_OBSERVE_FAILED", { recoverable: true }).message,
        observedAt: nowIso(),
        actions: []
      },
      endpoint
    );
  }
}

// src/shared/dom.ts
function resolveUserIntervention(pageKind) {
  if (pageKind === "login") {
    return {
      kind: "login",
      message: "Login page detected. Please sign in manually, then type done to continue."
    };
  }
  if (pageKind === "payment") {
    return {
      kind: "payment",
      message: "Payment page detected. Please complete the payment manually, then type done to continue."
    };
  }
  return null;
}
function resolvePageStateFromSnapshot(snapshot) {
  const userIntervention = resolveUserIntervention(snapshot.pageKind);
  return {
    url: snapshot.url,
    title: snapshot.title,
    readyState: snapshot.meta.readyState,
    navigationMode: snapshot.navigationMode,
    pageKind: snapshot.pageKind,
    interactiveCount: snapshot.meta.interactiveCount,
    formCount: snapshot.meta.formCount,
    visibleTextLength: snapshot.meta.visibleTextLength,
    hasSensitiveInputs: snapshot.meta.hasSensitiveInputs,
    siteAdapterId: snapshot.siteAdapter?.id ?? null,
    siteAdapterLabel: snapshot.siteAdapter?.label ?? null,
    userInterventionKind: userIntervention?.kind ?? null,
    userInterventionMessage: userIntervention?.message ?? null,
    updatedAt: snapshot.capturedAt
  };
}

// src/shared/messages.ts
function isRecord5(value) {
  return typeof value === "object" && value !== null;
}
function isUiRequest(value) {
  return isRecord5(value) && typeof value.kind === "string";
}
function isContentEvent(value) {
  return isRecord5(value) && typeof value.kind === "string";
}

// src/shared/storage.ts
async function readSessionValue(key, fallback) {
  const data = await chrome.storage.session.get(key);
  return data[key] ?? fallback;
}
async function writeSessionValue(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

// src/background/service-worker.ts
var uiPorts = /* @__PURE__ */ new Set();
function createDefaultTabState(tabId, partial = {}) {
  return {
    tabId,
    windowId: partial.windowId ?? 0,
    active: partial.active ?? false,
    url: partial.url ?? "",
    title: partial.title ?? "",
    pageState: partial.pageState ?? null,
    snapshot: partial.snapshot ?? null,
    snapshotFresh: partial.snapshotFresh ?? false,
    contentReady: partial.contentReady ?? false,
    busy: partial.busy ?? false,
    approvals: partial.approvals ?? [],
    activityLog: partial.activityLog ?? [],
    lastError: partial.lastError ?? null,
    lastSeenAt: partial.lastSeenAt ?? nowIso()
  };
}
function createInitialState() {
  return {
    activeTabId: null,
    tabs: {},
    bridge: createDisconnectedBridgeState(),
    semantic: createDisabledSemanticState(),
    workflow: createInitialWorkflowState(),
    status: "idle",
    lastUpdatedAt: nowIso()
  };
}
function normalizeTabState(tabId, partial) {
  if (!partial) {
    return createDefaultTabState(tabId);
  }
  return createDefaultTabState(tabId, {
    ...partial,
    approvals: Array.isArray(partial.approvals) ? partial.approvals : [],
    activityLog: Array.isArray(partial.activityLog) ? partial.activityLog : []
  });
}
function normalizeState(partial) {
  const fallback = createInitialState();
  if (!partial) {
    return fallback;
  }
  const tabs = {};
  for (const [key, value] of Object.entries(partial.tabs ?? {})) {
    const tabId = Number.parseInt(key, 10);
    if (!Number.isFinite(tabId)) {
      continue;
    }
    tabs[tabId] = normalizeTabState(tabId, value);
  }
  return {
    activeTabId: typeof partial.activeTabId === "number" ? partial.activeTabId : null,
    tabs,
    bridge: partial.bridge ?? createDisconnectedBridgeState(),
    semantic: partial.semantic ?? createDisabledSemanticState(),
    workflow: normalizeWorkflowState(partial.workflow ?? createInitialWorkflowState()),
    status: partial.status ?? "idle",
    lastUpdatedAt: typeof partial.lastUpdatedAt === "string" ? partial.lastUpdatedAt : nowIso()
  };
}
var state = createInitialState();
var persistTimer = null;
var bridgeRefreshTimer = null;
var bridgeRefreshInFlight = false;
var semanticRefreshTimer = null;
var semanticRefreshInFlight = false;
function getTabState(tabId) {
  const existing = state.tabs[tabId];
  if (existing) {
    return existing;
  }
  const next = createDefaultTabState(tabId);
  state.tabs[tabId] = next;
  return next;
}
function getActiveTabState() {
  if (state.activeTabId === null) {
    return null;
  }
  return state.tabs[state.activeTabId] ?? null;
}
function replaceTabState(tabId, updater) {
  const current = getTabState(tabId);
  const next = updater(current);
  state.tabs[tabId] = next;
  return next;
}
function truncateEntries(entries, maxEntries) {
  if (entries.length <= maxEntries) {
    return entries;
  }
  return entries.slice(entries.length - maxEntries);
}
function deriveStatus() {
  const active = getActiveTabState();
  if (!active) {
    return "idle";
  }
  if (active.busy) {
    return "running";
  }
  if (getManualIntervention(active)) {
    return "awaiting-user";
  }
  if (active.lastError) {
    return "error";
  }
  if (active.approvals.some((approval) => approval.status === "pending" || approval.status === "executing")) {
    return "awaiting-approval";
  }
  return active.contentReady ? "connected" : "idle";
}
function getManualIntervention(tab) {
  if (!tab) {
    return null;
  }
  const pageIntervention = resolveUserIntervention(tab.pageState?.userInterventionKind ?? tab.pageState?.pageKind ?? null);
  if (pageIntervention) {
    return pageIntervention;
  }
  if (!requiresManualIntervention(tab.snapshot)) {
    return null;
  }
  return resolveUserIntervention(tab.snapshot?.pageKind ?? null);
}
function isAwaitingUserIntervention(tab) {
  return Boolean(getManualIntervention(tab));
}
async function persistState() {
  await writeSessionValue(STORAGE_KEY_STATE, state);
}
function schedulePersistState() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
  }
  persistTimer = globalThis.setTimeout(() => {
    persistTimer = null;
    void persistState();
  }, 50);
}
function updateDerivedState() {
  state.status = deriveStatus();
  state.lastUpdatedAt = nowIso();
}
function broadcastState() {
  const message = { kind: "state", state };
  for (const port of uiPorts) {
    try {
      port.postMessage(message);
    } catch {
    }
  }
}
function broadcastEvent(event) {
  for (const port of uiPorts) {
    try {
      port.postMessage(event);
    } catch {
    }
  }
}
function updateBadge() {
  const active = getActiveTabState();
  const approvalCount = active?.approvals.filter((approval) => approval.status === "pending" || approval.status === "executing").length ?? 0;
  let text = "";
  let color = "#64748b";
  if (active?.busy) {
    text = "RUN";
    color = "#0f766e";
  } else if (isAwaitingUserIntervention(active)) {
    text = "WAIT";
    color = "#ca8a04";
  } else if (approvalCount > 0) {
    text = approvalCount > 99 ? "99+" : String(approvalCount);
    color = "#c2410c";
  } else if (active?.lastError) {
    text = "!";
    color = "#b91c1c";
  } else if (active?.contentReady) {
    text = "OK";
    color = "#166534";
  }
  void chrome.action.setBadgeText({ text }).catch(() => void 0);
  void chrome.action.setBadgeBackgroundColor({ color }).catch(() => void 0);
}
function commit(event) {
  updateDerivedState();
  updateBadge();
  schedulePersistState();
  broadcastState();
  if (event) {
    broadcastEvent(event);
  }
}
async function refreshBridgeStatus() {
  if (bridgeRefreshInFlight) {
    return;
  }
  bridgeRefreshInFlight = true;
  try {
    state.bridge = await refreshBridgeState();
    commit();
  } finally {
    bridgeRefreshInFlight = false;
  }
}
function scheduleBridgePolling() {
  if (bridgeRefreshTimer !== null) {
    return;
  }
  bridgeRefreshTimer = globalThis.setInterval(() => {
    void refreshBridgeStatus();
  }, BRIDGE_POLL_INTERVAL_MS);
}
async function refreshSemanticStatus() {
  if (semanticRefreshInFlight) {
    return;
  }
  semanticRefreshInFlight = true;
  try {
    state.semantic = await refreshSemanticState();
    commit();
  } finally {
    semanticRefreshInFlight = false;
  }
}
function scheduleSemanticPolling() {
  if (semanticRefreshTimer !== null) {
    return;
  }
  semanticRefreshTimer = globalThis.setInterval(() => {
    void refreshSemanticStatus();
  }, SEMANTIC_POLL_INTERVAL_MS);
}
async function resolveSemanticTarget(tabId, selector) {
  try {
    const response = await sendContentRequest(tabId, { kind: "resolve-selector", selector });
    if (response.kind !== "resolve-selector-result" || !response.elementId) {
      return null;
    }
    return {
      elementId: response.elementId,
      label: response.label || response.tagName || selector
    };
  } catch {
    return null;
  }
}
async function mergeSemanticSuggestions(tabId, snapshot) {
  const observation = await requestSemanticObservation(snapshot);
  state.semantic = updateSemanticStateWithObservation(state.semantic, observation);
  if (observation.status !== "ready" || observation.actions.length === 0) {
    commit();
    return;
  }
  const semanticSuggestions = await buildSemanticSuggestions(observation, snapshot, async (selector) => resolveSemanticTarget(tabId, selector));
  if (semanticSuggestions.length === 0) {
    commit();
    return;
  }
  const mergedSnapshot = {
    ...snapshot,
    suggestedActions: [...snapshot.suggestedActions, ...semanticSuggestions]
  };
  replaceTabState(tabId, (current) => ({
    ...current,
    snapshot: mergedSnapshot,
    pageState: resolvePageStateFromSnapshot(mergedSnapshot),
    snapshotFresh: true,
    lastSeenAt: nowIso()
  }));
  state.semantic = {
    ...state.semantic,
    observedAt: observation.observedAt,
    pageUrl: observation.pageUrl,
    pageTitle: observation.pageTitle,
    suggestionCount: semanticSuggestions.length
  };
  pushLog(tabId, "success", "Added semantic suggestions from Stagehand.", `${semanticSuggestions.length} suggestion${semanticSuggestions.length === 1 ? "" : "s"} added.`);
  commit({ kind: "page-snapshot", tabId, snapshot: mergedSnapshot });
}
function mergeWorkflowSuggestions(tabId, snapshot) {
  const workflowSuggestions = buildWorkflowSuggestions(state.workflow, snapshot);
  if (workflowSuggestions.length === 0) {
    return;
  }
  const tabState = getTabState(tabId);
  const currentSnapshot = tabState.snapshot ?? snapshot;
  const mergedSnapshot = {
    ...currentSnapshot,
    suggestedActions: [...workflowSuggestions, ...currentSnapshot.suggestedActions]
  };
  replaceTabState(tabId, (current) => ({
    ...current,
    snapshot: mergedSnapshot,
    pageState: resolvePageStateFromSnapshot(mergedSnapshot),
    snapshotFresh: true,
    lastSeenAt: nowIso()
  }));
  commit({ kind: "page-snapshot", tabId, snapshot: mergedSnapshot });
}
function setLastError(tabId, error) {
  replaceTabState(tabId, (current) => ({
    ...current,
    lastError: error,
    lastSeenAt: nowIso()
  }));
}
function pushLog(tabId, level, message, details) {
  const entry = createActivityLogEntry(level, message, { tabId, details });
  replaceTabState(tabId, (current) => ({
    ...current,
    activityLog: truncateEntries([...current.activityLog, entry], MAX_ACTIVITY_LOG_ENTRIES),
    lastSeenAt: nowIso()
  }));
}
function logManualInterventionTransition(tabId, previousKind, pageState) {
  if (!pageState.userInterventionKind || pageState.userInterventionKind === previousKind) {
    return;
  }
  pushLog(tabId, "warning", `Manual ${pageState.userInterventionKind} step detected.`, pageState.userInterventionMessage ?? "Please complete the step manually, then type done to continue.");
}
function markBusy(tabId, busy) {
  replaceTabState(tabId, (current) => ({
    ...current,
    busy,
    lastSeenAt: nowIso()
  }));
}
function markContentReady(tabId, ready) {
  replaceTabState(tabId, (current) => ({
    ...current,
    contentReady: ready,
    lastSeenAt: nowIso()
  }));
}
function markSnapshotFresh(tabId, fresh) {
  replaceTabState(tabId, (current) => ({
    ...current,
    snapshotFresh: fresh,
    lastSeenAt: nowIso()
  }));
}
function setActiveTab(tabId) {
  state.activeTabId = tabId;
  for (const [knownId, tabState] of Object.entries(state.tabs)) {
    const numericId = Number.parseInt(knownId, 10);
    if (!Number.isFinite(numericId)) {
      continue;
    }
    state.tabs[numericId] = {
      ...tabState,
      active: tabId === numericId
    };
  }
}
function updateTabContextFromChromeTab(tab, options = {}) {
  if (typeof tab.id !== "number") {
    throw new Error("Tab is missing an id.");
  }
  const markActive = options.markActive ?? true;
  const current = getTabState(tab.id);
  const nextUrl = tab.url ?? current.url;
  const nextTitle = tab.title ?? current.title;
  const urlChanged = nextUrl !== current.url;
  const titleChanged = nextTitle !== current.title;
  const next = {
    ...current,
    windowId: tab.windowId ?? current.windowId,
    active: markActive ? Boolean(tab.active) || state.activeTabId === tab.id : state.activeTabId === tab.id,
    url: nextUrl,
    title: nextTitle,
    pageState: current.pageState ? {
      ...current.pageState,
      url: nextUrl,
      title: nextTitle
    } : current.pageState,
    snapshotFresh: urlChanged ? false : current.snapshotFresh,
    contentReady: urlChanged ? false : current.contentReady,
    lastSeenAt: nowIso()
  };
  state.tabs[tab.id] = next;
  if (markActive && tab.active) {
    setActiveTab(tab.id);
  }
  if ((urlChanged || titleChanged) && options.logChanges !== false) {
    pushLog(tab.id, "info", "Tab context updated.", `${nextTitle || "Untitled"} | ${nextUrl || "unknown url"}`);
  }
  return next;
}
async function syncActiveTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const next = updateTabContextFromChromeTab(tab);
    setActiveTab(tabId);
    commit();
    return next;
  } catch (error) {
    const normalized = normalizeError(error, "TAB_SYNC_FAILED", { tabId, recoverable: true });
    setLastError(tabId, normalized);
    pushLog(tabId, "error", "Failed to sync active tab.", normalized.message);
    commit({ kind: "error", error: normalized });
    return null;
  }
}
async function refreshKnownTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (typeof tab.id !== "number") {
        continue;
      }
      updateTabContextFromChromeTab(tab, { markActive: false, logChanges: false });
    }
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeTab = activeTabs.find((tab) => typeof tab.id === "number") ?? null;
    if (activeTab) {
      updateTabContextFromChromeTab(activeTab, { markActive: true, logChanges: false });
    } else if (state.activeTabId !== null && !state.tabs[state.activeTabId]) {
      state.activeTabId = null;
    }
    commit();
  } catch (error) {
    const normalized = normalizeError(error, "TAB_REFRESH_FAILED", { recoverable: true });
    const tabId = state.activeTabId ?? null;
    if (tabId !== null) {
      setLastError(tabId, normalized);
      pushLog(tabId, "error", "Failed to refresh tab inventory.", normalized.message);
    }
    commit({ kind: "error", error: normalized });
  }
}
async function focusTrackedTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (typeof tab.windowId === "number") {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
      }
    }
    await chrome.tabs.update(tabId, { active: true });
    const synced = await syncActiveTab(tabId);
    if (synced) {
      pushLog(tabId, "info", "Focused tab.", summarizeTrackedTab(synced));
    }
    return synced;
  } catch (error) {
    const normalized = normalizeError(error, "TAB_FOCUS_FAILED", { tabId, recoverable: true });
    setLastError(tabId, normalized);
    pushLog(tabId, "error", "Failed to focus tab.", normalized.message);
    commit({ kind: "error", error: normalized });
    return null;
  }
}
function isInspectableUrl(url) {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:" || parsed.protocol === "about:";
  } catch {
    return false;
  }
}
async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { kind: "ping" });
    if (pong && pong.kind === "ping") {
      markContentReady(tabId, true);
      return;
    }
  } catch {
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
  for (let attempt = 0; attempt < CONTENT_SCRIPT_READY_RETRIES; attempt += 1) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, CONTENT_SCRIPT_RETRY_DELAY_MS));
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { kind: "ping" });
      if (pong && pong.kind === "ping") {
        markContentReady(tabId, true);
        return;
      }
    } catch {
    }
  }
  throw new Error("The content script did not respond after injection.");
}
async function sendContentRequest(tabId, request) {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, request);
}
async function capturePageFromTab(tabId, mode) {
  const response = await sendContentRequest(tabId, { kind: "capture-page", mode });
  if (response.kind === "content-error") {
    throw new Error(response.error.message);
  }
  if (response.kind !== "page-snapshot") {
    throw new Error(`Unexpected content response: ${response.kind}`);
  }
  const snapshot = {
    ...response.snapshot,
    tabId
  };
  return snapshot;
}
async function recordSnapshot(tabId, mode) {
  const snapshot = await capturePageFromTab(tabId, mode);
  const pageState = resolvePageStateFromSnapshot(snapshot);
  const previousInterventionKind = getTabState(tabId).pageState?.userInterventionKind;
  replaceTabState(tabId, (current) => ({
    ...current,
    snapshot,
    pageState,
    contentReady: true,
    snapshotFresh: true,
    lastError: null,
    lastSeenAt: nowIso()
  }));
  logManualInterventionTransition(tabId, previousInterventionKind, pageState);
  state.workflow = recordWorkflowPageState(state.workflow, tabId, pageState, snapshot);
  pushLog(tabId, "success", `Captured ${mode} page snapshot.`, `Interactive controls: ${snapshot.interactiveElements.length}`);
  commit({ kind: "page-snapshot", tabId, snapshot });
  return snapshot;
}
async function scanActiveTab(mode, workflowContext = null) {
  const tabId = state.activeTabId;
  if (tabId === null) {
    const error = normalizeError("No active tab is available.", "NO_ACTIVE_TAB", { recoverable: true });
    commit({ kind: "error", error });
    return;
  }
  const tabState = getTabState(tabId);
  if (!isInspectableUrl(tabState.url)) {
    const error = normalizeError(`The active tab cannot be inspected: ${tabState.url || "unknown url"}`, "UNSUPPORTED_URL", {
      tabId,
      recoverable: true
    });
    setLastError(tabId, error);
    pushLog(tabId, "warning", "Scan blocked because the current page is not inspectable.", error.message);
    commit({ kind: "error", error });
    return;
  }
  markBusy(tabId, true);
  commit();
  try {
    const snapshot = await recordSnapshot(tabId, mode);
    if (workflowContext?.workflowId && workflowContext.workflowStepId) {
      state.workflow = markWorkflowRequestCompleted(state.workflow, workflowContext, snapshot.summary);
      commit();
    }
    if (mode === "suggestions" && state.semantic.status === "ready") {
      await mergeSemanticSuggestions(tabId, snapshot);
    }
    if (mode === "suggestions") {
      mergeWorkflowSuggestions(tabId, snapshot);
    }
  } catch (error) {
    const normalized = normalizeError(error, "CAPTURE_FAILED", { tabId, recoverable: true });
    if (workflowContext?.workflowId && workflowContext.workflowStepId) {
      state.workflow = markWorkflowRequestFailed(state.workflow, workflowContext, normalized.message);
    }
    setLastError(tabId, normalized);
    markContentReady(tabId, false);
    pushLog(tabId, "error", "Failed to capture the page.", `${normalized.message}${normalized.details ? ` | ${normalized.details}` : ""}`);
    commit({ kind: "error", error: normalized });
  } finally {
    markBusy(tabId, false);
    commit();
  }
}
async function scanTrackedTab(tabId, mode, workflowContext = null) {
  const tabState = getTabState(tabId);
  if (!isInspectableUrl(tabState.url)) {
    const error = normalizeError(`The tab cannot be inspected: ${tabState.url || "unknown url"}`, "UNSUPPORTED_URL", {
      tabId,
      recoverable: true
    });
    setLastError(tabId, error);
    pushLog(tabId, "warning", "Scan blocked because the selected tab is not inspectable.", error.message);
    commit({ kind: "error", error });
    return;
  }
  if (state.activeTabId !== tabId) {
    const focused = await focusTrackedTab(tabId);
    if (!focused) {
      return;
    }
  } else {
    await syncActiveTab(tabId);
  }
  await scanActiveTab(mode, workflowContext);
}
function pruneApprovals(approvals) {
  return truncateEntries(approvals, MAX_APPROVAL_QUEUE_ENTRIES);
}
function findApprovalById(approvalId) {
  for (const [tabKey, tabState] of Object.entries(state.tabs)) {
    const tabId = Number.parseInt(tabKey, 10);
    if (!Number.isFinite(tabId)) {
      continue;
    }
    const approval = tabState.approvals.find((entry) => entry.approvalId === approvalId);
    if (approval) {
      return { tabId, approval };
    }
  }
  return null;
}
async function queueActionForApproval(action) {
  const tabId = resolveActionTabId(action) ?? state.activeTabId;
  if (tabId === null) {
    const error = normalizeError("No active tab is available.", "NO_ACTIVE_TAB", { recoverable: true });
    commit({ kind: "error", error });
    return;
  }
  const tabState = getTabState(tabId);
  const snapshot = tabState.snapshot;
  if (isAwaitingUserIntervention(tabState)) {
    const intervention = getManualIntervention(tabState);
    pushLog(tabId, "warning", "Paused for a manual browser step.", intervention?.message ?? "Complete the login or payment step manually, then type done to continue.");
    commit();
    return;
  }
  if (isBlockedSensitiveAction(action, snapshot)) {
    const error = normalizeError("Sensitive form fields are not supported in v1.", "SENSITIVE_FIELD_BLOCKED", {
      tabId,
      recoverable: true
    });
    setLastError(tabId, error);
    pushLog(tabId, "warning", "Blocked an action targeting a sensitive field.", error.message);
    commit({ kind: "error", error });
    return;
  }
  state.workflow = markWorkflowStepQueued(state.workflow, action);
  action.tabId = tabId;
  const approval = buildApprovalRequest(action, tabId, snapshot);
  replaceTabState(tabId, (current) => ({
    ...current,
    approvals: pruneApprovals([...current.approvals, approval]),
    lastError: null,
    lastSeenAt: nowIso()
  }));
  pushLog(tabId, "warning", "Queued an action for approval.", `${approval.title} | ${approval.dangerLevel}`);
  commit({ kind: "approval-requested", approval });
}
async function executeApprovedAction(tabId, action, approvalId) {
  const tabState = getTabState(tabId);
  const snapshot = tabState.snapshot;
  if (isAwaitingUserIntervention(tabState)) {
    const intervention = getManualIntervention(tabState);
    pushLog(tabId, "warning", "Paused for a manual browser step.", intervention?.message ?? "Complete the login or payment step manually, then type done to continue.");
    commit();
    return;
  }
  if (requiresApproval(action)) {
    if (!approvalId) {
      throw new Error("Action requires approval before execution.");
    }
  }
  if (!canAutoExecute(action) && !snapshot) {
    throw new Error("The page must be scanned before this action can run.");
  }
  const actionLabel = describeAction(action, snapshot).title;
  markBusy(tabId, true);
  commit();
  try {
    const response = await sendContentRequest(tabId, { kind: "perform-action", action });
    if (response.kind === "content-error") {
      throw new Error(response.error.message);
    }
    if (response.kind !== "action-result") {
      throw new Error(`Unexpected content response: ${response.kind}`);
    }
    const result = {
      ...response.result,
      actionId: action.actionId,
      approvalId: approvalId ?? void 0,
      tabId
    };
    replaceTabState(tabId, (current) => {
      const nextApprovals = current.approvals.map(
        (approval) => approval.approvalId === approvalId ? { ...approval, status: "succeeded", updatedAt: nowIso() } : approval
      );
      return {
        ...current,
        approvals: nextApprovals,
        snapshotFresh: action.kind === "scroll" ? current.snapshotFresh : action.kind === "refresh" || action.kind === "navigate-back" || action.kind === "navigate-forward" ? false : current.snapshotFresh,
        lastError: null,
        lastSeenAt: nowIso()
      };
    });
    state.workflow = markWorkflowStepCompleted(state.workflow, action, result.message);
    pushLog(tabId, "success", `Executed ${actionLabel}.`, result.message);
    commit({ kind: "action-result", result });
  } catch (error) {
    const normalized = normalizeError(error, "ACTION_FAILED", { tabId, recoverable: true });
    state.workflow = markWorkflowStepFailed(state.workflow, action, normalized.message);
    setLastError(tabId, normalized);
    replaceTabState(tabId, (current) => ({
      ...current,
      approvals: current.approvals.map(
        (approval) => approval.approvalId === approvalId ? { ...approval, status: "failed", updatedAt: nowIso() } : approval
      ),
      busy: false,
      lastSeenAt: nowIso()
    }));
    pushLog(tabId, "error", "Action execution failed.", normalized.message);
    commit({ kind: "error", error: normalized });
    return;
  } finally {
    markBusy(tabId, false);
    commit();
  }
}
async function approveAction(approvalId) {
  const approvalLocation = findApprovalById(approvalId);
  if (!approvalLocation) {
    return;
  }
  const { tabId, approval } = approvalLocation;
  if (approval.status !== "pending") {
    return;
  }
  if (state.activeTabId !== tabId) {
    await focusTrackedTab(tabId);
  }
  replaceTabState(tabId, (current) => ({
    ...current,
    approvals: current.approvals.map(
      (entry) => entry.approvalId === approvalId ? { ...entry, status: "approved", updatedAt: nowIso() } : entry
    ),
    lastSeenAt: nowIso()
  }));
  commit({ kind: "approval-updated", approval: { ...approval, status: "approved", updatedAt: nowIso() } });
  replaceTabState(tabId, (current) => ({
    ...current,
    approvals: current.approvals.map(
      (entry) => entry.approvalId === approvalId ? { ...entry, status: "executing", updatedAt: nowIso() } : entry
    ),
    busy: true,
    lastSeenAt: nowIso()
  }));
  commit();
  await executeApprovedAction(tabId, approval.action, approval.approvalId);
}
async function rejectAction(approvalId) {
  const approvalLocation = findApprovalById(approvalId);
  if (!approvalLocation) {
    return;
  }
  const { tabId, approval } = approvalLocation;
  const updated = {
    ...approval,
    status: "rejected",
    updatedAt: nowIso()
  };
  state.workflow = markWorkflowStepFailed(state.workflow, approval.action, "Rejected by user.");
  replaceTabState(tabId, (current) => ({
    ...current,
    approvals: current.approvals.map((entry) => entry.approvalId === approvalId ? updated : entry),
    lastSeenAt: nowIso()
  }));
  pushLog(tabId, "warning", "Rejected an action request.", updated.title);
  commit({ kind: "approval-updated", approval: updated });
}
async function resumeManualIntervention() {
  const tabId = state.activeTabId;
  if (tabId === null) {
    return;
  }
  await syncActiveTab(tabId);
  pushLog(tabId, "info", "Manual step completed.", "Rescanning the current page and resuming the workflow.");
  await scanActiveTab("suggestions");
  const tabState = getTabState(tabId);
  const intervention = getManualIntervention(tabState);
  if (intervention) {
    pushLog(tabId, "warning", "Manual step is still pending.", intervention.message);
    commit();
    return;
  }
  const nextRequest = state.workflow.activeWorkflow ? getActiveWorkflowNextRequest(state.workflow) : null;
  if (nextRequest?.kind === "request-action") {
    await queueActionForApproval(nextRequest.action);
  }
}
async function openSidePanel() {
  const tabId = state.activeTabId;
  if (tabId === null || !chrome.sidePanel) {
    return;
  }
  await chrome.sidePanel.setOptions({
    tabId,
    enabled: true,
    path: "sidepanel/index.html"
  });
  await chrome.sidePanel.open({ tabId });
  pushLog(tabId, "info", "Opened the side panel.");
  commit();
}
function clearActiveTabLog() {
  const tabId = state.activeTabId;
  if (tabId === null) {
    return;
  }
  replaceTabState(tabId, (current) => ({
    ...current,
    activityLog: [],
    lastError: null,
    lastSeenAt: nowIso()
  }));
  pushLog(tabId, "info", "Cleared the activity log.");
  commit();
}
async function handleUiRequest(port, request) {
  const workflowContext = "workflowId" in request || "workflowStepId" in request ? {
    ...typeof request.workflowId === "string" ? { workflowId: request.workflowId } : {},
    ...typeof request.workflowStepId === "string" ? { workflowStepId: request.workflowStepId } : {}
  } : null;
  switch (request.kind) {
    case "get-state":
      await refreshKnownTabs();
      port.postMessage({ kind: "state", state });
      void refreshBridgeStatus();
      void refreshSemanticStatus();
      return;
    case "scan-page":
      if (resolveSuggestedRequestTabId(request) !== null) {
        await scanTrackedTab(resolveSuggestedRequestTabId(request), request.mode, workflowContext);
      } else {
        await scanActiveTab(request.mode, workflowContext);
      }
      return;
    case "list-interactive-elements":
      if (resolveSuggestedRequestTabId(request) !== null) {
        await scanTrackedTab(resolveSuggestedRequestTabId(request), "interactive", workflowContext);
      } else {
        await scanActiveTab("interactive", workflowContext);
      }
      return;
    case "summarize-page":
      if (resolveSuggestedRequestTabId(request) !== null) {
        await scanTrackedTab(resolveSuggestedRequestTabId(request), "summary", workflowContext);
      } else {
        await scanActiveTab("summary", workflowContext);
      }
      return;
    case "suggest-next-actions":
      if (resolveSuggestedRequestTabId(request) !== null) {
        await scanTrackedTab(resolveSuggestedRequestTabId(request), "suggestions", workflowContext);
      } else {
        await scanActiveTab("suggestions", workflowContext);
      }
      return;
    case "request-action":
      await queueActionForApproval(request.action);
      return;
    case "plan-workflow":
      state.workflow = recordWorkflowPlan(state.workflow, request.workflow, getActiveTabState()?.snapshot ?? null);
      if (state.activeTabId !== null) {
        pushLog(
          state.activeTabId,
          "info",
          "Planned a workflow.",
          `${request.workflow.steps.length} step${request.workflow.steps.length === 1 ? "" : "s"} · ${request.workflow.objective}`
        );
      }
      commit();
      return;
    case "refresh-tabs":
      await refreshKnownTabs();
      return;
    case "focus-tab":
      await focusTrackedTab(request.tabId);
      return;
    case "scan-tab":
      await scanTrackedTab(
        request.tabId,
        request.mode,
        request.workflowId || request.workflowStepId ? {
          ...request.workflowId ? { workflowId: request.workflowId } : {},
          ...request.workflowStepId ? { workflowStepId: request.workflowStepId } : {}
        } : null
      );
      return;
    case "approve-action":
      await approveAction(request.approvalId);
      return;
    case "reject-action":
      await rejectAction(request.approvalId);
      return;
    case "refresh-bridge":
      await refreshBridgeStatus();
      return;
    case "refresh-semantic":
      await refreshSemanticStatus();
      return;
    case "resume-user-intervention":
      await resumeManualIntervention();
      return;
    case "open-sidepanel":
      await openSidePanel();
      return;
    case "clear-log":
      clearActiveTabLog();
      return;
  }
}
function resolveTabIdFromSender(sender) {
  return typeof sender.tab?.id === "number" ? sender.tab.id : null;
}
async function handleContentEvent(message, sender) {
  if (!isContentEvent(message)) {
    return;
  }
  const tabId = resolveTabIdFromSender(sender);
  if (tabId === null) {
    return;
  }
  switch (message.kind) {
    case "page-state": {
      const previousInterventionKind = getTabState(tabId).pageState?.userInterventionKind;
      const nextState = {
        ...message.state,
        url: message.state.url,
        title: message.state.title,
        updatedAt: nowIso()
      };
      replaceTabState(tabId, (current) => ({
        ...current,
        pageState: nextState,
        title: nextState.title,
        url: nextState.url,
        contentReady: true,
        snapshotFresh: message.reason === "initial" ? current.snapshotFresh : false,
        lastError: null,
        lastSeenAt: nowIso()
      }));
      logManualInterventionTransition(tabId, previousInterventionKind, nextState);
      state.workflow = recordWorkflowPageState(state.workflow, tabId, nextState, null);
      commit();
      return;
    }
    case "content-error": {
      const error = message.error;
      setLastError(tabId, error);
      pushLog(tabId, "error", "Content script reported an error.", error.message);
      commit({ kind: "error", error });
      return;
    }
    case "ping":
    case "page-snapshot":
    case "action-result":
      return;
  }
}
async function boot() {
  state = normalizeState(await readSessionValue(STORAGE_KEY_STATE, createInitialState()));
  commit();
}
await boot();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "codex-ui") {
    return;
  }
  uiPorts.add(port);
  port.postMessage({ kind: "state", state });
  void refreshBridgeStatus();
  void refreshSemanticStatus();
  scheduleBridgePolling();
  scheduleSemanticPolling();
  port.onMessage.addListener((message) => {
    if (!isUiRequest(message)) {
      return;
    }
    void handleUiRequest(port, message).catch((error) => {
      const normalized = normalizeError(error, "UI_REQUEST_FAILED", { recoverable: true });
      port.postMessage({ kind: "error", error: normalized });
    });
  });
  port.onDisconnect.addListener(() => {
    uiPorts.delete(port);
    if (uiPorts.size === 0 && bridgeRefreshTimer !== null) {
      clearInterval(bridgeRefreshTimer);
      bridgeRefreshTimer = null;
    }
    if (uiPorts.size === 0 && semanticRefreshTimer !== null) {
      clearInterval(semanticRefreshTimer);
      semanticRefreshTimer = null;
    }
  });
});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!isContentEvent(message)) {
    return;
  }
  void handleContentEvent(message, sender).catch((error) => {
    const normalized = normalizeError(error, "CONTENT_EVENT_FAILED", { recoverable: true });
    const tabId = resolveTabIdFromSender(sender);
    if (tabId !== null) {
      setLastError(tabId, normalized);
      pushLog(tabId, "error", "Failed to process a content event.", normalized.message);
      commit({ kind: "error", error: normalized });
    }
  });
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void syncActiveTab(tabId);
});
chrome.tabs.onCreated.addListener((tab) => {
  if (typeof tab.id !== "number") {
    return;
  }
  updateTabContextFromChromeTab(tab, { markActive: false, logChanges: false });
  commit();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const tabState = getTabState(tabId);
  const urlChanged = typeof changeInfo.url === "string" && changeInfo.url !== tabState.url;
  const titleChanged = typeof changeInfo.title === "string" && changeInfo.title !== tabState.title;
  const loadingChanged = typeof changeInfo.status === "string";
  if (changeInfo.url || changeInfo.title || changeInfo.status) {
    updateTabContextFromChromeTab(tab);
  }
  if (urlChanged) {
    markContentReady(tabId, false);
    markSnapshotFresh(tabId, false);
  }
  if (loadingChanged && changeInfo.status === "loading") {
    markContentReady(tabId, false);
  }
  if (titleChanged) {
    replaceTabState(tabId, (current) => ({
      ...current,
      title: changeInfo.title ?? current.title,
      lastSeenAt: nowIso()
    }));
  }
  if (tab.active) {
    setActiveTab(tabId);
  }
  updateDerivedState();
  updateBadge();
  schedulePersistState();
  broadcastState();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  delete state.tabs[tabId];
  const wasActive = state.activeTabId === tabId;
  if (wasActive) {
    state.activeTabId = null;
  }
  commit();
  if (wasActive) {
    void refreshKnownTabs();
  }
});
chrome.runtime.onInstalled.addListener(() => {
  void persistState();
  void refreshKnownTabs();
  void refreshBridgeStatus();
  void refreshSemanticStatus();
  updateBadge();
});
chrome.runtime.onStartup.addListener(() => {
  void refreshKnownTabs();
});
chrome.action.setBadgeText({ text: "" }).catch(() => void 0);
//# sourceMappingURL=background.js.map
