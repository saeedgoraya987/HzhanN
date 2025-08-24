// ESM WebSocket signaling server for WebRTC
// Works behind Nginx/Cloud proxy at path `/ws` or as a direct app.
//
// Env:
//   PORT=8999
//   WS_BASE_PATH=/ws   (optional; only affects health routes when not proxied)
//
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8999);
const WS_BASE_PATH = process.env.WS_BASE_PATH || "/"; // e.g. "/ws"
const STATE_FILE = path.join(__dirname, "online.json");

// ---- tiny state helpers ----
function loadOnline() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { users: {} }; }
}
function saveOnline(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---- HTTP server (health + optional JSON of online users) ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  // When proxied at /ws -> upstream path is likely "/" (Nginx `location /ws`)
  // So expose both with and without WS_BASE_PATH to make it easy.
  const onlinePaths = new Set([
    "/online",
    `${WS_BASE_PATH.replace(/\/+$/,"")}/online`
  ]);
  const healthPaths = new Set([
    "/",
    "/healthz",
    `${WS_BASE_PATH.replace(/\/+$/,"")}/healthz`
  ]);

  if (onlinePaths.has(p)) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ users: Object.values(loadOnline().users) }));
    return;
  }
  if (healthPaths.has(p)) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// ---- WebSocket server ----
const wss = new WebSocketServer({
  server,
  // Disabling permessage-deflate avoids some proxies causing stalls
  perMessageDeflate: false
});

const sockets = new Map(); // userId -> ws

function broadcastOnline() {
  const state = loadOnline();
  const users = Object.values(state.users);
  const payload = JSON.stringify({ type: "online", users });
  for (const ws of sockets.values()) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

wss.on("connection", (ws /*, req */) => {
  let myId = null;

  // mark live for heartbeat
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); }
    catch { return; }

    if (msg.type === "hello") {
      // msg.me: { id, name, avatar }
      myId = msg.me?.id;
      if (!myId) return;

      sockets.set(myId, ws);

      const state = loadOnline();
      state.users[myId] = { id: myId, name: msg.me.name, avatar: msg.me.avatar };
      saveOnline(state);
      broadcastOnline();
      return;
    }

    if (msg.type === "offer" || msg.type === "answer" ||
        msg.type === "ice"   || msg.type === "end") {
      const to = sockets.get(msg.to);
      if (to && to.readyState === to.OPEN) to.send(JSON.stringify(msg));
      return;
    }

    if (msg.type === "pong") {
      ws.isAlive = true;
      return;
    }
  });

  ws.on("close", () => {
    if (myId) {
      sockets.delete(myId);
      const state = loadOnline();
      delete state.users[myId];
      saveOnline(state);
      broadcastOnline();
    }
  });
});

// ---- Heartbeat: drop dead sockets and keep connections warm ----
const HEARTBEAT_MS = 30_000;
setInterval(() => {
  for (const [id, ws] of sockets.entries()) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      sockets.delete(id);
      const state = loadOnline(); delete state.users[id]; saveOnline(state);
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
  broadcastOnline();
}, HEARTBEAT_MS);

// ---- Start ----
server.listen(PORT, () => {
  console.log(`Signaling server on :${PORT}`);
});
