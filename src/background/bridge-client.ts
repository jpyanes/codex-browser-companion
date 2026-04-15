import {
  BRIDGE_REQUEST_TIMEOUT_MS,
  DEFAULT_BRIDGE_ENDPOINT,
} from "../shared/constants";
import {
  buildBridgeState,
  createDisconnectedBridgeState,
  normalizeBridgeExtensionSummary,
} from "../shared/bridge";
import { normalizeError, nowIso } from "../shared/logger";
import type { BridgeSnapshot, BridgeState } from "../shared/types";

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request to ${url} failed with HTTP ${response.status}.`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function probeExtensions(endpoint: string): Promise<BridgeSnapshot> {
  const [versionResponse, extensionsResponse, fallbackResponse] = await Promise.all([
    fetchJson<{ version?: unknown }>(`${endpoint}/version`, BRIDGE_REQUEST_TIMEOUT_MS).catch(() => null),
    fetchJson<{ extensions?: unknown }>(`${endpoint}/extensions/status`, BRIDGE_REQUEST_TIMEOUT_MS).catch(() => null),
    fetchJson<Record<string, unknown>>(`${endpoint}/extension/status`, BRIDGE_REQUEST_TIMEOUT_MS).catch(() => null),
  ]);

  const relayVersion = typeof versionResponse?.version === "string" ? versionResponse.version : null;
  const extensions = Array.isArray(extensionsResponse?.extensions)
    ? extensionsResponse.extensions
        .map((entry, index) => normalizeBridgeExtensionSummary(entry, `extension-${index + 1}`))
        .filter((entry): entry is NonNullable<ReturnType<typeof normalizeBridgeExtensionSummary>> => entry !== null)
    : [];

  if (extensions.length === 0 && fallbackResponse && typeof fallbackResponse.connected === "boolean" && fallbackResponse.connected) {
    const fallbackExtension = normalizeBridgeExtensionSummary(
      {
        extensionId: "default",
        browser: fallbackResponse.browser,
        profile: fallbackResponse.profile,
        activeTargets: fallbackResponse.activeTargets,
        playwriterVersion: fallbackResponse.playwriterVersion,
      },
      "default",
    );

    if (fallbackExtension) {
      extensions.push(fallbackExtension);
    }
  }

  return {
    relayVersion,
    extensions,
    checkedAt: nowIso(),
  };
}

export async function refreshBridgeState(endpoint = DEFAULT_BRIDGE_ENDPOINT): Promise<BridgeState> {
  try {
    const snapshot = await probeExtensions(endpoint);
    return buildBridgeState(snapshot, { endpoint });
  } catch (error) {
    return createDisconnectedBridgeState(
      endpoint,
      normalizeError(error, "BRIDGE_UNAVAILABLE", { recoverable: true }),
      nowIso(),
    );
  }
}
