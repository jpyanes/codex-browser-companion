import { classifyDanger } from "./action-policy";
import { attachTabContextToAction, attachTabContextToRequest, buildTabContextFromSnapshot } from "./tab-context";
import type {
  InteractiveElementSummary,
  PageKind,
  PageSnapshot,
  PageStateBasic,
  SiteAdapterSummary,
  SuggestedAction,
} from "./types";

export interface SiteAdapterResolution {
  siteAdapter: SiteAdapterSummary | null;
  suggestions: SuggestedAction[];
}

function normalize(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function makeSuggestionId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function matchInteractiveElement(
  elements: InteractiveElementSummary[],
  matcher: (element: InteractiveElementSummary) => boolean,
): InteractiveElementSummary | null {
  for (const element of elements) {
    if (matcher(element)) {
      return element;
    }
  }

  return null;
}

function buildClickSuggestion(snapshot: PageSnapshot, element: InteractiveElementSummary, title: string, description: string): SuggestedAction {
  const tabContext = buildTabContextFromSnapshot(snapshot);
  const action = attachTabContextToAction(
    {
      actionId: makeSuggestionId("action"),
      tabId: snapshot.tabId,
      kind: "click",
      elementId: element.elementId,
      label: element.label || element.text || title,
      selector: element.selector,
    },
    tabContext,
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
        action,
      },
      tabContext,
    ),
    approvalRequired: true,
    dangerLevel: classifyDanger(action, snapshot),
    source: "site",
    selector: element.selector,
    confidence: 0.9,
  };
}

function buildAdapterSummary(
  id: string,
  label: string,
  kind: SiteAdapterSummary["kind"],
  summary: string,
  capabilities: string[],
  notes: string[],
): SiteAdapterSummary {
  return {
    id,
    label,
    kind,
    summary,
    capabilities,
    notes,
  };
}

export function resolveSiteAdapterFromState(state: Pick<PageStateBasic, "url" | "title" | "pageKind">): SiteAdapterSummary | null {
  const hostname = hostFromUrl(state.url);
  const title = normalize(state.title);

  if (!hostname) {
    return null;
  }

  if (hostname === "accounts.google.com" || (hostname.endsWith("google.com") && state.pageKind === "login" && title.includes("sign in"))) {
    return buildAdapterSummary(
      "google-login",
      "Google sign-in",
      "workspace-login",
      "Google sign-in is active. Sign in manually, then rescan so CBC can continue with the authenticated session.",
      ["manual sign-in", "session resume", "approval-gated follow-up"],
      ["CBC will not type passwords or bypass Google account security prompts."],
    );
  }

  if (hostname === "drive.google.com") {
    return buildAdapterSummary(
      "google-drive",
      "Google Drive",
      "workspace-app",
      "Google Drive is active. Use the New button or recent-file shortcuts to create or open documents.",
      ["new document", "recent files", "workspace navigation"],
      ["Use a rescan after opening or creating a file so the tab inventory stays fresh."],
    );
  }

  if (hostname === "docs.google.com") {
    return buildAdapterSummary(
      "google-docs",
      "Google Docs editor",
      "document-editor",
      "Google Docs is ready. The document canvas can be focused and typed into after approval.",
      ["document typing", "editor focus", "toolbar navigation"],
      ["If the editor is still loading, rescan after the contenteditable surface appears."],
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
        ["CBC will not type passwords into LinkedIn login forms."],
      );
    }

    return buildAdapterSummary(
      "linkedin-feed",
      "LinkedIn feed",
      "social-feed",
      "LinkedIn feed or profile content is visible. Use the visible post actions to inspect or engage with the feed.",
      ["feed navigation", "post engagement", "profile inspection"],
      ["Rescan after feed changes so the active tab snapshot stays current."],
    );
  }

  return null;
}

function findDocumentBodyTarget(snapshot: PageSnapshot): InteractiveElementSummary | null {
  return matchInteractiveElement(snapshot.interactiveElements, (element) => {
    const tagName = element.tagName.toLowerCase();
    const role = element.role.toLowerCase();
    return !element.isSensitive && (element.contentEditable === true || tagName === "textarea" || role === "textbox");
  });
}

function findLinkedInLikeTarget(snapshot: PageSnapshot): InteractiveElementSummary | null {
  return matchInteractiveElement(snapshot.interactiveElements, (element) => {
    const haystack = normalize([element.label, element.text, element.name ?? "", element.placeholder ?? "", element.selector, element.role, element.type ?? ""].join(" "));
    return !element.isSensitive && (haystack.includes("like") || haystack.includes("react"));
  });
}

function findGoogleDriveNewTarget(snapshot: PageSnapshot): InteractiveElementSummary | null {
  return matchInteractiveElement(snapshot.interactiveElements, (element) => {
    const haystack = normalize([element.label, element.text, element.name ?? "", element.placeholder ?? "", element.selector, element.role, element.type ?? ""].join(" "));
    return !element.isSensitive && (haystack === "new" || haystack.includes("new ") || haystack.includes("blank") || haystack.includes("create"));
  });
}

export function resolveSiteAdapterSnapshot(snapshot: PageSnapshot): SiteAdapterResolution {
  const siteAdapter = resolveSiteAdapterFromState({
    url: snapshot.url,
    title: snapshot.title,
    pageKind: snapshot.pageKind,
  });

  const suggestions: SuggestedAction[] = [];
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
          "Focus the document canvas so the next approved typing action lands in the editor.",
        ),
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
          "Open the Drive New menu so you can create a new document or file after approval.",
        ),
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
          "Click the first visible Like control in the LinkedIn feed after you review it.",
        ),
      );
    }
  }

  return {
    siteAdapter,
    suggestions,
  };
}

export function summarizeSiteAdapter(siteAdapter: SiteAdapterSummary | null): string {
  return siteAdapter ? `${siteAdapter.label} · ${siteAdapter.summary}` : "";
}
