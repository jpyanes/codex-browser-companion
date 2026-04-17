import { LIVE_TAKEOVER_POLL_INTERVAL_MS, PAGE_MUTATION_DEBOUNCE_MS } from "../shared/constants";
import { capturePageState, createActionResult, createSnapshotForMode, getActionScrollAmount, getElementTextSnapshot, isSensitiveElement } from "../shared/dom";
import { normalizeError, nowIso } from "../shared/logger";
import { isContentRequest } from "../shared/messages";
import {
  getNextLiveTakeoverCommand,
  postLiveTakeoverHeartbeat,
  postLiveTakeoverResult,
} from "../shared/live-takeover-client";
import type { ActionKind, ActionRequest, ActionResult, NavigationMode, PageSnapshot } from "../shared/types";
import type { LiveTakeoverCommand, LiveTakeoverCommandResult } from "../shared/types";
import type { ContentTargetPayload } from "../shared/messages";
import type { ContentLiveTakeoverContextResponse } from "../shared/messages";

declare global {
  interface Window {
    __codexBrowserCompanionContent?: ContentRuntimeState;
  }
}

interface ContentRuntimeState {
  initialized: boolean;
  navigationMode: NavigationMode;
  registry: Map<string, HTMLElement>;
  lastSnapshot: PageSnapshot | null;
  mutationTimer: number | null;
  liveTakeover: {
    enabled: boolean;
    endpoint: string | null;
    tabId: number | null;
    windowId: number | null;
    timer: number | null;
    inFlight: boolean;
    lastHeartbeat: string | null;
  };
}

const runtimeState: ContentRuntimeState = (window.__codexBrowserCompanionContent ??= {
  initialized: false,
  navigationMode: "document",
  registry: new Map(),
  lastSnapshot: null,
  mutationTimer: null,
  liveTakeover: {
    enabled: false,
    endpoint: null,
    tabId: null,
    windowId: null,
    timer: null,
    inFlight: false,
    lastHeartbeat: null,
  },
});

function makeId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function getNavigationMode(): NavigationMode {
  return runtimeState.navigationMode;
}

function normalizeComparable(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function schedulePageStateBroadcast(reason: "initial" | "mutation" | "navigation" | "reload"): void {
  if (runtimeState.mutationTimer !== null) {
    clearTimeout(runtimeState.mutationTimer);
  }

  runtimeState.mutationTimer = window.setTimeout(() => {
    runtimeState.mutationTimer = null;
    void broadcastPageState(reason);
  }, PAGE_MUTATION_DEBOUNCE_MS);
}

async function broadcastPageState(reason: "initial" | "mutation" | "navigation" | "reload"): Promise<void> {
  const state = capturePageState(document, getNavigationMode());

  await chrome.runtime.sendMessage({
    kind: "page-state",
    state,
    reason,
  });
}

async function requestLiveTakeoverContext(): Promise<ContentLiveTakeoverContextResponse | null> {
  try {
    const response = await chrome.runtime.sendMessage({ kind: "get-live-takeover-context" });
    if (
      response &&
      typeof response === "object" &&
      response !== null &&
      (response as { kind?: unknown }).kind === "live-takeover-context"
    ) {
      return response as ContentLiveTakeoverContextResponse;
    }
  } catch {
    // The background worker may still be booting. Retry from bootstrap.
  }

  return null;
}

async function bootstrapLiveTakeoverFromContext(attempt = 0): Promise<void> {
  if (runtimeState.liveTakeover.enabled) {
    return;
  }

  const context = await requestLiveTakeoverContext();
  if (!context) {
    if (attempt < 2) {
      window.setTimeout(() => {
        void bootstrapLiveTakeoverFromContext(attempt + 1);
      }, 250);
    }
    return;
  }

  if (context.enabled && context.shouldStart && context.tabId !== null) {
    startLiveTakeoverLoop(context.endpoint, context.tabId, context.windowId);
    return;
  }

  if (!context.enabled) {
    stopLiveTakeoverLoop();
  }
}

function stopLiveTakeoverLoop(): void {
  if (runtimeState.liveTakeover.timer !== null) {
    clearInterval(runtimeState.liveTakeover.timer);
    runtimeState.liveTakeover.timer = null;
  }
  runtimeState.liveTakeover.enabled = false;
  runtimeState.liveTakeover.endpoint = null;
  runtimeState.liveTakeover.tabId = null;
  runtimeState.liveTakeover.windowId = null;
  runtimeState.liveTakeover.inFlight = false;
}

async function executeLiveTakeoverCommand(tabId: number, command: LiveTakeoverCommand): Promise<LiveTakeoverCommandResult> {
  const startedAt = nowIso();

  switch (command.type) {
    case "snapshot": {
      const mode = command.payload?.mode === "interactive" || command.payload?.mode === "summary" || command.payload?.mode === "suggestions" ? command.payload.mode : "full";
      const capture = createSnapshotForMode(document, mode, getNavigationMode());
      const snapshot = capture.snapshot;
      snapshot.tabId = tabId;
      runtimeState.registry = capture.registry;
      runtimeState.lastSnapshot = snapshot;
      return {
        commandId: command.id,
        ok: true,
        result: {
          snapshotId: snapshot.snapshotId,
          summary: snapshot.summary,
          pageKind: snapshot.pageKind,
          capturedAt: snapshot.capturedAt,
        },
        ts: startedAt,
      };
    }
    case "click": {
      const result = performDirectClick(tabId, buildDirectTargetPayload(command.payload ?? {}));
      return {
        commandId: command.id,
        ok: true,
        result,
        ts: startedAt,
      };
    }
    case "fill": {
      const fillPayload: DirectFillPayload = {
        ...buildDirectTargetPayload(command.payload ?? {}),
        value: typeof command.payload?.value === "string" ? command.payload.value : "",
        ...(typeof command.payload?.clearBeforeTyping === "boolean" ? { clearBeforeTyping: command.payload.clearBeforeTyping } : {}),
      };
      const result = performDirectFill(tabId, fillPayload);
      return {
        commandId: command.id,
        ok: true,
        result,
        ts: startedAt,
      };
    }
    case "press": {
      const pressPayload: DirectPressPayload = {
        ...buildDirectTargetPayload(command.payload ?? {}),
        ...(typeof command.payload?.key === "string" ? { key: command.payload.key } : {}),
        ...(typeof command.payload?.submitForm === "boolean" ? { submitForm: command.payload.submitForm } : {}),
      };
      const result = performDirectPress(tabId, pressPayload);
      return {
        commandId: command.id,
        ok: true,
        result,
        ts: startedAt,
      };
    }
    case "navigate": {
      const url = typeof command.payload?.url === "string" && command.payload.url.trim() ? command.payload.url : "about:blank";
      return {
        commandId: command.id,
        ok: true,
        result: { navigatedTo: url },
        ts: startedAt,
      };
    }
  }
}

async function runLiveTakeoverCycle(): Promise<void> {
  const config = runtimeState.liveTakeover;
  if (!config.enabled || !config.endpoint || config.tabId === null || config.inFlight) {
    return;
  }

  config.inFlight = true;
  const heartbeatTs = nowIso();
  try {
    await postLiveTakeoverHeartbeat(
      config.endpoint,
      {
        tabId: config.tabId,
        windowId: config.windowId,
        url: location.href,
        title: document.title || null,
        ts: heartbeatTs,
      },
      { keepalive: true },
    );
    config.lastHeartbeat = heartbeatTs;

    const command = await getNextLiveTakeoverCommand(config.endpoint, config.tabId, location.href);
    if (command) {
      if (command.type === "navigate") {
        const navigatedTo = typeof command.payload?.url === "string" && command.payload.url.trim() ? command.payload.url : "about:blank";
        await postLiveTakeoverResult(
          config.endpoint,
          {
            commandId: command.id,
            ok: true,
            result: { navigatedTo },
            ts: nowIso(),
          },
          { keepalive: true },
        );
        location.href = navigatedTo;
        return;
      }

      const result = await executeLiveTakeoverCommand(config.tabId, command);
      await postLiveTakeoverResult(config.endpoint, result, { keepalive: true });
    }
  } catch {
    // Keep the loop alive; the background bridge will surface errors through health polling.
  } finally {
    config.inFlight = false;
  }
}

function startLiveTakeoverLoop(endpoint: string, tabId: number, windowId: number | null): void {
  runtimeState.liveTakeover.enabled = true;
  runtimeState.liveTakeover.endpoint = endpoint;
  runtimeState.liveTakeover.tabId = tabId;
  runtimeState.liveTakeover.windowId = windowId;

  if (runtimeState.liveTakeover.timer !== null) {
    clearInterval(runtimeState.liveTakeover.timer);
  }

  void runLiveTakeoverCycle();
  runtimeState.liveTakeover.timer = window.setInterval(() => {
    void runLiveTakeoverCycle();
  }, LIVE_TAKEOVER_POLL_INTERVAL_MS);
}

function installHistoryHooks(): void {
  const history = window.history as History & {
    __codexBrowserCompanionPatched?: boolean;
  };

  if (history.__codexBrowserCompanionPatched) {
    return;
  }

  history.__codexBrowserCompanionPatched = true;

  const wrap = <T extends (...args: never[]) => unknown>(name: "pushState" | "replaceState", original: T): T => {
    return ((...args: never[]) => {
      const result = original.apply(history, args);
      runtimeState.navigationMode = "spa";
      schedulePageStateBroadcast("navigation");
      return result;
    }) as T;
  };

  history.pushState = wrap("pushState", history.pushState.bind(history));
  history.replaceState = wrap("replaceState", history.replaceState.bind(history));
}

function installMutationObserver(): void {
  const root = document.documentElement;
  const observer = new MutationObserver(() => {
    runtimeState.navigationMode = runtimeState.navigationMode === "spa" ? "spa" : "document";
    schedulePageStateBroadcast("mutation");
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
}

function getFieldValue(element: HTMLInputElement | HTMLTextAreaElement): string {
  return element instanceof HTMLInputElement && element.type === "password" ? "" : element.value;
}

function setFieldValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = Object.getPrototypeOf(element);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true, cancelable: true, composed: true }));
  element.dispatchEvent(new Event("change", { bubbles: true, cancelable: true, composed: true }));
}

function selectOption(select: HTMLSelectElement, selection: ActionRequest & { kind: "select" }): string {
  const normalized = normalizeComparable(String(selection.selection.value));
  const options = Array.from(select.options);

  let chosenIndex = -1;
  if (selection.selection.by === "index") {
    chosenIndex = Number.parseInt(String(selection.selection.value), 10);
  } else if (selection.selection.by === "value") {
    chosenIndex = options.findIndex((option) => normalizeComparable(option.value) === normalized);
  } else {
    chosenIndex = options.findIndex((option) => normalizeComparable(option.textContent ?? "") === normalized);
  }

  if (chosenIndex < 0 || !options[chosenIndex]) {
    throw new Error(`Could not find an option matching "${selection.selection.value}".`);
  }

  const chosen = options[chosenIndex]!;
  select.selectedIndex = chosenIndex;
  select.dispatchEvent(new Event("input", { bubbles: true, cancelable: true, composed: true }));
  select.dispatchEvent(new Event("change", { bubbles: true, cancelable: true, composed: true }));

  return chosen.textContent ?? chosen.value;
}

function resolveRegistryElement(elementId: string): HTMLElement | null {
  return runtimeState.registry.get(elementId) ?? null;
}

function registerResolvedElement(element: HTMLElement): string {
  for (const [elementId, registeredElement] of runtimeState.registry.entries()) {
    if (registeredElement === element) {
      return elementId;
    }
  }

  const elementId = makeId("element");
  runtimeState.registry.set(elementId, element);
  return elementId;
}

function resolveSelectorWithXPath(selector: string): HTMLElement | null {
  const normalized = selector.trim().replace(/^xpath=/i, "");
  if (!normalized) {
    return null;
  }

  try {
    const result = document.evaluate(normalized, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return result.singleNodeValue instanceof HTMLElement ? result.singleNodeValue : null;
  } catch {
    return null;
  }
}

function resolveSelectorByText(selector: string): HTMLElement | null {
  const comparable = normalizeComparable(selector.replace(/^text=/i, "").replace(/^aria=/i, ""));
  if (!comparable) {
    return null;
  }

  const candidates = Array.from(runtimeState.registry.values()).filter((element) => element instanceof HTMLElement);
  for (const element of candidates) {
    const label = normalizeComparable(
      `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""} ${getElementTextSnapshot(element)}`,
    );
    if (label.includes(comparable)) {
      return element;
    }
  }

  return null;
}

function resolveElementByLabel(label: string): HTMLElement | null {
  const comparable = normalizeComparable(label);
  if (!comparable) {
    return null;
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      [
        "button",
        "a[href]",
        "input:not([type='hidden'])",
        "select",
        "textarea",
        "summary",
        "[role='button']",
        "[role='link']",
        "[contenteditable='true']",
      ].join(","),
    ),
  ).filter((element) => element instanceof HTMLElement);

  for (const element of candidates) {
    const haystack = normalizeComparable(
      [
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("title") ?? "",
        element.getAttribute("placeholder") ?? "",
        getElementTextSnapshot(element),
      ].join(" "),
    );

    if (haystack.includes(comparable)) {
      return element;
    }
  }

  return resolveSelectorByText(label);
}

function resolveSelectorToElement(selector: string): HTMLElement | null {
  const normalized = selector.trim();
  if (!normalized) {
    return null;
  }

  for (const element of runtimeState.registry.values()) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }

    try {
      if (element.matches(normalized)) {
        return element;
      }
    } catch {
      // Fall through to broader matching strategies.
    }
  }

  try {
    const cssMatch = document.querySelector(normalized);
    if (cssMatch instanceof HTMLElement) {
      return cssMatch;
    }
  } catch {
    // Ignore invalid CSS selectors.
  }

  if (normalized.startsWith("xpath=") || normalized.startsWith("/")) {
    const xpathMatch = resolveSelectorWithXPath(normalized);
    if (xpathMatch) {
      return xpathMatch;
    }
  }

  const textMatch = resolveSelectorByText(normalized);
  if (textMatch) {
    return textMatch;
  }

  const labelMatch = resolveElementByLabel(normalized);
  if (labelMatch) {
    return labelMatch;
  }

  return null;
}

type DirectTargetPayload = ContentTargetPayload;
type DirectFillPayload = ContentTargetPayload & { value: string; clearBeforeTyping?: boolean };
type DirectPressPayload = ContentTargetPayload & { key?: string; submitForm?: boolean };

function buildDirectTargetPayload(payload: Record<string, unknown>): DirectTargetPayload {
  const target: DirectTargetPayload = {};
  if (typeof payload.selector === "string") {
    target.selector = payload.selector;
  }
  if (typeof payload.bridgeId === "string") {
    target.bridgeId = payload.bridgeId;
  }
  if (typeof payload.label === "string") {
    target.label = payload.label;
  }

  return target;
}

function resolveTargetFromPayload(payload: DirectTargetPayload): HTMLElement | null {
  if (typeof payload.bridgeId === "string" && payload.bridgeId.trim()) {
    const bridgeTarget = resolveRegistryElement(payload.bridgeId);
    if (bridgeTarget) {
      return bridgeTarget;
    }
  }

  if (typeof payload.selector === "string" && payload.selector.trim()) {
    const selectorTarget = resolveSelectorToElement(payload.selector);
    if (selectorTarget) {
      return selectorTarget;
    }
  }

  if (typeof payload.label === "string" && payload.label.trim()) {
    const labelTarget = resolveElementByLabel(payload.label);
    if (labelTarget) {
      return labelTarget;
    }
  }

  return null;
}

function createDirectActionResult(
  tabId: number,
  kind: Extract<ActionKind, "click" | "fill" | "press">,
  success: boolean,
  message: string,
  details?: string,
): ActionResult {
  return {
    actionId: makeId(`live-${kind}`),
    approvalId: undefined,
    tabId,
    kind,
    success,
    message,
    executedAt: nowIso(),
    details,
  };
}

function dispatchKeyboardEvent(target: HTMLElement, key: string, type: "keydown" | "keypress" | "keyup"): void {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  target.dispatchEvent(
    new KeyboardEvent(type, {
      key,
      code,
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );
}

function performDirectClick(tabId: number, payload: DirectTargetPayload): ActionResult {
  const target = resolveTargetFromPayload(payload);
  if (!target) {
    throw new Error("The target element is no longer available.");
  }

  if (isSensitiveElement(target)) {
    throw new Error("Sensitive fields are blocked.");
  }

  registerResolvedElement(target);
  target.focus?.();
  target.click();
  schedulePageStateBroadcast("mutation");
  return createDirectActionResult(tabId, "click", true, "Clicked the selected element.", `Target: ${target.tagName.toLowerCase()}.`);
}

function performDirectFill(tabId: number, payload: DirectFillPayload): ActionResult {
  const value = payload.value;
  const target = resolveTargetFromPayload(payload);
  if (!target || !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)) {
    throw new Error("The target field is no longer available.");
  }

  if (isSensitiveElement(target)) {
    throw new Error("Sensitive fields are blocked.");
  }

  registerResolvedElement(target);
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.focus();
    const nextValue = payload.clearBeforeTyping === false ? `${getFieldValue(target)}${value}` : value;
    setFieldValue(target, nextValue);
  } else {
    target.focus();
    if (payload.clearBeforeTyping !== false) {
      target.textContent = "";
    }
    if (document.queryCommandSupported?.("insertText")) {
      document.execCommand("insertText", false, value);
    } else {
      target.textContent = `${target.textContent ?? ""}${value}`;
    }
    target.dispatchEvent(new Event("input", { bubbles: true, cancelable: true, composed: true }));
  }

  schedulePageStateBroadcast("mutation");
  return createDirectActionResult(tabId, "fill", true, "Typed text into the selected field.", `Inserted ${value.length} characters.`);
}

function performDirectPress(tabId: number, payload: DirectPressPayload): ActionResult {
  const key = typeof payload.key === "string" && payload.key.trim() ? payload.key : "Enter";
  const target = resolveTargetFromPayload(payload) ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  if (!target) {
    throw new Error("The target element is no longer available.");
  }

  registerResolvedElement(target);
  target.focus?.();
  dispatchKeyboardEvent(target, key, "keydown");
  dispatchKeyboardEvent(target, key, "keypress");
  dispatchKeyboardEvent(target, key, "keyup");

  const shouldSubmit = key === "Enter" && payload.submitForm !== false;
  const form = shouldSubmit ? target.closest("form") : null;
  if (form instanceof HTMLFormElement) {
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      form.submit();
    }
    schedulePageStateBroadcast("navigation");
    return createDirectActionResult(tabId, "press", true, `Pressed ${key} and submitted the active form.`, `Target: ${target.tagName.toLowerCase()}.`);
  }

  schedulePageStateBroadcast("mutation");
  return createDirectActionResult(tabId, "press", true, `Pressed ${key}.`, `Target: ${target.tagName.toLowerCase()}.`);
}

function resolveActionTarget(action: ActionRequest): HTMLElement | null {
  const targetById = "elementId" in action ? resolveRegistryElement(action.elementId) : null;
  if (targetById) {
    return targetById;
  }

  if ("selector" in action && action.selector) {
    return resolveSelectorToElement(action.selector);
  }

  return null;
}

function isEditableContent(element: HTMLElement): element is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable;
}

async function performAction(action: ActionRequest) {
  const startedAt = nowIso();

  switch (action.kind) {
    case "click": {
      const target = resolveActionTarget(action);
      if (!target) {
        throw new Error(`The target element "${action.elementId}" is no longer available.`);
      }

      if (isSensitiveElement(target)) {
        throw new Error("Sensitive fields are blocked.");
      }

      registerResolvedElement(target);
      target.focus?.();
      target.click();
      schedulePageStateBroadcast("mutation");
      return createActionResult(action, action.tabId, true, "Clicked the selected element.", `Target: ${target.tagName.toLowerCase()}.`);
    }
    case "type": {
      const target = resolveActionTarget(action);
      if (!target || !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)) {
        throw new Error(`The target input "${action.elementId}" is no longer available.`);
      }

      if (isSensitiveElement(target)) {
        throw new Error("Sensitive fields are blocked.");
      }

      registerResolvedElement(target);
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        target.focus();
        const nextValue = action.clearBeforeTyping === false ? `${getFieldValue(target)}${action.text}` : action.text;
        setFieldValue(target, nextValue);
      } else {
        target.focus();
        if (action.clearBeforeTyping !== false) {
          target.textContent = "";
        }
        if (document.queryCommandSupported?.("insertText")) {
          document.execCommand("insertText", false, action.text);
        } else {
          target.textContent = `${target.textContent ?? ""}${action.text}`;
        }
        target.dispatchEvent(new Event("input", { bubbles: true, cancelable: true, composed: true }));
      }

      schedulePageStateBroadcast("mutation");
      return createActionResult(action, action.tabId, true, "Typed text into the selected field.", `Inserted ${action.text.length} characters.`);
    }
    case "select": {
      const target = resolveActionTarget(action);
      if (!target || !(target instanceof HTMLSelectElement)) {
        throw new Error(`The target dropdown "${action.elementId}" is no longer available.`);
      }

      registerResolvedElement(target);
      const selectedLabel = selectOption(target, action);
      schedulePageStateBroadcast("mutation");
      return createActionResult(action, action.tabId, true, "Selected a dropdown option.", `Selected ${selectedLabel}.`);
    }
    case "scroll": {
      const amount = getActionScrollAmount(action);
      const delta = action.direction === "up" ? -amount : action.direction === "down" ? amount : 0;
      const horizontalDelta = action.direction === "left" ? -amount : action.direction === "right" ? amount : 0;
      window.scrollBy({ top: delta, left: horizontalDelta, behavior: "smooth" });
      schedulePageStateBroadcast("mutation");
      return createActionResult(action, action.tabId, true, `Scrolled ${action.direction}.`, `Amount: ${amount}px.`);
    }
    case "navigate-back": {
      history.back();
      schedulePageStateBroadcast("navigation");
      return createActionResult(action, action.tabId, true, "Navigated back.", `Started at ${startedAt}.`);
    }
    case "navigate-forward": {
      history.forward();
      schedulePageStateBroadcast("navigation");
      return createActionResult(action, action.tabId, true, "Navigated forward.", `Started at ${startedAt}.`);
    }
    case "refresh": {
      location.reload();
      schedulePageStateBroadcast("reload");
      return createActionResult(action, action.tabId, true, "Reloaded the current page.", `Started at ${startedAt}.`);
    }
    case "submit-form": {
      const target = resolveActionTarget(action);
      if (!target) {
        throw new Error(`The target form "${action.elementId}" is no longer available.`);
      }

      registerResolvedElement(target);
      const form = target instanceof HTMLFormElement ? target : target.closest("form");
      if (!form) {
        throw new Error("No form was found for the selected target.");
      }

      if (form.querySelector("input[type='password'], input[type='file']")) {
        throw new Error("Submitting forms with sensitive fields is blocked in v1.");
      }

      if (typeof form.requestSubmit === "function") {
        const submitter = target instanceof HTMLButtonElement || (target instanceof HTMLInputElement && target.type === "submit") ? target : undefined;
        form.requestSubmit(submitter as HTMLElement | undefined);
      } else {
        form.submit();
      }

      schedulePageStateBroadcast("navigation");
      return createActionResult(action, action.tabId, true, "Submitted the selected form.", `Started at ${startedAt}.`);
    }
  }
}

function bootstrap(): void {
  if (runtimeState.initialized) {
    return;
  }

  runtimeState.initialized = true;
  installHistoryHooks();
  installMutationObserver();
  void broadcastPageState("initial");
  void bootstrapLiveTakeoverFromContext();

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isContentRequest(message)) {
      return;
    }

    void (async () => {
      switch (message.kind) {
        case "ping": {
          const state = capturePageState(document, getNavigationMode());
          sendResponse({
            kind: "ping",
            state,
          });
          return;
        }
        case "set-live-takeover": {
          if (message.enabled) {
            startLiveTakeoverLoop(message.endpoint, message.tabId, message.windowId);
          } else {
            stopLiveTakeoverLoop();
          }

          sendResponse({
            kind: "live-takeover-state",
            enabled: message.enabled,
            endpoint: message.endpoint,
            tabId: message.tabId,
            windowId: message.windowId,
            lastHeartbeat: runtimeState.liveTakeover.lastHeartbeat,
          });
          return;
        }
        case "capture-page": {
          const capture = createSnapshotForMode(document, message.mode, getNavigationMode());
          runtimeState.registry = capture.registry;
          runtimeState.lastSnapshot = capture.snapshot;
          capture.snapshot.tabId = -1;
          sendResponse({
            kind: "page-snapshot",
            snapshot: capture.snapshot,
          });
          return;
        }
        case "resolve-selector": {
          const target = resolveSelectorToElement(message.selector);
          const elementId = target ? registerResolvedElement(target) : null;
          sendResponse({
            kind: "resolve-selector-result",
            selector: message.selector,
            elementId,
            tagName: target?.tagName.toLowerCase() ?? null,
            label: target ? getElementTextSnapshot(target) || target.getAttribute("aria-label") || target.getAttribute("title") || target.tagName.toLowerCase() : null,
          });
          return;
        }
        case "perform-action": {
          const result = await performAction(message.action);
          runtimeState.lastSnapshot = createSnapshotForMode(document, "summary", getNavigationMode()).snapshot;
          sendResponse({
            kind: "action-result",
            result,
          });
          return;
        }
        case "click": {
          const result = performDirectClick(message.tabId, message.payload);
          runtimeState.lastSnapshot = createSnapshotForMode(document, "summary", getNavigationMode()).snapshot;
          sendResponse({
            kind: "action-result",
            result,
          });
          return;
        }
        case "fill": {
          const result = performDirectFill(message.tabId, message.payload);
          runtimeState.lastSnapshot = createSnapshotForMode(document, "summary", getNavigationMode()).snapshot;
          sendResponse({
            kind: "action-result",
            result,
          });
          return;
        }
        case "press": {
          const result = performDirectPress(message.tabId, message.payload);
          runtimeState.lastSnapshot = createSnapshotForMode(document, "summary", getNavigationMode()).snapshot;
          sendResponse({
            kind: "action-result",
            result,
          });
          return;
        }
      }
    })().catch((error) => {
      sendResponse({
        kind: "content-error",
        error: normalizeError(error, "CONTENT_HANDLER_FAILED", { recoverable: true }),
      });
    });

    return true;
  });
}

bootstrap();
