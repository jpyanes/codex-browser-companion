export type AssistantConnectionState = "idle" | "connected" | "running" | "awaiting-approval" | "awaiting-user" | "error";
export type NavigationMode = "document" | "spa";
export type PageKind = "unknown" | "document" | "mixed" | "article" | "form" | "login" | "payment" | "spa";
export type ScanMode = "full" | "interactive" | "summary" | "suggestions";
export type LogLevel = "debug" | "info" | "success" | "warning" | "error";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "executing" | "succeeded" | "failed";
export type DangerLevel = "low" | "medium" | "high";
export type SemanticConnectionState = "disconnected" | "disabled" | "ready" | "error";
export type WorkflowStatus = "active" | "paused" | "completed" | "abandoned" | "failed";
export type WorkflowStepStatus = "pending" | "queued" | "completed" | "blocked" | "failed";
export type WorkflowStepSource = "command" | "planner" | "memory";
export type SiteAdapterKind = "social-feed" | "document-editor" | "workspace-login" | "workspace-app" | "general";
export type UserInterventionKind = "login" | "payment";

export interface BoxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkflowRequestContext {
  workflowId?: string;
  workflowStepId?: string;
}

export interface TabContext {
  tabId: number;
  windowId: number | null;
  browserTargetId?: string | null;
  url: string;
  title: string;
  pageKind: PageKind;
  siteAdapterId: string | null;
  siteAdapterLabel: string | null;
  snapshotId: string | null;
  capturedAt: string | null;
}

export interface UserInterventionSummary {
  kind: UserInterventionKind;
  message: string;
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
  siteAdapterId: string | null;
  siteAdapterLabel: string | null;
  userInterventionKind?: UserInterventionKind | null;
  userInterventionMessage?: string | null;
  updatedAt: string;
}

export type BridgeConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface BridgeProfileSummary {
  email: string;
  id: string;
}

export interface BridgeExtensionSummary {
  extensionId: string;
  stableKey: string | undefined;
  browser: string | null;
  profile: BridgeProfileSummary | null;
  activeTargets: number;
  playwriterVersion: string | null;
}

export interface BridgeSnapshot {
  relayVersion: string | null;
  extensions: BridgeExtensionSummary[];
  checkedAt: string;
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

export interface SiteAdapterSummary {
  id: string;
  label: string;
  kind: SiteAdapterKind;
  summary: string;
  capabilities: string[];
  notes: string[];
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
  selector?: string;
  tabContext?: TabContext;
  workflowId?: string;
  workflowStepId?: string;
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
  tabContext?: TabContext;
  workflowId?: string;
  workflowStepId?: string;
}

export interface SuggestedRequestListInteractive {
  kind: "list-interactive-elements";
  tabContext?: TabContext;
  workflowId?: string;
  workflowStepId?: string;
}

export interface SuggestedRequestSummarize {
  kind: "summarize-page";
  tabContext?: TabContext;
  workflowId?: string;
  workflowStepId?: string;
}

export interface SuggestedRequestSuggestNext {
  kind: "suggest-next-actions";
  tabContext?: TabContext;
  workflowId?: string;
  workflowStepId?: string;
}

export interface SuggestedRequestAction {
  kind: "request-action";
  action: ActionRequest;
  tabContext?: TabContext;
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
  tabContext: TabContext;
  request: SuggestedRequest;
  approvalRequired: boolean;
  dangerLevel: DangerLevel;
  source: "dom" | "stagehand" | "workflow" | "site";
  selector: string | undefined;
  confidence: number | undefined;
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
  siteAdapter: SiteAdapterSummary | null;
  userInterventionKind?: UserInterventionKind | null;
  userInterventionMessage?: string | null;
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

export interface SemanticHealthSnapshot {
  endpoint: string;
  browserEndpoint: string;
  status: SemanticConnectionState;
  model: string | null;
  reason: string | null;
  observedAt: string | null;
  lastError: AppError | null;
}

export interface SemanticObservationAction {
  selector: string;
  description: string;
  method: string | undefined;
  arguments: string[] | undefined;
}

export interface SemanticObservationSnapshot {
  endpoint: string;
  browserEndpoint: string;
  status: SemanticConnectionState;
  model: string | null;
  pageUrl: string | null;
  pageTitle: string | null;
  reason: string | null;
  observedAt: string;
  actions: SemanticObservationAction[];
}

export interface BridgeState {
  endpoint: string;
  status: BridgeConnectionState;
  relayVersion: string | null;
  extensions: BridgeExtensionSummary[];
  activeExtension: BridgeExtensionSummary | null;
  activeTargetCount: number;
  checkedAt: string | null;
  lastError: AppError | null;
}

export interface SemanticState {
  endpoint: string;
  browserEndpoint: string;
  status: SemanticConnectionState;
  model: string | null;
  observedAt: string | null;
  pageUrl: string | null;
  pageTitle: string | null;
  suggestionCount: number;
  disabledReason: string | null;
  lastError: AppError | null;
}

export interface WorkflowPlanStep {
  stepId: string;
  title: string;
  description: string;
  source: WorkflowStepSource;
  request: SuggestedRequest | null;
  approvalRequired: boolean;
  dangerLevel: DangerLevel;
  confidence: number;
  status: WorkflowStepStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  resultSummary: string | null;
  notes: string | null;
}

export interface WorkflowPlan {
  workflowId: string;
  objective: string;
  createdAt: string;
  updatedAt: string;
  status: WorkflowStatus;
  originTabId: number;
  originUrl: string;
  originTitle: string;
  currentStepIndex: number;
  lastPageUrl: string | null;
  lastPageTitle: string | null;
  lastSummary: string | null;
  steps: WorkflowPlanStep[];
}

export interface WorkflowHistoryEntry {
  workflowId: string;
  objective: string;
  status: WorkflowStatus;
  startedAt: string;
  endedAt: string | null;
  stepCount: number;
  completedStepCount: number;
  originTabId: number;
  originUrl: string;
  originTitle: string;
  lastResult: string | null;
}

export interface WorkflowState {
  activeWorkflow: WorkflowPlan | null;
  recentWorkflows: WorkflowHistoryEntry[];
  memoryNotes: string[];
  lastInstruction: string | null;
  lastObjective: string | null;
  lastUpdatedAt: string;
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
  bridge: BridgeState;
  semantic: SemanticState;
  workflow: WorkflowState;
  status: AssistantConnectionState;
  lastUpdatedAt: string;
}
