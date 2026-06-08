// Multiplayer client. Connects to the room server (server.js) over WebSocket.
// If no server is reachable (e.g. opened via a plain static host), connect()
// resolves in "solo" mode and every send becomes a no-op — single player still
// works unchanged.
//
// Game wires handlers via net.init({ ... }) and calls net.move/place/pickup/cursor.

const PROTO = location.protocol === "https:" ? "wss" : "ws";
const WS_URL = `${PROTO}://${location.host}`;

export const net = {
  cb: {},
  ws: null,
  id: null,
  solo: true,
  players: new Map(),
  _lastCursor: 0,

  init(cb) { this.cb = cb; },

  connect(roomCode, name, color, desiredConfig) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (val) => { if (!settled) { settled = true; resolve(val); } };

      let ws;
      try { ws = new WebSocket(WS_URL); }
      catch { return done({ solo: true, config: desiredConfig }); }
      this.ws = ws;

      const fail = () => { this.solo = true; this.ws = null; done({ solo: true, config: desiredConfig }); };
      const timeout = setTimeout(fail, 2500);

      ws.onopen = () => ws.send(JSON.stringify({ t: "join", room: roomCode, name, color, config: desiredConfig }));
      ws.onerror = fail;
      ws.onclose = () => { if (!settled) fail(); };

      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === "welcome") {
          clearTimeout(timeout);
          this.solo = false;
          this.id = m.id;
          (m.players || []).forEach((p) => this.players.set(p.id, p));
          done({ solo: false, config: m.config, adminId: m.adminId, players: m.players || [], pieces: m.pieces || [], id: m.id });
          return;
        }
        this._handle(m);
      };
    });
  },

  _handle(m) {
    const c = this.cb;
    switch (m.t) {
      case "player": this.players.set(m.id, { id: m.id, name: m.name, color: m.color }); c.onPlayer?.(m.id, m.name, m.color); break;
      case "leave":  this.players.delete(m.id); c.onPlayerLeave?.(m.id); break;
      case "start":  c.onStart?.(m.config); break;
      case "admin":  c.onAdmin?.(m.id); break;
      case "move":   c.onRemoteMove?.(m.id, m.x, m.y); break;
      case "place":  c.onRemotePlace?.(m.id); break;
      case "pickup": c.onRemotePickup?.(m.id); break;
      case "cursor": {
        const p = this.players.get(m.pid) || { name: "Player", color: "#5865f2" };
        c.onRemoteCursor?.(m.pid, p.name, p.color, m.x, m.y);
        break;
      }
    }
  },

  _send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); },

  start(config) { this._send({ t: "start", config }); },
  move(id, x, y) { this._send({ t: "move", id, x, y }); },
  place(id) { this._send({ t: "place", id }); },
  pickup(id) { this._send({ t: "pickup", id }); },
  cursor(x, y) {
    const now = performance.now();
    if (now - this._lastCursor < 45) return; // throttle
    this._lastCursor = now;
    this._send({ t: "cursor", x, y });
  },
};
