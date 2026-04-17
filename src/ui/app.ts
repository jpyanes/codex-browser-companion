import { DEFAULT_UI_POLL_MS } from "../shared/constants";
import { bridgeStatusLabel, bridgeStatusTone, summarizeBridgeState } from "../shared/bridge";
import { normalizeError, nowIso } from "../shared/logger";
import { liveTakeoverStatusLabel, liveTakeoverStatusTone, summarizeLiveTakeoverState } from "../shared/live-takeover";
import { semanticStatusLabel, semanticStatusTone, summarizeSemanticState } from "../shared/semantic";
import { buildTabContextFromTrackedTab, formatTabContext } from "../shared/tab-context";
import { sortTrackedTabs, summarizeTrackedTab, tabStatusLabel, tabStatusTone } from "../shared/tab-orchestration";
import { searchTrackedTabs } from "../shared/tab-intelligence";
import { resolveUserIntervention } from "../shared/dom";
import type { UiRequest } from "../shared/messages";
import {
  buildWorkflowPlanFromInstruction,
  getActiveWorkflowNextStep,
  summarizeWorkflowState,
  workflowProgress,
  workflowStatusLabel,
  workflowStatusTone,
  workflowStepStatusLabel,
  workflowStepStatusTone,
} from "../shared/workflow";
import type {
  ApprovalRequest,
  BridgeState,
  ExtensionState,
  LiveTakeoverState,
  PageSnapshot,
  SuggestedAction,
  SuggestedRequest,
  SemanticState,
  WorkflowState,
  TrackedTabState,
} from "../shared/types";

export type AppMode = "popup" | "sidepanel";

interface AppMessageState {
  kind: "state";
  state: ExtensionState;
}

interface AppMessageApprovalRequested {
  kind: "approval-requested";
  approval: ApprovalRequest;
}

interface AppMessageApprovalUpdated {
  kind: "approval-updated";
  approval: ApprovalRequest;
}

interface AppMessagePageSnapshot {
  kind: "page-snapshot";
  tabId: number;
  snapshot: PageSnapshot;
}

interface AppMessageActionResult {
  kind: "action-result";
  result: import("../shared/types").ActionResult;
}

interface AppMessageError {
  kind: "error";
  error: import("../shared/types").AppError;
}

type AppMessage = AppMessageState | AppMessageApprovalRequested | AppMessageApprovalUpdated | AppMessagePageSnapshot | AppMessageActionResult | AppMessageError;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeAttr(input: string): string {
  return escapeHtml(input).replace(/`/g, "&#96;");
}

function formatTime(timestamp: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return timestamp;
  }
}

function formatRelative(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return "just now";
  }

  const seconds = Math.floor(diffMs / 1000);
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

function limit<T>(items: T[], max: number): T[] {
  return items.slice(0, max);
}

function statusLabel(status: ExtensionState["status"]): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "connected":
      return "Connected";
    case "running":
      return "Running";
    case "awaiting-approval":
      return "Awaiting approval";
    case "awaiting-user":
      return "Waiting for you";
    case "error":
      return "Error";
  }
}

function statusClass(status: ExtensionState["status"]): string {
  return `status-chip--${status}`;
}

function commandHint(mode: AppMode): string {
  return mode === "popup"
    ? 'Try: "click save", "click save then summarize page", "type hello into search", or "scroll down 600".'
    : 'Try: "click save", "click save then summarize page", "type hello into search", or "scroll down 600".';
}

function getPageState(tab: TrackedTabState | null): PageSnapshot | null {
  return tab?.snapshot ?? null;
}

function getTabIntervention(tab: TrackedTabState | null): { kind: "login" | "payment"; message: string } | null {
  if (!tab) {
    return null;
  }

  return resolveUserIntervention(tab.pageState?.userInterventionKind ?? tab.pageState?.pageKind ?? tab.snapshot?.pageKind ?? null);
}

function isResumeSignal(input: string): boolean {
  return /^(done|i'?m done|im done|finished|complete|resume|continue)[.!]?$/i.test(input.trim());
}

function renderChip(label: string, tone = "neutral"): string {
  return `<span class="chip chip--${tone}">${escapeHtml(label)}</span>`;
}

function renderList(items: string[], emptyLabel: string, className = "list list--compact"): string {
  if (items.length === 0) {
    return `<p class="empty">${escapeHtml(emptyLabel)}</p>`;
  }

  return `<ul class="${className}">${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function renderLogEntries(tab: TrackedTabState | null, maxItems: number): string {
  const entries = limit(tab?.activityLog ?? [], maxItems);
  if (entries.length === 0) {
    return `<p class="empty">No activity yet. Scan the page or run a command to get started.</p>`;
  }

  return `<ul class="activity-log">${entries
    .map(
      (entry) => `
        <li class="log log--${entry.level}">
          <div class="log__meta">
            <span class="log__level">${escapeHtml(entry.level)}</span>
            <span class="log__time">${escapeHtml(formatRelative(entry.timestamp))}</span>
          </div>
          <div class="log__message">${escapeHtml(entry.message)}</div>
          ${
            entry.details
              ? `<pre class="log__details">${escapeHtml(entry.details)}</pre>`
              : ""
          }
        </li>`,
    )
    .join("")}</ul>`;
}

function renderApprovals(tab: TrackedTabState | null): string {
  const approvals = tab?.approvals ?? [];
  if (approvals.length === 0) {
    return `<p class="empty">No pending approvals.</p>`;
  }

  return `<ul class="approval-list">${approvals
    .slice()
    .reverse()
    .map((approval) => {
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
          ${
            pending
              ? `
                <div class="approval__actions">
                  <button class="btn btn--primary" data-approval-action="approve" data-approval-id="${safeAttr(approval.approvalId)}">Approve</button>
                  <button class="btn btn--ghost" data-approval-action="reject" data-approval-id="${safeAttr(approval.approvalId)}">Reject</button>
                </div>`
              : ""
          }
        </li>`;
    })
    .join("")}</ul>`;
}

function renderSuggestions(snapshot: PageSnapshot | null): string {
  const suggestions = snapshot?.suggestedActions ?? [];
  if (suggestions.length === 0) {
    return `<p class="empty">Scan the page to generate suggested next actions.</p>`;
  }

  return `<div class="suggestions">${suggestions.map((suggestion) => renderSuggestionCard(suggestion)).join("")}</div>`;
}

function renderSuggestionCard(suggestion: SuggestedAction): string {
  const tone = suggestion.dangerLevel === "high" ? "danger" : suggestion.dangerLevel === "medium" ? "warning" : "neutral";
  const sourceLabel =
    suggestion.source === "workflow"
      ? "Workflow"
      : suggestion.source === "stagehand"
        ? "Stagehand"
        : suggestion.source === "site"
          ? "Site"
          : "DOM";
  const confidenceLabel = typeof suggestion.confidence === "number" && Number.isFinite(suggestion.confidence)
    ? `${Math.round(suggestion.confidence * 100)}%`
    : "";
  return `
    <button class="suggestion" data-suggestion-id="${safeAttr(suggestion.id)}">
      <div class="suggestion__top">
        <div class="suggestion__title">${escapeHtml(suggestion.title)}</div>
        <div class="suggestion__chips">
          ${renderChip(sourceLabel, "neutral")}
          ${renderChip(suggestion.dangerLevel, tone)}
          ${confidenceLabel ? renderChip(confidenceLabel, "neutral") : ""}
        </div>
      </div>
      <div class="suggestion__description">${escapeHtml(suggestion.description)}</div>
      <div class="suggestion__context">${escapeHtml(`On ${formatTabContext(suggestion.tabContext)}`)}</div>
      ${
        suggestion.selector
          ? `<div class="suggestion__selector">${escapeHtml(suggestion.selector)}</div>`
          : ""
      }
      <div class="suggestion__cta">${escapeHtml(suggestion.buttonLabel)}</div>
    </button>`;
}

function renderInteractiveElements(tab: TrackedTabState | null, maxItems: number): string {
  const snapshot = getPageState(tab);
  const elements = limit(snapshot?.interactiveElements ?? [], maxItems);
  if (elements.length === 0) {
    return `<p class="empty">No interactive elements captured yet.</p>`;
  }

  return `<ul class="element-list">${elements
    .map(
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
        </li>`,
    )
    .join("")}</ul>`;
}

function renderHeadings(snapshot: PageSnapshot | null): string {
  const headings = snapshot?.headings ?? [];
  if (headings.length === 0) {
    return `<p class="empty">No headings were detected.</p>`;
  }

  return `<ol class="heading-list">${limit(headings, 8)
    .map((heading) => `<li><span class="heading-list__level">H${heading.level}</span> ${escapeHtml(heading.text)}</li>`)
    .join("")}</ol>`;
}

function renderOutline(snapshot: PageSnapshot | null): string {
  const outline = snapshot?.semanticOutline ?? [];
  if (outline.length === 0) {
    return `<p class="empty">No semantic outline was captured.</p>`;
  }

  return `<ul class="outline">${limit(outline, 8)
    .map((node) => {
      const prefix = node.kind === "heading" ? `H${node.level ?? ""}` : node.role || node.kind;
      return `<li><span class="outline__prefix">${escapeHtml(prefix)}</span> ${escapeHtml(node.text)}</li>`;
    })
    .join("")}</ul>`;
}

function renderSummary(tab: TrackedTabState | null, snapshot: PageSnapshot | null, mode: AppMode): string {
  if (!tab) {
    return `<section class="panel panel--empty"><p class="empty">No active tab detected. Open a web page and reopen the extension.</p></section>`;
  }

  const pageState = tab.pageState;
  const intervention = getTabIntervention(tab);
  const freshState = tab.snapshotFresh ? "Fresh" : "Stale";
  const freshnessTone = tab.snapshotFresh ? "success" : "warning";
  const adapterLabel = pageState?.siteAdapterLabel || snapshot?.siteAdapter?.label || "";
  const kinds = [
    pageState ? renderChip(pageState.pageKind, "neutral") : "",
    pageState ? renderChip(pageState.navigationMode, "neutral") : "",
    adapterLabel ? renderChip(adapterLabel, "neutral") : "",
    tab.contentReady ? renderChip("Content ready", "success") : renderChip("No content script", "warning"),
    tab.busy ? renderChip("Busy", "warning") : "",
    tab.lastError ? renderChip("Error present", "danger") : "",
  ]
    .filter(Boolean)
    .join(" ");

  const links = snapshot?.meta.linkCount ?? 0;
  const forms = snapshot?.meta.formCount ?? pageState?.formCount ?? 0;
  const interactive = snapshot?.meta.interactiveCount ?? pageState?.interactiveCount ?? 0;
  const textLength = snapshot?.meta.visibleTextLength ?? pageState?.visibleTextLength ?? 0;

  const summaryLine = snapshot?.summary
    ? snapshot.summary
    : pageState
      ? `${pageState.pageKind ?? "page"} context is ready.`
      : "Scan the page to build a structured summary.";

  return `
    <section class="panel">
      <div class="section-head">
        <h2>Current tab</h2>
        <span class="section-note">${escapeHtml(
          statusLabel(tab.busy ? "running" : tab.approvals.some((approval) => approval.status === "pending") ? "awaiting-approval" : tab.lastError ? "error" : tab.contentReady ? "connected" : "idle"),
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
      ${
        intervention
          ? `
            <div class="intervention-banner intervention-banner--warning">
              <div class="intervention-banner__copy">
                <div class="intervention-banner__title">${escapeHtml(intervention.kind === "login" ? "Manual login required" : "Manual payment required")}</div>
                <div class="intervention-banner__body">${escapeHtml(intervention.message)}</div>
              </div>
              <div class="intervention-banner__actions">
                <button class="btn btn--primary" data-action="resume-user-intervention" type="button">Done</button>
              </div>
            </div>`
          : ""
      }
      ${tab.snapshotFresh ? "" : `<div class="stale-banner">The page changed after the last scan. Run another scan before approving actions.</div>`}
    </section>

    <section class="panel">
      <div class="section-head">
        <h2>Page summary</h2>
        <span class="section-note">${mode === "popup" ? "Condensed view" : "Structured page context"}</span>
      </div>
      <p class="summary-body">${escapeHtml(snapshot?.summary || "No snapshot yet. Use Scan page to capture the current page.")}</p>
      ${
        snapshot?.visibleTextExcerpt
          ? `<pre class="excerpt">${escapeHtml(snapshot.visibleTextExcerpt)}</pre>`
          : `<p class="empty">No visible text excerpt captured yet.</p>`
      }
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

function renderBridgePanel(bridge: BridgeState | null): string {
  if (!bridge) {
    return `<section class="panel panel--bridge"><p class="empty">No bridge state available yet.</p></section>`;
  }

  const tone = bridgeStatusTone(bridge.status);
  const label = bridgeStatusLabel(bridge.status);
  const active = bridge.activeExtension;
  const activeSummary = active
    ? `${active.browser || "Chrome"} · ${active.profile?.email || "unknown profile"} · ${bridge.activeTargetCount} active target${bridge.activeTargetCount === 1 ? "" : "s"}`
    : "No Playwriter-enabled tab detected yet.";

  return `
    <section class="panel panel--bridge">
      <div class="section-head">
        <h2>Live bridge</h2>
        <span class="section-note">Playwriter relay on localhost</span>
      </div>
      <div class="bridge-card">
        <div class="bridge-card__top">
          <div>
            <div class="bridge-card__label">Bridge state</div>
            <div class="bridge-card__summary">${escapeHtml(summarizeBridgeState(bridge))}</div>
          </div>
          <span class="status-chip status-chip--${tone}">${escapeHtml(label)}</span>
        </div>
        <div class="bridge-card__meta">
          <span>Endpoint: ${escapeHtml(bridge.endpoint)}</span>
          <span>Relay: ${escapeHtml(bridge.relayVersion || "not detected")}</span>
          <span>${escapeHtml(activeSummary)}</span>
          <span>Checked: ${bridge.checkedAt ? escapeHtml(formatTime(bridge.checkedAt)) : "unknown"}</span>
        </div>
        ${
          bridge.lastError
            ? `
              <div class="bridge-card__error">
                <div class="bridge-card__error-title">${escapeHtml(bridge.lastError.message)}</div>
                <div class="bridge-card__error-meta">${escapeHtml(bridge.lastError.code)}</div>
              </div>`
            : ""
        }
      </div>
    </section>
  `;
}

function renderLiveTakeoverPanel(liveTakeover: LiveTakeoverState | null): string {
  if (!liveTakeover) {
    return `<section class="panel panel--takeover"><p class="empty">No live takeover state available yet.</p></section>`;
  }

  const tone = liveTakeoverStatusTone(liveTakeover.status);
  const label = liveTakeoverStatusLabel(liveTakeover.status);
  const toggleLabel = liveTakeover.enabled ? "Disable live takeover" : "Enable live takeover";

  return `
    <section class="panel panel--takeover">
      <div class="section-head">
        <h2>Live takeover</h2>
        <span class="section-note">Visible-browser queue and command loop</span>
      </div>
      <div class="bridge-card takeover-card">
        <div class="bridge-card__top">
          <div>
            <div class="bridge-card__label">Takeover state</div>
            <div class="bridge-card__summary">${escapeHtml(summarizeLiveTakeoverState(liveTakeover))}</div>
          </div>
          <span class="status-chip status-chip--${tone}">${escapeHtml(label)}</span>
        </div>
        <div class="bridge-card__meta">
          <span>Endpoint: ${escapeHtml(liveTakeover.endpoint)}</span>
          <span>Enabled: ${liveTakeover.enabled ? "yes" : "no"}</span>
          <span>Active tab: ${escapeHtml(liveTakeover.activeTitle || liveTakeover.activeUrl || (liveTakeover.activeTabId !== null ? `tab ${liveTakeover.activeTabId}` : "unknown"))}</span>
          <span>Queue: ${liveTakeover.queueLength}</span>
          <span>Last heartbeat: ${liveTakeover.lastHeartbeat ? escapeHtml(formatTime(liveTakeover.lastHeartbeat)) : "none"}</span>
          <span>Checked: ${liveTakeover.checkedAt ? escapeHtml(formatTime(liveTakeover.checkedAt)) : "unknown"}</span>
        </div>
        ${
          liveTakeover.lastError
            ? `
              <div class="bridge-card__error">
                <div class="bridge-card__error-title">${escapeHtml(liveTakeover.lastError.message)}</div>
                <div class="bridge-card__error-meta">${escapeHtml(liveTakeover.lastError.code)}</div>
              </div>`
            : ""
        }
        <div class="takeover-card__actions">
          <button class="btn btn--ghost" data-action="refresh-live-takeover" type="button">Refresh takeover</button>
          <button class="btn btn--primary" data-action="toggle-live-takeover" type="button">${escapeHtml(toggleLabel)}</button>
        </div>
      </div>
    </section>
  `;
}

function renderSemanticPanel(semantic: SemanticState | null): string {
  if (!semantic) {
    return `<section class="panel panel--semantic"><p class="empty">No semantic bridge state available yet.</p></section>`;
  }

  const tone = semanticStatusTone(semantic.status);
  const label = semanticStatusLabel(semantic.status);
  return `
    <section class="panel panel--semantic">
      <div class="section-head">
        <h2>Semantic layer</h2>
        <span class="section-note">Stagehand observe on the live Chrome session</span>
      </div>
      <div class="bridge-card">
        <div class="bridge-card__top">
          <div>
            <div class="bridge-card__label">Semantic state</div>
            <div class="bridge-card__summary">${escapeHtml(summarizeSemanticState(semantic))}</div>
          </div>
          <span class="status-chip status-chip--${tone}">${escapeHtml(label)}</span>
        </div>
        <div class="bridge-card__meta">
          <span>Endpoint: ${escapeHtml(semantic.endpoint)}</span>
          <span>Browser: ${escapeHtml(semantic.browserEndpoint || "not detected")}</span>
          <span>Model: ${escapeHtml(semantic.model || "not configured")}</span>
          <span>Suggestions: ${semantic.suggestionCount}</span>
          <span>Observed: ${semantic.observedAt ? escapeHtml(formatTime(semantic.observedAt)) : "never"}</span>
        </div>
        ${
          semantic.pageTitle || semantic.pageUrl
            ? `<div class="bridge-card__meta"><span>Page: ${escapeHtml(semantic.pageTitle || semantic.pageUrl || "")}</span></div>`
            : ""
        }
        ${
          semantic.disabledReason
            ? `
              <div class="bridge-card__error">
                <div class="bridge-card__error-title">${escapeHtml(semantic.disabledReason)}</div>
                <div class="bridge-card__error-meta">Configure STAGEHAND_MODEL and the matching provider API key, then run npm run semantic.</div>
              </div>`
            : ""
        }
        ${
          semantic.lastError
            ? `
              <div class="bridge-card__error">
                <div class="bridge-card__error-title">${escapeHtml(semantic.lastError.message)}</div>
                <div class="bridge-card__error-meta">${escapeHtml(semantic.lastError.code)}</div>
              </div>`
            : ""
        }
      </div>
    </section>
  `;
}

function renderTabOrchestrationPanel(tabs: TrackedTabState[], activeTabId: number | null, mode: AppMode, searchQuery: string): string {
  const sorted = sortTrackedTabs(tabs, activeTabId);
  const query = searchQuery.trim();
  const searchResults = searchTrackedTabs(tabs, searchQuery, activeTabId);
  const visibleResults = limit(searchResults, mode === "popup" ? 5 : 10);

  return `
    <section class="panel panel--tabs">
      <div class="section-head">
        <h2>Tab intelligence</h2>
        <span class="section-note">MCP-style cross-tab search and focus</span>
      </div>
      <div class="tabs-toolbar">
        <label class="tabs-toolbar__search">
          <span class="tabs-toolbar__search-label">Search tabs</span>
          <input
            class="tabs-toolbar__search-input"
            data-tab-search
            type="search"
            placeholder="Search titles, URLs, summaries, or site adapters"
            value="${safeAttr(searchQuery)}"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
        <button class="btn btn--ghost" data-action="refresh-tabs" type="button">Refresh tabs</button>
        <span class="section-note">${query ? `${searchResults.length} match${searchResults.length === 1 ? "" : "es"} for "${escapeHtml(query)}"` : `${sorted.length} tracked tab${sorted.length === 1 ? "" : "s"}`}</span>
      </div>
      ${
        visibleResults.length === 0
          ? `<p class="empty">No tracked tabs matched the current search. Refresh tabs to rebuild the inventory.</p>`
          : `<ul class="tab-list">${visibleResults
              .map((result) => {
                const tab = result.tab;
                const isCurrent = tab.tabId === activeTabId;
                const statusTone = tabStatusTone(tab, activeTabId);
                const statusLabel = tabStatusLabel(tab, activeTabId);
                const approvals = tab.approvals.filter((approval) => approval.status === "pending" || approval.status === "executing").length;
                const interactiveCount = tab.pageState?.interactiveCount ?? 0;
                const adapterLabel = tab.pageState?.siteAdapterLabel || tab.snapshot?.siteAdapter?.label || "";

                return `
                  <li class="tab-row${isCurrent ? " tab-row--active" : ""}">
                    <div class="tab-row__top">
                      <div>
                        <div class="tab-row__title">${escapeHtml(tab.title || "Untitled page")}</div>
                        <div class="tab-row__url">${escapeHtml(tab.url || "Unknown url")}</div>
                      </div>
                      ${renderChip(statusLabel, statusTone)}
                    </div>
                    <div class="tab-row__meta">
                      <span>${escapeHtml(`Window ${tab.windowId}`)}</span>
                      <span>${tab.contentReady ? "Content ready" : "No content script"}</span>
                      <span>${tab.snapshotFresh ? "Snapshot fresh" : "Snapshot stale"}</span>
                      <span>${approvals > 0 ? `${approvals} approval${approvals === 1 ? "" : "s"}` : "No approvals"}</span>
                      ${adapterLabel ? `<span>Adapter: ${escapeHtml(adapterLabel)}</span>` : ""}
                      ${query ? `<span>Match: ${escapeHtml(result.reason)}</span>` : ""}
                    </div>
                    <div class="tab-row__summary">${escapeHtml(summarizeTrackedTab(tab))}</div>
                    <div class="tab-row__footer">
                      <span>Interactive controls: ${interactiveCount}</span>
                      <span>Last seen ${escapeHtml(formatRelative(tab.lastSeenAt))}</span>
                    </div>
                    <div class="tab-row__actions">
                      ${
                        isCurrent
                          ? `<span class="tab-row__current">Current tab</span>`
                          : `<button class="btn btn--ghost" data-tab-action="focus" data-tab-id="${safeAttr(String(tab.tabId))}" type="button">Focus</button>`
                      }
                      <button class="btn btn--ghost" data-tab-action="scan" data-mode="full" data-tab-id="${safeAttr(String(tab.tabId))}" type="button">Scan</button>
                      <button class="btn btn--ghost" data-tab-action="scan" data-mode="summary" data-tab-id="${safeAttr(String(tab.tabId))}" type="button">Summary</button>
                    </div>
                  </li>`;
              })
              .join("")}</ul>`
      }
      ${
        sorted.length > visibleResults.length
          ? `<p class="section-note">Showing ${visibleResults.length} of ${sorted.length} tracked tabs${query ? " after search filtering" : ""}.</p>`
          : ""
      }
    </section>
  `;
}

function renderWorkflowSteps(workflow: WorkflowState | null): string {
  const active = workflow?.activeWorkflow;
  if (!active) {
    return `<p class="empty">No active workflow plan yet. Enter a multi-step command to create one.</p>`;
  }

  if (active.steps.length === 0) {
    return `<p class="empty">This workflow does not have any steps yet.</p>`;
  }

  return `<ol class="workflow-step-list">${active.steps
    .map((step, index) => {
      const tone = workflowStepStatusTone(step.status);
      const badge = workflowStepStatusLabel(step.status);
      const current = index === active.currentStepIndex ? " workflow-step--current" : "";
      return `
        <li class="workflow-step${current}">
          <div class="workflow-step__header">
            <div class="workflow-step__title">${escapeHtml(step.title)}</div>
            ${renderChip(badge, tone)}
          </div>
          <div class="workflow-step__description">${escapeHtml(step.description)}</div>
          ${
            step.notes
              ? `<div class="workflow-step__notes">${escapeHtml(step.notes)}</div>`
              : ""
          }
        </li>`;
    })
    .join("")}</ol>`;
}

function renderWorkflowPanel(workflow: WorkflowState | null): string {
  if (!workflow) {
    return `<section class="panel panel--workflow"><p class="empty">No workflow memory available yet.</p></section>`;
  }

  const active = workflow.activeWorkflow;
  const progress = workflowProgress(workflow);
  const tone = active ? workflowStatusTone(active.status) : "neutral";
  const label = active ? workflowStatusLabel(active.status) : "Idle";
  const nextStep = getActiveWorkflowNextStep(workflow);
  const nextRequest = nextStep?.request ?? null;
  const nextSummary = nextStep
    ? `${nextStep.title}${nextStep.request?.kind === "request-action" ? " (approval queued before execution)" : ""}`
    : "No active step is ready to continue.";
  const recent = workflow.recentWorkflows.slice().reverse();

  return `
    <section class="panel panel--workflow">
      <div class="section-head">
        <h2>Workflow memory</h2>
        <span class="section-note">Planner state and recent outcomes</span>
      </div>
      <div class="bridge-card workflow-card">
        <div class="bridge-card__top">
          <div>
            <div class="bridge-card__label">Workflow state</div>
            <div class="bridge-card__summary">${escapeHtml(summarizeWorkflowState(workflow))}</div>
          </div>
          <span class="status-chip status-chip--${tone}">${escapeHtml(label)}</span>
        </div>
        <div class="bridge-card__meta">
          <span>Completed: ${progress.completed}/${progress.total || 0}</span>
          <span>Blocked: ${progress.blocked}</span>
          <span>Last instruction: ${escapeHtml(workflow.lastInstruction || "none")}</span>
          <span>Last objective: ${escapeHtml(workflow.lastObjective || "none")}</span>
        </div>
        ${
          active
            ? `
              <div class="workflow-card__focus">
                <div class="workflow-card__focus-label">Current workflow</div>
                <div class="workflow-card__focus-title">${escapeHtml(active.objective)}</div>
                <div class="workflow-card__focus-meta">Step ${Math.min(active.currentStepIndex + 1, active.steps.length || 1)} of ${active.steps.length || 1}</div>
                <div class="workflow-card__focus-next">${escapeHtml(nextSummary)}</div>
                ${
                  active.status === "paused"
                    ? `<div class="workflow-card__blocked">The current step is blocked or unsupported. Start a new command to replace the workflow, or continue manually if the page changed.</div>`
                    : ""
                }
                ${
                  nextRequest
                    ? `<div class="approval-dialog__actions"><button class="btn btn--primary" data-action="continue-workflow" type="button">Continue workflow</button></div>`
                    : ""
                }
              </div>`
            : ""
        }
      </div>
      <div class="section-split">
        <div>
          <h3>Steps</h3>
          ${renderWorkflowSteps(workflow)}
        </div>
        <div>
          <h3>Memory notes</h3>
          ${
            workflow.memoryNotes.length > 0
              ? `<ul class="workflow-note-list">${workflow.memoryNotes
                  .slice()
                  .reverse()
                  .map((note) => `<li>${escapeHtml(note)}</li>`)
                  .join("")}</ul>`
              : `<p class="empty">No workflow notes yet.</p>`
          }
          <h3>Recent workflows</h3>
          ${
            recent.length > 0
              ? `<ul class="workflow-history-list">${recent
                  .map((entry) => `
                    <li class="workflow-history-item">
                      <div class="workflow-history-item__top">
                        <span class="workflow-history-item__title">${escapeHtml(entry.objective)}</span>
                        ${renderChip(workflowStatusLabel(entry.status), workflowStatusTone(entry.status))}
                      </div>
                      <div class="workflow-history-item__meta">
                        <span>${entry.completedStepCount}/${entry.stepCount} steps</span>
                        <span>${escapeHtml(entry.originTitle || entry.originUrl || "unknown page")}</span>
                      </div>
                    </li>`)
                  .join("")}</ul>`
              : `<p class="empty">No recent workflows yet.</p>`
          }
        </div>
      </div>
    </section>
  `;
}

function renderPanels(
  tab: TrackedTabState | null,
  snapshot: PageSnapshot | null,
  bridge: BridgeState | null,
  liveTakeover: LiveTakeoverState | null,
  semantic: SemanticState | null,
  workflow: WorkflowState | null,
  tabs: TrackedTabState[],
  activeTabId: number | null,
  tabSearchQuery: string,
  mode: AppMode,
): string {
  const maxInteractive = mode === "popup" ? 6 : 14;
  const maxLogs = mode === "popup" ? 6 : 12;

  return `
    ${renderSummary(tab, snapshot, mode)}
    ${renderTabOrchestrationPanel(tabs, activeTabId, mode, tabSearchQuery)}
    ${renderBridgePanel(bridge)}
    ${renderLiveTakeoverPanel(liveTakeover)}
    ${renderSemanticPanel(semantic)}
    ${renderWorkflowPanel(workflow)}
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
      ${
        tab?.lastError
          ? `
            <div class="error-box">
              <div class="error-box__title">${escapeHtml(tab.lastError.message)}</div>
              <div class="error-box__meta">${escapeHtml(tab.lastError.code)} ${tab.lastError.recoverable ? "(recoverable)" : "(blocking)"}</div>
              ${tab.lastError.details ? `<pre class="error-box__details">${escapeHtml(tab.lastError.details)}</pre>` : ""}
            </div>`
          : `<p class="empty">No errors to report. If something fails, the message will appear here.</p>`
      }
    </section>
  `;
}

export class BrowserCompanionApp {
  private state: ExtensionState | null = null;
  private port: chrome.runtime.Port | null = null;
  private reconnectTimer: number | null = null;
  private currentApproval: ApprovalRequest | null = null;
  private commandFeedback = "";
  private tabSearchQuery = "";
  private suggestionLookup = new Map<string, SuggestedAction>();
  private readonly rootShell: HTMLElement;
  private readonly stateRoot: HTMLElement;
  private readonly commandInput: HTMLInputElement;
  private readonly commandForm: HTMLFormElement;
  private readonly commandFeedbackNode: HTMLElement;
  private readonly statusChip: HTMLElement;
  private readonly statusSubline: HTMLElement;
  private readonly approvalDialog: HTMLDialogElement;
  private readonly approvalTitle: HTMLElement;
  private readonly approvalDescription: HTMLElement;
  private readonly approvalMeta: HTMLElement;
  private readonly approvalTarget: HTMLElement;
  private readonly approvalDanger: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly mode: AppMode) {
    this.root.classList.add("app-shell");
    this.root.dataset.mode = mode;
    this.renderShell();
    this.rootShell = this.root;
    this.stateRoot = this.rootShell.querySelector<HTMLElement>("#state-root")!;
    this.commandInput = this.rootShell.querySelector<HTMLInputElement>("#command-input")!;
    this.commandForm = this.rootShell.querySelector<HTMLFormElement>("#command-form")!;
    this.commandFeedbackNode = this.rootShell.querySelector<HTMLElement>("#command-feedback")!;
    this.statusChip = this.rootShell.querySelector<HTMLElement>("#status-chip")!;
    this.statusSubline = this.rootShell.querySelector<HTMLElement>("#status-subline")!;
    this.approvalDialog = this.rootShell.querySelector<HTMLDialogElement>("#approval-dialog")!;
    this.approvalTitle = this.rootShell.querySelector<HTMLElement>("#approval-title")!;
    this.approvalDescription = this.rootShell.querySelector<HTMLElement>("#approval-description")!;
    this.approvalMeta = this.rootShell.querySelector<HTMLElement>("#approval-meta")!;
    this.approvalTarget = this.rootShell.querySelector<HTMLElement>("#approval-target")!;
    this.approvalDanger = this.rootShell.querySelector<HTMLElement>("#approval-danger")!;
    this.bindEvents();
    this.connect();
  }

  private renderShell(): void {
    const logoUrl = chrome.runtime.getURL("icons/icon-128.png");
    this.root.innerHTML = `
      <div class="app-shell__frame">
        <header class="hero">
          <div class="hero__brand">
            <img class="hero__logo" src="${escapeHtml(logoUrl)}" alt="Codex logo" />
            <div class="hero__copy">
              <p class="eyebrow">Codex Browser Companion</p>
              <h1>Active tab control</h1>
              <p class="lede">Inspect the current page, queue approved actions, and keep Codex tied to the active tab.</p>
            </div>
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
            <button class="btn btn--ghost" data-action="refresh-bridge" type="button">Refresh bridge</button>
            <button class="btn btn--ghost" data-action="refresh-live-takeover" type="button">Refresh takeover</button>
            <button class="btn btn--ghost" data-action="toggle-live-takeover" type="button">Toggle takeover</button>
            <button class="btn btn--ghost" data-action="refresh-semantic" type="button">Refresh semantic</button>
            <button class="btn btn--ghost" data-action="refresh-tabs" type="button">Refresh tabs</button>
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

  private bindEvents(): void {
    this.root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      const approvalButton = target.closest<HTMLElement>("[data-approval-action][data-approval-id]");
      if (approvalButton) {
        const approvalId = approvalButton.dataset.approvalId;
        const approvalAction = approvalButton.dataset.approvalAction;
        if (approvalId && approvalAction) {
          event.preventDefault();
          this.send({
            kind: approvalAction === "approve" ? "approve-action" : "reject-action",
            approvalId,
          });
        }
        return;
      }

      const suggestionButton = target.closest<HTMLElement>("[data-suggestion-id]");
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

      const tabActionButton = target.closest<HTMLElement>("[data-tab-action][data-tab-id]");
      if (tabActionButton) {
        const tabAction = tabActionButton.dataset.tabAction;
        const tabId = Number.parseInt(tabActionButton.dataset.tabId ?? "", 10);
        if (!tabAction || !Number.isFinite(tabId)) {
          return;
        }

        event.preventDefault();
        if (tabAction === "focus") {
          this.send({ kind: "focus-tab", tabId });
        } else if (tabAction === "scan") {
          const mode = (tabActionButton.dataset.mode as "full" | "interactive" | "summary" | "suggestions" | undefined) ?? "full";
          this.send({ kind: "scan-tab", tabId, mode });
        }
        return;
      }

      const quickAction = target.closest<HTMLElement>("[data-action]");
      if (quickAction) {
        const action = quickAction.dataset.action;
        if (!action) {
          return;
        }

        event.preventDefault();
        if (action === "scan-page") {
          const mode = (quickAction.dataset.mode as "full" | "interactive" | "summary" | "suggestions" | undefined) ?? "full";
          this.send({ kind: "scan-page", mode });
        } else if (action === "refresh-bridge") {
          this.send({ kind: "refresh-bridge" });
        } else if (action === "refresh-live-takeover") {
          this.send({ kind: "refresh-live-takeover" });
        } else if (action === "toggle-live-takeover") {
          this.send({ kind: "toggle-live-takeover" });
        } else if (action === "refresh-semantic") {
          this.send({ kind: "refresh-semantic" });
        } else if (action === "refresh-tabs") {
          this.send({ kind: "refresh-tabs" });
        } else if (action === "open-sidepanel") {
          this.send({ kind: "open-sidepanel" });
        } else if (action === "resume-user-intervention") {
          this.send({ kind: "resume-user-intervention" });
        } else if (action === "continue-workflow") {
          const nextStep = getActiveWorkflowNextStep(this.state?.workflow ?? null);
          if (nextStep?.request) {
            this.sendSuggestion(nextStep.request);
            this.setFeedback(`Continuing workflow: ${nextStep.title}`, "info");
          } else {
            this.setFeedback("No workflow step is ready to continue yet.", "warning");
          }
        } else if (action === "clear-log") {
          this.send({ kind: "clear-log" });
        }
      }
    });

    this.root.addEventListener("input", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      const tabSearchInput = target.closest<HTMLInputElement>("[data-tab-search]");
      if (tabSearchInput && tabSearchInput === target) {
        this.tabSearchQuery = tabSearchInput.value;
        this.renderState();
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
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      if (target instanceof HTMLDialogElement || target.classList.contains("approval-dialog")) {
        return;
      }

      const button = target.closest<HTMLButtonElement>("button[value]");
      if (button?.value === "cancel") {
        this.closeApprovalDialog();
      }
    });
  }

  private connect(): void {
    this.port?.disconnect();
    this.port = chrome.runtime.connect({ name: "codex-ui" });
    this.port.postMessage({ kind: "get-state" });

    this.port.onMessage.addListener((message: unknown) => {
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

  private isAppMessage(message: unknown): message is AppMessage {
    return typeof message === "object" && message !== null && "kind" in message;
  }

  private handleMessage(message: AppMessage): void {
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
          const currentTab = this.state.tabs[message.tabId]!;
          const intervention = resolveUserIntervention(message.snapshot.pageKind);
          const updatedTab: TrackedTabState = {
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
              siteAdapterId: message.snapshot.siteAdapter?.id ?? null,
              siteAdapterLabel: message.snapshot.siteAdapter?.label ?? null,
              userInterventionKind: intervention?.kind ?? null,
              userInterventionMessage: intervention?.message ?? null,
              updatedAt: message.snapshot.capturedAt,
            },
            snapshotFresh: true,
            contentReady: currentTab.contentReady,
            busy: currentTab.busy,
            approvals: currentTab.approvals,
            activityLog: currentTab.activityLog,
            lastError: null,
            lastSeenAt: nowIso(),
          };
          this.state = {
            ...this.state,
            ...(this.state.activeTabId === message.tabId && intervention ? { status: "awaiting-user" as const } : {}),
            tabs: {
              ...this.state.tabs,
              [message.tabId]: updatedTab,
            },
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

  private activeTab(): TrackedTabState | null {
    if (!this.state || this.state.activeTabId === null) {
      return null;
    }

    return this.state.tabs[this.state.activeTabId] ?? null;
  }

  private snapshot(): PageSnapshot | null {
    return getPageState(this.activeTab());
  }

  private renderState(): void {
    const activeTab = this.activeTab();
    const snapshot = this.snapshot();
    const intervention = getTabIntervention(activeTab);
    this.statusChip.className = `status-chip ${statusClass(this.state?.status ?? "idle")}`;
    this.statusChip.textContent = statusLabel(this.state?.status ?? "idle");
    this.statusSubline.textContent = activeTab
      ? intervention?.message ?? `${activeTab.title || "Untitled page"}${activeTab.snapshotFresh ? " - snapshot fresh" : " - snapshot stale"}`
      : "Waiting for a page.";

    this.stateRoot.innerHTML = renderPanels(
      activeTab,
      snapshot,
      this.state?.bridge ?? null,
      this.state?.liveTakeover ?? null,
      this.state?.semantic ?? null,
      this.state?.workflow ?? null,
      Object.values(this.state?.tabs ?? {}),
      this.state?.activeTabId ?? null,
      this.tabSearchQuery,
      this.mode,
    );
    this.suggestionLookup = new Map((snapshot?.suggestedActions ?? []).map((suggestion) => [suggestion.id, suggestion]));

    if (this.currentApproval) {
      this.renderApprovalDialog();
    }
  }

  private renderApprovalDialog(): void {
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
    const approveButton = this.approvalDialog.querySelector<HTMLButtonElement>('[data-approval-action="approve"]');
    const rejectButton = this.approvalDialog.querySelector<HTMLButtonElement>('[data-approval-action="reject"]');
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

  private openApprovalDialog(approval: ApprovalRequest): void {
    this.currentApproval = approval;
    this.renderApprovalDialog();
    this.setFeedback(`Action requires approval: ${approval.title}`, approval.dangerLevel === "high" ? "warning" : "info");
  }

  private closeApprovalDialog(): void {
    this.currentApproval = null;
    if (this.approvalDialog.open) {
      this.approvalDialog.close();
    }
  }

  private setFeedback(message: string, tone: "info" | "success" | "warning" | "error"): void {
    this.commandFeedback = message;
    this.commandFeedbackNode.className = `command-feedback command-feedback--${tone}`;
    this.commandFeedbackNode.textContent = message;
    if (tone === "success" || tone === "error") {
      window.setTimeout(() => {
        if (this.commandFeedbackNode.textContent === message) {
          this.commandFeedbackNode.textContent = "";
          this.commandFeedbackNode.className = "command-feedback";
        }
      }, 3000);
    }
  }

  private attachTabContext<T extends UiRequest | SuggestedRequest>(request: T): T {
    const activeTab = this.activeTab();
    const activeContext = activeTab ? buildTabContextFromTrackedTab(activeTab) : null;
    if (!activeContext) {
      return request;
    }

    switch (request.kind) {
      case "scan-page":
      case "list-interactive-elements":
      case "summarize-page":
      case "suggest-next-actions":
        return (request.tabContext ? request : { ...request, tabContext: activeContext }) as T;
      case "request-action": {
        const context = request.tabContext ?? request.action.tabContext ?? activeContext;
        const actionTabId = request.action.tabId >= 0 ? request.action.tabId : context.tabId;
        return {
          ...request,
          tabContext: context,
          action: {
            ...request.action,
            tabId: actionTabId,
            tabContext: context,
          },
        } as T;
      }
      default:
        return request;
    }
  }

  private send(request: UiRequest | SuggestedRequest): void {
    this.port?.postMessage(this.attachTabContext(request));
  }

  private sendSuggestion(request: SuggestedRequest): void {
    this.port?.postMessage(this.attachTabContext(request));
  }

  private async handleCommandSubmit(): Promise<void> {
    const value = this.commandInput.value.trim();
    if (!value) {
      this.setFeedback("Type a command before running it.", "warning");
      return;
    }

    const activeTab = this.activeTab();
    const intervention = getTabIntervention(activeTab);
    if (intervention) {
      if (isResumeSignal(value)) {
        this.commandInput.value = "";
        this.send({ kind: "resume-user-intervention" });
        this.setFeedback("Resuming after the manual step.", "info");
        return;
      }

      this.setFeedback(intervention.message, "warning");
      return;
    }

    const preview = buildWorkflowPlanFromInstruction(value, this.snapshot(), this.state?.workflow?.activeWorkflow ?? null);
    if (!preview) {
      this.setFeedback("Could not parse that command. Try: click save, type hello into search, scroll down 600, summarize page.", "error");
      return;
    }

    this.commandInput.value = "";
    this.setFeedback(preview.explanation, "info");
    const activeWorkflowId = this.state?.workflow?.activeWorkflow?.workflowId ?? null;
    const isResumingActiveWorkflow = activeWorkflowId !== null && preview.workflow.workflowId === activeWorkflowId;

    if (!isResumingActiveWorkflow) {
      this.port?.postMessage({ kind: "plan-workflow", workflow: preview.workflow });
    }

    if (preview.primaryRequest) {
      const request = this.attachTabContext(preview.primaryRequest);
      window.setTimeout(() => {
        this.port?.postMessage(request);
      }, 0);
    }
  }
}

export function mountBrowserCompanionApp(root: HTMLElement, mode: AppMode): BrowserCompanionApp {
  return new BrowserCompanionApp(root, mode);
}
