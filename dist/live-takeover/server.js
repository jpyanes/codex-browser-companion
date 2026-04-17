// src/live-takeover/server.ts
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// src/shared/logger.ts
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}

// src/shared/live-takeover.ts
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function toStringOrNull(value) {
  return typeof value === "string" && value.trim() ? value : null;
}
function toNumberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}
function isLiveTakeoverCommandType(value) {
  return value === "snapshot" || value === "click" || value === "fill" || value === "press" || value === "navigate";
}
function createInitialLiveTakeoverServerState() {
  return {
    startedAt: nowIso(),
    lastHeartbeat: null,
    activeTab: {
      tabId: null,
      windowId: null,
      url: null,
      title: null,
      ts: null
    },
    queue: [],
    results: {}
  };
}
function normalizeLiveTakeoverCommand(value) {
  if (!isRecord(value)) {
    return null;
  }
  const id = toStringOrNull(value.id);
  const type = isLiveTakeoverCommandType(value.type) ? value.type : null;
  const createdAt = toStringOrNull(value.createdAt);
  const claimedAt = toStringOrNull(value.claimedAt);
  if (!id || !type || !createdAt) {
    return null;
  }
  return {
    id,
    type,
    payload: isRecord(value.payload) ? { ...value.payload } : {},
    createdAt,
    ...claimedAt ? { claimedAt } : {},
    tabId: toNumberOrNull(value.tabId),
    url: toStringOrNull(value.url)
  };
}
function normalizeLiveTakeoverCommandResult(value) {
  if (!isRecord(value)) {
    return null;
  }
  const commandId = toStringOrNull(value.commandId);
  const ts = toStringOrNull(value.ts);
  if (!commandId || !ts) {
    return null;
  }
  return {
    commandId,
    ok: typeof value.ok === "boolean" ? value.ok : false,
    result: "result" in value ? value.result : null,
    ts
  };
}
function normalizeLiveTakeoverServerState(value) {
  const fallback = createInitialLiveTakeoverServerState();
  if (!isRecord(value)) {
    return fallback;
  }
  const queue = Array.isArray(value.queue) ? value.queue.map((entry) => normalizeLiveTakeoverCommand(entry)).filter((entry) => entry !== null) : [];
  const results = {};
  if (isRecord(value.results)) {
    for (const [key, entry] of Object.entries(value.results)) {
      const normalized = normalizeLiveTakeoverCommandResult(entry);
      if (normalized) {
        results[key] = normalized;
      }
    }
  }
  return {
    startedAt: toStringOrNull(value.startedAt) ?? fallback.startedAt,
    lastHeartbeat: toStringOrNull(value.lastHeartbeat),
    activeTab: {
      tabId: isRecord(value.activeTab) ? toNumberOrNull(value.activeTab.tabId) : null,
      windowId: isRecord(value.activeTab) ? toNumberOrNull(value.activeTab.windowId) : null,
      url: isRecord(value.activeTab) ? toStringOrNull(value.activeTab.url) : null,
      title: isRecord(value.activeTab) ? toStringOrNull(value.activeTab.title) : null,
      ts: isRecord(value.activeTab) ? toStringOrNull(value.activeTab.ts) : null
    },
    queue,
    results
  };
}
function buildLiveTakeoverHealthSnapshot(state) {
  return {
    startedAt: state.startedAt,
    lastHeartbeat: state.lastHeartbeat,
    activeTab: state.activeTab,
    queueLength: state.queue.filter((command) => !command.claimedAt).length,
    checkedAt: nowIso()
  };
}
function claimNextLiveTakeoverCommand(state, tabId, url) {
  const command = state.queue.find((entry) => {
    if (entry.claimedAt) {
      return false;
    }
    if (entry.tabId !== null && entry.tabId !== void 0 && tabId !== null && entry.tabId !== tabId) {
      return false;
    }
    if (entry.url && url && entry.url !== url) {
      return false;
    }
    if (entry.tabId !== null && entry.tabId !== void 0 && tabId === null) {
      return false;
    }
    if (entry.url && !url) {
      return false;
    }
    return true;
  });
  if (!command) {
    return null;
  }
  command.claimedAt = nowIso();
  return command;
}
function recordLiveTakeoverResult(state, result) {
  return {
    ...state,
    results: {
      ...state.results,
      [result.commandId]: result
    },
    queue: state.queue.filter((command) => command.id !== result.commandId)
  };
}

// src/live-takeover/server.ts
var HOST = "127.0.0.1";
var PORT = Number(process.env.CODEX_LIVE_TAKEOVER_PORT || 47123);
var repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
var takeoverDir = path.join(repoRoot, ".codex", "live-takeover");
var statePath = path.join(takeoverDir, "state.json");
function ensureTakeoverDir() {
  mkdirSync(takeoverDir, { recursive: true });
}
function writeState(state) {
  ensureTakeoverDir();
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
function readState() {
  ensureTakeoverDir();
  if (!existsSync(statePath)) {
    const initial = createInitialLiveTakeoverServerState();
    writeState(initial);
    return initial;
  }
  try {
    return normalizeLiveTakeoverServerState(JSON.parse(readFileSync(statePath, "utf8")));
  } catch {
    const initial = createInitialLiveTakeoverServerState();
    writeState(initial);
    return initial;
  }
}
function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return typeof parsed === "object" && parsed !== null ? parsed : {};
}
function enqueueCommand(state, command) {
  const next = {
    id: randomUUID(),
    type: command.type,
    payload: command.payload ?? {},
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    tabId: typeof command.tabId === "number" ? command.tabId : null,
    url: typeof command.url === "string" ? command.url : null,
    ...typeof command.claimedAt === "string" && command.claimedAt.trim() ? { claimedAt: command.claimedAt } : {}
  };
  state.queue.push(next);
  writeState(state);
  return next;
}
function findResult(state, commandId) {
  return normalizeLiveTakeoverCommandResult(state.results[commandId]) ?? null;
}
var server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const state = readState();
    if (req.method === "GET" && url.pathname === "/health") {
      const health = buildLiveTakeoverHealthSnapshot(state);
      sendJson(res, 200, {
        ok: true,
        port: PORT,
        statePath,
        ...health
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/state") {
      sendJson(res, 200, state);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/heartbeat") {
      const body = await readJson(req);
      state.lastHeartbeat = typeof body.ts === "string" ? body.ts : (/* @__PURE__ */ new Date()).toISOString();
      state.activeTab = {
        tabId: typeof body.tabId === "number" && Number.isFinite(body.tabId) ? body.tabId : null,
        windowId: typeof body.windowId === "number" && Number.isFinite(body.windowId) ? body.windowId : null,
        url: typeof body.url === "string" ? body.url : null,
        title: typeof body.title === "string" ? body.title : null,
        ts: state.lastHeartbeat
      };
      writeState(state);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/commands") {
      const body = await readJson(req);
      if (!isLiveTakeoverCommandType(body.type)) {
        sendJson(res, 400, { error: "Missing command type." });
        return;
      }
      const command = enqueueCommand(state, {
        type: body.type,
        payload: typeof body.payload === "object" && body.payload !== null ? body.payload : {},
        tabId: typeof body.tabId === "number" && Number.isFinite(body.tabId) ? body.tabId : null,
        url: typeof body.url === "string" ? body.url : null
      });
      sendJson(res, 201, { command });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/commands/next") {
      const tabIdParam = url.searchParams.get("tabId");
      const tabId = tabIdParam ? Number.parseInt(tabIdParam, 10) : null;
      const command = claimNextLiveTakeoverCommand(
        state,
        Number.isFinite(tabId ?? Number.NaN) ? tabId : null,
        url.searchParams.get("url")
      );
      writeState(state);
      if (!command) {
        res.writeHead(204);
        res.end();
        return;
      }
      sendJson(res, 200, { command });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/results") {
      const body = await readJson(req);
      const normalized = normalizeLiveTakeoverCommandResult(body);
      if (!normalized) {
        sendJson(res, 400, { error: "Missing commandId or result payload." });
        return;
      }
      const nextState = recordLiveTakeoverResult(state, normalized);
      nextState.results[normalized.commandId] = normalized;
      writeState(nextState);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/v1/results/")) {
      const commandId = url.pathname.split("/").pop() || "";
      const result = findResult(state, commandId);
      if (!result) {
        sendJson(res, 404, { error: "Result not found." });
        return;
      }
      sendJson(res, 200, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/reset") {
      const initial = createInitialLiveTakeoverServerState();
      writeState(initial);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
server.listen(PORT, HOST, () => {
  ensureTakeoverDir();
  const state = readState();
  writeState(state);
  console.log(`Codex live takeover bridge listening on http://${HOST}:${PORT}`);
  console.log(`State file: ${statePath}`);
});
//# sourceMappingURL=server.js.map
