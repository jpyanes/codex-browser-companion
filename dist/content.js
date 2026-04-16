"use strict";
(() => {
  // src/shared/constants.ts
  var MAX_VISIBLE_TEXT_CHARS = 12e3;
  var MAX_INTERACTIVE_ELEMENTS = 120;
  var MAX_LINKS = 80;
  var MAX_HEADINGS = 24;
  var MAX_FORM_FIELDS = 40;
  var PAGE_MUTATION_DEBOUNCE_MS = 400;
  var DEFAULT_SCROLL_AMOUNT = 600;

  // src/shared/logger.ts
  function nowIso() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  function normalizeError(error, code = "UNKNOWN_ERROR", options = {}) {
    if (typeof error === "object" && error !== null) {
      const maybeError = error;
      const message = typeof maybeError.message === "string" ? maybeError.message : "An unexpected error occurred.";
      const detailValue = typeof maybeError.details === "string" ? maybeError.details : error instanceof Error ? error.stack ?? error.message : void 0;
      return {
        code: typeof maybeError.code === "string" ? maybeError.code : code,
        message,
        details: detailValue,
        recoverable: options.recoverable ?? true,
        tabId: options.tabId,
        occurredAt: nowIso()
      };
    }
    return {
      code,
      message: typeof error === "string" ? error : "An unexpected error occurred.",
      details: void 0,
      recoverable: options.recoverable ?? true,
      tabId: options.tabId,
      occurredAt: nowIso()
    };
  }

  // src/shared/action-policy.ts
  var DANGEROUS_KEYWORDS = [
    "delete",
    "remove",
    "submit",
    "confirm",
    "purchase",
    "pay",
    "checkout",
    "unsubscribe",
    "sign out",
    "log out",
    "logoff",
    "close account",
    "cancel",
    "post",
    "publish"
  ];
  function isLikelySensitiveSnapshot(snapshot) {
    return Boolean(snapshot?.meta.hasSensitiveInputs || snapshot?.pageKind === "login" || snapshot?.pageKind === "payment");
  }
  function classifyDanger(action, snapshot) {
    if (action.kind === "submit-form") {
      return "high";
    }
    if (action.kind === "type") {
      return isLikelySensitiveSnapshot(snapshot) ? "high" : "medium";
    }
    if (action.kind === "select") {
      return "medium";
    }
    if (action.kind === "click") {
      const label = (action.label ?? "").toLowerCase();
      if (DANGEROUS_KEYWORDS.some((keyword) => label.includes(keyword))) {
        return "high";
      }
      return "medium";
    }
    return "low";
  }

  // src/shared/tab-context.ts
  function buildTabContextFromSnapshot(snapshot) {
    return {
      tabId: snapshot.tabId,
      windowId: null,
      url: snapshot.url,
      title: snapshot.title,
      pageKind: snapshot.pageKind,
      siteAdapterId: snapshot.siteAdapter?.id ?? null,
      siteAdapterLabel: snapshot.siteAdapter?.label ?? null,
      snapshotId: snapshot.snapshotId,
      capturedAt: snapshot.capturedAt
    };
  }
  function attachTabContextToAction(action, tabContext) {
    return {
      ...action,
      tabContext
    };
  }
  function attachTabContextToRequest(request, tabContext) {
    if (request.kind === "request-action") {
      return {
        ...request,
        tabContext,
        action: attachTabContextToAction(request.action, tabContext)
      };
    }
    return {
      ...request,
      tabContext
    };
  }

  // src/shared/site-adapters.ts
  function normalize(input) {
    return input.trim().replace(/\s+/g, " ").toLowerCase();
  }
  function hostFromUrl(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  }
  function makeSuggestionId(prefix) {
    return globalThis.crypto?.randomUUID?.() ?? `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
  function matchInteractiveElement(elements, matcher) {
    for (const element of elements) {
      if (matcher(element)) {
        return element;
      }
    }
    return null;
  }
  function buildClickSuggestion(snapshot, element, title, description) {
    const tabContext = buildTabContextFromSnapshot(snapshot);
    const action = attachTabContextToAction(
      {
        actionId: makeSuggestionId("action"),
        tabId: snapshot.tabId,
        kind: "click",
        elementId: element.elementId,
        label: element.label || element.text || title,
        selector: element.selector
      },
      tabContext
    );
    return {
      id: makeSuggestionId(`site-${snapshot.snapshotId}`),
      title,
      description,
      buttonLabel: "Queue",
      tabContext,
      request: attachTabContextToRequest(
        {
          kind: "request-action",
          action
        },
        tabContext
      ),
      approvalRequired: true,
      dangerLevel: classifyDanger(action, snapshot),
      source: "site",
      selector: element.selector,
      confidence: 0.9
    };
  }
  function buildAdapterSummary(id, label, kind, summary, capabilities, notes) {
    return {
      id,
      label,
      kind,
      summary,
      capabilities,
      notes
    };
  }
  function resolveSiteAdapterFromState(state) {
    const hostname = hostFromUrl(state.url);
    const title = normalize(state.title);
    if (!hostname) {
      return null;
    }
    if (hostname === "accounts.google.com" || hostname.endsWith("google.com") && state.pageKind === "login" && title.includes("sign in")) {
      return buildAdapterSummary(
        "google-login",
        "Google sign-in",
        "workspace-login",
        "Google sign-in is active. Sign in manually, then rescan so CBC can continue with the authenticated session.",
        ["manual sign-in", "session resume", "approval-gated follow-up"],
        ["CBC will not type passwords or bypass Google account security prompts."]
      );
    }
    if (hostname === "drive.google.com") {
      return buildAdapterSummary(
        "google-drive",
        "Google Drive",
        "workspace-app",
        "Google Drive is active. Use the New button or recent-file shortcuts to create or open documents.",
        ["new document", "recent files", "workspace navigation"],
        ["Use a rescan after opening or creating a file so the tab inventory stays fresh."]
      );
    }
    if (hostname === "docs.google.com") {
      return buildAdapterSummary(
        "google-docs",
        "Google Docs editor",
        "document-editor",
        "Google Docs is ready. The document canvas can be focused and typed into after approval.",
        ["document typing", "editor focus", "toolbar navigation"],
        ["If the editor is still loading, rescan after the contenteditable surface appears."]
      );
    }
    if (hostname.endsWith("linkedin.com")) {
      if (state.pageKind === "login" || title.includes("sign in") || title.includes("log in")) {
        return buildAdapterSummary(
          "linkedin-login",
          "LinkedIn sign-in",
          "workspace-login",
          "LinkedIn sign-in is active. Enter credentials manually, then rescan to continue the feed workflow.",
          ["manual sign-in", "feed resume", "approval-gated follow-up"],
          ["CBC will not type passwords into LinkedIn login forms."]
        );
      }
      return buildAdapterSummary(
        "linkedin-feed",
        "LinkedIn feed",
        "social-feed",
        "LinkedIn feed or profile content is visible. Use the visible post actions to inspect or engage with the feed.",
        ["feed navigation", "post engagement", "profile inspection"],
        ["Rescan after feed changes so the active tab snapshot stays current."]
      );
    }
    return null;
  }
  function findDocumentBodyTarget(snapshot) {
    return matchInteractiveElement(snapshot.interactiveElements, (element) => {
      const tagName = element.tagName.toLowerCase();
      const role = element.role.toLowerCase();
      return !element.isSensitive && (element.contentEditable === true || tagName === "textarea" || role === "textbox");
    });
  }
  function findLinkedInLikeTarget(snapshot) {
    return matchInteractiveElement(snapshot.interactiveElements, (element) => {
      const haystack = normalize([element.label, element.text, element.name ?? "", element.placeholder ?? "", element.selector, element.role, element.type ?? ""].join(" "));
      return !element.isSensitive && (haystack.includes("like") || haystack.includes("react"));
    });
  }
  function findGoogleDriveNewTarget(snapshot) {
    return matchInteractiveElement(snapshot.interactiveElements, (element) => {
      const haystack = normalize([element.label, element.text, element.name ?? "", element.placeholder ?? "", element.selector, element.role, element.type ?? ""].join(" "));
      return !element.isSensitive && (haystack === "new" || haystack.includes("new ") || haystack.includes("blank") || haystack.includes("create"));
    });
  }
  function resolveSiteAdapterSnapshot(snapshot) {
    const siteAdapter = resolveSiteAdapterFromState({
      url: snapshot.url,
      title: snapshot.title,
      pageKind: snapshot.pageKind
    });
    const suggestions = [];
    if (!siteAdapter) {
      return { siteAdapter: null, suggestions };
    }
    if (siteAdapter.id === "google-docs") {
      const target = findDocumentBodyTarget(snapshot);
      if (target) {
        suggestions.push(
          buildClickSuggestion(
            snapshot,
            target,
            "Focus document body",
            "Focus the document canvas so the next approved typing action lands in the editor."
          )
        );
      }
    }
    if (siteAdapter.id === "google-drive") {
      const target = findGoogleDriveNewTarget(snapshot);
      if (target) {
        suggestions.push(
          buildClickSuggestion(
            snapshot,
            target,
            "Open the New menu",
            "Open the Drive New menu so you can create a new document or file after approval."
          )
        );
      }
    }
    if (siteAdapter.id === "linkedin-feed") {
      const target = findLinkedInLikeTarget(snapshot);
      if (target) {
        suggestions.push(
          buildClickSuggestion(
            snapshot,
            target,
            "Like the first visible post",
            "Click the first visible Like control in the LinkedIn feed after you review it."
          )
        );
      }
    }
    return {
      siteAdapter,
      suggestions
    };
  }

  // src/shared/dom.ts
  function createRegistryHandle() {
    const elementToId = /* @__PURE__ */ new WeakMap();
    const registry = /* @__PURE__ */ new Map();
    let index = 0;
    return {
      registry,
      assign(element) {
        const existing = elementToId.get(element);
        if (existing) {
          return existing;
        }
        index += 1;
        const id = `codex-${index}`;
        elementToId.set(element, id);
        registry.set(id, element);
        return id;
      }
    };
  }
  function toIso() {
    return nowIso();
  }
  function normalizeWhitespace(input) {
    return input.replace(/\s+/g, " ").trim();
  }
  function normalizeComparable(input) {
    return normalizeWhitespace(input).toLowerCase().replace(/[^a-z0-9]+/g, " ");
  }
  function truncate(input, maxChars) {
    if (input.length <= maxChars) {
      return input;
    }
    return `${input.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }
  function cssEscape(value) {
    const escape = globalThis.CSS?.escape;
    if (typeof escape === "function") {
      return escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
  }
  function isElementVisible(element) {
    const htmlElement = element;
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
  function isLikelyVisibleControl(element) {
    return element.matches("button, a[href], input, select, textarea, summary, [role='button'], [role='link'], [contenteditable='true']");
  }
  function cleanText(input) {
    return normalizeWhitespace(input.replace(/\u00a0/g, " "));
  }
  function getTextSnippet(element, maxChars = 120) {
    const text = cleanText(element.textContent ?? "");
    if (text) {
      return truncate(text, maxChars);
    }
    const tagName = element.tagName.toLowerCase();
    if (tagName === "input") {
      const input = element;
      const type = cleanText(element.getAttribute("type") ?? "").toLowerCase();
      const value = type === "password" ? "" : cleanText(input.value);
      return truncate(value, maxChars);
    }
    if (tagName === "textarea") {
      const textarea = element;
      return truncate(cleanText(textarea.value), maxChars);
    }
    return "";
  }
  function getLabelFromIdRefs(element, attributeName) {
    const raw = element.getAttribute(attributeName);
    if (!raw) {
      return "";
    }
    const ids = raw.split(/\s+/).filter(Boolean);
    const doc = element.ownerDocument;
    const parts = ids.map((id) => doc.getElementById(id)).filter((candidate) => Boolean(candidate)).map((candidate) => cleanText(candidate.textContent ?? ""));
    return cleanText(parts.join(" "));
  }
  function resolveLabel(element) {
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
          const text2 = cleanText(label.textContent ?? "");
          if (text2) {
            return text2;
          }
        }
      }
      const wrappingLabel = element.closest("label");
      if (wrappingLabel) {
        const text2 = cleanText(wrappingLabel.textContent ?? "");
        if (text2) {
          return text2;
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
      const value = cleanText(element.value);
      if (value) {
        return value;
      }
    }
    return "";
  }
  function resolveRole(element) {
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
  function buildCssPath(element) {
    if (element.id) {
      return `#${cssEscape(element.id)}`;
    }
    const segments = [];
    let current = element;
    while (current && current.tagName.toLowerCase() !== "html" && segments.length < 5) {
      const tagName = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) {
        segments.unshift(tagName);
        break;
      }
      const currentTagName = current.tagName;
      const siblings = Array.from(parent.children).filter((candidate) => candidate.tagName === currentTagName);
      const index = siblings.indexOf(current) + 1;
      segments.unshift(`${tagName}:nth-of-type(${index})`);
      current = parent;
    }
    return segments.join(" > ");
  }
  function measureRect(element) {
    const rect = element.getBoundingClientRect?.();
    if (!rect) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }
  function isSensitiveField(element) {
    const tagName = element.tagName.toLowerCase();
    if (tagName === "input") {
      const type = cleanText(element.getAttribute("type") ?? "").toLowerCase();
      return type === "password" || type === "file";
    }
    const autocomplete = cleanText(element.getAttribute("autocomplete") ?? "").toLowerCase();
    return autocomplete.includes("password") || autocomplete.includes("cc-") || autocomplete.includes("one-time-code");
  }
  function extractVisibleText(root, maxChars = MAX_VISIBLE_TEXT_CHARS) {
    const body = root;
    const innerText = typeof body.innerText === "string" ? body.innerText : "";
    if (innerText) {
      return truncate(cleanText(innerText), maxChars);
    }
    const doc = root.nodeType === 9 ? root : root.ownerDocument;
    if (!doc) {
      return "";
    }
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const segments = [];
    let current = walker.nextNode();
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
  function extractHeadings(document2) {
    const headings = Array.from(document2.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    return headings.filter((heading) => isElementVisible(heading)).slice(0, MAX_HEADINGS).map((heading) => {
      const level = Number.parseInt(heading.tagName.slice(1), 10) || 0;
      return {
        level,
        text: truncate(cleanText(heading.textContent ?? ""), 160),
        selector: buildCssPath(heading),
        id: heading.id || void 0
      };
    });
  }
  function captureInteractiveElements(document2, registry) {
    const candidates = Array.from(
      document2.querySelectorAll(
        [
          "button",
          "a[href]",
          "input:not([type='hidden'])",
          "select",
          "textarea",
          "summary",
          "[role='button']",
          "[role='link']",
          "[contenteditable='true']"
        ].join(",")
      )
    ).filter((element) => isElementVisible(element));
    return candidates.slice(0, MAX_INTERACTIVE_ELEMENTS).map((element) => {
      const elementId = registry.assign(element);
      const tagName = element.tagName.toLowerCase();
      const type = tagName === "input" ? cleanText(element.getAttribute("type") ?? "") || void 0 : void 0;
      const isSelected = tagName === "option" ? element.selected : void 0;
      const href = tagName === "a" ? element.href : void 0;
      return {
        elementId,
        tagName,
        role: resolveRole(element),
        text: tagName === "input" ? "" : getTextSnippet(element),
        label: resolveLabel(element),
        type,
        name: cleanText(element.getAttribute("name") ?? "") || void 0,
        placeholder: cleanText(element.getAttribute("placeholder") ?? "") || void 0,
        href,
        checked: tagName === "input" ? element.checked : void 0,
        disabled: element.matches(":disabled"),
        selected: isSelected,
        contentEditable: element.isContentEditable || void 0,
        formAssociated: Boolean(element.closest("form")),
        selector: buildCssPath(element),
        rect: measureRect(element),
        isSensitive: isSensitiveField(element)
      };
    });
  }
  function captureLinks(document2, registry) {
    const links = Array.from(document2.querySelectorAll("a[href]")).filter((link) => isElementVisible(link));
    return links.slice(0, MAX_LINKS).map((link) => {
      const href = link.href;
      const external = (() => {
        try {
          return new URL(href).origin !== new URL(document2.location.href).origin;
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
        rect: measureRect(link)
      };
    });
  }
  function captureForms(document2, registry) {
    const forms = Array.from(document2.querySelectorAll("form")).filter((form) => isElementVisible(form));
    return forms.slice(0, Math.max(1, MAX_INTERACTIVE_ELEMENTS)).map((form) => {
      const fields = Array.from(form.querySelectorAll("input, select, textarea")).filter((field) => isElementVisible(field)).slice(0, MAX_FORM_FIELDS);
      const fieldSummaries = fields.map((field) => {
        const fieldElementId = registry.assign(field);
        const tagName = field.tagName.toLowerCase();
        const type = tagName === "input" ? cleanText(field.getAttribute("type") ?? "") || void 0 : void 0;
        return {
          elementId: fieldElementId,
          tagName,
          type,
          label: resolveLabel(field),
          name: cleanText(field.getAttribute("name") ?? "") || void 0,
          placeholder: cleanText(field.getAttribute("placeholder") ?? "") || void 0,
          required: field.matches("[required]"),
          disabled: field.matches(":disabled"),
          isSensitive: isSensitiveField(field),
          selector: buildCssPath(field)
        };
      });
      const legend = form.querySelector("legend");
      const label = cleanText(form.getAttribute("aria-label") ?? "") || cleanText(form.getAttribute("title") ?? "") || (legend ? cleanText(legend.textContent ?? "") : "") || cleanText(form.textContent ?? "");
      return {
        elementId: registry.assign(form),
        label: truncate(label || "Form", 120),
        selector: buildCssPath(form),
        action: cleanText(form.getAttribute("action") ?? "") || void 0,
        method: cleanText(form.getAttribute("method") ?? "") || void 0,
        fieldCount: fieldSummaries.length,
        hasPasswordField: fieldSummaries.some((field) => field.isSensitive),
        hasFileField: fieldSummaries.some((field) => field.type === "file"),
        fields: fieldSummaries
      };
    });
  }
  function captureSemanticOutline(document2, headings) {
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
      "[role='form']"
    ];
    const landmarks = Array.from(document2.querySelectorAll(landmarkSelectors.join(","))).filter((landmark) => isElementVisible(landmark)).slice(0, 12).map((landmark) => ({
      kind: "landmark",
      text: truncate(resolveLabel(landmark) || getTextSnippet(landmark) || landmark.tagName.toLowerCase(), 160),
      role: resolveRole(landmark),
      level: void 0,
      selector: buildCssPath(landmark),
      children: void 0
    }));
    const headingNodes = headings.slice(0, MAX_HEADINGS).map((heading) => ({
      kind: "heading",
      text: heading.text,
      level: heading.level,
      selector: heading.selector,
      role: void 0,
      children: void 0
    }));
    return [...landmarks, ...headingNodes];
  }
  function derivePageKind(state, headings, forms) {
    const pageText = normalizeComparable(
      [
        state.title,
        ...headings.map((heading) => heading.text),
        ...forms.flatMap((form) => [
          form.label,
          form.action ?? "",
          form.method ?? "",
          ...form.fields.flatMap((field) => [field.label, field.placeholder, field.name, field.type].filter((value) => typeof value === "string"))
        ])
      ].filter(Boolean).join(" ")
    );
    const hasLoginSignals = forms.some((form) => form.hasPasswordField) || /(?:sign in|log in|login|authenticate|verify account)/.test(pageText);
    const hasPaymentSignals = /(?:checkout|payment|pay now|pay|billing|card|credit card|purchase|buy now|place order|order summary|subscription|donate|invoice|wallet|paypal)/.test(pageText) || /(?:card number|cvv|cvc|security code|expiration|expiry|mm yy|billing address|zip code|postal code|name on card|cardholder)/.test(pageText);
    const hasFormSignals = forms.length > 0;
    const isArticleLike = state.visibleTextLength > 3e3 && headings.length >= 2;
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
  function resolveUserIntervention(pageKind) {
    if (pageKind === "login") {
      return {
        kind: "login",
        message: "Login page detected. Please sign in manually, then type done to continue."
      };
    }
    if (pageKind === "payment") {
      return {
        kind: "payment",
        message: "Payment page detected. Please complete the payment manually, then type done to continue."
      };
    }
    return null;
  }
  function summarizePageState(state, headings, forms, interactiveCount, siteAdapter) {
    const kindLabel = state.pageKind === "unknown" ? "page" : `${state.pageKind} page`;
    const parts = [
      `${state.title || "Untitled"} on ${new URL(state.url).hostname}.`,
      `This is a ${kindLabel} with ${headings.length} heading${headings.length === 1 ? "" : "s"}, ${forms.length} form${forms.length === 1 ? "" : "s"}, and ${interactiveCount} interactive control${interactiveCount === 1 ? "" : "s"}.`
    ];
    if (siteAdapter) {
      parts.push(siteAdapter.summary);
      if (siteAdapter.notes.length > 0) {
        parts.push(siteAdapter.notes[0]);
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
  function makeSuggestedActionId(prefix) {
    return globalThis.crypto?.randomUUID?.() ?? `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
  function suggestionSignature(suggestion) {
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
        action.workflowStepId ?? ""
      ].join(":");
    }
    return [
      "scan",
      contextKey,
      suggestion.request.kind,
      suggestion.request.kind === "scan-page" ? suggestion.request.mode : "",
      suggestion.request.workflowId ?? "",
      suggestion.request.workflowStepId ?? ""
    ].join(":");
  }
  function dedupeSuggestedActions(suggestions) {
    const seen = /* @__PURE__ */ new Set();
    const deduped = [];
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
  function buildTabScopedScanSuggestion(snapshot, tabContext, id, title, description, mode, buttonLabel) {
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
      selector: void 0,
      confidence: void 0
    };
  }
  function scorePrimaryActionCandidate(element, pageKind) {
    if (element.isSensitive || element.disabled) {
      return -1;
    }
    const tagName = element.tagName.toLowerCase();
    const haystack = normalizeComparable(
      [element.label, element.text, element.name ?? "", element.placeholder ?? "", element.selector, element.role, element.type ?? ""].filter(Boolean).join(" ")
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
  function buildPrimaryActionSuggestion(snapshot, tabContext) {
    if (snapshot.pageKind === "login" || snapshot.pageKind === "payment") {
      return null;
    }
    let bestElement = null;
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
        selector: bestElement.selector
      },
      tabContext
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
      confidence: Math.min(0.95, 0.5 + bestScore / 100)
    };
  }
  function buildNextActionSuggestions(snapshot) {
    const tabContext = buildTabContextFromSnapshot(snapshot);
    const suggestions = [];
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
        "Summarize"
      ),
      buildTabScopedScanSuggestion(
        snapshot,
        tabContext,
        "list-interactive-elements",
        "List interactive elements",
        "Inspect visible buttons, links, inputs, and other controls.",
        "interactive",
        "Inspect"
      )
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
          "Review"
        )
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
          "Review"
        )
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
          "Rescan"
        )
      );
    }
    return dedupeSuggestedActions(suggestions).slice(0, 5);
  }
  function buildSuggestedActions(snapshot) {
    return buildNextActionSuggestions(snapshot);
  }
  function capturePageState(document2, navigationMode) {
    const registry = createRegistryHandle();
    const interactiveCount = captureInteractiveElements(document2, registry).length;
    const forms = captureForms(document2, registry);
    const visibleText = extractVisibleText(document2.body ?? document2.documentElement);
    const headings = extractHeadings(document2);
    const hasSensitiveInputs = forms.some((form) => form.hasPasswordField || form.hasFileField);
    const provisionalState = {
      url: document2.location.href,
      title: cleanText(document2.title || "Untitled"),
      readyState: document2.readyState,
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
      updatedAt: toIso()
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
      userInterventionMessage: userIntervention?.message ?? null
    };
  }
  function capturePageSnapshot(document2, options) {
    const registry = createRegistryHandle();
    const visibleText = options.mode === "interactive" ? "" : extractVisibleText(document2.body ?? document2.documentElement);
    const headings = extractHeadings(document2);
    const interactiveElements = captureInteractiveElements(document2, registry);
    const links = captureLinks(document2, registry);
    const forms = captureForms(document2, registry);
    const pageState = {
      url: document2.location.href,
      title: cleanText(document2.title || "Untitled"),
      readyState: document2.readyState,
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
      updatedAt: toIso()
    };
    const pageKind = derivePageKind(pageState, headings, forms);
    const userIntervention = resolveUserIntervention(pageKind);
    const completedState = {
      ...pageState,
      pageKind,
      userInterventionKind: userIntervention?.kind ?? null,
      userInterventionMessage: userIntervention?.message ?? null
    };
    const semanticOutline = captureSemanticOutline(document2, headings);
    const siteResolution = resolveSiteAdapterSnapshot({
      snapshotId: "",
      tabId: -1,
      url: document2.location.href,
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
        readyState: document2.readyState,
        interactiveCount: interactiveElements.length,
        linkCount: links.length,
        formCount: forms.length,
        headingCount: headings.length,
        visibleTextLength: visibleText.length,
        hasSensitiveInputs: completedState.hasSensitiveInputs,
        isArticleLike: pageKind === "article",
        isLoginLike: pageKind === "login",
        isSinglePageApp: options.navigationMode === "spa"
      },
      headings,
      links,
      forms,
      interactiveElements,
      semanticOutline,
      siteAdapter: null,
      suggestedActions: [],
      summary: ""
    });
    const snapshotBase = {
      snapshotId: globalThis.crypto?.randomUUID?.() ?? `snapshot_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      tabId: -1,
      url: document2.location.href,
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
        readyState: document2.readyState,
        interactiveCount: interactiveElements.length,
        linkCount: links.length,
        formCount: forms.length,
        headingCount: headings.length,
        visibleTextLength: visibleText.length,
        hasSensitiveInputs: completedState.hasSensitiveInputs,
        isArticleLike: pageKind === "article",
        isLoginLike: pageKind === "login",
        isSinglePageApp: options.navigationMode === "spa"
      },
      headings,
      links,
      forms,
      interactiveElements,
      semanticOutline,
      siteAdapter: siteResolution.siteAdapter,
      userInterventionKind: completedState.userInterventionKind,
      userInterventionMessage: completedState.userInterventionMessage
    };
    const snapshot = {
      ...snapshotBase,
      summary: summarizePageState(completedState, headings, forms, interactiveElements.length, siteResolution.siteAdapter),
      suggestedActions: dedupeSuggestedActions([
        ...buildSuggestedActions({
          ...snapshotBase,
          siteAdapter: siteResolution.siteAdapter,
          summary: "",
          suggestedActions: []
        }),
        ...siteResolution.suggestions
      ])
    };
    return { snapshot, registry: registry.registry };
  }
  function createActionResult(action, tabId, success, message, details, approvalId) {
    return {
      actionId: action.actionId,
      approvalId,
      tabId,
      kind: action.kind,
      success,
      message,
      executedAt: toIso(),
      details
    };
  }
  function getActionScrollAmount(action) {
    if (action.kind === "scroll") {
      return action.amount || DEFAULT_SCROLL_AMOUNT;
    }
    return DEFAULT_SCROLL_AMOUNT;
  }
  function getElementTextSnapshot(element) {
    return getTextSnippet(element, 160);
  }
  function isSensitiveElement(element) {
    return isSensitiveField(element);
  }
  function createSnapshotForMode(document2, mode, navigationMode) {
    return capturePageSnapshot(document2, { mode, navigationMode });
  }

  // src/shared/messages.ts
  function isRecord(value) {
    return typeof value === "object" && value !== null;
  }
  function isContentRequest(value) {
    return isRecord(value) && typeof value.kind === "string";
  }

  // src/content/content-script.ts
  var runtimeState = window.__codexBrowserCompanionContent ??= {
    initialized: false,
    navigationMode: "document",
    registry: /* @__PURE__ */ new Map(),
    lastSnapshot: null,
    mutationTimer: null
  };
  function makeId(prefix) {
    return globalThis.crypto?.randomUUID?.() ?? `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
  function getNavigationMode() {
    return runtimeState.navigationMode;
  }
  function normalizeComparable2(input) {
    return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
  }
  function schedulePageStateBroadcast(reason) {
    if (runtimeState.mutationTimer !== null) {
      clearTimeout(runtimeState.mutationTimer);
    }
    runtimeState.mutationTimer = window.setTimeout(() => {
      runtimeState.mutationTimer = null;
      void broadcastPageState(reason);
    }, PAGE_MUTATION_DEBOUNCE_MS);
  }
  async function broadcastPageState(reason) {
    const state = capturePageState(document, getNavigationMode());
    await chrome.runtime.sendMessage({
      kind: "page-state",
      state,
      reason
    });
  }
  function installHistoryHooks() {
    const history2 = window.history;
    if (history2.__codexBrowserCompanionPatched) {
      return;
    }
    history2.__codexBrowserCompanionPatched = true;
    const wrap = (name, original) => {
      return ((...args) => {
        const result = original.apply(history2, args);
        runtimeState.navigationMode = "spa";
        schedulePageStateBroadcast("navigation");
        return result;
      });
    };
    history2.pushState = wrap("pushState", history2.pushState.bind(history2));
    history2.replaceState = wrap("replaceState", history2.replaceState.bind(history2));
  }
  function installMutationObserver() {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      runtimeState.navigationMode = runtimeState.navigationMode === "spa" ? "spa" : "document";
      schedulePageStateBroadcast("mutation");
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
  }
  function getFieldValue(element) {
    return element instanceof HTMLInputElement && element.type === "password" ? "" : element.value;
  }
  function setFieldValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true, cancelable: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, cancelable: true, composed: true }));
  }
  function selectOption(select, selection) {
    const normalized = normalizeComparable2(String(selection.selection.value));
    const options = Array.from(select.options);
    let chosenIndex = -1;
    if (selection.selection.by === "index") {
      chosenIndex = Number.parseInt(String(selection.selection.value), 10);
    } else if (selection.selection.by === "value") {
      chosenIndex = options.findIndex((option) => normalizeComparable2(option.value) === normalized);
    } else {
      chosenIndex = options.findIndex((option) => normalizeComparable2(option.textContent ?? "") === normalized);
    }
    if (chosenIndex < 0 || !options[chosenIndex]) {
      throw new Error(`Could not find an option matching "${selection.selection.value}".`);
    }
    const chosen = options[chosenIndex];
    select.selectedIndex = chosenIndex;
    select.dispatchEvent(new Event("input", { bubbles: true, cancelable: true, composed: true }));
    select.dispatchEvent(new Event("change", { bubbles: true, cancelable: true, composed: true }));
    return chosen.textContent ?? chosen.value;
  }
  function resolveRegistryElement(elementId) {
    return runtimeState.registry.get(elementId) ?? null;
  }
  function registerResolvedElement(element) {
    for (const [elementId2, registeredElement] of runtimeState.registry.entries()) {
      if (registeredElement === element) {
        return elementId2;
      }
    }
    const elementId = makeId("element");
    runtimeState.registry.set(elementId, element);
    return elementId;
  }
  function resolveSelectorWithXPath(selector) {
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
  function resolveSelectorByText(selector) {
    const comparable = normalizeComparable2(selector.replace(/^text=/i, "").replace(/^aria=/i, ""));
    if (!comparable) {
      return null;
    }
    const candidates = Array.from(runtimeState.registry.values()).filter((element) => element instanceof HTMLElement);
    for (const element of candidates) {
      const label = normalizeComparable2(
        `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""} ${getElementTextSnapshot(element)}`
      );
      if (label.includes(comparable)) {
        return element;
      }
    }
    return null;
  }
  function resolveSelectorToElement(selector) {
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
      }
    }
    try {
      const cssMatch = document.querySelector(normalized);
      if (cssMatch instanceof HTMLElement) {
        return cssMatch;
      }
    } catch {
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
  function resolveActionTarget(action) {
    const targetById = "elementId" in action ? resolveRegistryElement(action.elementId) : null;
    if (targetById) {
      return targetById;
    }
    if ("selector" in action && action.selector) {
      return resolveSelectorToElement(action.selector);
    }
    return null;
  }
  async function performAction(action) {
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
          const submitter = target instanceof HTMLButtonElement || target instanceof HTMLInputElement && target.type === "submit" ? target : void 0;
          form.requestSubmit(submitter);
        } else {
          form.submit();
        }
        schedulePageStateBroadcast("navigation");
        return createActionResult(action, action.tabId, true, "Submitted the selected form.", `Started at ${startedAt}.`);
      }
    }
  }
  function bootstrap() {
    if (runtimeState.initialized) {
      return;
    }
    runtimeState.initialized = true;
    installHistoryHooks();
    installMutationObserver();
    void broadcastPageState("initial");
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!isContentRequest(message)) {
        return;
      }
      void (async () => {
        switch (message.kind) {
          case "ping": {
            const state = capturePageState(document, getNavigationMode());
            sendResponse({
              kind: "ping",
              state
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
              snapshot: capture.snapshot
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
              label: target ? getElementTextSnapshot(target) || target.getAttribute("aria-label") || target.getAttribute("title") || target.tagName.toLowerCase() : null
            });
            return;
          }
          case "perform-action": {
            const result = await performAction(message.action);
            runtimeState.lastSnapshot = createSnapshotForMode(document, "summary", getNavigationMode()).snapshot;
            sendResponse({
              kind: "action-result",
              result
            });
            return;
          }
        }
      })().catch((error) => {
        sendResponse({
          kind: "content-error",
          error: normalizeError(error, "CONTENT_HANDLER_FAILED", { recoverable: true })
        });
      });
      return true;
    });
  }
  bootstrap();
})();
//# sourceMappingURL=content.js.map
