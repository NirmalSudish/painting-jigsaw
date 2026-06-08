// Multiplayer room server. Serves the static app AND the WebSocket on one port,
// so two browser tabs on http://localhost:3001 are two players in the same room.
//
//   npm install      (gets the `ws` dependency)
//   npm start        (this file)  ->  http://localhost:3001
//
// For friends over the internet, run this on a host with a public URL (or tunnel
// it, e.g. `cloudflared tunnel --url http://localhost:3001`).
//
// A room stays alive while ANY player is connected; it's only discarded once
// everyone has left (after a short grace window so a refresh doesn't wipe it).
//
// Optional Discord username lookup: set DISCORD_CLIENT_SECRET (and optionally
// DISCORD_CLIENT_ID) in the environment to enable the POST /api/token endpoint.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const ROOM_GRACE_MS = 90_000; // keep an empty room this long before discarding

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "1513594815617437706";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".ico": "image/x-icon",
};

// ---- Discord OAuth token exchange (optional username feature) ----
function readBody(req) {
  return new Promise((resolve) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b));
  });
}
async function handleToken(req, res) {
  if (!CLIENT_SECRET) { res.writeHead(501).end(JSON.stringify({ error: "DISCORD_CLIENT_SECRET not set" })); return; }
  try {
    const { code } = JSON.parse(await readBody(req) || "{}");
    const r = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "authorization_code", code }),
    });
    const data = await r.json();
    res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ access_token: data.access_token, error: data.error }));
  } catch (e) {
    res.writeHead(500).end(JSON.stringify({ error: String(e) }));
  }
}

// ---- HTTP: API + static files ----
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/token") { handleToken(req, res); return; }

  let url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/") url = "/index.html";
  const file = path.join(ROOT, path.normalize(url));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

// ---- rooms ----
const rooms = new Map(); // code -> { code, config, pieces: Map, players: Map, graceTimer }
let nextId = 1;

function room(code) {
  if (!rooms.has(code)) rooms.set(code, { code, config: null, pieces: new Map(), players: new Map(), graceTimer: null });
  return rooms.get(code);
}
function broadcast(r, msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const [pid, p] of r.players) {
    if (pid === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(data);
  }
}

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  let r = null, pid = null;

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === "join") {
      r = room(m.room);
      if (r.graceTimer) { clearTimeout(r.graceTimer); r.graceTimer = null; } // someone's back
      pid = nextId++;
      if (!r.config && m.config) r.config = m.config; // first player sets the puzzle
      r.players.set(pid, { name: m.name || "Player", color: m.color || "#5865f2", ws });
      ws.send(JSON.stringify({
        t: "welcome", id: pid, config: r.config,
        players: [...r.players].filter(([id]) => id !== pid).map(([id, p]) => ({ id, name: p.name, color: p.color })),
        pieces: [...r.pieces].map(([id, s]) => ({ id, x: s.x, y: s.y, placed: s.placed })),
      }));
      broadcast(r, { t: "player", id: pid, name: m.name, color: m.color }, pid);
      return;
    }
    if (!r || pid == null) return;

    switch (m.t) {
      case "move":
        r.pieces.set(m.id, { x: m.x, y: m.y, placed: false });
        broadcast(r, { t: "move", id: m.id, x: m.x, y: m.y }, pid);
        break;
      case "place":
        r.pieces.set(m.id, { ...(r.pieces.get(m.id) || {}), placed: true });
        broadcast(r, { t: "place", id: m.id }, pid);
        break;
      case "pickup":
        if (r.pieces.has(m.id)) r.pieces.get(m.id).placed = false;
        broadcast(r, { t: "pickup", id: m.id }, pid);
        break;
      case "cursor":
        broadcast(r, { t: "cursor", pid, x: m.x, y: m.y }, pid);
        break;
    }
  });

  ws.on("close", () => {
    if (!r || pid == null) return;
    r.players.delete(pid);
    broadcast(r, { t: "leave", id: pid });
    // only tear the room (and its progress) down once EVERYONE has left
    if (r.players.size === 0) {
      r.graceTimer = setTimeout(() => { if (r.players.size === 0) rooms.delete(r.code); }, ROOM_GRACE_MS);
    }
  });
});

server.listen(PORT, () => console.log(`Painting Jigsaw → http://localhost:${PORT}`));
