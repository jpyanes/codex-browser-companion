import { DEFAULT_BRIDGE_ENDPOINT } from "./constants";
import type {
  AppError,
  BridgeConnectionState,
  BridgeExtensionSummary,
  BridgeSnapshot,
  BridgeState,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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

function normalizeProfile(value: unknown): BridgeExtensionSummary["profile"] {
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

export function normalizeBridgeExtensionSummary(value: unknown, fallbackExtensionId = "default"): BridgeExtensionSummary | null {
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
    stableKey: toStringOrNull(value.stableKey) ?? undefined,
    browser,
    profile,
    activeTargets,
    playwriterVersion,
  };
}

export function bridgeStatusTone(status: BridgeConnectionState): "neutral" | "warning" | "success" | "danger" {
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

export function bridgeStatusLabel(status: BridgeConnectionState): string {
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

export function createDisconnectedBridgeState(
  endpoint = DEFAULT_BRIDGE_ENDPOINT,
  error: AppError | null = null,
  checkedAt: string | null = null,
): BridgeState {
  return {
    endpoint,
    status: error ? "error" : "disconnected",
    relayVersion: null,
    extensions: [],
    activeExtension: null,
    activeTargetCount: 0,
    checkedAt,
    lastError: error,
  };
}

export function buildBridgeState(
  snapshot: BridgeSnapshot,
  options: { endpoint?: string; lastError?: AppError | null } = {},
): BridgeState {
  const endpoint = options.endpoint ?? DEFAULT_BRIDGE_ENDPOINT;
  const extensions = snapshot.extensions.slice();
  const activeExtension = extensions.find((extension) => extension.activeTargets > 0) ?? extensions[0] ?? null;
  const activeTargetCount = extensions.reduce((count, extension) => count + extension.activeTargets, 0);
  const status: BridgeConnectionState = options.lastError
    ? "error"
    : extensions.length > 0
      ? "connected"
      : snapshot.relayVersion
        ? "connecting"
        : "disconnected";

  return {
    endpoint,
    status,
    relayVersion: snapshot.relayVersion,
    extensions,
    activeExtension,
    activeTargetCount,
    checkedAt: snapshot.checkedAt,
    lastError: options.lastError ?? null,
  };
}

export function summarizeBridgeState(state: BridgeState): string {
  if (state.status === "connected" && state.activeExtension) {
    const profile = state.activeExtension.profile?.email ?? state.activeExtension.browser ?? "your Chrome session";
    return `Connected to ${profile} with ${state.activeTargetCount} active target${state.activeTargetCount === 1 ? "" : "s"}.`;
  }

  if (state.status === "connecting") {
    return state.relayVersion
      ? `Playwriter relay ${state.relayVersion} is up, waiting for a Chrome tab to connect.`
      : `Waiting for the local Playwriter bridge at ${state.endpoint}.`;
  }

  if (state.status === "error") {
    return state.lastError?.message ?? `The bridge at ${state.endpoint} reported an error.`;
  }

  return `No Playwriter bridge detected at ${state.endpoint}. Run \`npm run bridge\` to start one.`;
}
