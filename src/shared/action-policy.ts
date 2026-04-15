import { DEFAULT_SCROLL_AMOUNT } from "./constants";
import type {
  ActionRequest,
  ApprovalRequest,
  DangerLevel,
  InteractiveElementSummary,
  PageSnapshot,
  SuggestedRequest,
} from "./types";
import { nowIso } from "./logger";

const DANGEROUS_KEYWORDS = [
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
  "publish",
];

export function requiresApproval(action: ActionRequest): boolean {
  return action.kind === "click" || action.kind === "type" || action.kind === "select" || action.kind === "submit-form";
}

export function isLikelySensitiveSnapshot(snapshot: PageSnapshot | null): boolean {
  return Boolean(snapshot?.meta.hasSensitiveInputs || snapshot?.pageKind === "login" || snapshot?.pageKind === "payment");
}

export function requiresManualIntervention(snapshot: PageSnapshot | null): boolean {
  return Boolean(snapshot && (snapshot.pageKind === "login" || snapshot.pageKind === "payment"));
}

export function isSensitiveInteractiveElement(element: InteractiveElementSummary): boolean {
  return element.isSensitive || element.disabled || element.type === "password" || element.type === "file";
}

export function canAutoExecute(action: ActionRequest): boolean {
  return action.kind === "scroll" || action.kind === "navigate-back" || action.kind === "navigate-forward" || action.kind === "refresh";
}

export function classifyDanger(action: ActionRequest, snapshot: PageSnapshot | null): DangerLevel {
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

export function describeAction(action: ActionRequest, snapshot: PageSnapshot | null): { title: string; description: string } {
  const pageName = snapshot?.title || "current page";

  switch (action.kind) {
    case "click":
      return {
        title: `Click ${action.label || action.elementId}`,
        description: `Trigger a click on ${action.label || "the selected element"} on ${pageName}.`,
      };
    case "type":
      return {
        title: `Type into ${action.elementId}`,
        description: `Insert the provided text into the selected field on ${pageName}. Passwords and other sensitive fields are blocked.`,
      };
    case "select":
      return {
        title: `Choose an option in ${action.elementId}`,
        description: `Select an option in the target dropdown on ${pageName}.`,
      };
    case "scroll":
      return {
        title: `Scroll ${action.direction}`,
        description: `Move the viewport ${action.direction} by ${action.amount || DEFAULT_SCROLL_AMOUNT}px on ${pageName}.`,
      };
    case "navigate-back":
      return {
        title: "Navigate back",
        description: `Go back to the previous page in this tab from ${pageName}.`,
      };
    case "navigate-forward":
      return {
        title: "Navigate forward",
        description: `Go forward to the next page in this tab from ${pageName}.`,
      };
    case "refresh":
      return {
        title: "Refresh page",
        description: `Reload ${pageName} in the active tab.`,
      };
    case "submit-form":
      return {
        title: `Submit ${action.label || action.elementId}`,
        description: `Submit the selected form on ${pageName}. This is the most sensitive browser action in v1 and requires explicit approval.`,
      };
  }
}

export function buildApprovalRequest(action: ActionRequest, tabId: number, snapshot: PageSnapshot | null): ApprovalRequest {
  const description = describeAction(action, snapshot);
  const targetLabel =
    action.kind === "click"
      ? action.label
      : action.kind === "type" || action.kind === "select" || action.kind === "submit-form"
        ? action.elementId
        : undefined;

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
    targetElementId: "elementId" in action ? action.elementId : undefined,
    rejectionReason: undefined,
  };
}

export function actionToSuggestedRequest(action: ActionRequest): SuggestedRequest {
  return { kind: "request-action", action };
}

export function isBlockedSensitiveAction(action: ActionRequest, snapshot: PageSnapshot | null): boolean {
  if (action.kind === "type" && isLikelySensitiveSnapshot(snapshot)) {
    return true;
  }

  if (action.kind === "submit-form" && isLikelySensitiveSnapshot(snapshot)) {
    return true;
  }

  return false;
}
