import { DEFAULT_SEMANTIC_ENDPOINT } from "./constants";
import { classifyDanger } from "./action-policy";
import { normalizeError, nowIso } from "./logger";
import { attachTabContextToAction, attachTabContextToRequest, buildTabContextFromSnapshot } from "./tab-context";
import type {
  AppError,
  PageSnapshot,
  SemanticConnectionState,
  SemanticHealthSnapshot,
  SemanticObservationAction,
  SemanticObservationSnapshot,
  SemanticState,
  SuggestedAction,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toNumberOrDefault(value: unknown, fallback: number): number {
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

export interface ResolvedSemanticTarget {
  elementId: string;
  label: string;
}

export function createDisabledSemanticState(endpoint = DEFAULT_SEMANTIC_ENDPOINT, disabledReason: string | null = null): SemanticState {
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
    lastError: null,
  };
}

export function semanticStatusTone(status: SemanticConnectionState): "neutral" | "warning" | "success" | "danger" {
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

export function semanticStatusLabel(status: SemanticConnectionState): string {
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

export function buildSemanticState(snapshot: SemanticHealthSnapshot): SemanticState {
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
    lastError: snapshot.lastError,
  };
}

export function updateSemanticStateWithObservation(
  state: SemanticState,
  observation: SemanticObservationSnapshot,
): SemanticState {
  return {
    ...state,
    endpoint: observation.endpoint,
    browserEndpoint: observation.browserEndpoint,
    status: observation.status,
    model: observation.model,
    observedAt: observation.observedAt,
    pageUrl: observation.pageUrl,
    pageTitle: observation.pageTitle,
    suggestionCount: observation.actions.length,
    disabledReason: observation.status === "disabled" ? observation.reason : state.disabledReason,
    lastError: observation.status === "error"
      ? normalizeError(observation.reason || "Stagehand reported an error.", "SEMANTIC_BRIDGE_ERROR", { recoverable: true })
      : state.lastError,
  };
}

export function summarizeSemanticState(state: SemanticState): string {
  if (state.status === "ready") {
    const model = state.model ?? "configured model";
    const page = state.pageTitle || state.pageUrl || "the active page";
    const count = state.suggestionCount;
    return `Stagehand semantic bridge is ready with ${model}. Last observation covered ${page} and produced ${count} suggestion${count === 1 ? "" : "s"}.`;
  }

  if (state.status === "disabled") {
    return state.disabledReason
      ? `Stagehand semantic bridge is disabled: ${state.disabledReason}`
      : "Stagehand semantic bridge is disabled until a model is configured.";
  }

  if (state.status === "error") {
    return state.lastError?.message ?? "Stagehand semantic bridge reported an error.";
  }

  return `No Stagehand semantic bridge detected at ${state.endpoint}. Run \`npm run semantic\` to start one.`;
}

export function semanticInstructionFromSnapshot(snapshot: PageSnapshot): string {
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
    `Page summary: ${pageSummary}.`,
  ].join(" ");
}

function normalizeMethod(method: string | undefined): string {
  return method?.trim().toLowerCase() ?? "";
}

function isClickLikeAction(action: SemanticObservationAction): boolean {
  const method = normalizeMethod(action.method);
  return method === "click" || method === "press" || method === "tap" || method === "open";
}

export async function buildSemanticSuggestions(
  observation: SemanticObservationSnapshot,
  snapshot: PageSnapshot,
  resolveTarget: (selector: string) => Promise<ResolvedSemanticTarget | null>,
): Promise<SuggestedAction[]> {
  const suggestions: SuggestedAction[] = [];

  for (const [index, action] of observation.actions.entries()) {
    if (!isClickLikeAction(action)) {
      continue;
    }

    const selector = toStringOrNull(action.selector);
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
      kind: "click" as const,
      elementId: resolved.elementId,
      label: resolved.label || action.description || selector,
      selector,
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
      confidence: undefined,
    });
  }

  return suggestions;
}

export function normalizeSemanticHealth(value: unknown, fallbackEndpoint = DEFAULT_SEMANTIC_ENDPOINT): SemanticHealthSnapshot {
  if (!isRecord(value)) {
    return {
      endpoint: fallbackEndpoint,
      browserEndpoint: "",
      status: "disconnected",
      model: null,
      reason: "Invalid semantic bridge response.",
      observedAt: null,
      lastError: null,
    };
  }

  const status = toStringOrNull(value.status);
  const browserEndpoint = toStringOrNull(value.browserEndpoint) ?? "";
  const observedAt = toStringOrNull(value.observedAt);
  const lastError = isRecord(value.lastError)
    ? normalizeError(value.lastError, "SEMANTIC_BRIDGE_ERROR", { recoverable: true })
    : null;

  return {
    endpoint: toStringOrNull(value.endpoint) ?? fallbackEndpoint,
    browserEndpoint,
    status: status === "ready" || status === "disabled" || status === "error" ? status : "disconnected",
    model: toStringOrNull(value.model),
    reason: toStringOrNull(value.reason),
    observedAt,
    lastError,
  };
}

export function normalizeSemanticObservation(value: unknown, fallbackEndpoint = DEFAULT_SEMANTIC_ENDPOINT): SemanticObservationSnapshot {
  if (!isRecord(value)) {
    return {
      endpoint: fallbackEndpoint,
      browserEndpoint: "",
      status: "disconnected",
      model: null,
      pageUrl: null,
      pageTitle: null,
      reason: "Invalid semantic observation response.",
      observedAt: nowIso(),
      actions: [],
    };
  }

  const actions = Array.isArray(value.actions)
    ? value.actions
        .filter(isRecord)
        .map((entry) => ({
          selector: toStringOrNull(entry.selector) ?? "",
          description: toStringOrNull(entry.description) ?? "",
          method: toStringOrNull(entry.method) ?? undefined,
          arguments: Array.isArray(entry.arguments) ? entry.arguments.map((argument) => toStringOrNull(argument) ?? String(argument ?? "")).filter(Boolean) : undefined,
        }))
        .filter((entry) => Boolean(entry.selector && entry.description))
    : [];

  const status = toStringOrNull(value.status);
  return {
    endpoint: toStringOrNull(value.endpoint) ?? fallbackEndpoint,
    browserEndpoint: toStringOrNull(value.browserEndpoint) ?? "",
    status: status === "ready" || status === "disabled" || status === "error" ? status : "disconnected",
    model: toStringOrNull(value.model),
    pageUrl: toStringOrNull(value.pageUrl),
    pageTitle: toStringOrNull(value.pageTitle),
    reason: toStringOrNull(value.reason),
    observedAt: toStringOrNull(value.observedAt) ?? nowIso(),
    actions,
  };
}
