import type {
  ActionRequest,
  ActionResult,
  AppError,
  ApprovalRequest,
  ExtensionState,
  PageSnapshot,
  PageStateBasic,
  ScanMode,
  WorkflowPlan,
  SuggestedRequest,
} from "./types";

type MessageKind =
  | "get-state"
  | "scan-page"
  | "list-interactive-elements"
  | "summarize-page"
  | "suggest-next-actions"
  | "request-action"
  | "plan-workflow"
  | "refresh-tabs"
  | "focus-tab"
  | "scan-tab"
  | "approve-action"
  | "reject-action"
  | "refresh-bridge"
  | "refresh-semantic"
  | "open-sidepanel"
  | "clear-log"
  | "ping"
  | "capture-page"
  | "resolve-selector"
  | "perform-action"
  | "page-state"
  | "page-snapshot"
  | "resolve-selector-result"
  | "action-result"
  | "content-error"
  | "state"
  | "approval-requested"
  | "approval-updated"
  | "error";

interface MessageEnvelopeBase {
  kind: MessageKind;
}

export interface UiGetStateRequest extends MessageEnvelopeBase {
  kind: "get-state";
}

export interface UiScanPageRequest extends MessageEnvelopeBase {
  kind: "scan-page";
  mode: ScanMode;
  workflowId?: string;
  workflowStepId?: string;
}

export interface UiListInteractiveRequest extends MessageEnvelopeBase {
  kind: "list-interactive-elements";
  workflowId?: string;
  workflowStepId?: string;
}

export interface UiSummarizePageRequest extends MessageEnvelopeBase {
  kind: "summarize-page";
  workflowId?: string;
  workflowStepId?: string;
}

export interface UiSuggestNextActionsRequest extends MessageEnvelopeBase {
  kind: "suggest-next-actions";
  workflowId?: string;
  workflowStepId?: string;
}

export interface UiRequestActionRequest extends MessageEnvelopeBase {
  kind: "request-action";
  action: ActionRequest;
}

export interface UiPlanWorkflowRequest extends MessageEnvelopeBase {
  kind: "plan-workflow";
  workflow: WorkflowPlan;
}

export interface UiRefreshTabsRequest extends MessageEnvelopeBase {
  kind: "refresh-tabs";
}

export interface UiFocusTabRequest extends MessageEnvelopeBase {
  kind: "focus-tab";
  tabId: number;
}

export interface UiScanTabRequest extends MessageEnvelopeBase {
  kind: "scan-tab";
  tabId: number;
  mode: ScanMode;
  workflowId?: string;
  workflowStepId?: string;
}

export interface UiApproveActionRequest extends MessageEnvelopeBase {
  kind: "approve-action";
  approvalId: string;
}

export interface UiRejectActionRequest extends MessageEnvelopeBase {
  kind: "reject-action";
  approvalId: string;
  reason?: string;
}

export interface UiRefreshBridgeRequest extends MessageEnvelopeBase {
  kind: "refresh-bridge";
}

export interface UiRefreshSemanticRequest extends MessageEnvelopeBase {
  kind: "refresh-semantic";
}

export interface UiOpenSidePanelRequest extends MessageEnvelopeBase {
  kind: "open-sidepanel";
}

export interface UiClearLogRequest extends MessageEnvelopeBase {
  kind: "clear-log";
}

export type UiRequest =
  | UiGetStateRequest
  | UiScanPageRequest
  | UiListInteractiveRequest
  | UiSummarizePageRequest
  | UiSuggestNextActionsRequest
  | UiRequestActionRequest
  | UiPlanWorkflowRequest
  | UiRefreshTabsRequest
  | UiFocusTabRequest
  | UiScanTabRequest
  | UiApproveActionRequest
  | UiRejectActionRequest
  | UiRefreshBridgeRequest
  | UiRefreshSemanticRequest
  | UiOpenSidePanelRequest
  | UiClearLogRequest;

export interface UiStateEvent extends MessageEnvelopeBase {
  kind: "state";
  state: ExtensionState;
}

export interface UiApprovalRequestedEvent extends MessageEnvelopeBase {
  kind: "approval-requested";
  approval: ApprovalRequest;
}

export interface UiApprovalUpdatedEvent extends MessageEnvelopeBase {
  kind: "approval-updated";
  approval: ApprovalRequest;
}

export interface UiPageSnapshotEvent extends MessageEnvelopeBase {
  kind: "page-snapshot";
  tabId: number;
  snapshot: PageSnapshot;
}

export interface UiActionResultEvent extends MessageEnvelopeBase {
  kind: "action-result";
  result: ActionResult;
}

export interface UiErrorEvent extends MessageEnvelopeBase {
  kind: "error";
  error: AppError;
}

export type UiEvent =
  | UiStateEvent
  | UiApprovalRequestedEvent
  | UiApprovalUpdatedEvent
  | UiPageSnapshotEvent
  | UiActionResultEvent
  | UiErrorEvent;

export interface ContentPingRequest extends MessageEnvelopeBase {
  kind: "ping";
}

export interface ContentCapturePageRequest extends MessageEnvelopeBase {
  kind: "capture-page";
  mode: ScanMode;
}

export interface ContentResolveSelectorRequest extends MessageEnvelopeBase {
  kind: "resolve-selector";
  selector: string;
}

export interface ContentPerformActionRequest extends MessageEnvelopeBase {
  kind: "perform-action";
  action: ActionRequest;
}

export type ContentRequest =
  | ContentPingRequest
  | ContentCapturePageRequest
  | ContentResolveSelectorRequest
  | ContentPerformActionRequest;

export interface ContentPageStateEvent extends MessageEnvelopeBase {
  kind: "page-state";
  state: PageStateBasic;
  reason: "initial" | "mutation" | "navigation" | "reload";
}

export interface ContentResponseEvent extends MessageEnvelopeBase {
  kind: "page-snapshot";
  snapshot: PageSnapshot;
}

export interface ContentResolveSelectorResponse extends MessageEnvelopeBase {
  kind: "resolve-selector-result";
  selector: string;
  elementId: string | null;
  tagName: string | null;
  label: string | null;
}

export interface ContentActionResultEvent extends MessageEnvelopeBase {
  kind: "action-result";
  result: ActionResult;
}

export interface ContentErrorEvent extends MessageEnvelopeBase {
  kind: "content-error";
  error: AppError;
}

export interface ContentPongEvent extends MessageEnvelopeBase {
  kind: "ping";
  state: PageStateBasic;
}

export type ContentResponse =
  | ContentResponseEvent
  | ContentResolveSelectorResponse
  | ContentActionResultEvent
  | ContentErrorEvent
  | ContentPongEvent;

export type ContentEvent =
  | ContentPageStateEvent
  | ContentResponseEvent
  | ContentResolveSelectorResponse
  | ContentActionResultEvent
  | ContentErrorEvent
  | ContentPongEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isUiRequest(value: unknown): value is UiRequest {
  return isRecord(value) && typeof value.kind === "string";
}

export function isContentRequest(value: unknown): value is ContentRequest {
  return isRecord(value) && typeof value.kind === "string";
}

export function isContentEvent(value: unknown): value is ContentEvent {
  return isRecord(value) && typeof value.kind === "string";
}

export function isSuggestedRequest(value: unknown): value is SuggestedRequest {
  return isRecord(value) && typeof value.kind === "string";
}
