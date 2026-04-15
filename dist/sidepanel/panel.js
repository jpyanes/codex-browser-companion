"use strict";
(() => {
  // src/shared/constants.ts
  var DEFAULT_SCROLL_AMOUNT = 600;
  var DEFAULT_UI_POLL_MS = 1e3;

  // src/shared/instructions.ts
  function normalize(input) {
    return input.trim().replace(/\s+/g, " ");
  }
  function normalizeComparable(input) {
    return normalize(input).toLowerCase().replace(/[^a-z0-9]+/g, " ");
  }
  function scoreCandidate(candidates, query) {
    let best = 0;
    const normalizedQuery = normalizeComparable(query);
    for (const candidate of candidates) {
      const normalizedCandidate = normalizeComparable(candidate);
      if (!normalizedCandidate) {
        continue;
      }
      if (normalizedCandidate === normalizedQuery) {
        best = Math.max(best, 100);
        continue;
      }
      if (normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate)) {
        best = Math.max(best, 80);
        continue;
      }
      const queryWords = normalizedQuery.split(" ").filter(Boolean);
      const candidateWords = normalizedCandidate.split(" ").filter(Boolean);
      const overlap = queryWords.filter((word) => candidateWords.includes(word)).length;
      if (overlap > 0) {
        best = Math.max(best, Math.min(30 + overlap * 12, 70));
      }
    }
    return best;
  }
  function findInteractiveElement(snapshot, query, options = {}) {
    const tags = options.tags?.map((tag) => tag.toLowerCase()) ?? [];
    const queryScore = normalizeComparable(query);
    let best = null;
    for (const element of snapshot.interactiveElements) {
      const tagName = element.tagName.toLowerCase();
      if (tags.length > 0 && !tags.includes(tagName)) {
        continue;
      }
      if (options.requireSensitiveBlock && element.isSensitive) {
        continue;
      }
      const score = scoreCandidate(
        [element.label, element.text, element.name ?? "", element.placeholder ?? "", element.selector, element.type ?? ""],
        queryScore
      );
      if (!score) {
        continue;
      }
      if (!best || score > best.score) {
        best = { element, score };
      }
    }
    return best && best.score >= 40 ? best.element : null;
  }
  function parseScrollInstruction(input) {
    const match = normalize(input).match(/^(?:scroll|page scroll|move page)\s+(up|down|left|right)(?:\s+(\d+))?$/i);
    if (!match) {
      return null;
    }
    const mode = match[1].toLowerCase();
    const amount = Number.parseInt(match[2] ?? "", 10);
    return {
      kind: "request-action",
      action: {
        actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        tabId: -1,
        kind: "scroll",
        direction: mode,
        amount: Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_SCROLL_AMOUNT
      }
    };
  }
  function parseBackForwardRefresh(input) {
    const normalized = normalizeComparable(input);
    if (/^(go )?back$/.test(normalized)) {
      return {
        kind: "request-action",
        action: {
          actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          tabId: -1,
          kind: "navigate-back"
        }
      };
    }
    if (/^(go )?forward$/.test(normalized)) {
      return {
        kind: "request-action",
        action: {
          actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          tabId: -1,
          kind: "navigate-forward"
        }
      };
    }
    if (/^(refresh|reload)$/.test(normalized)) {
      return {
        kind: "request-action",
        action: {
          actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          tabId: -1,
          kind: "refresh"
        }
      };
    }
    return null;
  }
  function parseInstruction(input, snapshot) {
    const trimmed = normalize(input);
    if (!trimmed) {
      return null;
    }
    const comparable = normalizeComparable(trimmed);
    if (/^(scan|scan page|rescan|capture page)(?:\s+(full|summary|interactive|suggestions))?$/.test(comparable)) {
      const mode = trimmed.match(/\b(full|summary|interactive|suggestions)\b/i)?.[1]?.toLowerCase() ?? "full";
      return {
        request: { kind: "scan-page", mode },
        explanation: `Queue a ${mode} scan of the current page.`,
        confidence: 0.96
      };
    }
    if (/^(summarize|summary)( page)?$/.test(comparable)) {
      return {
        request: { kind: "scan-page", mode: "summary" },
        explanation: "Summarize the current page.",
        confidence: 0.98
      };
    }
    if (/^(list|show|inspect) (interactive|controls|elements)( on page)?$/.test(comparable) || comparable === "interactive elements") {
      return {
        request: { kind: "scan-page", mode: "interactive" },
        explanation: "List the page's interactive controls and form fields.",
        confidence: 0.96
      };
    }
    if (/^(suggest|suggest next actions|next actions)$/.test(comparable)) {
      return {
        request: { kind: "scan-page", mode: "suggestions" },
        explanation: "Generate suggested next actions from the current page.",
        confidence: 0.94
      };
    }
    const scroll = parseScrollInstruction(trimmed);
    if (scroll) {
      return {
        request: scroll,
        explanation: "Scroll the current page.",
        confidence: 0.9
      };
    }
    const backForwardRefresh = parseBackForwardRefresh(trimmed);
    if (backForwardRefresh) {
      return {
        request: backForwardRefresh,
        explanation: "Run a simple navigation action.",
        confidence: 0.95
      };
    }
    if (/^(click|press|tap|open)\s+(.+)$/i.test(trimmed)) {
      if (!snapshot) {
        return null;
      }
      const target = trimmed.replace(/^(click|press|tap|open)\s+/i, "").trim();
      const element = findInteractiveElement(snapshot, target, { tags: ["button", "a", "summary", "input"] });
      if (!element) {
        return null;
      }
      return {
        request: {
          kind: "request-action",
          action: {
            actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            tabId: snapshot.tabId,
            kind: "click",
            elementId: element.elementId,
            label: element.label || element.text || target
          }
        },
        explanation: `Click the control that best matches "${target}".`,
        confidence: 0.82
      };
    }
    if (/^(type|enter|fill)\s+(.+?)\s+(?:into|in|on)\s+(.+)$/i.test(trimmed)) {
      if (!snapshot) {
        return null;
      }
      const match = trimmed.match(/^(type|enter|fill)\s+(.+?)\s+(?:into|in|on)\s+(.+)$/i);
      if (!match) {
        return null;
      }
      const text = match[2].trim();
      const target = match[3].trim();
      const element = findInteractiveElement(snapshot, target, { tags: ["input", "textarea", "div"] });
      if (!element || element.isSensitive) {
        return null;
      }
      return {
        request: {
          kind: "request-action",
          action: {
            actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            tabId: snapshot.tabId,
            kind: "type",
            elementId: element.elementId,
            text,
            clearBeforeTyping: true
          }
        },
        explanation: `Type text into the field that best matches "${target}".`,
        confidence: 0.84
      };
    }
    if (/^(select|choose|pick)\s+(.+?)\s+(?:in|on|for)\s+(.+)$/i.test(trimmed)) {
      if (!snapshot) {
        return null;
      }
      const match = trimmed.match(/^(select|choose|pick)\s+(.+?)\s+(?:in|on|for)\s+(.+)$/i);
      if (!match) {
        return null;
      }
      const optionText = match[2].trim();
      const target = match[3].trim();
      const element = findInteractiveElement(snapshot, target, { tags: ["select"] });
      if (!element) {
        return null;
      }
      return {
        request: {
          kind: "request-action",
          action: {
            actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            tabId: snapshot.tabId,
            kind: "select",
            elementId: element.elementId,
            selection: { by: "label", value: optionText }
          }
        },
        explanation: `Select "${optionText}" in the dropdown that best matches "${target}".`,
        confidence: 0.84
      };
    }
    if (/^(submit|submit form)\s+(.+)?$/i.test(trimmed)) {
      if (!snapshot) {
        return null;
      }
      const target = trimmed.replace(/^(submit|submit form)\s+/i, "").trim();
      const element = target ? findInteractiveElement(snapshot, target, { tags: ["button", "input"] }) : snapshot.interactiveElements.find((entry) => entry.tagName.toLowerCase() === "button" || entry.type === "submit");
      if (!element) {
        return null;
      }
      return {
        request: {
          kind: "request-action",
          action: {
            actionId: globalThis.crypto?.randomUUID?.() ?? `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            tabId: snapshot.tabId,
            kind: "submit-form",
            elementId: element.elementId,
            label: element.label || element.text || target
          }
        },
        explanation: `Submit the form control that best matches "${target || element.label || element.text}".`,
        confidence: 0.78
      };
    }
    return null;
  }

  // src/shared/logger.ts
  function nowIso() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }

  // src/ui/app.ts
  function escapeHtml(input) {
    return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function safeAttr(input) {
    return escapeHtml(input).replace(/`/g, "&#96;");
  }
  function formatTime(timestamp) {
    try {
      return new Intl.DateTimeFormat(void 0, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit"
      }).format(new Date(timestamp));
    } catch {
      return timestamp;
    }
  }
  function formatRelative(timestamp) {
    const diffMs = Date.now() - new Date(timestamp).getTime();
    if (!Number.isFinite(diffMs) || diffMs < 0) {
      return "just now";
    }
    const seconds = Math.floor(diffMs / 1e3);
    if (seconds < 60) {
      return `${seconds}s ago`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
  function limit(items, max) {
    return items.slice(0, max);
  }
  function statusLabel(status) {
    switch (status) {
      case "idle":
        return "Idle";
      case "connected":
        return "Connected";
      case "running":
        return "Running";
      case "awaiting-approval":
        return "Awaiting approval";
      case "error":
        return "Error";
    }
  }
  function statusClass(status) {
    return `status-chip--${status}`;
  }
  function commandHint(mode) {
    return mode === "popup" ? 'Try: "click save", "type hello into search", "scroll down 600", or "summarize page".' : 'Try: "click save", "type hello into search", "scroll down 600", or "summarize page".';
  }
  function getPageState(tab) {
    return tab?.snapshot ?? null;
  }
  function renderChip(label, tone = "neutral") {
    return `<span class="chip chip--${tone}">${escapeHtml(label)}</span>`;
  }
  function renderList(items, emptyLabel, className = "list list--compact") {
    if (items.length === 0) {
      return `<p class="empty">${escapeHtml(emptyLabel)}</p>`;
    }
    return `<ul class="${className}">${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
  }
  function renderLogEntries(tab, maxItems) {
    const entries = limit(tab?.activityLog ?? [], maxItems);
    if (entries.length === 0) {
      return `<p class="empty">No activity yet. Scan the page or run a command to get started.</p>`;
    }
    return `<ul class="activity-log">${entries.map(
      (entry) => `
        <li class="log log--${entry.level}">
          <div class="log__meta">
            <span class="log__level">${escapeHtml(entry.level)}</span>
            <span class="log__time">${escapeHtml(formatRelative(entry.timestamp))}</span>
          </div>
          <div class="log__message">${escapeHtml(entry.message)}</div>
          ${entry.details ? `<pre class="log__details">${escapeHtml(entry.details)}</pre>` : ""}
        </li>`
    ).join("")}</ul>`;
  }
  function renderApprovals(tab) {
    const approvals = tab?.approvals ?? [];
    if (approvals.length === 0) {
      return `<p class="empty">No pending approvals.</p>`;
    }
    return `<ul class="approval-list">${approvals.slice().reverse().map((approval) => {
      const pending = approval.status === "pending" || approval.status === "approved" || approval.status === "executing";
      const tone = approval.dangerLevel === "high" ? "danger" : approval.dangerLevel === "medium" ? "warning" : "neutral";
      return `
        <li class="approval approval--${tone}">
          <div class="approval__header">
            <div>
              <div class="approval__title">${escapeHtml(approval.title)}</div>
              <div class="approval__description">${escapeHtml(approval.description)}</div>
            </div>
            ${renderChip(approval.status, tone)}
          </div>
          <div class="approval__meta">
            <span>${escapeHtml(approval.dangerLevel)} risk</span>
            <span>${escapeHtml(formatTime(approval.createdAt))}</span>
          </div>
          ${pending ? `
                <div class="approval__actions">
                  <button class="btn btn--primary" data-approval-action="approve" data-approval-id="${safeAttr(approval.approvalId)}">Approve</button>
                  <button class="btn btn--ghost" data-approval-action="reject" data-approval-id="${safeAttr(approval.approvalId)}">Reject</button>
                </div>` : ""}
        </li>`;
    }).join("")}</ul>`;
  }
  function renderSuggestions(snapshot) {
    const suggestions = snapshot?.suggestedActions ?? [];
    if (suggestions.length === 0) {
      return `<p class="empty">Scan the page to generate suggested next actions.</p>`;
    }
    return `<div class="suggestions">${suggestions.map((suggestion) => renderSuggestionCard(suggestion)).join("")}</div>`;
  }
  function renderSuggestionCard(suggestion) {
    const tone = suggestion.dangerLevel === "high" ? "danger" : suggestion.dangerLevel === "medium" ? "warning" : "neutral";
    return `
    <button class="suggestion" data-suggestion-id="${safeAttr(suggestion.id)}">
      <div class="suggestion__top">
        <div class="suggestion__title">${escapeHtml(suggestion.title)}</div>
        ${renderChip(suggestion.dangerLevel, tone)}
      </div>
      <div class="suggestion__description">${escapeHtml(suggestion.description)}</div>
      <div class="suggestion__cta">${escapeHtml(suggestion.buttonLabel)}</div>
    </button>`;
  }
  function renderInteractiveElements(tab, maxItems) {
    const snapshot = getPageState(tab);
    const elements = limit(snapshot?.interactiveElements ?? [], maxItems);
    if (elements.length === 0) {
      return `<p class="empty">No interactive elements captured yet.</p>`;
    }
    return `<ul class="element-list">${elements.map(
      (element) => `
        <li class="element">
          <div class="element__top">
            <span class="element__label">${escapeHtml(element.label || element.text || element.tagName)}</span>
            ${renderChip(element.tagName, element.isSensitive ? "danger" : "neutral")}
          </div>
          <div class="element__meta">
            <span>${escapeHtml(element.role)}</span>
            <span>${escapeHtml(element.type || "")}</span>
            <span>${escapeHtml(element.disabled ? "disabled" : "enabled")}</span>
          </div>
          <div class="element__selector">${escapeHtml(element.selector)}</div>
        </li>`
    ).join("")}</ul>`;
  }
  function renderHeadings(snapshot) {
    const headings = snapshot?.headings ?? [];
    if (headings.length === 0) {
      return `<p class="empty">No headings were detected.</p>`;
    }
    return `<ol class="heading-list">${limit(headings, 8).map((heading) => `<li><span class="heading-list__level">H${heading.level}</span> ${escapeHtml(heading.text)}</li>`).join("")}</ol>`;
  }
  function renderOutline(snapshot) {
    const outline = snapshot?.semanticOutline ?? [];
    if (outline.length === 0) {
      return `<p class="empty">No semantic outline was captured.</p>`;
    }
    return `<ul class="outline">${limit(outline, 8).map((node) => {
      const prefix = node.kind === "heading" ? `H${node.level ?? ""}` : node.role || node.kind;
      return `<li><span class="outline__prefix">${escapeHtml(prefix)}</span> ${escapeHtml(node.text)}</li>`;
    }).join("")}</ul>`;
  }
  function renderSummary(tab, snapshot, mode) {
    if (!tab) {
      return `<section class="panel panel--empty"><p class="empty">No active tab detected. Open a web page and reopen the extension.</p></section>`;
    }
    const pageState = tab.pageState;
    const freshState = tab.snapshotFresh ? "Fresh" : "Stale";
    const freshnessTone = tab.snapshotFresh ? "success" : "warning";
    const kinds = [
      pageState ? renderChip(pageState.pageKind, "neutral") : "",
      pageState ? renderChip(pageState.navigationMode, "neutral") : "",
      tab.contentReady ? renderChip("Content ready", "success") : renderChip("No content script", "warning"),
      tab.busy ? renderChip("Busy", "warning") : "",
      tab.lastError ? renderChip("Error present", "danger") : ""
    ].filter(Boolean).join(" ");
    const links = snapshot?.meta.linkCount ?? 0;
    const forms = snapshot?.meta.formCount ?? pageState?.formCount ?? 0;
    const interactive = snapshot?.meta.interactiveCount ?? pageState?.interactiveCount ?? 0;
    const textLength = snapshot?.meta.visibleTextLength ?? pageState?.visibleTextLength ?? 0;
    const summaryLine = snapshot?.summary ? snapshot.summary : pageState ? `${pageState.pageKind ?? "page"} context is ready.` : "Scan the page to build a structured summary.";
    return `
    <section class="panel">
      <div class="section-head">
        <h2>Current tab</h2>
        <span class="section-note">${escapeHtml(
      statusLabel(tab.busy ? "running" : tab.approvals.some((approval) => approval.status === "pending") ? "awaiting-approval" : tab.lastError ? "error" : tab.contentReady ? "connected" : "idle")
    )}</span>
      </div>
      <div class="tab-card">
        <div class="tab-card__title">${escapeHtml(tab.title || "Untitled page")}</div>
        <div class="tab-card__url">${escapeHtml(tab.url || "Unknown url")}</div>
        <div class="tab-card__chips">${kinds}</div>
      </div>
      <div class="meta-grid">
        <div class="meta">
          <span class="meta__label">Freshness</span>
          <span class="meta__value">${renderChip(freshState, freshnessTone)}</span>
        </div>
        <div class="meta">
          <span class="meta__label">Ready state</span>
          <span class="meta__value">${escapeHtml(pageState?.readyState || document.readyState)}</span>
        </div>
        <div class="meta">
          <span class="meta__label">Interactive</span>
          <span class="meta__value">${interactive}</span>
        </div>
        <div class="meta">
          <span class="meta__label">Forms</span>
          <span class="meta__value">${forms}</span>
        </div>
        <div class="meta">
          <span class="meta__label">Links</span>
          <span class="meta__value">${links}</span>
        </div>
        <div class="meta">
          <span class="meta__label">Visible text</span>
          <span class="meta__value">${textLength.toLocaleString()}</span>
        </div>
      </div>
      <p class="summary-note">${escapeHtml(summaryLine)}</p>
      ${tab.snapshotFresh ? "" : `<div class="stale-banner">The page changed after the last scan. Run another scan before approving actions.</div>`}
    </section>

    <section class="panel">
      <div class="section-head">
        <h2>Page summary</h2>
        <span class="section-note">${mode === "popup" ? "Condensed view" : "Structured page context"}</span>
      </div>
      <p class="summary-body">${escapeHtml(snapshot?.summary || "No snapshot yet. Use Scan page to capture the current page.")}</p>
      ${snapshot?.visibleTextExcerpt ? `<pre class="excerpt">${escapeHtml(snapshot.visibleTextExcerpt)}</pre>` : `<p class="empty">No visible text excerpt captured yet.</p>`}
      <div class="section-split">
        <div>
          <h3>Headings</h3>
          ${renderHeadings(snapshot)}
        </div>
        <div>
          <h3>Semantic outline</h3>
          ${mode === "popup" ? renderList(limit(snapshot?.semanticOutline ?? [], 4).map((node) => escapeHtml(node.text)), "No outline yet.") : renderOutline(snapshot)}
        </div>
      </div>
    </section>
  `;
  }
  function renderPanels(tab, snapshot, mode) {
    const maxInteractive = mode === "popup" ? 6 : 14;
    const maxLogs = mode === "popup" ? 6 : 12;
    return `
    ${renderSummary(tab, snapshot, mode)}
    <section class="panel">
      <div class="section-head">
        <h2>Suggested next actions</h2>
        <span class="section-note">Generated from the current page</span>
      </div>
      ${renderSuggestions(snapshot)}
    </section>

    <section class="panel">
      <div class="section-head">
        <h2>Interactive elements</h2>
        <span class="section-note">${snapshot?.interactiveElements.length ?? 0} captured</span>
      </div>
      ${renderInteractiveElements(tab, maxInteractive)}
    </section>

    <section class="panel">
      <div class="section-head">
        <h2>Approval queue</h2>
        <span class="section-note">Explicit confirmation required for click, type, select, and submit actions</span>
      </div>
      ${renderApprovals(tab)}
    </section>

    <section class="panel">
      <div class="section-head">
        <h2>Activity log</h2>
        <span class="section-note">${tab?.activityLog.length ?? 0} entries</span>
      </div>
      ${renderLogEntries(tab, maxLogs)}
    </section>

    <section class="panel panel--error">
      <div class="section-head">
        <h2>Error panel</h2>
        <span class="section-note">Latest recoverable issue</span>
      </div>
      ${tab?.lastError ? `
            <div class="error-box">
              <div class="error-box__title">${escapeHtml(tab.lastError.message)}</div>
              <div class="error-box__meta">${escapeHtml(tab.lastError.code)} ${tab.lastError.recoverable ? "(recoverable)" : "(blocking)"}</div>
              ${tab.lastError.details ? `<pre class="error-box__details">${escapeHtml(tab.lastError.details)}</pre>` : ""}
            </div>` : `<p class="empty">No errors to report. If something fails, the message will appear here.</p>`}
    </section>
  `;
  }
  var BrowserCompanionApp = class {
    constructor(root2, mode) {
      this.root = root2;
      this.mode = mode;
      this.root.classList.add("app-shell");
      this.root.dataset.mode = mode;
      this.renderShell();
      this.rootShell = this.root;
      this.stateRoot = this.rootShell.querySelector("#state-root");
      this.commandInput = this.rootShell.querySelector("#command-input");
      this.commandForm = this.rootShell.querySelector("#command-form");
      this.commandFeedbackNode = this.rootShell.querySelector("#command-feedback");
      this.statusChip = this.rootShell.querySelector("#status-chip");
      this.statusSubline = this.rootShell.querySelector("#status-subline");
      this.approvalDialog = this.rootShell.querySelector("#approval-dialog");
      this.approvalTitle = this.rootShell.querySelector("#approval-title");
      this.approvalDescription = this.rootShell.querySelector("#approval-description");
      this.approvalMeta = this.rootShell.querySelector("#approval-meta");
      this.approvalTarget = this.rootShell.querySelector("#approval-target");
      this.approvalDanger = this.rootShell.querySelector("#approval-danger");
      this.bindEvents();
      this.connect();
    }
    state = null;
    port = null;
    reconnectTimer = null;
    currentApproval = null;
    commandFeedback = "";
    suggestionLookup = /* @__PURE__ */ new Map();
    rootShell;
    stateRoot;
    commandInput;
    commandForm;
    commandFeedbackNode;
    statusChip;
    statusSubline;
    approvalDialog;
    approvalTitle;
    approvalDescription;
    approvalMeta;
    approvalTarget;
    approvalDanger;
    renderShell() {
      this.root.innerHTML = `
      <div class="app-shell__frame">
        <header class="hero">
          <div class="hero__copy">
            <p class="eyebrow">Codex Browser Companion</p>
            <h1>Active tab control</h1>
            <p class="lede">Inspect the current page, queue approved actions, and keep Codex tied to the active tab.</p>
          </div>
          <div class="hero__status">
            <div id="status-chip" class="status-chip status-chip--idle">Idle</div>
            <p id="status-subline" class="hero__status-subline">Waiting for a page.</p>
          </div>
        </header>

        <section class="panel panel--command">
          <div class="section-head">
            <h2>Command</h2>
            <span class="section-note">Use a simple page command or browser action.</span>
          </div>
          <form id="command-form" class="command-form">
            <input id="command-input" type="text" placeholder="click save, type hello into search, summarize page" autocomplete="off" spellcheck="false" />
            <button class="btn btn--primary" type="submit">Run</button>
          </form>
          <div id="command-feedback" class="command-feedback"></div>
          <div class="quick-actions">
            <button class="btn btn--ghost" data-action="scan-page" data-mode="full" type="button">Scan page</button>
            <button class="btn btn--ghost" data-action="scan-page" data-mode="interactive" type="button">List interactive</button>
            <button class="btn btn--ghost" data-action="scan-page" data-mode="summary" type="button">Summarize</button>
            <button class="btn btn--ghost" data-action="scan-page" data-mode="suggestions" type="button">Suggest next</button>
            <button class="btn btn--ghost" data-action="open-sidepanel" type="button">Open side panel</button>
            <button class="btn btn--ghost" data-action="clear-log" type="button">Clear log</button>
          </div>
          <p class="hint">${escapeHtml(commandHint(this.mode))}</p>
        </section>

        <div id="state-root" class="state-root"></div>
      </div>

      <dialog id="approval-dialog" class="approval-dialog">
        <form method="dialog" class="approval-dialog__card">
          <div class="approval-dialog__top">
            <div>
              <p class="eyebrow">Approval required</p>
              <h2 id="approval-title">Action review</h2>
            </div>
            <div id="approval-danger" class="status-chip status-chip--warning">medium</div>
          </div>
          <p id="approval-description" class="approval-dialog__description"></p>
          <div id="approval-target" class="approval-dialog__target"></div>
          <div id="approval-meta" class="approval-dialog__meta"></div>
          <div class="approval-dialog__actions">
            <button class="btn btn--primary" data-approval-action="approve" data-approval-id="" value="approve">Approve</button>
            <button class="btn btn--ghost" data-approval-action="reject" data-approval-id="" value="reject">Reject</button>
            <button class="btn btn--ghost" value="cancel">Cancel</button>
          </div>
        </form>
      </dialog>
    `;
    }
    bindEvents() {
      this.root.addEventListener("click", (event) => {
        const target = event.target;
        if (!target) {
          return;
        }
        const approvalButton = target.closest("[data-approval-action][data-approval-id]");
        if (approvalButton) {
          const approvalId = approvalButton.dataset.approvalId;
          const approvalAction = approvalButton.dataset.approvalAction;
          if (approvalId && approvalAction) {
            event.preventDefault();
            this.send({
              kind: approvalAction === "approve" ? "approve-action" : "reject-action",
              approvalId
            });
          }
          return;
        }
        const suggestionButton = target.closest("[data-suggestion-id]");
        if (suggestionButton) {
          const suggestionId = suggestionButton.dataset.suggestionId;
          const suggestion = suggestionId ? this.suggestionLookup.get(suggestionId) : null;
          if (suggestion) {
            event.preventDefault();
            this.sendSuggestion(suggestion.request);
            this.setFeedback(`Queued suggestion: ${suggestion.title}`, "success");
          }
          return;
        }
        const quickAction = target.closest("[data-action]");
        if (quickAction) {
          const action = quickAction.dataset.action;
          if (!action) {
            return;
          }
          event.preventDefault();
          if (action === "scan-page") {
            const mode = quickAction.dataset.mode ?? "full";
            this.send({ kind: "scan-page", mode });
          } else if (action === "open-sidepanel") {
            this.send({ kind: "open-sidepanel" });
          } else if (action === "clear-log") {
            this.send({ kind: "clear-log" });
          }
        }
      });
      this.commandForm.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.handleCommandSubmit();
      });
      this.commandInput.addEventListener("input", () => {
        this.commandFeedback = "";
        this.commandFeedbackNode.textContent = "";
      });
      this.approvalDialog.addEventListener("click", (event) => {
        const target = event.target;
        if (!target) {
          return;
        }
        if (target instanceof HTMLDialogElement || target.classList.contains("approval-dialog")) {
          return;
        }
        const button = target.closest("button[value]");
        if (button?.value === "cancel") {
          this.closeApprovalDialog();
        }
      });
    }
    connect() {
      this.port?.disconnect();
      this.port = chrome.runtime.connect({ name: "codex-ui" });
      this.port.postMessage({ kind: "get-state" });
      this.port.onMessage.addListener((message) => {
        if (!this.isAppMessage(message)) {
          return;
        }
        this.handleMessage(message);
      });
      this.port.onDisconnect.addListener(() => {
        this.setFeedback("Connection lost. Reconnecting...", "warning");
        if (this.reconnectTimer !== null) {
          clearTimeout(this.reconnectTimer);
        }
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, DEFAULT_UI_POLL_MS);
      });
    }
    isAppMessage(message) {
      return typeof message === "object" && message !== null && "kind" in message;
    }
    handleMessage(message) {
      switch (message.kind) {
        case "state":
          this.state = message.state;
          this.renderState();
          break;
        case "approval-requested":
          this.openApprovalDialog(message.approval);
          break;
        case "approval-updated":
          if (this.currentApproval?.approvalId === message.approval.approvalId) {
            this.currentApproval = message.approval;
            this.renderApprovalDialog();
            if (message.approval.status === "rejected" || message.approval.status === "succeeded" || message.approval.status === "failed") {
              this.closeApprovalDialog();
            }
          }
          this.setFeedback(`Approval ${message.approval.status}: ${message.approval.title}`, message.approval.status === "failed" ? "error" : "info");
          break;
        case "page-snapshot":
          if (this.state && this.state.tabs[message.tabId]) {
            const currentTab = this.state.tabs[message.tabId];
            const updatedTab = {
              tabId: currentTab.tabId,
              windowId: currentTab.windowId,
              active: currentTab.active,
              url: currentTab.url,
              title: currentTab.title,
              snapshot: message.snapshot,
              pageState: {
                url: message.snapshot.url,
                title: message.snapshot.title,
                readyState: message.snapshot.meta.readyState,
                navigationMode: message.snapshot.navigationMode,
                pageKind: message.snapshot.pageKind,
                interactiveCount: message.snapshot.meta.interactiveCount,
                formCount: message.snapshot.meta.formCount,
                visibleTextLength: message.snapshot.meta.visibleTextLength,
                hasSensitiveInputs: message.snapshot.meta.hasSensitiveInputs,
                updatedAt: message.snapshot.capturedAt
              },
              snapshotFresh: true,
              contentReady: currentTab.contentReady,
              busy: currentTab.busy,
              approvals: currentTab.approvals,
              activityLog: currentTab.activityLog,
              lastError: null,
              lastSeenAt: nowIso()
            };
            this.state = {
              ...this.state,
              tabs: {
                ...this.state.tabs,
                [message.tabId]: updatedTab
              }
            };
            this.renderState();
          }
          this.setFeedback(`Captured ${message.snapshot.captureMode} snapshot.`, "success");
          break;
        case "action-result":
          this.setFeedback(message.result.message, message.result.success ? "success" : "error");
          this.renderState();
          break;
        case "error":
          this.setFeedback(message.error.message, "error");
          this.renderState();
          break;
      }
    }
    activeTab() {
      if (!this.state || this.state.activeTabId === null) {
        return null;
      }
      return this.state.tabs[this.state.activeTabId] ?? null;
    }
    snapshot() {
      return getPageState(this.activeTab());
    }
    renderState() {
      const activeTab = this.activeTab();
      const snapshot = this.snapshot();
      this.statusChip.className = `status-chip ${statusClass(this.state?.status ?? "idle")}`;
      this.statusChip.textContent = statusLabel(this.state?.status ?? "idle");
      this.statusSubline.textContent = activeTab ? `${activeTab.title || "Untitled page"}${activeTab.snapshotFresh ? " - snapshot fresh" : " - snapshot stale"}` : "Waiting for a page.";
      this.stateRoot.innerHTML = renderPanels(activeTab, snapshot, this.mode);
      this.suggestionLookup = new Map((snapshot?.suggestedActions ?? []).map((suggestion) => [suggestion.id, suggestion]));
      if (this.currentApproval) {
        this.renderApprovalDialog();
      }
    }
    renderApprovalDialog() {
      if (!this.currentApproval) {
        return;
      }
      const approval = this.currentApproval;
      const tone = approval.dangerLevel === "high" ? "danger" : approval.dangerLevel === "medium" ? "warning" : "neutral";
      this.approvalTitle.textContent = approval.title;
      this.approvalDescription.textContent = approval.description;
      this.approvalDanger.className = `status-chip status-chip--${tone}`;
      this.approvalDanger.textContent = approval.dangerLevel;
      this.approvalTarget.textContent = approval.targetLabel ? `Target: ${approval.targetLabel}` : "Target: current page context";
      this.approvalMeta.textContent = `Requested ${formatTime(approval.createdAt)} | ${approval.status}`;
      const approveButton = this.approvalDialog.querySelector('[data-approval-action="approve"]');
      const rejectButton = this.approvalDialog.querySelector('[data-approval-action="reject"]');
      if (approveButton) {
        approveButton.dataset.approvalId = approval.approvalId;
      }
      if (rejectButton) {
        rejectButton.dataset.approvalId = approval.approvalId;
      }
      if (!this.approvalDialog.open) {
        this.approvalDialog.showModal();
      }
    }
    openApprovalDialog(approval) {
      this.currentApproval = approval;
      this.renderApprovalDialog();
      this.setFeedback(`Action requires approval: ${approval.title}`, approval.dangerLevel === "high" ? "warning" : "info");
    }
    closeApprovalDialog() {
      this.currentApproval = null;
      if (this.approvalDialog.open) {
        this.approvalDialog.close();
      }
    }
    setFeedback(message, tone) {
      this.commandFeedback = message;
      this.commandFeedbackNode.className = `command-feedback command-feedback--${tone}`;
      this.commandFeedbackNode.textContent = message;
      if (tone === "success" || tone === "error") {
        window.setTimeout(() => {
          if (this.commandFeedbackNode.textContent === message) {
            this.commandFeedbackNode.textContent = "";
            this.commandFeedbackNode.className = "command-feedback";
          }
        }, 3e3);
      }
    }
    send(request) {
      this.port?.postMessage(request);
    }
    sendSuggestion(request) {
      this.port?.postMessage(request);
    }
    async handleCommandSubmit() {
      const value = this.commandInput.value.trim();
      if (!value) {
        this.setFeedback("Type a command before running it.", "warning");
        return;
      }
      const parsed = parseInstruction(value, this.snapshot());
      if (!parsed) {
        this.setFeedback("Could not parse that command. Try: click save, type hello into search, scroll down 600, summarize page.", "error");
        return;
      }
      const request = parsed.request;
      if (request.kind === "request-action") {
        const activeTab = this.activeTab();
        if (activeTab) {
          request.action.tabId = activeTab.tabId;
        }
      }
      this.commandInput.value = "";
      this.setFeedback(parsed.explanation, "info");
      this.port?.postMessage(request);
    }
  };
  function mountBrowserCompanionApp(root2, mode) {
    return new BrowserCompanionApp(root2, mode);
  }

  // src/ui/sidepanel/panel.ts
  var root = document.getElementById("app");
  if (!root) {
    throw new Error("Side panel root element not found.");
  }
  mountBrowserCompanionApp(root, "sidepanel");
})();
//# sourceMappingURL=panel.js.map
