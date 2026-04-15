export type AssistantConnectionState = "idle" | "connected" | "running" | "awaiting-approval" | "error";
export type NavigationMode = "document" | "spa";
export type PageKind = "unknown" | "document" | "mixed" | "article" | "form" | "login" | "spa";
export type ScanMode = "full" | "interactive" | "summary" | "suggestions";
export type LogLevel = "debug" | "info" | "success" | "warning" | "error";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "executing" | "succeeded" | "failed";
export type DangerLevel = "low" | "medium" | "high";

export interface BoxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageStateBasic {
  url: string;
  title: string;
  readyState: DocumentReadyState;
  navigationMode: NavigationMode;
  pageKind: PageKind;
  interactiveCount: number;
  formCount: number;
  visibleTextLength: number;
  hasSensitiveInputs: boolean;
  updatedAt: string;
}

export interface PageMeta {
  navigationMode: NavigationMode;
  readyState: DocumentReadyState;
  interactiveCount: number;
  linkCount: number;
  formCount: number;
  headingCount: number;
  visibleTextLength: number;
  hasSensitiveInputs: boolean;
  isArticleLike: boolean;
  isLoginLike: boolean;
  isSinglePageApp: boolean;
}

export interface HeadingSummary {
  level: number;
  text: string;
  selector: string;
  id: string | undefined;
}

export interface LinkSummary {
  elementId: string;
  text: string;
  href: string;
  external: boolean;
  selector: string;
  rect: BoxRect;
}

export interface FormFieldSummary {
  elementId: string;
  tagName: string;
  type: string | undefined;
  label: string;
  name: string | undefined;
  placeholder: string | undefined;
  required: boolean;
  disabled: boolean;
  isSensitive: boolean;
  selector: string;
}

export interface FormSummary {
  elementId: string;
  label: string;
  selector: string;
  action: string | undefined;
  method: string | undefined;
  fieldCount: number;
  hasPasswordField: boolean;
  hasFileField: boolean;
  fields: FormFieldSummary[];
}

export interface InteractiveElementSummary {
  elementId: string;
  tagName: string;
  role: string;
  text: string;
  label: string;
  type: string | undefined;
  name: string | undefined;
  placeholder: string | undefined;
  href: string | undefined;
  checked: boolean | undefined;
  disabled: boolean;
  selected: boolean | undefined;
  contentEditable: boolean | undefined;
  formAssociated: boolean;
  selector: string;
  rect: BoxRect;
  isSensitive: boolean;
}

export interface SemanticNode {
  kind: "heading" | "landmark" | "section";
  text: string;
  role: string | undefined;
  level: number | undefined;
  selector: string;
  children: SemanticNode[] | undefined;
}

export type ActionKind =
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "navigate-back"
  | "navigate-forward"
  | "refresh"
  | "submit-form";

export interface ActionRequestBase {
  actionId: string;
  tabId: number;
  kind: ActionKind;
}

export interface ClickActionRequest extends ActionRequestBase {
  kind: "click";
  elementId: string;
  label: string | undefined;
}

export interface TypeActionRequest extends ActionRequestBase {
  kind: "type";
  elementId: string;
  text: string;
  clearBeforeTyping: boolean | undefined;
}

export interface SelectActionRequest extends ActionRequestBase {
  kind: "select";
  elementId: string;
  selection: {
    by: "value" | "label" | "index";
    value: string | number;
  };
}

export interface ScrollActionRequest extends ActionRequestBase {
  kind: "scroll";
  direction: "up" | "down" | "left" | "right";
  amount: number;
}

export interface NavigateBackActionRequest extends ActionRequestBase {
  kind: "navigate-back";
}

export interface NavigateForwardActionRequest extends ActionRequestBase {
  kind: "navigate-forward";
}

export interface RefreshActionRequest extends ActionRequestBase {
  kind: "refresh";
}

export interface SubmitFormActionRequest extends ActionRequestBase {
  kind: "submit-form";
  elementId: string;
  label: string | undefined;
}

export type ActionRequest =
  | ClickActionRequest
  | TypeActionRequest
  | SelectActionRequest
  | ScrollActionRequest
  | NavigateBackActionRequest
  | NavigateForwardActionRequest
  | RefreshActionRequest
  | SubmitFormActionRequest;

export type ApprovedActionRequest = ActionRequest & {
  approvalId: string;
  approvedAt: string;
};

export interface ActionResult {
  actionId: string;
  approvalId: string | undefined;
  tabId: number;
  kind: ActionKind;
  success: boolean;
  message: string;
  executedAt: string;
  details: string | undefined;
}

export interface SuggestedRequestScanPage {
  kind: "scan-page";
  mode: ScanMode;
}

export interface SuggestedRequestListInteractive {
  kind: "list-interactive-elements";
}

export interface SuggestedRequestSummarize {
  kind: "summarize-page";
}

export interface SuggestedRequestSuggestNext {
  kind: "suggest-next-actions";
}

export interface SuggestedRequestAction {
  kind: "request-action";
  action: ActionRequest;
}

export type SuggestedRequest =
  | SuggestedRequestScanPage
  | SuggestedRequestListInteractive
  | SuggestedRequestSummarize
  | SuggestedRequestSuggestNext
  | SuggestedRequestAction;

export interface SuggestedAction {
  id: string;
  title: string;
  description: string;
  buttonLabel: string;
  request: SuggestedRequest;
  approvalRequired: boolean;
  dangerLevel: DangerLevel;
}

export interface PageSnapshot {
  snapshotId: string;
  tabId: number;
  url: string;
  title: string;
  captureMode: ScanMode;
  capturedAt: string;
  pageKind: PageKind;
  navigationMode: NavigationMode;
  visibleText: string;
  visibleTextExcerpt: string;
  textLength: number;
  meta: PageMeta;
  headings: HeadingSummary[];
  links: LinkSummary[];
  forms: FormSummary[];
  interactiveElements: InteractiveElementSummary[];
  semanticOutline: SemanticNode[];
  suggestedActions: SuggestedAction[];
  summary: string;
}

export interface ActivityLogEntry {
  id: string;
  tabId: number | null;
  level: LogLevel;
  message: string;
  details: string | undefined;
  timestamp: string;
}

export interface AppError {
  code: string;
  message: string;
  details: string | undefined;
  recoverable: boolean;
  tabId: number | undefined;
  occurredAt: string;
}

export interface ApprovalRequest {
  approvalId: string;
  actionId: string;
  tabId: number;
  action: ActionRequest;
  title: string;
  description: string;
  dangerLevel: DangerLevel;
  status: ApprovalStatus;
  createdAt: string;
  updatedAt: string;
  targetLabel: string | undefined;
  targetElementId: string | undefined;
  rejectionReason: string | undefined;
}

export interface TrackedTabState {
  tabId: number;
  windowId: number;
  active: boolean;
  url: string;
  title: string;
  pageState: PageStateBasic | null;
  snapshot: PageSnapshot | null;
  snapshotFresh: boolean;
  contentReady: boolean;
  busy: boolean;
  approvals: ApprovalRequest[];
  activityLog: ActivityLogEntry[];
  lastError: AppError | null;
  lastSeenAt: string;
}

export interface ExtensionState {
  activeTabId: number | null;
  tabs: Record<number, TrackedTabState>;
  status: AssistantConnectionState;
  lastUpdatedAt: string;
}
