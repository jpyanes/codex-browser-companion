import { DEFAULT_SCROLL_AMOUNT, MAX_FORM_FIELDS, MAX_HEADINGS, MAX_INTERACTIVE_ELEMENTS, MAX_LINKS, MAX_VISIBLE_TEXT_CHARS } from "./constants";
import { classifyDanger } from "./action-policy";
import { nowIso } from "./logger";
import { resolveSiteAdapterFromState, resolveSiteAdapterSnapshot } from "./site-adapters";
import { attachTabContextToAction, attachTabContextToRequest, buildTabContextFromSnapshot } from "./tab-context";
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
  SiteAdapterSummary,
  UserInterventionSummary,
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

function normalizeComparable(input: string): string {
  return normalizeWhitespace(input).toLowerCase().replace(/[^a-z0-9]+/g, " ");
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
  const pageText = normalizeComparable(
    [
      state.title,
      ...headings.map((heading) => heading.text),
      ...forms.flatMap((form) => [
        form.label,
        form.action ?? "",
        form.method ?? "",
        ...form.fields.flatMap((field) => [field.label, field.placeholder, field.name, field.type].filter((value): value is string => typeof value === "string")),
      ]),
    ]
      .filter(Boolean)
      .join(" "),
  );
  const hasLoginSignals = forms.some((form) => form.hasPasswordField) || /(?:sign in|log in|login|authenticate|verify account)/.test(pageText);
  const hasPaymentSignals =
    /(?:checkout|payment|pay now|pay|billing|card|credit card|purchase|buy now|place order|order summary|subscription|donate|invoice|wallet|paypal)/.test(pageText) ||
    /(?:card number|cvv|cvc|security code|expiration|expiry|mm yy|billing address|zip code|postal code|name on card|cardholder)/.test(pageText);
  const hasFormSignals = forms.length > 0;
  const isArticleLike = state.visibleTextLength > 3000 && headings.length >= 2;
  const isSpaLike = state.navigationMode === "spa";

  if (hasLoginSignals) {
    return "login";
  }

  if (hasPaymentSignals) {
    return "payment";
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

export function resolveUserIntervention(pageKind: PageKind | null | undefined): UserInterventionSummary | null {
  if (pageKind === "login") {
    return {
      kind: "login",
      message: "Login page detected. Please sign in manually, then type done to continue.",
    };
  }

  if (pageKind === "payment") {
    return {
      kind: "payment",
      message: "Payment page detected. Please complete the payment manually, then type done to continue.",
    };
  }

  return null;
}

function summarizePageState(
  state: PageStateBasic,
  headings: HeadingSummary[],
  forms: FormSummary[],
  interactiveCount: number,
  siteAdapter: SiteAdapterSummary | null,
): string {
  const kindLabel = state.pageKind === "unknown" ? "page" : `${state.pageKind} page`;
  const parts = [
    `${state.title || "Untitled"} on ${new URL(state.url).hostname}.`,
    `This is a ${kindLabel} with ${headings.length} heading${headings.length === 1 ? "" : "s"}, ${forms.length} form${forms.length === 1 ? "" : "s"}, and ${interactiveCount} interactive control${interactiveCount === 1 ? "" : "s"}.`,
  ];

  if (siteAdapter) {
    parts.push(siteAdapter.summary);
    if (siteAdapter.notes.length > 0) {
      parts.push(siteAdapter.notes[0]!);
    }
  }

  if (state.userInterventionMessage) {
    parts.push(state.userInterventionMessage);
  }

  if (state.hasSensitiveInputs) {
    parts.push("Sensitive inputs are present. Password values are not captured and the extension will not type into them.");
  }

  if (state.pageKind === "article") {
    parts.push("The page looks article-like, so summarize or read the headings first.");
  }

  return parts.join(" ");
}

function makeSuggestedActionId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function suggestionSignature(suggestion: SuggestedAction): string {
  const contextKey = `${suggestion.tabContext.tabId}:${suggestion.tabContext.snapshotId ?? ""}`;
  if (suggestion.request.kind === "request-action") {
    const action = suggestion.request.action;
    const elementKey = "elementId" in action ? action.elementId : "";
    const labelKey = "label" in action ? action.label ?? "" : "";
    return [
      "action",
      contextKey,
      action.kind,
      action.selector ?? elementKey,
      labelKey,
      action.workflowId ?? "",
      action.workflowStepId ?? "",
    ].join(":");
  }

  return [
    "scan",
    contextKey,
    suggestion.request.kind,
    suggestion.request.kind === "scan-page" ? suggestion.request.mode : "",
    suggestion.request.workflowId ?? "",
    suggestion.request.workflowStepId ?? "",
  ].join(":");
}

function dedupeSuggestedActions(suggestions: SuggestedAction[]): SuggestedAction[] {
  const seen = new Set<string>();
  const deduped: SuggestedAction[] = [];

  for (const suggestion of suggestions) {
    const signature = suggestionSignature(suggestion);
    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    deduped.push(suggestion);
  }

  return deduped;
}

function buildTabScopedScanSuggestion(
  snapshot: PageSnapshot,
  tabContext: ReturnType<typeof buildTabContextFromSnapshot>,
  id: string,
  title: string,
  description: string,
  mode: Extract<PageSnapshot["captureMode"], "full" | "summary" | "interactive" | "suggestions">,
  buttonLabel: string,
): SuggestedAction {
  return {
    id,
    title,
    description,
    buttonLabel,
    tabContext,
    request: attachTabContextToRequest({ kind: "scan-page", mode }, tabContext),
    approvalRequired: false,
    dangerLevel: "low",
    source: "dom",
    selector: undefined,
    confidence: undefined,
  };
}

function scorePrimaryActionCandidate(element: InteractiveElementSummary, pageKind: PageKind): number {
  if (element.isSensitive || element.disabled) {
    return -1;
  }

  const tagName = element.tagName.toLowerCase();
  const haystack = normalizeComparable(
    [element.label, element.text, element.name ?? "", element.placeholder ?? "", element.selector, element.role, element.type ?? ""]
      .filter(Boolean)
      .join(" "),
  );

  if (/\b(delete|remove|unsubscribe|cancel account|sign out|log out|purchase|pay|checkout|publish|post)\b/.test(haystack)) {
    return -1;
  }

  let score = 0;
  if (tagName === "button") {
    score += 25;
  } else if (tagName === "a") {
    score += 20;
  } else if (tagName === "summary") {
    score += 15;
  } else if (element.role.toLowerCase().includes("button")) {
    score += 18;
  }

  if (element.formAssociated) {
    score += 4;
  }

  if (element.contentEditable) {
    score += 6;
  }

  if (element.type === "submit") {
    score += 8;
  }

  if (/\b(continue|next|open|new|compose|reply|create|start|save|search|view|edit|more|details|expand|open menu)\b/.test(haystack)) {
    score += 35;
  }

  if (/\b(like|react|follow|accept|approve|confirm|details)\b/.test(haystack)) {
    score += 16;
  }

  if (pageKind === "article" && /\b(read more|continue reading|more)\b/.test(haystack)) {
    score += 8;
  }

  if (pageKind === "spa" && /\b(refresh|reload|update)\b/.test(haystack)) {
    score += 10;
  }

  return score;
}

function buildPrimaryActionSuggestion(snapshot: PageSnapshot, tabContext: ReturnType<typeof buildTabContextFromSnapshot>): SuggestedAction | null {
  if (snapshot.pageKind === "login" || snapshot.pageKind === "payment") {
    return null;
  }

  let bestElement: InteractiveElementSummary | null = null;
  let bestScore = 0;
  for (const element of snapshot.interactiveElements) {
    const score = scorePrimaryActionCandidate(element, snapshot.pageKind);
    if (score > bestScore) {
      bestScore = score;
      bestElement = element;
    }
  }

  if (!bestElement || bestScore < 45) {
    return null;
  }

  const label = bestElement.label || bestElement.text || bestElement.placeholder || bestElement.name || "the highlighted control";
  const action = attachTabContextToAction(
    {
      actionId: makeSuggestedActionId("action"),
      tabId: snapshot.tabId,
      kind: "click",
      elementId: bestElement.elementId,
      label,
      selector: bestElement.selector,
    },
    tabContext,
  );

  return {
    id: `primary-action-${snapshot.snapshotId}-${bestElement.elementId}`,
    title: `Click ${label}`,
    description: `Use the most relevant visible control on ${snapshot.title || "the current page"} after reviewing the page context.`,
    buttonLabel: "Queue",
    tabContext,
    request: attachTabContextToRequest({ kind: "request-action", action }, tabContext),
    approvalRequired: true,
    dangerLevel: classifyDanger(action, snapshot),
    source: "dom",
    selector: bestElement.selector,
    confidence: Math.min(0.95, 0.5 + bestScore / 100),
  };
}

export function buildNextActionSuggestions(snapshot: PageSnapshot): SuggestedAction[] {
  const tabContext = buildTabContextFromSnapshot(snapshot);
  const suggestions: SuggestedAction[] = [];

  const primarySuggestion = buildPrimaryActionSuggestion(snapshot, tabContext);
  if (primarySuggestion) {
    suggestions.push(primarySuggestion);
  }

  suggestions.push(
    buildTabScopedScanSuggestion(
      snapshot,
      tabContext,
      "summarize-page",
      "Summarize page",
      "Generate a concise summary of the current page.",
      "summary",
      "Summarize",
    ),
    buildTabScopedScanSuggestion(
      snapshot,
      tabContext,
      "list-interactive-elements",
      "List interactive elements",
      "Inspect visible buttons, links, inputs, and other controls.",
      "interactive",
      "Inspect",
    ),
  );

  if (snapshot.pageKind === "article") {
    suggestions.push(
      buildTabScopedScanSuggestion(
        snapshot,
        tabContext,
        "article-review",
        "Review article structure",
        "Use the heading outline to move through the page in sections.",
        "summary",
        "Review",
      ),
    );
  }

  if (snapshot.pageKind === "form" || snapshot.pageKind === "login") {
    suggestions.push(
      buildTabScopedScanSuggestion(
        snapshot,
        tabContext,
        "form-review",
        "Review form controls",
        "Inspect the form fields before typing or submitting anything.",
        "interactive",
        "Review",
      ),
    );
  }

  if (snapshot.pageKind === "spa") {
    suggestions.push(
      buildTabScopedScanSuggestion(
        snapshot,
        tabContext,
        "spa-rescan",
        "Rescan after route changes",
        "Single-page apps often mutate the page without a full reload.",
        "full",
        "Rescan",
      ),
    );
  }

  return dedupeSuggestedActions(suggestions).slice(0, 5);
}

function buildSuggestedActions(snapshot: PageSnapshot): SuggestedAction[] {
  return buildNextActionSuggestions(snapshot);
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
    siteAdapterId: null,
    siteAdapterLabel: null,
    userInterventionKind: null,
    userInterventionMessage: null,
    updatedAt: toIso(),
  };

  const siteAdapter = resolveSiteAdapterFromState(provisionalState);
  const pageKind = derivePageKind(provisionalState, headings, forms);
  const userIntervention = resolveUserIntervention(pageKind);

  return {
    ...provisionalState,
    pageKind,
    siteAdapterId: siteAdapter?.id ?? null,
    siteAdapterLabel: siteAdapter?.label ?? null,
    userInterventionKind: userIntervention?.kind ?? null,
    userInterventionMessage: userIntervention?.message ?? null,
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
    siteAdapterId: null,
    siteAdapterLabel: null,
    userInterventionKind: null,
    userInterventionMessage: null,
    updatedAt: toIso(),
  };

  const pageKind = derivePageKind(pageState, headings, forms);
  const userIntervention = resolveUserIntervention(pageKind);
  const completedState = {
    ...pageState,
    pageKind,
    userInterventionKind: userIntervention?.kind ?? null,
    userInterventionMessage: userIntervention?.message ?? null,
  };
  const semanticOutline = captureSemanticOutline(document, headings);
  const siteResolution = resolveSiteAdapterSnapshot({
    snapshotId: "",
    tabId: -1,
    url: document.location.href,
    title: completedState.title,
    captureMode: options.mode,
    capturedAt: toIso(),
    pageKind,
    navigationMode: options.navigationMode,
    visibleText,
    visibleTextExcerpt: "",
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
    siteAdapter: null,
    suggestedActions: [],
    summary: "",
  });
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
    siteAdapter: siteResolution.siteAdapter,
    userInterventionKind: completedState.userInterventionKind,
    userInterventionMessage: completedState.userInterventionMessage,
  };

  const snapshot: PageSnapshot = {
    ...snapshotBase,
    summary: summarizePageState(completedState, headings, forms, interactiveElements.length, siteResolution.siteAdapter),
    suggestedActions: dedupeSuggestedActions([
      ...buildSuggestedActions({
        ...snapshotBase,
        siteAdapter: siteResolution.siteAdapter,
        summary: "",
        suggestedActions: [],
      }),
      ...siteResolution.suggestions,
    ]),
  };

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
  const adapterLabel = pageState.siteAdapterLabel ? ` ${pageState.siteAdapterLabel} detected.` : "";
  const interventionLabel = pageState.userInterventionMessage ? ` ${pageState.userInterventionMessage}` : "";
  return `${pageState.title || "Untitled"} on ${new URL(pageState.url).hostname}.${adapterLabel} ${pageState.pageKind} page with ${pageState.interactiveCount} interactive controls and ${pageState.formCount} forms.${interventionLabel}`;
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
  const userIntervention = resolveUserIntervention(snapshot.pageKind);

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
    siteAdapterId: snapshot.siteAdapter?.id ?? null,
    siteAdapterLabel: snapshot.siteAdapter?.label ?? null,
    userInterventionKind: userIntervention?.kind ?? null,
    userInterventionMessage: userIntervention?.message ?? null,
    updatedAt: snapshot.capturedAt,
  };
}

export function createSnapshotForMode(document: Document, mode: ScanMode, navigationMode: NavigationMode): { snapshot: PageSnapshot; registry: Map<string, HTMLElement> } {
  return capturePageSnapshot(document, { mode, navigationMode });
}

export function resolveSuggestedRequestForAction(action: ActionRequest): SuggestedRequest {
  return { kind: "request-action", action };
}
