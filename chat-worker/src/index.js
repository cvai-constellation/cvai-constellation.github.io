import { DurableObject } from "cloudflare:workers";

const SITE_ORIGIN = "https://cvai-constellation.github.io";
const HISTORY_LIMIT = 50;
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
const MESSAGE_LIMIT = 280;

function originAllowed(origin) {
  if (origin === SITE_ORIGIN) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");
}

function cleanText(value, limit) {
  const text = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).slice(0, limit).join("");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": SITE_ORIGIN,
    },
  });
}

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        text TEXT NOT NULL,
        venue TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
    `);
  }

  async fetch(request) {
    if (!originAllowed(request.headers.get("Origin"))) {
      return json({ error: "Origin not allowed" }, 403);
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    if (this.connectionCount() >= 100) {
      return new Response("Chat room is full", { status: 503 });
    }

    const url = new URL(request.url);
    const name = cleanText(url.searchParams.get("name"), 24) || "guest";
    const venue = url.searchParams.get("venue") === "eccv" ? "ECCV" : "CVPR";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const session = {
      id: crypto.randomUUID(),
      name,
      venue,
      joinedAt: Date.now(),
      lastAt: 0,
      windowAt: Date.now(),
      windowCount: 0,
    };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(session);
    server.send(JSON.stringify({
      type: "hello",
      sessionId: session.id,
      history: this.getHistory(),
      presence: this.connectionCount(),
    }));
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  getHistory() {
    const cutoff = Date.now() - HISTORY_TTL_MS;
    return this.sql.exec(
      `SELECT id, name, text, venue, ts FROM (
         SELECT id, name, text, venue, ts
         FROM messages WHERE ts >= ? ORDER BY ts DESC LIMIT ?
       ) ORDER BY ts ASC`,
      cutoff,
      HISTORY_LIMIT,
    ).toArray();
  }

  connectionCount() {
    return this.ctx.getWebSockets()
      .filter(socket => socket.readyState === WebSocket.OPEN).length;
  }

  broadcast(data) {
    const payload = JSON.stringify(data);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(payload);
      } catch (_) {
        // The close callback updates presence once the runtime confirms closure.
      }
    }
  }

  broadcastPresence() {
    this.broadcast({ type: "presence", count: this.connectionCount() });
  }

  webSocketMessage(socket, raw) {
    if (typeof raw !== "string" || raw.length > 2048) {
      socket.send(JSON.stringify({ type: "error", message: "Message is too large." }));
      return;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      socket.send(JSON.stringify({ type: "error", message: "Invalid message." }));
      return;
    }
    if (data.type !== "chat") return;

    const session = socket.deserializeAttachment();
    if (!session) return;
    const now = Date.now();
    if (now - session.lastAt < 1200) {
      socket.send(JSON.stringify({ type: "error", message: "Please slow down." }));
      return;
    }
    if (now - session.windowAt >= 60_000) {
      session.windowAt = now;
      session.windowCount = 0;
    }
    if (session.windowCount >= 12) {
      socket.send(JSON.stringify({ type: "error", message: "Rate limit reached. Try again soon." }));
      return;
    }

    const text = cleanText(data.text, MESSAGE_LIMIT);
    if (!text) return;
    session.lastAt = now;
    session.windowCount += 1;
    socket.serializeAttachment(session);

    const message = {
      type: "message",
      id: crypto.randomUUID(),
      name: session.name,
      text,
      venue: session.venue,
      ts: now,
      senderId: session.id,
    };
    this.sql.exec(
      "INSERT INTO messages (id, name, text, venue, ts) VALUES (?, ?, ?, ?, ?)",
      message.id,
      message.name,
      message.text,
      message.venue,
      message.ts,
    );
    this.sql.exec("DELETE FROM messages WHERE ts < ?", now - HISTORY_TTL_MS);
    this.sql.exec(
      `DELETE FROM messages WHERE id NOT IN (
         SELECT id FROM messages ORDER BY ts DESC LIMIT ?
       )`,
      HISTORY_LIMIT,
    );
    this.broadcast(message);
  }

  webSocketClose() {
    this.broadcastPresence();
  }

  webSocketError() {
    this.broadcastPresence();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "cvai-constellation-chat" });
    }
    if (url.pathname !== "/chat") {
      return json({ error: "Not found" }, 404);
    }
    if (!originAllowed(request.headers.get("Origin"))) {
      return json({ error: "Origin not allowed" }, 403);
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }
    const room = url.searchParams.get("room") === "e2e" ? "e2e" : "global";
    return env.CHAT_ROOM.getByName(room).fetch(request);
  },
};
