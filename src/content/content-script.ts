import { PAGE_MUTATION_DEBOUNCE_MS } from "../shared/constants";
import { createActionResult, createSnapshotForMode, getActionScrollAmount, getElementTextSnapshot, isSensitiveElement } from "../shared/dom";
import { normalizeError, nowIso } from "../shared/logger";
import { isContentRequest } from "../shared/messages";
import type { ActionRequest, NavigationMode, PageSnapshot, PageStateBasic } from "../shared/types";

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
}

const runtimeState: ContentRuntimeState = (window.__codexBrowserCompanionContent ??= {
  initialized: false,
  navigationMode: "document",
  registry: new Map(),
  lastSnapshot: null,
  mutationTimer: null,
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
  const pageState = createSnapshotForMode(document, "summary", getNavigationMode()).snapshot;
  const state: PageStateBasic = {
    url: pageState.url,
    title: pageState.title,
    readyState: document.readyState,
    navigationMode: getNavigationMode(),
    pageKind: pageState.pageKind,
    interactiveCount: pageState.meta.interactiveCount,
    formCount: pageState.meta.formCount,
    visibleTextLength: pageState.meta.visibleTextLength,
    hasSensitiveInputs: pageState.meta.hasSensitiveInputs,
    siteAdapterId: pageState.siteAdapter?.id ?? null,
    siteAdapterLabel: pageState.siteAdapter?.label ?? null,
    updatedAt: nowIso(),
  };

  await chrome.runtime.sendMessage({
    kind: "page-state",
    state,
    reason,
  });
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

  return null;
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

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isContentRequest(message)) {
      return;
    }

    void (async () => {
      switch (message.kind) {
        case "ping": {
          const state = createSnapshotForMode(document, "summary", getNavigationMode());
          runtimeState.registry = state.registry;
          runtimeState.lastSnapshot = state.snapshot;
          sendResponse({
            kind: "ping",
            state: {
              url: state.snapshot.url,
              title: state.snapshot.title,
              readyState: document.readyState,
              navigationMode: getNavigationMode(),
              pageKind: state.snapshot.pageKind,
              interactiveCount: state.snapshot.meta.interactiveCount,
              formCount: state.snapshot.meta.formCount,
              visibleTextLength: state.snapshot.meta.visibleTextLength,
              hasSensitiveInputs: state.snapshot.meta.hasSensitiveInputs,
              updatedAt: nowIso(),
            },
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
