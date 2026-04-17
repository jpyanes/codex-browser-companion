import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  buildLiveTakeoverHealthSnapshot,
  claimNextLiveTakeoverCommand,
  createInitialLiveTakeoverServerState,
  isLiveTakeoverCommandType,
  normalizeLiveTakeoverCommandResult,
  normalizeLiveTakeoverServerState,
  recordLiveTakeoverResult,
} from "../shared/live-takeover";
import type {
  LiveTakeoverCommand,
  LiveTakeoverCommandResult,
} from "../shared/types";

const HOST = "127.0.0.1";
const PORT = Number(process.env.CODEX_LIVE_TAKEOVER_PORT || 47123);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const takeoverDir = path.join(repoRoot, ".codex", "live-takeover");
const statePath = path.join(takeoverDir, "state.json");

function ensureTakeoverDir(): void {
  mkdirSync(takeoverDir, { recursive: true });
}

function writeState(state: ReturnType<typeof createInitialLiveTakeoverServerState>): void {
  ensureTakeoverDir();
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function readState(): ReturnType<typeof createInitialLiveTakeoverServerState> {
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

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function enqueueCommand(
  state: ReturnType<typeof createInitialLiveTakeoverServerState>,
  command: Omit<LiveTakeoverCommand, "id" | "createdAt"> & { payload?: Record<string, unknown> },
): LiveTakeoverCommand {
  const next: LiveTakeoverCommand = {
    id: randomUUID(),
    type: command.type,
    payload: command.payload ?? {},
    createdAt: new Date().toISOString(),
    tabId: typeof command.tabId === "number" ? command.tabId : null,
    url: typeof command.url === "string" ? command.url : null,
    ...(typeof command.claimedAt === "string" && command.claimedAt.trim() ? { claimedAt: command.claimedAt } : {}),
  };

  state.queue.push(next);
  writeState(state);
  return next;
}

function findResult(state: ReturnType<typeof createInitialLiveTakeoverServerState>, commandId: string): LiveTakeoverCommandResult | null {
  return normalizeLiveTakeoverCommandResult(state.results[commandId]) ?? null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const state = readState();

    if (req.method === "GET" && url.pathname === "/health") {
      const health = buildLiveTakeoverHealthSnapshot(state);
      sendJson(res, 200, {
        ok: true,
        port: PORT,
        statePath,
        ...health,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/state") {
      sendJson(res, 200, state);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/heartbeat") {
      const body = await readJson(req);
      state.lastHeartbeat = typeof body.ts === "string" ? body.ts : new Date().toISOString();
      state.activeTab = {
        tabId: typeof body.tabId === "number" && Number.isFinite(body.tabId) ? body.tabId : null,
        windowId: typeof body.windowId === "number" && Number.isFinite(body.windowId) ? body.windowId : null,
        url: typeof body.url === "string" ? body.url : null,
        title: typeof body.title === "string" ? body.title : null,
        ts: state.lastHeartbeat,
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
        payload: typeof body.payload === "object" && body.payload !== null ? (body.payload as Record<string, unknown>) : {},
        tabId: typeof body.tabId === "number" && Number.isFinite(body.tabId) ? body.tabId : null,
        url: typeof body.url === "string" ? body.url : null,
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
        url.searchParams.get("url"),
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
      error: error instanceof Error ? error.message : String(error),
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
