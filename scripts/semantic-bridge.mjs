#!/usr/bin/env node

import http from "node:http";
import { URL } from "node:url";
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

const port = Number.parseInt(process.env.SEMANTIC_PORT ?? "19989", 10);
const browserEndpoint = process.env.PLAYWRITER_ENDPOINT ?? "http://localhost:19988";
const model = process.env.STAGEHAND_MODEL?.trim() ?? "";

const observeRequestSchema = z.object({
  instruction: z.string().min(1),
  pageUrl: z.string().min(1).optional(),
  pageTitle: z.string().min(1).optional(),
  snapshotSummary: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(12).optional(),
});

let stagehand = null;
let initPromise = null;
let lastError = null;
let observedAt = null;

function nowIso() {
  return new Date().toISOString();
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function normalizeUrl(input) {
  if (!input) {
    return "";
  }

  try {
    const url = new URL(input);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(input).trim().replace(/\/$/, "");
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function ensureStagehand() {
  if (!model) {
    const error = new Error("STAGEHAND_MODEL is not set.");
    error.code = "SEMANTIC_MODEL_NOT_CONFIGURED";
    throw error;
  }

  if (stagehand) {
    return stagehand;
  }

  if (!initPromise) {
    initPromise = (async () => {
      const instance = new Stagehand({
        env: "LOCAL",
        model,
        localBrowserLaunchOptions: {
          cdpUrl: browserEndpoint,
        },
        verbose: 0,
      });

      await instance.init();
      return instance;
    })()
      .then((instance) => {
        stagehand = instance;
        lastError = null;
        return instance;
      })
      .catch((error) => {
        lastError = error;
        initPromise = null;
        throw error;
      });
  }

  return initPromise;
}

async function findActivePage(instance, requestedUrl, requestedTitle) {
  const pages = instance.context.pages();
  const normalizedRequestedUrl = normalizeUrl(requestedUrl);
  const normalizedRequestedTitle = requestedTitle?.trim().toLowerCase() ?? "";

  if (normalizedRequestedUrl) {
    for (const page of pages) {
      if (normalizeUrl(page.url()) === normalizedRequestedUrl) {
        return page;
      }
    }
  }

  if (normalizedRequestedTitle) {
    for (const page of pages) {
      try {
        const title = (await page.title()).trim().toLowerCase();
        if (title === normalizedRequestedTitle) {
          return page;
        }
      } catch {
        // Ignore title lookup failures and fall back to the active page.
      }
    }
  }

  const activePage = await instance.context.awaitActivePage(5000);
  if (activePage) {
    return activePage;
  }

  return pages[pages.length - 1] ?? null;
}

function getHealthPayload() {
  if (!model) {
    return {
      endpoint: `http://localhost:${port}`,
      browserEndpoint,
      status: "disabled",
      model: null,
      reason: "STAGEHAND_MODEL is not set.",
      observedAt: observedAt,
      lastError: null,
    };
  }

  if (stagehand) {
    return {
      endpoint: `http://localhost:${port}`,
      browserEndpoint,
      status: "ready",
      model,
      reason: null,
      observedAt,
      lastError: null,
    };
  }

  if (lastError) {
    return {
      endpoint: `http://localhost:${port}`,
      browserEndpoint,
      status: "error",
      model,
      reason: lastError.message ?? "Stagehand initialization failed.",
      observedAt,
      lastError: {
        code: lastError.code ?? "SEMANTIC_BRIDGE_ERROR",
        message: lastError.message ?? "Stagehand initialization failed.",
        details: lastError.stack ?? undefined,
        recoverable: true,
        tabId: undefined,
        occurredAt: nowIso(),
      },
    };
  }

  return {
    endpoint: `http://localhost:${port}`,
    browserEndpoint,
    status: "disconnected",
    model,
    reason: null,
    observedAt,
    lastError: null,
  };
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${port}`}`);

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    json(res, 200, getHealthPayload());
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/observe") {
    if (!model) {
      json(res, 200, {
        endpoint: `http://localhost:${port}`,
        browserEndpoint,
        status: "disabled",
        model: null,
        pageUrl: null,
        pageTitle: null,
        reason: "STAGEHAND_MODEL is not set.",
        observedAt: nowIso(),
        actions: [],
      });
      return;
    }

    try {
      const body = observeRequestSchema.parse(await readJson(req));
      const instance = await ensureStagehand();
      const page = await findActivePage(instance, body.pageUrl, body.pageTitle);

      if (!page) {
        json(res, 503, {
          ...getHealthPayload(),
          status: "error",
          reason: "No active page is available in the live Chrome session.",
        });
        return;
      }

      const actions = await instance.observe(body.instruction, {
        page,
        timeout: 15000,
        serverCache: false,
      });

      observedAt = nowIso();

      json(res, 200, {
        endpoint: `http://localhost:${port}`,
        browserEndpoint,
        status: "ready",
        model,
        pageUrl: page.url(),
        pageTitle: await page.title().catch(() => body.pageTitle ?? null),
        reason: null,
        observedAt,
        actions: actions.slice(0, body.limit ?? 5).map((action) => ({
          selector: action.selector,
          description: action.description,
          method: action.method ?? undefined,
          arguments: Array.isArray(action.arguments) ? action.arguments : undefined,
        })),
      });
    } catch (error) {
      lastError = error;
      json(res, 500, {
        ...getHealthPayload(),
        status: "error",
        reason: error.message ?? "Stagehand observation failed.",
      });
    }
    return;
  }

  json(res, 404, {
    error: "Not found",
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[semantic-bridge] listening on http://127.0.0.1:${port}`);
  console.log(`[semantic-bridge] browser endpoint: ${browserEndpoint}`);
  if (model) {
    console.log(`[semantic-bridge] model: ${model}`);
  } else {
    console.log("[semantic-bridge] model not configured; bridge will remain disabled until STAGEHAND_MODEL is set.");
  }
});

async function shutdown(signal) {
  try {
    if (stagehand) {
      await stagehand.close().catch(() => undefined);
    }
  } finally {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 250).unref?.();
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
