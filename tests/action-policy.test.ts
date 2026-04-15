import { JSDOM } from "jsdom";
import { buildApprovalRequest, canAutoExecute, classifyDanger, isBlockedSensitiveAction, requiresApproval } from "../src/shared/action-policy";
import { capturePageSnapshot } from "../src/shared/dom";
import type { ActionRequest } from "../src/shared/types";

function makeDocument(html: string, url = "https://example.com/"): Document {
  const dom = new JSDOM(html, { url });
  return dom.window.document;
}

function action(kind: ActionRequest["kind"], extras: Partial<ActionRequest> = {}): ActionRequest {
  const base = {
    actionId: "action-1",
    tabId: 1,
    kind,
  } as ActionRequest;

  return Object.assign(base, extras) as ActionRequest;
}

describe("action policy", () => {
  it("requires approval for DOM mutating actions only", () => {
    expect(requiresApproval(action("click", { elementId: "button-1" } as Partial<ActionRequest>))).toBe(true);
    expect(requiresApproval(action("type", { elementId: "input-1", text: "hello" } as Partial<ActionRequest>))).toBe(true);
    expect(requiresApproval(action("select", { elementId: "select-1", selection: { by: "label", value: "One" } } as Partial<ActionRequest>))).toBe(true);
    expect(requiresApproval(action("submit-form", { elementId: "form-1" } as Partial<ActionRequest>))).toBe(true);
    expect(requiresApproval(action("scroll", { direction: "down", amount: 400 } as Partial<ActionRequest>))).toBe(false);
    expect(requiresApproval(action("navigate-back"))).toBe(false);
    expect(requiresApproval(action("refresh"))).toBe(false);
  });

  it("classifies dangerous click actions", () => {
    const result = classifyDanger(action("click", { elementId: "delete", label: "Delete account" } as Partial<ActionRequest>), null);
    expect(result).toBe("high");
  });

  it("blocks typing and form submission on login pages", () => {
    const document = makeDocument(`
      <!doctype html>
      <html>
        <head><title>Sign in</title></head>
        <body>
          <form aria-label="Sign in">
            <label for="password">Password</label>
            <input id="password" type="password" />
            <button type="submit">Sign in</button>
          </form>
        </body>
      </html>
    `);

    const snapshot = capturePageSnapshot(document, { mode: "full", navigationMode: "document" }).snapshot;
    const typeAction = action("type", { elementId: "password", text: "secret" } as Partial<ActionRequest>);
    const submitAction = action("submit-form", { elementId: "form-1" } as Partial<ActionRequest>);

    expect(isBlockedSensitiveAction(typeAction, snapshot)).toBe(true);
    expect(isBlockedSensitiveAction(submitAction, snapshot)).toBe(true);
  });

  it("builds an approval request with a danger label", () => {
    const request = buildApprovalRequest(
      action("click", { elementId: "save-button", label: "Save changes" } as Partial<ActionRequest>),
      3,
      null,
    );

    expect(request.status).toBe("pending");
    expect(request.tabId).toBe(3);
    expect(request.title).toContain("Click");
    expect(request.targetElementId).toBe("save-button");
    expect(request.dangerLevel).toBe("medium");
  });

  it("auto executes only reversible actions", () => {
    expect(canAutoExecute(action("scroll", { direction: "down", amount: 400 } as Partial<ActionRequest>))).toBe(true);
    expect(canAutoExecute(action("refresh"))).toBe(true);
    expect(canAutoExecute(action("click", { elementId: "save" } as Partial<ActionRequest>))).toBe(false);
  });
});
