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
  TabContext,
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
  | "refresh-live-takeover"
  | "toggle-live-takeover"
  | "approve-action"
  | "reject-action"
  | "refresh-bridge"
  | "refresh-semantic"
  | "resume-user-intervention"
  | "open-sidepanel"
  | "clear-log"
  | "ping"
  | "get-live-takeover-context"
  | "set-live-takeover"
  | "live-takeover-state"
  | "live-takeover-context"
  | "capture-page"
  | "click"
  | "fill"
  | "press"
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
  tabContext?: TabContext;
  workflowId?: string;
  workflowStepId?: string;
}

export interface UiListInteractiveRequest extends MessageEnvelopeBase {
  kind: "list-interactive-elements";
  tabContext?: TabContext;
  workflowId?: string;
  workflowStepId?: string;
}

export interface UiSummarizePageRequest extends MessageEnvelopeBase {
  kind: "summarize-page";
  tabContext?: TabContext;
  workflowId?: string;
  workflowStepId?: string;
}

export interface UiSuggestNextActionsRequest extends MessageEnvelopeBase {
  kind: "suggest-next-actions";
  tabContext?: TabContext;
  workflowId?: string;
  workflowStepId?: string;
}

export interface UiRequestActionRequest extends MessageEnvelopeBase {
  kind: "request-action";
  action: ActionRequest;
  tabContext?: TabContext;
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

export interface UiRefreshLiveTakeoverRequest extends MessageEnvelopeBase {
  kind: "refresh-live-takeover";
}

export interface UiToggleLiveTakeoverRequest extends MessageEnvelopeBase {
  kind: "toggle-live-takeover";
}

export interface UiResumeUserInterventionRequest extends MessageEnvelopeBase {
  kind: "resume-user-intervention";
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
  | UiRefreshLiveTakeoverRequest
  | UiToggleLiveTakeoverRequest
  | UiResumeUserInterventionRequest
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

export interface ContentLiveTakeoverContextRequest extends MessageEnvelopeBase {
  kind: "get-live-takeover-context";
}

export interface ContentSetLiveTakeoverRequest extends MessageEnvelopeBase {
  kind: "set-live-takeover";
  enabled: boolean;
  endpoint: string;
  tabId: number;
  windowId: number | null;
}

export interface ContentCapturePageRequest extends MessageEnvelopeBase {
  kind: "capture-page";
  mode: ScanMode;
}

export interface ContentTargetPayload {
  selector?: string;
  bridgeId?: string;
  label?: string;
}

export interface ContentClickRequest extends MessageEnvelopeBase {
  kind: "click";
  tabId: number;
  payload: ContentTargetPayload;
}

export interface ContentFillRequest extends MessageEnvelopeBase {
  kind: "fill";
  tabId: number;
  payload: ContentTargetPayload & {
    value: string;
    clearBeforeTyping?: boolean;
  };
}

export interface ContentPressRequest extends MessageEnvelopeBase {
  kind: "press";
  tabId: number;
  payload: ContentTargetPayload & {
    key?: string;
    submitForm?: boolean;
  };
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
  | ContentLiveTakeoverContextRequest
  | ContentSetLiveTakeoverRequest
  | ContentCapturePageRequest
  | ContentClickRequest
  | ContentFillRequest
  | ContentPressRequest
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

export interface ContentLiveTakeoverContextResponse extends MessageEnvelopeBase {
  kind: "live-takeover-context";
  enabled: boolean;
  shouldStart: boolean;
  endpoint: string;
  tabId: number | null;
  windowId: number | null;
  lastHeartbeat: string | null;
}

export interface ContentLiveTakeoverStateEvent extends MessageEnvelopeBase {
  kind: "live-takeover-state";
  enabled: boolean;
  endpoint: string;
  tabId: number;
  windowId: number | null;
  lastHeartbeat: string | null;
}

export type ContentResponse =
  | ContentLiveTakeoverContextResponse
  | ContentLiveTakeoverStateEvent
  | ContentResponseEvent
  | ContentResolveSelectorResponse
  | ContentActionResultEvent
  | ContentErrorEvent
  | ContentPongEvent;

export type ContentEvent =
  | ContentPageStateEvent
  | ContentLiveTakeoverStateEvent
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
