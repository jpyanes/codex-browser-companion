import {
  MAX_WORKFLOW_HISTORY_ENTRIES,
  MAX_WORKFLOW_NOTES,
  MAX_WORKFLOW_STEPS,
} from "./constants";
import { classifyDanger, requiresApproval } from "./action-policy";
import { parseInstruction } from "./instructions";
import { nowIso } from "./logger";
import { attachTabContextToRequest, buildTabContextFromSnapshot, normalizeTabContext } from "./tab-context";
import type {
  ActionRequest,
  DangerLevel,
  PageSnapshot,
  PageStateBasic,
  SuggestedAction,
  SuggestedRequest,
  WorkflowHistoryEntry,
  WorkflowPlan,
  WorkflowPlanStep,
  WorkflowRequestContext,
  WorkflowState,
  WorkflowStatus,
  WorkflowStepStatus,
} from "./types";

export interface WorkflowPlanPreview {
  workflow: WorkflowPlan;
  primaryRequest: SuggestedRequest | null;
  explanation: string;
  confidence: number;
  blockedStepCount: number;
}

function makeId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalize(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

function normalizeComparable(input: string): string {
  return normalize(input).toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function truncate<T>(items: T[], max: number): T[] {
  if (items.length <= max) {
    return items;
  }

  return items.slice(items.length - max);
}

function cloneRequestWithWorkflowContext(request: SuggestedRequest, workflowId: string, workflowStepId: string): SuggestedRequest {
  if (request.kind === "request-action") {
    return {
      ...request,
      action: {
        ...request.action,
        workflowId,
        workflowStepId,
      },
    };
  }

  return {
    ...request,
    workflowId,
    workflowStepId,
  };
}

function normalizeStepStatus(value: unknown): WorkflowStepStatus {
  if (value === "pending" || value === "queued" || value === "completed" || value === "blocked" || value === "failed") {
    return value;
  }

  return "pending";
}

function normalizeWorkflowStatus(value: unknown): WorkflowStatus {
  if (value === "active" || value === "paused" || value === "completed" || value === "abandoned" || value === "failed") {
    return value;
  }

  return "active";
}

function normalizeDangerLevel(value: unknown): DangerLevel {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  return "low";
}

function normalizeRequest(value: unknown): SuggestedRequest | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }

  const tabContext = normalizeTabContext(value.tabContext);

  switch (value.kind) {
    case "scan-page":
      return {
        kind: "scan-page",
        mode: value.mode === "interactive" || value.mode === "summary" || value.mode === "suggestions" ? value.mode : "full",
        ...(tabContext ? { tabContext } : {}),
        ...(typeof value.workflowId === "string" ? { workflowId: value.workflowId } : {}),
        ...(typeof value.workflowStepId === "string" ? { workflowStepId: value.workflowStepId } : {}),
      };
    case "list-interactive-elements":
      return {
        kind: "list-interactive-elements",
        ...(tabContext ? { tabContext } : {}),
        ...(typeof value.workflowId === "string" ? { workflowId: value.workflowId } : {}),
        ...(typeof value.workflowStepId === "string" ? { workflowStepId: value.workflowStepId } : {}),
      };
    case "summarize-page":
      return {
        kind: "summarize-page",
        ...(tabContext ? { tabContext } : {}),
        ...(typeof value.workflowId === "string" ? { workflowId: value.workflowId } : {}),
        ...(typeof value.workflowStepId === "string" ? { workflowStepId: value.workflowStepId } : {}),
      };
    case "suggest-next-actions":
      return {
        kind: "suggest-next-actions",
        ...(tabContext ? { tabContext } : {}),
        ...(typeof value.workflowId === "string" ? { workflowId: value.workflowId } : {}),
        ...(typeof value.workflowStepId === "string" ? { workflowStepId: value.workflowStepId } : {}),
      };
    case "request-action":
      if (!isRecord(value.action) || typeof value.action.kind !== "string" || typeof value.action.actionId !== "string" || typeof value.action.tabId !== "number") {
        return null;
      }

      const actionTabContext = normalizeTabContext(value.action.tabContext) ?? tabContext;
      const action = value.action as unknown as ActionRequest;
      return {
        kind: "request-action",
        ...(actionTabContext ? { tabContext: actionTabContext } : {}),
        action: {
          ...action,
          ...(actionTabContext ? { tabContext: actionTabContext } : {}),
        },
      };
    default:
      return null;
  }
}

function normalizeStep(value: unknown): WorkflowPlanStep | null {
  if (!isRecord(value)) {
    return null;
  }

  const request = normalizeRequest(value.request);
  return {
    stepId: typeof value.stepId === "string" ? value.stepId : makeId("workflow-step"),
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : "Untitled step",
    description: typeof value.description === "string" ? value.description : "",
    source: value.source === "planner" || value.source === "memory" ? value.source : "command",
    request,
    approvalRequired: typeof value.approvalRequired === "boolean" ? value.approvalRequired : false,
    dangerLevel: normalizeDangerLevel(value.dangerLevel),
    confidence: typeof value.confidence === "number" && Number.isFinite(value.confidence) ? value.confidence : 0.5,
    status: normalizeStepStatus(value.status),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
    completedAt: typeof value.completedAt === "string" ? value.completedAt : null,
    resultSummary: typeof value.resultSummary === "string" ? value.resultSummary : null,
    notes: typeof value.notes === "string" ? value.notes : null,
  };
}

function normalizeHistoryEntry(value: unknown): WorkflowHistoryEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    workflowId: typeof value.workflowId === "string" ? value.workflowId : makeId("workflow"),
    objective: typeof value.objective === "string" ? value.objective : "Untitled workflow",
    status: normalizeWorkflowStatus(value.status),
    startedAt: typeof value.startedAt === "string" ? value.startedAt : nowIso(),
    endedAt: typeof value.endedAt === "string" ? value.endedAt : null,
    stepCount: typeof value.stepCount === "number" && Number.isFinite(value.stepCount) ? value.stepCount : 0,
    completedStepCount: typeof value.completedStepCount === "number" && Number.isFinite(value.completedStepCount) ? value.completedStepCount : 0,
    originTabId: typeof value.originTabId === "number" ? value.originTabId : -1,
    originUrl: typeof value.originUrl === "string" ? value.originUrl : "",
    originTitle: typeof value.originTitle === "string" ? value.originTitle : "",
    lastResult: typeof value.lastResult === "string" ? value.lastResult : null,
  };
}

function normalizeWorkflowPlan(value: unknown): WorkflowPlan | null {
  if (!isRecord(value)) {
    return null;
  }

  const steps = Array.isArray(value.steps)
    ? value.steps.map(normalizeStep).filter((step): step is WorkflowPlanStep => Boolean(step)).slice(0, MAX_WORKFLOW_STEPS)
    : [];

  return {
    workflowId: typeof value.workflowId === "string" ? value.workflowId : makeId("workflow"),
    objective: typeof value.objective === "string" ? value.objective : "Untitled workflow",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
    status: normalizeWorkflowStatus(value.status),
    originTabId: typeof value.originTabId === "number" ? value.originTabId : -1,
    originUrl: typeof value.originUrl === "string" ? value.originUrl : "",
    originTitle: typeof value.originTitle === "string" ? value.originTitle : "",
    currentStepIndex: typeof value.currentStepIndex === "number" && Number.isFinite(value.currentStepIndex) ? value.currentStepIndex : 0,
    lastPageUrl: typeof value.lastPageUrl === "string" ? value.lastPageUrl : null,
    lastPageTitle: typeof value.lastPageTitle === "string" ? value.lastPageTitle : null,
    lastSummary: typeof value.lastSummary === "string" ? value.lastSummary : null,
    steps,
  };
}

function isResumeInstruction(input: string): boolean {
  const comparable = normalizeComparable(input);
  return comparable === "continue" || comparable === "resume" || comparable === "next" || comparable === "next step" || comparable === "keep going";
}

function splitWorkflowClauses(input: string): string[] {
  const chunks = normalize(input)
    .replace(/\r\n/g, "\n")
    .split(/\n+|;/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  const clauses: string[] = [];
  for (const chunk of chunks) {
    const parts = chunk
      .split(/\b(?:and then|then|next|after that|finally)\b/i)
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length === 0) {
      continue;
    }

    clauses.push(...parts);
  }

  return clauses.length > 0 ? clauses : [normalize(input)];
}

function isActionStep(request: SuggestedRequest | null): request is Extract<SuggestedRequest, { kind: "request-action" }> {
  return Boolean(request && request.kind === "request-action");
}

function hasWorkflowContext(context: WorkflowRequestContext | null | undefined): context is Required<WorkflowRequestContext> {
  return Boolean(context?.workflowId && context?.workflowStepId);
}

function getWorkflowNextStep(plan: WorkflowPlan | null): WorkflowPlanStep | null {
  if (!plan) {
    return null;
  }

  const step = plan.steps[plan.currentStepIndex] ?? null;
  if (!step) {
    return null;
  }

  if (step.status === "completed" || step.status === "failed") {
    return null;
  }

  return step;
}

function isWorkflowPlanPaused(plan: WorkflowPlan): boolean {
  const step = plan.steps[plan.currentStepIndex] ?? null;
  return Boolean(step && (step.status === "blocked" || !step.request));
}

function isWorkflowPlanComplete(plan: WorkflowPlan): boolean {
  return plan.currentStepIndex >= plan.steps.length;
}

function updatePlanStep(plan: WorkflowPlan, stepId: string, updater: (step: WorkflowPlanStep) => WorkflowPlanStep): WorkflowPlan {
  return {
    ...plan,
    updatedAt: nowIso(),
    steps: plan.steps.map((step) => (step.stepId === stepId ? updater(step) : step)),
  };
}

function promotePlanCursor(plan: WorkflowPlan): WorkflowPlan {
  let nextIndex = plan.currentStepIndex;
  while (nextIndex < plan.steps.length) {
    const step = plan.steps[nextIndex];
    if (!step || step.status === "completed") {
      nextIndex += 1;
      continue;
    }

    break;
  }

  return {
    ...plan,
    currentStepIndex: nextIndex,
    updatedAt: nowIso(),
  };
}

function summarizePlanEntry(plan: WorkflowPlan): WorkflowHistoryEntry {
  const completedStepCount = plan.steps.filter((step) => step.status === "completed").length;
  const lastResult = [...plan.steps].reverse().find((step) => step.resultSummary)?.resultSummary ?? null;

  return {
    workflowId: plan.workflowId,
    objective: plan.objective,
    status: plan.status,
    startedAt: plan.createdAt,
    endedAt: plan.status === "active" ? null : plan.updatedAt,
    stepCount: plan.steps.length,
    completedStepCount,
    originTabId: plan.originTabId,
    originUrl: plan.originUrl,
    originTitle: plan.originTitle,
    lastResult,
  };
}

function maybeArchiveWorkflow(state: WorkflowState, workflow: WorkflowPlan): WorkflowState {
  const nextWorkflow = {
    ...workflow,
    updatedAt: nowIso(),
  };

  if (isWorkflowPlanComplete(nextWorkflow)) {
    return archiveActiveWorkflow(
      {
        ...state,
        activeWorkflow: nextWorkflow,
      },
      "completed",
      { resultSummary: nextWorkflow.lastSummary },
    );
  }

  if (isWorkflowPlanPaused(nextWorkflow)) {
    return {
      ...state,
      activeWorkflow: {
        ...nextWorkflow,
        status: "paused",
      },
      lastUpdatedAt: nowIso(),
    };
  }

  return {
    ...state,
    activeWorkflow: {
      ...nextWorkflow,
      status: "active",
    },
    lastUpdatedAt: nowIso(),
  };
}

function appendNote(state: WorkflowState, note: string): WorkflowState {
  const normalized = normalize(note);
  if (!normalized) {
    return state;
  }

  return {
    ...state,
    memoryNotes: truncate([...state.memoryNotes, normalized], MAX_WORKFLOW_NOTES),
    lastUpdatedAt: nowIso(),
  };
}

function archiveActiveWorkflow(
  state: WorkflowState,
  status: WorkflowStatus,
  options: { note?: string; resultSummary?: string | null } = {},
): WorkflowState {
  if (!state.activeWorkflow) {
    return options.note ? appendNote(state, options.note) : state;
  }

  const nextWorkflow: WorkflowPlan = {
    ...state.activeWorkflow,
    status,
    updatedAt: nowIso(),
  };

  const historyEntry = {
    ...summarizePlanEntry(nextWorkflow),
    lastResult: options.resultSummary ?? summarizePlanEntry(nextWorkflow).lastResult,
  };

  const nextState: WorkflowState = {
    ...state,
    activeWorkflow: null,
    recentWorkflows: truncate([...state.recentWorkflows, historyEntry], MAX_WORKFLOW_HISTORY_ENTRIES),
    lastUpdatedAt: nowIso(),
  };

  return options.note ? appendNote(nextState, options.note) : nextState;
}

function updateWorkflowStepByContext(
  state: WorkflowState,
  context: WorkflowRequestContext | null | undefined,
  status: WorkflowStepStatus,
  resultSummary: string | null,
): WorkflowState {
  if (!hasWorkflowContext(context) || !state.activeWorkflow || context.workflowId !== state.activeWorkflow.workflowId) {
    return state;
  }

  const workflow = state.activeWorkflow;
  const stepIndex = workflow.steps.findIndex((step) => step.stepId === context.workflowStepId);
  if (stepIndex < 0) {
    return state;
  }

  const step = workflow.steps[stepIndex]!;
  const updatedStep: WorkflowPlanStep = {
    ...step,
    status,
    updatedAt: nowIso(),
    completedAt: status === "completed" ? nowIso() : step.completedAt,
    resultSummary: resultSummary ?? step.resultSummary,
  };

  let nextWorkflow: WorkflowPlan = {
    ...workflow,
    steps: workflow.steps.map((entry, index) => (index === stepIndex ? updatedStep : entry)),
    currentStepIndex: Math.max(workflow.currentStepIndex, status === "completed" ? stepIndex + 1 : stepIndex),
    updatedAt: nowIso(),
    lastSummary: resultSummary ?? workflow.lastSummary,
  };

  if (status === "failed") {
    const archived = archiveActiveWorkflow(
      {
        ...state,
        activeWorkflow: nextWorkflow,
      },
      "failed",
      { resultSummary },
    );
    return appendNote(archived, `Workflow step failed: ${step.title}`);
  }

  const nextState: WorkflowState = {
    ...state,
    activeWorkflow: nextWorkflow,
    lastUpdatedAt: nowIso(),
  };

  if (status === "queued") {
    return appendNote(nextState, `Queued workflow step: ${step.title}`);
  }

  if (status === "completed") {
    nextWorkflow = {
      ...nextWorkflow,
      currentStepIndex: stepIndex + 1,
    };

    const finalizedState = maybeArchiveWorkflow(
      {
        ...nextState,
        activeWorkflow: nextWorkflow,
      },
      nextWorkflow,
    );

    if (finalizedState.activeWorkflow) {
      const cursorStep = finalizedState.activeWorkflow.steps[finalizedState.activeWorkflow.currentStepIndex] ?? null;
      if (cursorStep && finalizedState.activeWorkflow.status === "paused") {
        return appendNote(finalizedState, `Workflow "${finalizedState.activeWorkflow.objective}" is paused on "${cursorStep.title}".`);
      }
    }

    return finalizedState;
  }

  return maybeArchiveWorkflow(nextState, nextWorkflow);
}

export function createInitialWorkflowState(): WorkflowState {
  return {
    activeWorkflow: null,
    recentWorkflows: [],
    memoryNotes: [],
    lastInstruction: null,
    lastObjective: null,
    lastUpdatedAt: nowIso(),
  };
}

export function normalizeWorkflowState(partial: Partial<WorkflowState> | undefined | null): WorkflowState {
  const fallback = createInitialWorkflowState();
  if (!partial) {
    return fallback;
  }

  const activeWorkflow = normalizeWorkflowPlan(partial.activeWorkflow);
  const recentWorkflows = Array.isArray(partial.recentWorkflows)
    ? partial.recentWorkflows.map(normalizeHistoryEntry).filter((entry): entry is WorkflowHistoryEntry => Boolean(entry)).slice(-MAX_WORKFLOW_HISTORY_ENTRIES)
    : [];

  return {
    activeWorkflow,
    recentWorkflows,
    memoryNotes: Array.isArray(partial.memoryNotes)
      ? partial.memoryNotes.filter((note): note is string => typeof note === "string" && note.trim().length > 0).slice(-MAX_WORKFLOW_NOTES)
      : [],
    lastInstruction: typeof partial.lastInstruction === "string" ? partial.lastInstruction : null,
    lastObjective: typeof partial.lastObjective === "string" ? partial.lastObjective : null,
    lastUpdatedAt: typeof partial.lastUpdatedAt === "string" ? partial.lastUpdatedAt : nowIso(),
  };
}

function buildStepFromParsedInstruction(
  workflowId: string,
  clause: string,
  parsed: ReturnType<typeof parseInstruction>,
): WorkflowPlanStep | null {
  if (!parsed) {
    return null;
  }

  const stepId = makeId("workflow-step");
  const request = cloneRequestWithWorkflowContext(parsed.request, workflowId, stepId);
  if (request.kind === "request-action") {
    request.action.workflowId = workflowId;
    request.action.workflowStepId = stepId;
  }

  const approvalRequired = request.kind === "request-action" ? requiresApproval(request.action) : false;
  const dangerLevel = request.kind === "request-action" ? classifyDanger(request.action, null) : "low";

  return {
    stepId,
    title: parsed.explanation,
    description: parsed.explanation,
    source: "command",
    request,
    approvalRequired,
    dangerLevel,
    confidence: parsed.confidence,
    status: "pending",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completedAt: null,
    resultSummary: null,
    notes: normalize(clause),
  };
}

function buildBlockedStep(clause: string): WorkflowPlanStep {
  return {
    stepId: makeId("workflow-step"),
    title: `Unsupported step: ${normalize(clause)}`,
    description: `CBC could not translate "${normalize(clause)}" into a safe browser action in v1.`,
    source: "planner",
    request: null,
    approvalRequired: false,
    dangerLevel: "low",
    confidence: 0.1,
    status: "blocked",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completedAt: null,
    resultSummary: null,
    notes: normalize(clause),
  };
}

function countBlockedSteps(steps: WorkflowPlanStep[]): number {
  return steps.filter((step) => step.status === "blocked").length;
}

function countCompletedSteps(steps: WorkflowPlanStep[]): number {
  return steps.filter((step) => step.status === "completed").length;
}

function planExplanation(stepCount: number, blockedCount: number): string {
  const blockedSuffix = blockedCount > 0 ? ` ${blockedCount} step${blockedCount === 1 ? "" : "s"} need a manual follow-up.` : "";
  return stepCount > 1 ? `Planned ${stepCount} workflow steps.${blockedSuffix}` : `Planned 1 workflow step.${blockedSuffix}`;
}

function firstActionableRequest(steps: WorkflowPlanStep[]): SuggestedRequest | null {
  for (const step of steps) {
    if (step.status === "blocked" || !step.request) {
      return null;
    }

    return step.request;
  }

  return null;
}

export function buildWorkflowPlanFromInstruction(
  input: string,
  snapshot: PageSnapshot | null,
  activeWorkflow: WorkflowPlan | null,
): WorkflowPlanPreview | null {
  const trimmed = normalize(input);
  if (!trimmed) {
    return null;
  }

  const workflowId = makeId("workflow");
  const clauses = splitWorkflowClauses(trimmed);
  const steps: WorkflowPlanStep[] = [];

  if (isResumeInstruction(trimmed) && activeWorkflow) {
    const existingNextStep = getWorkflowNextStep(activeWorkflow);
    if (!existingNextStep) {
      return null;
    }

    const snapshotContext = snapshot ? buildTabContextFromSnapshot(snapshot) : null;

    const resumedStep: WorkflowPlanStep = {
      ...existingNextStep,
      stepId: existingNextStep.stepId,
      title: `Resume workflow: ${existingNextStep.title}`,
      description: `Continue the active workflow at step ${activeWorkflow.currentStepIndex + 1}.`,
      source: "memory",
      request:
        existingNextStep.request && snapshotContext
          ? attachTabContextToRequest(
              cloneRequestWithWorkflowContext(existingNextStep.request, activeWorkflow.workflowId, existingNextStep.stepId),
              snapshotContext,
            )
          : existingNextStep.request
            ? cloneRequestWithWorkflowContext(existingNextStep.request, activeWorkflow.workflowId, existingNextStep.stepId)
            : null,
      status: existingNextStep.status === "completed" ? "pending" : existingNextStep.status,
      updatedAt: nowIso(),
      notes: existingNextStep.notes,
    };

    return {
      workflow: {
        ...activeWorkflow,
        updatedAt: nowIso(),
        status: "active",
      },
      primaryRequest: resumedStep.request,
      explanation: `Resuming the active workflow: ${activeWorkflow.objective}.`,
      confidence: 0.88,
      blockedStepCount: countBlockedSteps(activeWorkflow.steps),
    };
  }

  for (const clause of clauses) {
    const parsed = parseInstruction(clause, snapshot);
    const step = parsed ? buildStepFromParsedInstruction(workflowId, clause, parsed) : buildBlockedStep(clause);
    if (step) {
      steps.push(step);
    }
  }

  if (steps.length === 0) {
    return null;
  }

  const workflow: WorkflowPlan = {
    workflowId,
    objective: trimmed,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "active",
    originTabId: snapshot?.tabId ?? -1,
    originUrl: snapshot?.url ?? "",
    originTitle: snapshot?.title ?? "",
    currentStepIndex: 0,
    lastPageUrl: snapshot?.url ?? null,
    lastPageTitle: snapshot?.title ?? null,
    lastSummary: snapshot?.summary ?? null,
    steps,
  };

  const primaryRequest = firstActionableRequest(steps);
  const blockedStepCount = countBlockedSteps(steps);
  return {
    workflow,
    primaryRequest,
    explanation: planExplanation(steps.length, blockedStepCount),
    confidence: Math.max(...steps.map((step) => step.confidence), 0.5),
    blockedStepCount,
  };
}

function requestLabelForStep(step: WorkflowPlanStep, stepNumber: number, workflow: WorkflowPlan): string {
  if (step.request?.kind === "request-action") {
    return `Step ${stepNumber}: ${step.title}`;
  }

  if (step.request?.kind === "scan-page") {
    return `Step ${stepNumber}: ${step.title}`;
  }

  return `Step ${stepNumber}: ${step.title}`;
}

function buildWorkflowStepSuggestion(workflow: WorkflowPlan, step: WorkflowPlanStep, index: number, snapshot: PageSnapshot): SuggestedAction | null {
  if (!step.request || step.status === "blocked") {
    return null;
  }

  const tabContext =
    step.request.tabContext ??
    (step.request.kind === "request-action" ? step.request.action.tabContext : null) ??
    buildTabContextFromSnapshot(snapshot);

  return {
    id: `workflow-${workflow.workflowId}-${step.stepId}`,
    title: requestLabelForStep(step, index + 1, workflow),
    description: step.description || `Continue the workflow "${workflow.objective}".`,
    buttonLabel: step.request.kind === "request-action" ? "Queue step" : "Run step",
    request: step.request,
    tabContext,
    approvalRequired: step.approvalRequired,
    dangerLevel: step.dangerLevel,
    source: "workflow",
    selector: undefined,
    confidence: step.confidence,
  };
}

function buildWorkflowRescanSuggestion(workflow: WorkflowPlan, snapshot: PageSnapshot): SuggestedAction | null {
  const changedPage = workflow.lastPageUrl && workflow.lastPageUrl !== snapshot.url;
  if (!changedPage) {
    return null;
  }

  const tabContext = buildTabContextFromSnapshot(snapshot);

  return {
    id: `workflow-rescan-${workflow.workflowId}-${snapshot.snapshotId}`,
    title: `Rescan before continuing "${workflow.objective}"`,
    description: `The workflow was last observed on ${workflow.lastPageTitle || workflow.lastPageUrl || "a previous page"} and the active tab has changed.`,
    buttonLabel: "Rescan",
    tabContext,
    request: attachTabContextToRequest({
      kind: "scan-page",
      mode: "suggestions",
      workflowId: workflow.workflowId,
    }, tabContext),
    approvalRequired: false,
    dangerLevel: "low",
    source: "workflow",
    selector: undefined,
    confidence: 0.8,
  };
}

export function buildWorkflowSuggestions(workflowState: WorkflowState, snapshot: PageSnapshot): SuggestedAction[] {
  const workflow = workflowState.activeWorkflow;
  if (!workflow) {
    return [];
  }

  const suggestions: SuggestedAction[] = [];
  const rescanSuggestion = buildWorkflowRescanSuggestion(workflow, snapshot);
  if (rescanSuggestion) {
    suggestions.push(rescanSuggestion);
  }

  const nextStep = getWorkflowNextStep(workflow);
  if (nextStep) {
    const stepSuggestion = buildWorkflowStepSuggestion(workflow, nextStep, workflow.currentStepIndex, snapshot);
    if (stepSuggestion) {
      suggestions.push(stepSuggestion);
    }
  }

  return suggestions;
}

function updateWorkflowPlanSummary(plan: WorkflowPlan, summary: string | null): WorkflowPlan {
  return {
    ...plan,
    lastSummary: summary,
    updatedAt: nowIso(),
  };
}

export function recordWorkflowPlan(state: WorkflowState, plan: WorkflowPlan, snapshot: PageSnapshot | null): WorkflowState {
  const nextState = state.activeWorkflow
    ? archiveActiveWorkflow(state, "abandoned", { note: `Replaced active workflow "${state.activeWorkflow.objective}".` })
    : state;

  const workflow: WorkflowPlan = {
    ...plan,
    createdAt: plan.createdAt || nowIso(),
    updatedAt: nowIso(),
    status: "active",
    originTabId: snapshot?.tabId ?? plan.originTabId,
    originUrl: snapshot?.url ?? plan.originUrl,
    originTitle: snapshot?.title ?? plan.originTitle,
    lastPageUrl: snapshot?.url ?? plan.lastPageUrl,
    lastPageTitle: snapshot?.title ?? plan.lastPageTitle,
    lastSummary: snapshot?.summary ?? plan.lastSummary,
    steps: plan.steps.slice(0, MAX_WORKFLOW_STEPS),
    currentStepIndex: Math.max(0, Math.min(plan.currentStepIndex, plan.steps.length)),
  };

  const note = `Planned workflow: ${workflow.objective}`;
  return {
    ...nextState,
    activeWorkflow: workflow,
    recentWorkflows: nextState.recentWorkflows,
    memoryNotes: truncate([...nextState.memoryNotes, note], MAX_WORKFLOW_NOTES),
    lastInstruction: workflow.objective,
    lastObjective: workflow.objective,
    lastUpdatedAt: nowIso(),
  };
}

export function recordWorkflowPageState(
  state: WorkflowState,
  tabId: number,
  pageState: PageStateBasic | null,
  snapshot: PageSnapshot | null,
): WorkflowState {
  if (!state.activeWorkflow) {
    return state;
  }

  const workflow = state.activeWorkflow;
  const nextUrl = snapshot?.url ?? pageState?.url ?? workflow.lastPageUrl;
  const nextTitle = snapshot?.title ?? pageState?.title ?? workflow.lastPageTitle;
  const nextSummary = snapshot?.summary ?? workflow.lastSummary;
  const changed = Boolean(nextUrl && workflow.lastPageUrl && nextUrl !== workflow.lastPageUrl) || Boolean(nextTitle && workflow.lastPageTitle && nextTitle !== workflow.lastPageTitle);

  const nextWorkflow: WorkflowPlan = {
    ...workflow,
    lastPageUrl: nextUrl ?? null,
    lastPageTitle: nextTitle ?? null,
    lastSummary: nextSummary ?? null,
    updatedAt: nowIso(),
  };

  let nextState: WorkflowState = {
    ...state,
    activeWorkflow: nextWorkflow,
    lastUpdatedAt: nowIso(),
  };

  if (changed) {
    nextState = appendNote(
      nextState,
      `Workflow "${workflow.objective}" observed tab ${tabId} change to ${nextTitle || nextUrl || "unknown page"}.`,
    );
  }

  return nextState;
}

export function markWorkflowStepQueued(state: WorkflowState, action: ActionRequest): WorkflowState {
  return updateWorkflowStepByContext(state, action, "queued", null);
}

export function markWorkflowStepCompleted(
  state: WorkflowState,
  action: ActionRequest,
  resultSummary: string | null,
): WorkflowState {
  return updateWorkflowStepByContext(state, action, "completed", resultSummary);
}

export function markWorkflowStepFailed(state: WorkflowState, action: ActionRequest, reason: string): WorkflowState {
  return updateWorkflowStepByContext(state, action, "failed", reason);
}

export function markWorkflowRequestCompleted(
  state: WorkflowState,
  context: WorkflowRequestContext | null | undefined,
  resultSummary: string | null,
): WorkflowState {
  return updateWorkflowStepByContext(state, context, "completed", resultSummary);
}

export function markWorkflowRequestFailed(
  state: WorkflowState,
  context: WorkflowRequestContext | null | undefined,
  reason: string,
): WorkflowState {
  return updateWorkflowStepByContext(state, context, "failed", reason);
}

export function summarizeWorkflowState(state: WorkflowState): string {
  const workflow = state.activeWorkflow;
  if (!workflow) {
    return "No active workflow plan.";
  }

  const currentStep = workflow.steps[workflow.currentStepIndex] ?? null;
  const completed = countCompletedSteps(workflow.steps);
  const total = workflow.steps.length;

  if (workflow.status === "paused") {
    return currentStep
      ? `Workflow "${workflow.objective}" is paused on step ${workflow.currentStepIndex + 1}/${total}: ${currentStep.title}.`
      : `Workflow "${workflow.objective}" is paused after completing ${completed}/${total} steps.`;
  }

  if (workflow.status === "completed") {
    return `Workflow "${workflow.objective}" is complete.`;
  }

  if (!currentStep) {
    return `Workflow "${workflow.objective}" is active with ${completed}/${total} steps complete.`;
  }

  return `Workflow "${workflow.objective}" is active at step ${workflow.currentStepIndex + 1}/${total}: ${currentStep.title}.`;
}

export function workflowStatusTone(status: WorkflowStatus): "neutral" | "warning" | "success" | "danger" {
  switch (status) {
    case "active":
      return "warning";
    case "paused":
      return "neutral";
    case "completed":
      return "success";
    case "abandoned":
      return "neutral";
    case "failed":
      return "danger";
  }
}

export function workflowStatusLabel(status: WorkflowStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "abandoned":
      return "Abandoned";
    case "failed":
      return "Failed";
  }
}

export function workflowStepStatusTone(status: WorkflowStepStatus): "neutral" | "warning" | "success" | "danger" {
  switch (status) {
    case "pending":
      return "neutral";
    case "queued":
      return "warning";
    case "completed":
      return "success";
    case "blocked":
      return "danger";
    case "failed":
      return "danger";
  }
}

export function workflowStepStatusLabel(status: WorkflowStepStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "queued":
      return "Queued";
    case "completed":
      return "Done";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
  }
}

export function workflowProgress(state: WorkflowState | null | undefined): { completed: number; total: number; blocked: number } {
  const workflow = state?.activeWorkflow ?? null;
  if (!workflow) {
    return { completed: 0, total: 0, blocked: 0 };
  }

  return {
    completed: countCompletedSteps(workflow.steps),
    total: workflow.steps.length,
    blocked: countBlockedSteps(workflow.steps),
  };
}

export function getActiveWorkflowNextRequest(state: WorkflowState | null | undefined): SuggestedRequest | null {
  return getWorkflowNextStep(state?.activeWorkflow ?? null)?.request ?? null;
}

export function getActiveWorkflowNextStep(state: WorkflowState | null | undefined): WorkflowPlanStep | null {
  return getWorkflowNextStep(state?.activeWorkflow ?? null);
}

export function mergeWorkflowSuggestions(workflowState: WorkflowState, snapshot: PageSnapshot): SuggestedAction[] {
  return buildWorkflowSuggestions(workflowState, snapshot);
}

export function workflowStepIsActionable(step: WorkflowPlanStep | null): boolean {
  return Boolean(step && step.request && step.status !== "blocked");
}
