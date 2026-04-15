import { DEFAULT_SCROLL_AMOUNT, MAX_FORM_FIELDS, MAX_HEADINGS, MAX_INTERACTIVE_ELEMENTS, MAX_LINKS, MAX_VISIBLE_TEXT_CHARS } from "./constants";
import { nowIso } from "./logger";
import type {
  ActionRequest,
  BoxRect,
  FormFieldSummary,
  FormSummary,
  HeadingSummary,
  InteractiveElementSummary,
  LinkSummary,
  NavigationMode,
  PageKind,
  PageMeta,
  PageSnapshot,
  PageStateBasic,
  ScanMode,
  SemanticNode,
  SuggestedAction,
  SuggestedRequest,
} from "./types";

interface SnapshotCaptureOptions {
  mode: ScanMode;
  navigationMode: NavigationMode;
}

interface RegistryHandle {
  registry: Map<string, HTMLElement>;
  assign(element: HTMLElement): string;
}

function createRegistryHandle(): RegistryHandle {
  const elementToId = new WeakMap<HTMLElement, string>();
  const registry = new Map<string, HTMLElement>();
  let index = 0;

  return {
    registry,
    assign(element: HTMLElement) {
      const existing = elementToId.get(element);
      if (existing) {
        return existing;
      }

      index += 1;
      const id = `codex-${index}`;
      elementToId.set(element, id);
      registry.set(id, element);
      return id;
    },
  };
}

function toIso() {
  return nowIso();
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }

  return `${input.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function cssEscape(value: string): string {
  const escape = globalThis.CSS?.escape;
  if (typeof escape === "function") {
    return escape(value);
  }

  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function isElementVisible(element: Element): boolean {
  const htmlElement = element as HTMLElement;
  if (htmlElement.hidden || htmlElement.getAttribute("aria-hidden") === "true") {
    return false;
  }

  const ancestorHidden = htmlElement.closest('[hidden], [aria-hidden="true"]');
  if (ancestorHidden && ancestorHidden !== htmlElement) {
    return false;
  }

  const win = htmlElement.ownerDocument.defaultView;
  if (win) {
    const style = win.getComputedStyle(htmlElement);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
  }

  const rect = htmlElement.getBoundingClientRect?.();
  if (rect && rect.width === 0 && rect.height === 0 && !isLikelyVisibleControl(htmlElement) && !cleanText(htmlElement.textContent ?? "")) {
    return false;
  }

  return true;
}

function isLikelyVisibleControl(element: Element): boolean {
  return (
    element.matches("button, a[href], input, select, textarea, summary, [role='button'], [role='link'], [contenteditable='true']")
  );
}

function cleanText(input: string): string {
  return normalizeWhitespace(input.replace(/\u00a0/g, " "));
}

function getTextSnippet(element: HTMLElement, maxChars = 120): string {
  const text = cleanText(element.textContent ?? "");
  if (text) {
    return truncate(text, maxChars);
  }

  const tagName = element.tagName.toLowerCase();
  if (tagName === "input") {
    const input = element as HTMLInputElement;
    const type = cleanText(element.getAttribute("type") ?? "").toLowerCase();
    const value = type === "password" ? "" : cleanText(input.value);
    return truncate(value, maxChars);
  }

  if (tagName === "textarea") {
    const textarea = element as HTMLTextAreaElement;
    return truncate(cleanText(textarea.value), maxChars);
  }

  return "";
}

function getLabelFromIdRefs(element: Element, attributeName: "aria-labelledby" | "for"): string {
  const raw = element.getAttribute(attributeName);
  if (!raw) {
    return "";
  }

  const ids = raw.split(/\s+/).filter(Boolean);
  const doc = element.ownerDocument;
  const parts = ids
    .map((id) => doc.getElementById(id))
    .filter((candidate): candidate is HTMLElement => Boolean(candidate))
    .map((candidate) => cleanText(candidate.textContent ?? ""));

  return cleanText(parts.join(" "));
}

function resolveLabel(element: Element): string {
  const ariaLabel = cleanText(element.getAttribute("aria-label") ?? "");
  if (ariaLabel) {
    return ariaLabel;
  }

  const labelledBy = getLabelFromIdRefs(element, "aria-labelledby");
  if (labelledBy) {
    return labelledBy;
  }

  const tagName = element.tagName.toLowerCase();
  if (tagName === "input" || tagName === "select" || tagName === "textarea") {
    if (element.id) {
      const label = element.ownerDocument.querySelector(`label[for="${cssEscape(element.id)}"]`);
      if (label) {
        const text = cleanText(label.textContent ?? "");
        if (text) {
          return text;
        }
      }
    }

    const wrappingLabel = element.closest("label");
    if (wrappingLabel) {
      const text = cleanText(wrappingLabel.textContent ?? "");
      if (text) {
        return text;
      }
    }
  }

  const placeholder = cleanText(element.getAttribute("placeholder") ?? "");
  if (placeholder) {
    return placeholder;
  }

  const title = cleanText(element.getAttribute("title") ?? "");
  if (title) {
    return title;
  }

  const text = cleanText(element.textContent ?? "");
  if (text) {
    return text;
  }

  if (tagName === "input" && cleanText(element.getAttribute("type") ?? "").toLowerCase() !== "password") {
    const value = cleanText((element as HTMLInputElement).value);
    if (value) {
      return value;
    }
  }

  return "";
}

function resolveRole(element: Element): string {
  const role = cleanText(element.getAttribute("role") ?? "");
  if (role) {
    return role;
  }

  const tagName = element.tagName.toLowerCase();

  if (tagName === "button") {
    return "button";
  }

  if (tagName === "a") {
    return "link";
  }

  if (tagName === "input") {
    return cleanText(element.getAttribute("type") ?? "") || "input";
  }

  if (tagName === "select") {
    return "select";
  }

  if (tagName === "textarea") {
    return "textbox";
  }

  return element.tagName.toLowerCase();
}

function buildCssPath(element: Element): string {
  if (element.id) {
    return `#${cssEscape(element.id)}`;
  }

  const segments: string[] = [];
  let current: Element | null = element;

  while (current && current.tagName.toLowerCase() !== "html" && segments.length < 5) {
    const tagName = current.tagName.toLowerCase();
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) {
      segments.unshift(tagName);
      break;
    }

    const currentTagName = current.tagName;
    const siblings = Array.from(parent.children).filter((candidate: Element) => candidate.tagName === currentTagName);
    const index = siblings.indexOf(current) + 1;
    segments.unshift(`${tagName}:nth-of-type(${index})`);
    current = parent;
  }

  return segments.join(" > ");
}

function measureRect(element: HTMLElement): BoxRect {
  const rect = element.getBoundingClientRect?.();
  if (!rect) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function isSensitiveField(element: HTMLElement): boolean {
  const tagName = element.tagName.toLowerCase();
  if (tagName === "input") {
    const type = cleanText(element.getAttribute("type") ?? "").toLowerCase();
    return type === "password" || type === "file";
  }

  const autocomplete = cleanText(element.getAttribute("autocomplete") ?? "").toLowerCase();
  return autocomplete.includes("password") || autocomplete.includes("cc-") || autocomplete.includes("one-time-code");
}

function extractVisibleText(root: ParentNode, maxChars = MAX_VISIBLE_TEXT_CHARS): string {
  const body = root as unknown as HTMLElement;
  const innerText = typeof body.innerText === "string" ? body.innerText : "";
  if (innerText) {
    return truncate(cleanText(innerText), maxChars);
  }

  const doc = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
  if (!doc) {
    return "";
  }

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segments: string[] = [];
  let current: Node | null = walker.nextNode();

  while (current) {
    const text = cleanText(current.textContent ?? "");
    if (text) {
      const parent = current.parentElement;
      if (parent && isElementVisible(parent)) {
        segments.push(text);
      }
    }

    if (segments.join(" ").length >= maxChars) {
      break;
    }

    current = walker.nextNode();
  }

  return truncate(cleanText(segments.join(" ")), maxChars);
}

function extractHeadings(document: Document): HeadingSummary[] {
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  return headings
    .filter((heading) => isElementVisible(heading))
    .slice(0, MAX_HEADINGS)
    .map((heading) => {
      const level = Number.parseInt(heading.tagName.slice(1), 10) || 0;
      return {
        level,
        text: truncate(cleanText(heading.textContent ?? ""), 160),
        selector: buildCssPath(heading),
        id: heading.id || undefined,
      };
    });
}

function captureInteractiveElements(document: Document, registry: RegistryHandle): InteractiveElementSummary[] {
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
  ).filter((element) => isElementVisible(element));

  return candidates.slice(0, MAX_INTERACTIVE_ELEMENTS).map((element) => {
    const elementId = registry.assign(element);
    const tagName = element.tagName.toLowerCase();
    const type = tagName === "input" ? cleanText(element.getAttribute("type") ?? "") || undefined : undefined;
    const isSelected = tagName === "option" ? (element as HTMLOptionElement).selected : undefined;
    const href = tagName === "a" ? (element as HTMLAnchorElement).href : undefined;

    return {
      elementId,
      tagName,
      role: resolveRole(element),
      text: tagName === "input" ? "" : getTextSnippet(element),
      label: resolveLabel(element),
      type,
      name: cleanText(element.getAttribute("name") ?? "") || undefined,
      placeholder: cleanText(element.getAttribute("placeholder") ?? "") || undefined,
      href,
      checked: tagName === "input" ? (element as HTMLInputElement).checked : undefined,
      disabled: element.matches(":disabled"),
      selected: isSelected,
      contentEditable: element.isContentEditable || undefined,
      formAssociated: Boolean(element.closest("form")),
      selector: buildCssPath(element),
      rect: measureRect(element),
      isSensitive: isSensitiveField(element),
    };
  });
}

function captureLinks(document: Document, registry: RegistryHandle): LinkSummary[] {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).filter((link) => isElementVisible(link));
  return links.slice(0, MAX_LINKS).map((link) => {
    const href = link.href;
    const external = (() => {
      try {
        return new URL(href).origin !== new URL(document.location.href).origin;
      } catch {
        return false;
      }
    })();

    return {
      elementId: registry.assign(link),
      text: truncate(resolveLabel(link) || getTextSnippet(link), 120),
      href,
      external,
      selector: buildCssPath(link),
      rect: measureRect(link),
    };
  });
}

function captureForms(document: Document, registry: RegistryHandle): FormSummary[] {
  const forms = Array.from(document.querySelectorAll<HTMLFormElement>("form")).filter((form) => isElementVisible(form));

  return forms.slice(0, Math.max(1, MAX_INTERACTIVE_ELEMENTS)).map((form) => {
    const fields = Array.from(form.querySelectorAll<HTMLElement>("input, select, textarea"))
      .filter((field) => isElementVisible(field))
      .slice(0, MAX_FORM_FIELDS);

    const fieldSummaries: FormFieldSummary[] = fields.map((field) => {
      const fieldElementId = registry.assign(field);
      const tagName = field.tagName.toLowerCase();
      const type = tagName === "input" ? cleanText(field.getAttribute("type") ?? "") || undefined : undefined;

      return {
        elementId: fieldElementId,
        tagName,
        type,
        label: resolveLabel(field),
        name: cleanText(field.getAttribute("name") ?? "") || undefined,
        placeholder: cleanText(field.getAttribute("placeholder") ?? "") || undefined,
        required: field.matches("[required]"),
        disabled: field.matches(":disabled"),
        isSensitive: isSensitiveField(field),
        selector: buildCssPath(field),
      };
    });

    const legend = form.querySelector("legend");
    const label =
      cleanText(form.getAttribute("aria-label") ?? "") ||
      cleanText(form.getAttribute("title") ?? "") ||
      (legend ? cleanText(legend.textContent ?? "") : "") ||
      cleanText(form.textContent ?? "");

    return {
      elementId: registry.assign(form),
      label: truncate(label || "Form", 120),
      selector: buildCssPath(form),
      action: cleanText(form.getAttribute("action") ?? "") || undefined,
      method: cleanText(form.getAttribute("method") ?? "") || undefined,
      fieldCount: fieldSummaries.length,
      hasPasswordField: fieldSummaries.some((field) => field.isSensitive),
      hasFileField: fieldSummaries.some((field) => field.type === "file"),
      fields: fieldSummaries,
    };
  });
}

function captureSemanticOutline(document: Document, headings: HeadingSummary[]): SemanticNode[] {
  const landmarkSelectors = [
    "main",
    "nav",
    "article",
    "aside",
    "header",
    "footer",
    "section",
    "[role='main']",
    "[role='navigation']",
    "[role='search']",
    "[role='dialog']",
    "[role='form']",
  ];

  const landmarks = Array.from(document.querySelectorAll<HTMLElement>(landmarkSelectors.join(",")))
    .filter((landmark) => isElementVisible(landmark))
    .slice(0, 12)
    .map((landmark) => ({
      kind: "landmark" as const,
      text: truncate(resolveLabel(landmark) || getTextSnippet(landmark) || landmark.tagName.toLowerCase(), 160),
      role: resolveRole(landmark),
      level: undefined,
      selector: buildCssPath(landmark),
      children: undefined,
    }));

  const headingNodes = headings.slice(0, MAX_HEADINGS).map((heading) => ({
    kind: "heading" as const,
    text: heading.text,
    level: heading.level,
    selector: heading.selector,
    role: undefined,
    children: undefined,
  }));

  return [...landmarks, ...headingNodes];
}

function derivePageKind(state: PageStateBasic, headings: HeadingSummary[], forms: FormSummary[]): PageKind {
  const hasLoginSignals = forms.some((form) => form.hasPasswordField) || headings.some((heading) => /sign in|log in|login/i.test(heading.text));
  const hasFormSignals = forms.length > 0;
  const isArticleLike = state.visibleTextLength > 3000 && headings.length >= 2;
  const isSpaLike = state.navigationMode === "spa";

  if (hasLoginSignals) {
    return "login";
  }

  if (hasFormSignals) {
    return "form";
  }

  if (isArticleLike) {
    return "article";
  }

  if (isSpaLike) {
    return "spa";
  }

  if (headings.length > 0 || state.interactiveCount > 0) {
    return "mixed";
  }

  return "document";
}

function summarizePageState(state: PageStateBasic, headings: HeadingSummary[], forms: FormSummary[], interactiveCount: number): string {
  const kindLabel = state.pageKind === "unknown" ? "page" : `${state.pageKind} page`;
  const parts = [
    `${state.title || "Untitled"} on ${new URL(state.url).hostname}.`,
    `This is a ${kindLabel} with ${headings.length} heading${headings.length === 1 ? "" : "s"}, ${forms.length} form${forms.length === 1 ? "" : "s"}, and ${interactiveCount} interactive control${interactiveCount === 1 ? "" : "s"}.`,
  ];

  if (state.hasSensitiveInputs) {
    parts.push("Sensitive inputs are present. Password values are not captured and the extension will not type into them.");
  }

  if (state.pageKind === "article") {
    parts.push("The page looks article-like, so summarize or read the headings first.");
  }

  return parts.join(" ");
}

function buildSuggestedActions(snapshot: PageSnapshot): SuggestedAction[] {
  const suggestions: SuggestedAction[] = [
    {
      id: "summarize-page",
      title: "Summarize page",
      description: "Generate a concise summary of the current page.",
      buttonLabel: "Summarize",
      request: { kind: "scan-page", mode: "summary" },
      approvalRequired: false,
      dangerLevel: "low",
    },
    {
      id: "list-interactive-elements",
      title: "List interactive elements",
      description: "Inspect visible buttons, links, inputs, and other controls.",
      buttonLabel: "Inspect",
      request: { kind: "scan-page", mode: "interactive" },
      approvalRequired: false,
      dangerLevel: "low",
    },
  ];

  if (snapshot.pageKind === "article") {
    suggestions.push({
      id: "article-review",
      title: "Review article structure",
      description: "Use the heading outline to move through the page in sections.",
      buttonLabel: "Review",
      request: { kind: "scan-page", mode: "summary" },
      approvalRequired: false,
      dangerLevel: "low",
    });
  }

  if (snapshot.pageKind === "form" || snapshot.pageKind === "login") {
    suggestions.push({
      id: "form-review",
      title: "Review form controls",
      description: "Inspect the form fields before typing or submitting anything.",
      buttonLabel: "Review",
      request: { kind: "scan-page", mode: "interactive" },
      approvalRequired: false,
      dangerLevel: "low",
    });
  }

  if (snapshot.pageKind === "spa") {
    suggestions.push({
      id: "spa-rescan",
      title: "Rescan after route changes",
      description: "Single-page apps often mutate the page without a full reload.",
      buttonLabel: "Rescan",
      request: { kind: "scan-page", mode: "full" },
      approvalRequired: false,
      dangerLevel: "low",
    });
  }

  return suggestions.slice(0, 4);
}

export function capturePageState(document: Document, navigationMode: NavigationMode): PageStateBasic {
  const registry = createRegistryHandle();
  const interactiveCount = captureInteractiveElements(document, registry).length;
  const forms = captureForms(document, registry);
  const visibleText = extractVisibleText(document.body ?? document.documentElement);
  const headings = extractHeadings(document);
  const hasSensitiveInputs = forms.some((form) => form.hasPasswordField || form.hasFileField);
  const provisionalState: PageStateBasic = {
    url: document.location.href,
    title: cleanText(document.title || "Untitled"),
    readyState: document.readyState,
    navigationMode,
    pageKind: "unknown",
    interactiveCount,
    formCount: forms.length,
    visibleTextLength: visibleText.length,
    hasSensitiveInputs,
    updatedAt: toIso(),
  };

  return {
    ...provisionalState,
    pageKind: derivePageKind(provisionalState, headings, forms),
  };
}

export function capturePageSnapshot(document: Document, options: SnapshotCaptureOptions): { snapshot: PageSnapshot; registry: Map<string, HTMLElement> } {
  const registry = createRegistryHandle();
  const visibleText = options.mode === "interactive" ? "" : extractVisibleText(document.body ?? document.documentElement);
  const headings = extractHeadings(document);
  const interactiveElements = captureInteractiveElements(document, registry);
  const links = captureLinks(document, registry);
  const forms = captureForms(document, registry);
  const pageState: PageStateBasic = {
    url: document.location.href,
    title: cleanText(document.title || "Untitled"),
    readyState: document.readyState,
    navigationMode: options.navigationMode,
    pageKind: "unknown",
    interactiveCount: interactiveElements.length,
    formCount: forms.length,
    visibleTextLength: visibleText.length,
    hasSensitiveInputs: forms.some((form) => form.hasPasswordField || form.hasFileField),
    updatedAt: toIso(),
  };

  const pageKind = derivePageKind(pageState, headings, forms);
  const completedState = { ...pageState, pageKind };
  const semanticOutline = captureSemanticOutline(document, headings);
  const snapshotBase: Omit<PageSnapshot, "summary" | "suggestedActions"> = {
    snapshotId: globalThis.crypto?.randomUUID?.() ?? `snapshot_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    tabId: -1,
    url: document.location.href,
    title: completedState.title,
    captureMode: options.mode,
    capturedAt: toIso(),
    pageKind,
    navigationMode: options.navigationMode,
    visibleText,
    visibleTextExcerpt: truncate(visibleText, 800),
    textLength: visibleText.length,
    meta: {
      navigationMode: options.navigationMode,
      readyState: document.readyState,
      interactiveCount: interactiveElements.length,
      linkCount: links.length,
      formCount: forms.length,
      headingCount: headings.length,
      visibleTextLength: visibleText.length,
      hasSensitiveInputs: completedState.hasSensitiveInputs,
      isArticleLike: pageKind === "article",
      isLoginLike: pageKind === "login",
      isSinglePageApp: options.navigationMode === "spa",
    },
    headings,
    links,
    forms,
    interactiveElements,
    semanticOutline,
  };

  const snapshot: PageSnapshot = {
    ...snapshotBase,
    summary: summarizePageState(completedState, headings, forms, interactiveElements.length),
    suggestedActions: buildSuggestedActions({
      ...snapshotBase,
      summary: "",
      suggestedActions: [],
    }),
  };

  snapshot.suggestedActions = buildSuggestedActions(snapshot);

  return { snapshot, registry: registry.registry };
}

export function createActionResult(action: ActionRequest, tabId: number, success: boolean, message: string, details?: string, approvalId?: string): import("./types").ActionResult {
  return {
    actionId: action.actionId,
    approvalId,
    tabId,
    kind: action.kind,
    success,
    message,
    executedAt: toIso(),
    details,
  };
}

export function buildPageStateSummary(pageState: PageStateBasic): string {
  return `${pageState.title || "Untitled"} on ${new URL(pageState.url).hostname}. ${pageState.pageKind} page with ${pageState.interactiveCount} interactive controls and ${pageState.formCount} forms.`;
}

export function getActionScrollAmount(action: ActionRequest): number {
  if (action.kind === "scroll") {
    return action.amount || DEFAULT_SCROLL_AMOUNT;
  }

  return DEFAULT_SCROLL_AMOUNT;
}

export function getElementTextSnapshot(element: HTMLElement): string {
  return getTextSnippet(element, 160);
}

export function isSensitiveElement(element: HTMLElement): boolean {
  return isSensitiveField(element);
}

export function resolvePageStateFromSnapshot(snapshot: PageSnapshot): PageStateBasic {
  return {
    url: snapshot.url,
    title: snapshot.title,
    readyState: snapshot.meta.readyState,
    navigationMode: snapshot.navigationMode,
    pageKind: snapshot.pageKind,
    interactiveCount: snapshot.meta.interactiveCount,
    formCount: snapshot.meta.formCount,
    visibleTextLength: snapshot.meta.visibleTextLength,
    hasSensitiveInputs: snapshot.meta.hasSensitiveInputs,
    updatedAt: snapshot.capturedAt,
  };
}

export function createSnapshotForMode(document: Document, mode: ScanMode, navigationMode: NavigationMode): { snapshot: PageSnapshot; registry: Map<string, HTMLElement> } {
  return capturePageSnapshot(document, { mode, navigationMode });
}

export function resolveSuggestedRequestForAction(action: ActionRequest): SuggestedRequest {
  return { kind: "request-action", action };
}
