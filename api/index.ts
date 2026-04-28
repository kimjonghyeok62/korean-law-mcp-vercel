/**
 * Vercel Serverless Handler - Korean Law MCP Server
 * Stateless mode: each request creates a fresh MCP server instance.
 * Session IDs are issued but in-memory sessions may not persist across cold starts;
 * the client will re-initialize automatically (404 → re-init flow).
 */

import express from "express"
import { randomUUID } from "crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { LawApiClient } from "../src/lib/api-client.js"
import { registerTools } from "../src/tool-registry.js"
import { VERSION } from "../src/version.js"
import { parseProfile } from "../src/lib/tool-profiles.js"

// 세션 맵 (warm 컨테이너 내에서만 유지 — 콜드 스타트 시 초기화됨)
interface SessionInfo {
  transport: StreamableHTTPServerTransport
  server: Server
  lastAccess: number
}
const MAX_SESSIONS = 50
const sessions = new Map<string, SessionInfo>()

// 10분 idle 세션 정리 (warm 컨테이너 전용)
const SESSION_MAX_IDLE = 10 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [sid, s] of sessions) {
    if (now - s.lastAccess > SESSION_MAX_IDLE) {
      try { s.transport.close() } catch { /* ignore */ }
      s.server.close().catch(() => {})
      sessions.delete(sid)
    }
  }
}, 5 * 60 * 1000).unref()

function extractApiKey(req: express.Request): string {
  return (
    (req.query.oc as string) ||
    (req.headers["apikey"] as string) ||
    (req.headers["x-api-key"] as string) ||
    (req.headers["law_oc"] as string) ||
    (req.headers["law-oc"] as string) ||
    ((req.headers["authorization"] as string) || "").replace(/^Bearer\s+/i, "") ||
    process.env.LAW_OC ||
    process.env.KOREAN_LAW_API_KEY ||
    ""
  )
}

const app = express()
app.use(express.json({ limit: "100kb" }))

// CORS + 보안 헤더
const corsOrigin = process.env.CORS_ORIGIN || "*"
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", corsOrigin)
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
  res.header("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, last-event-id")
  res.header("X-Content-Type-Options", "nosniff")
  res.header("X-Frame-Options", "DENY")
  if (req.method === "OPTIONS") return res.sendStatus(200)
  next()
})

// 헬스체크
app.get("/", (_req, res) => {
  res.json({
    name: "Korean Law MCP Server",
    version: VERSION,
    status: "running",
    transport: "streamable-http (Vercel serverless)",
    note: "Sessions are warm-container scoped. Clients auto-reinitialize on cold start.",
    endpoints: { mcp: "/mcp", health: "/health" },
  })
})

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() })
})

// POST /mcp — 주요 MCP 엔드포인트
app.post("/mcp", async (req, res) => {
  const apiKey = extractApiKey(req)
  const sessionId = req.headers["mcp-session-id"] as string | undefined

  try {
    const existing = sessionId ? sessions.get(sessionId) : undefined

    if (existing) {
      // warm 컨테이너에서 세션 재사용
      existing.lastAccess = Date.now()
      await existing.transport.handleRequest(req, res, req.body)
      return
    }

    if (sessionId && !existing) {
      // 콜드 스타트 → 세션 없음 → 클라이언트가 재초기화하도록 404 반환
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found (cold start). Please reinitialize." },
        id: null,
      })
      return
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      if (sessions.size >= MAX_SESSIONS) {
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: `Max sessions (${MAX_SESSIONS}) reached.` },
          id: null,
        })
        return
      }

      const apiClient = new LawApiClient({ apiKey })
      const profile = parseProfile(req.query.profile as string | undefined)

      const server = new Server(
        { name: "korean-law", version: VERSION },
        { capabilities: { tools: {} } }
      )
      registerTools(server, apiClient, profile ?? "full")

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        eventStore: new InMemoryEventStore(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, server, lastAccess: Date.now() })
        },
      })

      transport.onclose = () => {
        const sid = transport.sessionId
        if (sid) sessions.delete(sid)
      }

      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
      return
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID or init request." },
      id: null,
    })
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      })
    }
  }
})

// GET /mcp — SSE (warm 컨테이너에서만 유효)
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined
  const session = sessionId ? sessions.get(sessionId) : undefined

  if (!session) {
    res.status(404).send("Session not found. Please reinitialize.")
    return
  }

  session.lastAccess = Date.now()
  try {
    await session.transport.handleRequest(req, res)
  } catch {
    if (!res.headersSent) res.status(500).send("Internal server error")
  }
})

// DELETE /mcp — 세션 종료
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined
  const session = sessionId ? sessions.get(sessionId) : undefined

  if (!session) {
    res.status(404).send("Session not found")
    return
  }

  try {
    await session.transport.handleRequest(req, res)
    sessions.delete(sessionId!)
  } catch {
    if (!res.headersSent) res.status(500).send("Error closing session")
  }
})

export default app
