import {
  bridgeStatusLabel,
  bridgeStatusTone,
  buildBridgeState,
  createDisconnectedBridgeState,
  normalizeBridgeExtensionSummary,
  summarizeBridgeState,
} from "../src/shared/bridge";

describe("bridge state", () => {
  it("normalizes connected Playwriter extension data", () => {
    const extension = normalizeBridgeExtensionSummary({
      extensionId: "default",
      browser: "Chrome 136",
      profile: { email: "yanes@example.com", id: "profile-1" },
      activeTargets: 2,
      playwriterVersion: "0.0.105",
    });

    expect(extension).not.toBeNull();
    expect(extension?.profile?.email).toBe("yanes@example.com");
    expect(extension?.activeTargets).toBe(2);
  });

  it("builds a connected bridge snapshot from extension data", () => {
    const state = buildBridgeState({
      relayVersion: "0.0.105",
      checkedAt: "2026-04-14T22:11:21.000Z",
      extensions: [
        {
          extensionId: "default",
          stableKey: undefined,
          browser: "Chrome 136",
          profile: { email: "yanes@example.com", id: "profile-1" },
          activeTargets: 1,
          playwriterVersion: "0.0.105",
        },
      ],
    });

    expect(state.status).toBe("connected");
    expect(state.activeTargetCount).toBe(1);
    expect(bridgeStatusLabel(state.status)).toBe("Connected");
    expect(bridgeStatusTone(state.status)).toBe("success");
    expect(summarizeBridgeState(state)).toContain("Connected to yanes@example.com");
  });

  it("marks the bridge as connecting when the relay is up but no tabs are attached", () => {
    const state = buildBridgeState({
      relayVersion: "0.0.105",
      checkedAt: "2026-04-14T22:11:21.000Z",
      extensions: [],
    });

    expect(state.status).toBe("connecting");
    expect(summarizeBridgeState(state)).toContain("waiting for a Chrome tab");
  });

  it("creates an error state when the bridge cannot be reached", () => {
    const state = createDisconnectedBridgeState("http://127.0.0.1:19988", {
      code: "BRIDGE_UNAVAILABLE",
      message: "Bridge offline",
      details: undefined,
      recoverable: true,
      tabId: undefined,
      occurredAt: "2026-04-14T22:11:21.000Z",
    });

    expect(state.status).toBe("error");
    expect(bridgeStatusLabel(state.status)).toBe("Error");
    expect(bridgeStatusTone(state.status)).toBe("danger");
    expect(summarizeBridgeState(state)).toContain("Bridge offline");
  });
});
