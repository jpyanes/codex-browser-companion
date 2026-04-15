import type {
  ActionRequest,
  ActionResult,
  AppError,
  ApprovalRequest,
  ExtensionState,
  PageSnapshot,
  PageStateBasic,
  ScanMode,
  SuggestedRequest,
} from "./types";

type MessageKind =
  | "get-state"
  | "scan-page"
  | "list-interactive-elements"
  | "summarize-page"
  | "suggest-next-actions"
  | "request-action"
  | "approve-action"
  | "reject-action"
  | "open-sidepanel"
  | "clear-log"
  | "ping"
  | "capture-page"
  | "perform-action"
  | "page-state"
  | "page-snapshot"
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
}

export interface UiListInteractiveRequest extends MessageEnvelopeBase {
  kind: "list-interactive-elements";
}

export interface UiSummarizePageRequest extends MessageEnvelopeBase {
  kind: "summarize-page";
}

export interface UiSuggestNextActionsRequest extends MessageEnvelopeBase {
  kind: "suggest-next-actions";
}

export interface UiRequestActionRequest extends MessageEnvelopeBase {
  kind: "request-action";
  action: ActionRequest;
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
  | UiApproveActionRequest
  | UiRejectActionRequest
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

export interface ContentPerformActionRequest extends MessageEnvelopeBase {
  kind: "perform-action";
  action: ActionRequest;
}

export type ContentRequest =
  | ContentPingRequest
  | ContentCapturePageRequest
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
  | ContentActionResultEvent
  | ContentErrorEvent
  | ContentPongEvent;

export type ContentEvent =
  | ContentPageStateEvent
  | ContentResponseEvent
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
