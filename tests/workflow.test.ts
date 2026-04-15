import { JSDOM } from "jsdom";
import { capturePageSnapshot } from "../src/shared/dom";
import {
  buildWorkflowPlanFromInstruction,
  buildWorkflowSuggestions,
  createInitialWorkflowState,
  getActiveWorkflowNextStep,
  markWorkflowRequestCompleted,
  recordWorkflowPlan,
  summarizeWorkflowState,
  workflowProgress,
} from "../src/shared/workflow";

function makeDocument(html: string, url = "https://example.com/"): Document {
  const dom = new JSDOM(html, { url });
  return dom.window.document;
}

describe("workflow planner and memory", () => {
  const document = makeDocument(`
    <!doctype html>
    <html>
      <head><title>Workflow Page</title></head>
      <body>
        <main>
          <button>Save changes</button>
          <p>Some ordinary page content for workflow planning.</p>
        </main>
      </body>
    </html>
  `);

  const snapshot = capturePageSnapshot(document, { mode: "full", navigationMode: "document" }).snapshot;

  it("turns a compound instruction into a multi-step workflow", () => {
    const preview = buildWorkflowPlanFromInstruction("click save changes and then summarize page", snapshot, null);

    expect(preview).not.toBeNull();
    expect(preview?.workflow.steps).toHaveLength(2);
    expect(preview?.blockedStepCount).toBe(0);
    expect(preview?.primaryRequest?.kind).toBe("request-action");

    if (preview?.primaryRequest?.kind === "request-action") {
      expect(preview.primaryRequest.action.kind).toBe("click");
      expect(preview.primaryRequest.action.workflowId).toBe(preview.workflow.workflowId);
      expect(preview.primaryRequest.action.workflowStepId).toBe(preview.workflow.steps[0]?.stepId);
    }

    expect(preview?.workflow.steps[1]?.request?.kind).toBe("scan-page");
    if (preview?.workflow.steps[1]?.request?.kind === "scan-page") {
      expect(preview.workflow.steps[1].request.mode).toBe("summary");
    }
  });

  it("marks unsupported clauses as blocked instead of inventing unsafe actions", () => {
    const preview = buildWorkflowPlanFromInstruction("click save changes and then do something impossible", snapshot, null);

    expect(preview).not.toBeNull();
    expect(preview?.workflow.steps).toHaveLength(2);
    expect(preview?.blockedStepCount).toBe(1);
    expect(preview?.workflow.steps[1]?.status).toBe("blocked");
    expect(preview?.workflow.steps[1]?.request).toBeNull();
  });

  it("stores workflow memory and advances to the next step after completion", () => {
    const preview = buildWorkflowPlanFromInstruction("click save changes and then summarize page", snapshot, null);
    expect(preview).not.toBeNull();
    if (!preview) {
      throw new Error("Expected a workflow preview");
    }

    let state = recordWorkflowPlan(createInitialWorkflowState(), preview.workflow, snapshot);
    expect(summarizeWorkflowState(state)).toContain(preview.workflow.objective);
    expect(workflowProgress(state)).toEqual({ completed: 0, total: 2, blocked: 0 });

    const workflowStepId = preview.workflow.steps[0]?.stepId;
    if (!workflowStepId) {
      throw new Error("Expected the first workflow step to have an id");
    }

    state = markWorkflowRequestCompleted(
      state,
      {
        workflowId: preview.workflow.workflowId,
        workflowStepId,
      },
      "Clicked Save changes.",
    );

    expect(state.activeWorkflow?.currentStepIndex).toBe(1);
    expect(state.activeWorkflow?.steps[0]?.status).toBe("completed");
    expect(getActiveWorkflowNextStep(state)?.request?.kind).toBe("scan-page");

    const movedSnapshot = {
      ...snapshot,
      snapshotId: "workflow-snapshot-2",
      url: "https://example.com/other-page",
      title: "Workflow Page - Updated",
    };
    const suggestions = buildWorkflowSuggestions(state, movedSnapshot);
    expect(suggestions.some((item) => item.source === "workflow" && item.id.startsWith("workflow-rescan-"))).toBe(true);
    expect(suggestions.some((item) => item.source === "workflow" && item.request.kind === "scan-page")).toBe(true);
  });
});
