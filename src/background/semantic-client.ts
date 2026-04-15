import {
  DEFAULT_SEMANTIC_ENDPOINT,
  SEMANTIC_OBSERVE_REQUEST_TIMEOUT_MS,
  SEMANTIC_STATUS_REQUEST_TIMEOUT_MS,
} from "../shared/constants";
import {
  buildSemanticState,
  normalizeSemanticHealth,
  normalizeSemanticObservation,
  semanticInstructionFromSnapshot,
} from "../shared/semantic";
import { normalizeError, nowIso } from "../shared/logger";
import type {
  PageSnapshot,
  SemanticHealthSnapshot,
  SemanticObservationSnapshot,
  SemanticState,
} from "../shared/types";

async function fetchJson<T>(url: string, timeoutMs: number, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw new Error(`Request to ${url} failed with HTTP ${response.status}.`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function probeSemanticBridge(endpoint: string): Promise<SemanticHealthSnapshot> {
  try {
    const response = await fetchJson<Record<string, unknown>>(`${endpoint}/health`, SEMANTIC_STATUS_REQUEST_TIMEOUT_MS);
    return normalizeSemanticHealth(response, endpoint);
  } catch (error) {
    return {
      endpoint,
      browserEndpoint: "",
      status: "error",
      model: null,
      reason: normalizeError(error, "SEMANTIC_BRIDGE_UNAVAILABLE", { recoverable: true }).message,
      observedAt: nowIso(),
      lastError: normalizeError(error, "SEMANTIC_BRIDGE_UNAVAILABLE", { recoverable: true }),
    };
  }
}

export async function refreshSemanticState(endpoint = DEFAULT_SEMANTIC_ENDPOINT): Promise<SemanticState> {
  const health = await probeSemanticBridge(endpoint);
  return buildSemanticState(health);
}

export async function requestSemanticObservation(
  snapshot: PageSnapshot,
  endpoint = DEFAULT_SEMANTIC_ENDPOINT,
): Promise<SemanticObservationSnapshot> {
  const instruction = semanticInstructionFromSnapshot(snapshot);
  const payload = {
    instruction,
    pageUrl: snapshot.url,
    pageTitle: snapshot.title,
    snapshotSummary: snapshot.summary,
    limit: 5,
  };

  try {
    const response = await fetchJson<Record<string, unknown>>(`${endpoint}/observe`, SEMANTIC_OBSERVE_REQUEST_TIMEOUT_MS, {
      method: "POST",
      body: JSON.stringify(payload),
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
        actions: [],
      },
      endpoint,
    );
  }
}

