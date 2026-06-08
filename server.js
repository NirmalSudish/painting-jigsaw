// Multiplayer room server. Serves the static app AND the WebSocket on one port,
// so two browser tabs on http://localhost:3001 are two players in the same room.
//
//   npm install      (gets the `ws` dependency)
//   npm run serve    (this file)  ->  http://localhost:3001
//
// For friends over the internet, run this on a host with a public URL (or tunnel
// it, e.g. `cloudflared tunnel --url http://localhost:3001`).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".ico": "image/x-icon",
};

// ---- static file serving ----
const server = http.createServer((req, res) => {
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
const rooms = new Map(); // code -> { config, pieces: Map<id,{x,y,placed}>, players: Map<id,{name,color,ws}> }
let nextId = 1;

function room(code) {
  if (!rooms.has(code)) rooms.set(code, { config: null, pieces: new Map(), players: new Map() });
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
    if (r && pid != null) {
      r.players.delete(pid);
      broadcast(r, { t: "leave", id: pid });
      if (r.players.size === 0) rooms.delete([...rooms].find(([, v]) => v === r)?.[0]);
    }
  });
});

server.listen(PORT, () => console.log(`Painting Jigsaw → http://localhost:${PORT}`));
