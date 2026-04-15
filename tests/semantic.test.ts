import { describe, expect, it } from "vitest";
import { buildSemanticState, buildSemanticSuggestions, createDisabledSemanticState, semanticInstructionFromSnapshot, summarizeSemanticState } from "../src/shared/semantic";
import type { PageSnapshot, SemanticHealthSnapshot } from "../src/shared/types";

describe("semantic bridge helpers", () => {
  it("creates a disconnected semantic state by default", () => {
    const state = createDisabledSemanticState("http://localhost:19989");

    expect(state.endpoint).toBe("http://localhost:19989");
    expect(state.status).toBe("disconnected");
  });

  it("builds a ready semantic state from health data", () => {
    const health: SemanticHealthSnapshot = {
      endpoint: "http://localhost:19989",
      browserEndpoint: "http://localhost:19988",
      status: "ready",
      model: "openai/gpt-4.1-mini",
      reason: null,
      observedAt: "2026-04-14T22:11:21.000Z",
      lastError: null,
    };

    const state = buildSemanticState(health);

    expect(state.status).toBe("ready");
    expect(summarizeSemanticState(state)).toContain("openai/gpt-4.1-mini");
  });

  it("turns click-like Stagehand observations into resolved semantic suggestions", async () => {
    const snapshot = {
      snapshotId: "snapshot-1",
      tabId: 42,
      url: "https://example.com",
      title: "Example",
      pageKind: "mixed",
      summary: "Example page summary.",
    } as PageSnapshot;

    const suggestions = await buildSemanticSuggestions(
      {
        endpoint: "http://localhost:19989",
        browserEndpoint: "http://localhost:19988",
        status: "ready",
        model: "openai/gpt-4.1-mini",
        pageUrl: snapshot.url,
        pageTitle: snapshot.title,
        reason: null,
        observedAt: "2026-04-14T22:11:21.000Z",
        actions: [
          { selector: "button.primary", description: "Click the primary button", method: "click", arguments: undefined },
          { selector: "input.search", description: "Type into search", method: "type", arguments: ["hello"] },
        ],
      },
      snapshot,
      async (selector) =>
        selector === "button.primary"
          ? { elementId: "element-1", label: "Primary button" }
          : null,
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.source).toBe("stagehand");
    expect(suggestions[0]?.selector).toBe("button.primary");
    expect(suggestions[0]?.request.kind).toBe("request-action");
    if (suggestions[0]?.request.kind === "request-action" && "elementId" in suggestions[0].request.action) {
      expect(suggestions[0].request.action.elementId).toBe("element-1");
      expect(suggestions[0].request.action.selector).toBe("button.primary");
    }
  });

  it("builds a semantic instruction from the current snapshot", () => {
    const snapshot = {
      snapshotId: "snapshot-1",
      tabId: 42,
      url: "https://example.com",
      title: "Example",
      pageKind: "form",
      summary: "Fill out the form.",
    } as PageSnapshot;

    const instruction = semanticInstructionFromSnapshot(snapshot);

    expect(instruction).toContain("high-value click actions");
    expect(instruction).toContain("Fill out the form.");
    expect(instruction).toContain("form page");
  });
});
