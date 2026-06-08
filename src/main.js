import { PAINTINGS, PIECE_PRESETS } from "./paintings.js?v=5";
import { buildPuzzle } from "./puzzle.js?v=5";
import { net } from "./net.js?v=5";
import { sfx } from "./audio.js?v=5";
import { initDiscord } from "./discord.js?v=5";

const $ = (id) => document.getElementById(id);
const COLORS = ["#5865f2", "#57f287", "#fee75c", "#eb459e", "#4ad9e4", "#f0883e", "#9b59ff"];

// deterministic RNG so every player builds the identical puzzle from one seed
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- setup state ----------
const state = {
  imageURL: null, imageTitle: "", pieces: 24,
  name: "Player", color: COLORS[Math.floor(Math.random() * COLORS.length)],
  room: "",
  inDiscord: false, lobby: false, started: false, won: false,
  amAdmin: false, myId: null, adminId: null,
};

function buildGallery() {
  const gallery = $("gallery");
  PAINTINGS.forEach((p) => {
    const el = document.createElement("div");
    el.className = "thumb";
    el.innerHTML = `<img alt="${p.title}" /><div class="cap">${p.title}<small>${p.artist}</small></div>`;
    const img = el.querySelector("img");
    img.onerror = () => el.classList.add("broken");
    img.src = p.url;
    el.onclick = () => selectPainting(el, p.url, `${p.title} — ${p.artist}`);
    gallery.appendChild(el);
  });
}
function selectPainting(el, url, title) {
  document.querySelectorAll(".thumb").forEach((t) => t.classList.remove("selected"));
  if (el) el.classList.add("selected");
  state.imageURL = url; state.imageTitle = title;
  refreshStart();
}
function buildPieceOptions() {
  const wrap = $("piece-options");
  PIECE_PRESETS.forEach((opt) => {
    const el = document.createElement("button");
    el.className = "chip" + (opt.pieces === state.pieces ? " selected" : "");
    el.innerHTML = `${opt.label}<small>~${opt.pieces}</small>`;
    el.onclick = () => {
      state.pieces = opt.pieces;
      document.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
      el.classList.add("selected");
    };
    wrap.appendChild(el);
  });
}
function refreshStart() {
  const btn = $("start-btn");
  if (state.lobby) { // Discord host picking for everyone
    btn.disabled = !state.imageURL;
    btn.textContent = state.imageURL ? "Start for everyone" : "Choose a painting to start";
    return;
  }
  const ok = state.imageURL || state.room;
  btn.disabled = !ok;
  btn.textContent = state.room && !state.imageURL ? "Join room" : state.imageURL ? "Start puzzle" : "Choose a painting to start";
}

$("player-name").addEventListener("input", (e) => { state.name = e.target.value.trim() || "Player"; });
$("room-code").addEventListener("input", (e) => { state.room = e.target.value.trim().toUpperCase(); refreshStart(); });
$("custom-url").addEventListener("input", (e) => { const v = e.target.value.trim(); if (v) selectPainting(null, v, "Custom image"); });
$("max-players").addEventListener("change", (e) => {
  const v = Math.max(2, Math.min(25, parseInt(e.target.value, 10) || 10));
  e.target.value = v;
  net.settings(v);
});
$("custom-file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  // embed as a downscaled data URL so the image travels to every player in the
  // room (a blob: URL only works on the uploader's own machine).
  fileToDataURL(f, 1400).then((url) => selectPainting(null, url, f.name));
});

function fileToDataURL(file, maxDim) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        try { resolve(cv.toDataURL("image/jpeg", 0.85)); }
        catch { resolve(fr.result); }
      };
      img.onerror = () => resolve(fr.result);
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

function gridFor(count, aspect) {
  let best = null;
  for (let rows = 1; rows <= count; rows++) {
    const cols = Math.max(1, Math.round(count / rows));
    const cellAspect = (cols / rows) / aspect;
    const off = Math.abs(Math.log(cellAspect)) + Math.abs(rows * cols - count) * 0.01;
    if (!best || off < best.off) best = { rows, cols, off };
  }
  return best;
}

// ---------- game ----------
const game = {
  pieces: [], byId: new Map(), total: 0, placed: 0,
  img: null, zTop: 100, startTime: 0, timerId: null,
  config: null, room: "",
};
// shared world view (fixed coord space + fit transform)
const view = { s: 1, offX: 0, offY: 0, worldW: 0, worldH: 0, margin: 0, boardW: 0, boardH: 0 };

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image failed to load (blocked or bad URL)."));
    img.src = url;
  });
}

function randomRoom() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => a[Math.floor(Math.random() * a.length)]).join("");
}

function buildDesired() {
  if (!state.imageURL) return null;
  return { imageURL: state.imageURL, title: state.imageTitle, pieces: state.pieces, seed: Math.floor(Math.random() * 1e9) };
}

// Start button. In the Discord lobby the admin is already connected, so just
// broadcast the chosen puzzle; on the web we connect then begin.
async function onStartClick() {
  const desired = buildDesired();
  if (!desired) { $("setup-error").textContent = "Choose a painting first."; return; }
  if (net.id && !net.solo) {                // already connected (Discord host or restart)
    net.start(desired);
    await beginGame(desired, [], false, state.room);
  } else {                                  // web first start: connect then begin
    $("setup-error").textContent = "";
    const room = state.room || randomRoom();
    const res = await net.connect(room, state.name, state.color, desired);
    await beginGame(res.config || desired, res.pieces, res.solo, room);
  }
}

// Discord: connect immediately, then route to host-picker / waiting / late-join.
async function enterDiscord() {
  lobbyShell();
  $("waiting-note").textContent = "Connecting…";
  $("waiting-note").classList.remove("hidden");
  const res = await net.connect(state.room, state.name, state.color, null);
  if (res.full) { $("waiting-note").textContent = `Room is full (max ${res.maxPlayers}).`; return; }
  state.myId = res.id;
  state.adminId = res.adminId;
  if (res.maxPlayers) $("max-players").value = res.maxPlayers;
  renderPlayerCards();
  if (res.solo) { showHostPicker(); return; }           // no server: host solo
  if (res.config) { await beginGame(res.config, res.pieces, false, state.room); return; }
  state.amAdmin = res.adminId === res.id;
  if (state.amAdmin) showHostPicker(); else showWaiting();
}

// shared lobby layout: players list visible, manual name/room hidden
function lobbyShell() {
  $("setup").classList.remove("hidden");
  $("game").classList.add("hidden");
  $("manual-fields").classList.add("hidden");
  $("players-section").classList.remove("hidden");
  $("discord-note").classList.remove("hidden");
  $("host-settings").classList.add("hidden");
}

function showHostPicker() {
  state.lobby = true;
  lobbyShell();
  $("host-settings").classList.remove("hidden");
  $("settings-head").classList.remove("hidden");
  $("maxplayers-wrap").classList.remove("hidden");
  $("waiting-note").classList.add("hidden");
  renderPlayerCards();
  refreshStart();
}

function showWaiting() {
  state.lobby = false;
  lobbyShell();
  $("waiting-note").textContent = "Waiting for the host to start…";
  $("waiting-note").classList.remove("hidden");
  renderPlayerCards();
}

function avatarHtml(name, color) {
  const ch = (name || "?").trim().charAt(0).toUpperCase() || "?";
  return `<span class="avatar" style="background:${color}">${escapeHtml(ch)}</span>`;
}
function renderPlayerCards() {
  const list = [{ id: state.myId, name: state.name, color: state.color, you: true }, ...net.players.values()];
  const cnt = $("setup-count"); if (cnt) cnt.textContent = list.length;
  const box = $("setup-players"); if (!box) return;
  box.innerHTML = list.map((p) => {
    const host = p.id === state.adminId;
    return `<div class="p">${avatarHtml(p.name, p.color)}` +
      `<div class="grow"><div class="pname">${escapeHtml(p.name)}${p.you ? '<span class="you-pill">you</span>' : ""}</div>` +
      `<div class="pmeta">${host ? '<span class="host">★ host</span>' : "<span>player</span>"}</div></div></div>`;
  }).join("");
}

// load the image + lay out the puzzle; shared by web, Discord host, and joiners.
// Called again for "play again" (new seed) — ignores duplicate same-seed starts
// so a reconnect to an already-running round doesn't rebuild or re-trigger win.
async function beginGame(config, snapPieces, solo, room) {
  if (state.started && game.config && game.config.seed === config?.seed) return;
  if (!config || !config.imageURL) { $("setup-error").textContent = "No puzzle to load."; return; }
  let img;
  try { img = await loadImage(config.imageURL); }
  catch (e) { $("setup-error").textContent = e.message; $("waiting-note").textContent = "The host's image failed to load."; return; }

  state.started = true;
  state.won = false;
  state.lobby = false;
  $("win").classList.add("hidden");
  clearInterval(game.timerId);
  game.img = img;
  game.config = config;
  game.room = room;
  state.imageTitle = config.title || state.imageTitle || "Painting";

  $("setup").classList.add("hidden");
  $("lobby").classList.add("hidden");
  $("game").classList.remove("hidden");
  $("preview-img").src = config.imageURL;
  sfx.resume();

  layoutAndBuild();
  applySnapshot(snapPieces || []);
  renderInfo(solo);
  renderPlayers(solo);
  startTimer();

  if (!beginGame._resize) { window.addEventListener("resize", debounce(fitView, 150)); beginGame._resize = true; }
}

// ---------- build world + pieces ----------
function layoutAndBuild() {
  const aspect = game.img.naturalWidth / game.img.naturalHeight;

  // fixed board size (same for all players), capped
  let boardH = 620, boardW = boardH * aspect;
  if (boardW > 1100) { boardW = 1100; boardH = boardW / aspect; }
  const margin = Math.max(boardW, boardH) * 0.6; // scatter room around the board
  view.boardW = boardW; view.boardH = boardH; view.margin = margin;
  view.worldW = boardW + margin * 2;
  view.worldH = boardH + margin * 2;

  const world = $("world");
  world.style.width = view.worldW + "px";
  world.style.height = view.worldH + "px";

  const board = $("board");
  board.style.left = margin + "px";
  board.style.top = margin + "px";
  board.style.width = boardW + "px";
  board.style.height = boardH + "px";
  board.querySelector("#ghost-img")?.remove();
  const ghost = document.createElement("img");
  ghost.id = "ghost-img";
  ghost.src = game.config.imageURL;
  ghost.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:fill;opacity:0;transition:opacity .2s;border-radius:6px;";
  board.appendChild(ghost);

  const grid = gridFor(game.config.pieces, aspect);
  const rng = mulberry32(game.config.seed);
  const { pieces } = buildPuzzle(boardW, boardH, grid.rows, grid.cols, rng);

  const off = document.createElement("canvas");
  off.width = Math.round(boardW); off.height = Math.round(boardH);
  off.getContext("2d").drawImage(game.img, 0, 0, off.width, off.height);

  const layer = $("piece-layer");
  layer.innerHTML = "";
  $("cursors").innerHTML = "";
  game.pieces = []; game.byId = new Map(); game.total = pieces.length; game.placed = 0; game.zTop = 100;

  pieces.forEach((p) => createPieceEl(p, off, layer));
  // deterministic initial scatter (same seed -> identical for everyone)
  game.pieces.forEach((p) => {
    const x = rng() * (view.worldW - p.el.width);
    const y = rng() * (view.worldH - p.el.height);
    setPos(p, x, y);
    raise(p);
  });

  updateProgress();
  fitView();
}

function createPieceEl(model, offCanvas, layer) {
  const pad = 2;
  const cv = document.createElement("canvas");
  cv.className = "piece";
  cv.width = Math.ceil(model.w) + pad * 2;
  cv.height = Math.ceil(model.h) + pad * 2;
  cv.style.pointerEvents = "auto";
  const ctx = cv.getContext("2d");
  ctx.translate(pad - model.targetX, pad - model.targetY);
  ctx.save(); ctx.clip(model.path); ctx.drawImage(offCanvas, 0, 0); ctx.restore();
  ctx.lineWidth = 1.2; ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.stroke(model.path);
  ctx.lineWidth = 0.8; ctx.strokeStyle = "rgba(255,255,255,0.14)"; ctx.stroke(model.path);
  layer.appendChild(cv);

  const piece = {
    id: `${model.r}-${model.c}`, model, el: cv, ctx, pad,
    targetX: view.margin + model.targetX - pad,   // world coords of canvas top-left when solved
    targetY: view.margin + model.targetY - pad,
    left: 0, top: 0, placed: false,
  };
  setPos(piece, 0, 0);
  game.pieces.push(piece);
  game.byId.set(piece.id, piece);
}

function setPos(p, left, top) {
  p.left = left; p.top = top;
  p.el.style.left = left + "px";
  p.el.style.top = top + "px";
}
function raise(p) { p.el.style.zIndex = ++game.zTop; }

// ---------- fit the world into the viewport ----------
function fitView() {
  const stage = $("stage");
  const availW = stage.clientWidth, availH = stage.clientHeight;
  const s = Math.min(availW / view.worldW, availH / view.worldH);
  view.s = s;
  view.offX = (availW - view.worldW * s) / 2;
  view.offY = (availH - view.worldH * s) / 2;
  $("world").style.transform = `translate(${view.offX}px, ${view.offY}px) scale(${s})`;
  // keep cursor labels a constant on-screen size
  document.querySelectorAll(".cursor").forEach((c) => (c.style.transform = `scale(${1 / s})`));
}

function toWorld(clientX, clientY) {
  const r = $("stage").getBoundingClientRect();
  return { x: (clientX - r.left - view.offX) / view.s, y: (clientY - r.top - view.offY) / view.s };
}

function applySnapshot(snap) {
  snap.forEach((s) => {
    const p = game.byId.get(s.id);
    if (!p) return;
    setPos(p, s.x, s.y);
    if (s.placed) placePiece(p, true);
  });
}

// ---------- dragging ----------
let drag = null;

function pieceAtPoint(wx, wy) {
  const ordered = [...game.pieces].sort((a, b) => (+b.el.style.zIndex || 0) - (+a.el.style.zIndex || 0));
  for (const p of ordered) {
    const lx = wx - p.left, ly = wy - p.top;
    if (lx < 0 || ly < 0 || lx > p.el.width || ly > p.el.height) continue;
    if (p.ctx.isPointInPath(p.model.path, lx, ly)) return p;
  }
  return null;
}

document.addEventListener("pointerdown", (e) => {
  if ($("game").classList.contains("hidden")) return;
  if (e.target.closest(".toolbar") || e.target.closest("#preview")) return;
  const w = toWorld(e.clientX, e.clientY);
  const p = pieceAtPoint(w.x, w.y);
  if (!p) return;
  sfx.resume();
  if (p.placed) { p.placed = false; game.placed--; updateProgress(); net.pickup(p.id); }
  drag = { p, dx: w.x - p.left, dy: w.y - p.top };
  raise(p);
  p.el.classList.add("dragging");
  sfx.pickup();
});

document.addEventListener("pointermove", (e) => {
  if ($("game").classList.contains("hidden")) return;
  const w = toWorld(e.clientX, e.clientY);
  showLocalCursor(w.x, w.y);
  net.cursor(w.x, w.y);
  if (!drag) return;
  setPos(drag.p, w.x - drag.dx, w.y - drag.dy);
  net.move(drag.p.id, drag.p.left, drag.p.top);
});

document.addEventListener("pointerup", () => {
  if (!drag) return;
  drag.p.el.classList.remove("dragging");
  trySnap(drag.p);
  drag = null;
});

function trySnap(p) {
  const snap = Math.max(20, Math.min(p.model.w, p.model.h) * 0.35);
  if (Math.abs(p.left - p.targetX) < snap && Math.abs(p.top - p.targetY) < snap) {
    placePiece(p);
    net.place(p.id);
  }
}

function placePiece(p, silent = false) {
  p.el.classList.add("snapping");
  setPos(p, p.targetX, p.targetY);
  setTimeout(() => p.el.classList.remove("snapping"), 160);
  if (!silent) { p.el.classList.remove("placed-anim"); void p.el.offsetWidth; p.el.classList.add("placed-anim"); }
  p.el.style.zIndex = 5;
  if (!p.placed) { p.placed = true; game.placed++; updateProgress(); if (!silent) sfx.place(); }
  if (game.placed === game.total) winGame();
}

function updateProgress() {
  $("progress").textContent = (game.total ? Math.round((game.placed / game.total) * 100) : 0) + "%";
}

// ---------- remote players ----------
function onPlayer(id, name, color) {
  if (state.started) { renderInfo(false); renderPlayers(false); }
  else renderPlayerCards();
}
function onPlayerLeave(id) {
  document.getElementById("cur-" + id)?.remove();
  if (state.started) { renderInfo(false); renderPlayers(false); }
  else renderPlayerCards();
}
function onStart(config) { beginGame(config, [], false, state.room); }
function onAdmin(id) {
  state.adminId = id;
  const wasAdmin = state.amAdmin;
  state.amAdmin = id === state.myId;
  if (!state.started) {
    if (state.amAdmin && !wasAdmin) showHostPicker();
    renderPlayerCards();
  }
}
function onSettings(maxPlayers) { if (maxPlayers) $("max-players").value = maxPlayers; }
function onRemoteMove(id, x, y) {
  const p = game.byId.get(id);
  if (p && (!drag || drag.p !== p)) { if (p.placed) { p.placed = false; game.placed--; updateProgress(); } setPos(p, x, y); }
}
function onRemotePlace(id) { const p = game.byId.get(id); if (p && (!drag || drag.p !== p)) placePiece(p, true); }
function onRemotePickup(id) {
  const p = game.byId.get(id);
  if (p && p.placed && (!drag || drag.p !== p)) { p.placed = false; game.placed--; updateProgress(); }
}
function onRemoteCursor(pid, name, color, x, y) {
  let c = document.getElementById("cur-" + pid);
  if (!c) c = makeCursor("cur-" + pid, name, color);
  c.style.left = x + "px"; c.style.top = y + "px";
  c.style.transform = `scale(${1 / view.s})`;
}
function showLocalCursor(x, y) {
  let c = document.getElementById("cur-self");
  if (!c) c = makeCursor("cur-self", state.name + " (you)", state.color);
  c.style.left = x + "px"; c.style.top = y + "px";
  c.style.transform = `scale(${1 / view.s})`;
}
function makeCursor(id, name, color) {
  const c = document.createElement("div");
  c.id = id; c.className = "cursor";
  c.innerHTML = `${cursorSVG(color)}<span class="tag" style="background:${color}">${escapeHtml(name)}</span>`;
  $("cursors").appendChild(c);
  return c;
}
function cursorSVG(color) {
  return `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M4 2 L4 20 L9 15 L12 22 L15 21 L12 14 L19 14 Z" fill="${color}" stroke="#fff" stroke-width="1.3"/></svg>`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function renderInfo(solo) {
  const players = 1 + net.players.size;
  const where = state.inDiscord ? "Discord" : `room ${game.room}`;
  const roomTxt = solo ? `<span class="muted">· solo</span>` : `<span class="muted">· ${where} · ${players} ${players === 1 ? "player" : "players"}</span>`;
  $("hud-info").innerHTML =
    `<span class="dot" style="background:${state.color}"></span>${escapeHtml(state.name)}` +
    `<span class="muted">· ${escapeHtml(state.imageTitle)} · ${game.total} pcs</span>` + roomTxt;
}

function renderPlayers(solo) {
  const panel = $("players");
  if (solo) { panel.innerHTML = ""; return; }
  const list = [{ name: state.name, color: state.color, you: true }, ...net.players.values()];
  panel.innerHTML = `<div class="phead">Players · ${list.length}</div>` +
    list.map((p) =>
      `<div class="p"><span class="dot" style="background:${p.color}"></span>${escapeHtml(p.name)}${p.you ? '<span class="you">you</span>' : ""}</div>`
    ).join("");
}

// ---------- timer ----------
function startTimer() {
  game.startTime = Date.now();
  clearInterval(game.timerId);
  game.timerId = setInterval(() => {
    const s = Math.floor((Date.now() - game.startTime) / 1000);
    $("timer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
}

// ---------- win ----------
function winGame() {
  if (state.won) return;       // fire once per round
  state.won = true;
  clearInterval(game.timerId);
  const base = `${state.imageTitle} — ${game.total} pieces in ${$("timer").textContent}.`;
  const canRestart = !state.inDiscord || state.amAdmin || net.solo;
  $("win-text").textContent = canRestart ? base : base + " Waiting for the host to start a new game…";
  $("win-again").classList.toggle("hidden", !canRestart);
  $("win").classList.remove("hidden");
  sfx.win();
  confetti();
}

// "Play again" — no page reload (reloading re-joined the solved room and looped
// the win popup). Return the host to the picker; others wait for the new start.
function playAgain() {
  state.started = false;
  state.won = false;
  game.config = null;
  clearInterval(game.timerId);
  $("win").classList.add("hidden");
  $("game").classList.add("hidden");
  if (state.inDiscord) {
    showHostPicker();                 // name/room stay hidden
  } else {
    state.lobby = false;
    $("setup").classList.remove("hidden");
    refreshStart();
  }
}
function confetti() {
  for (let i = 0; i < 130; i++) {
    const d = document.createElement("div");
    d.className = "confetti";
    d.style.left = Math.random() * 100 + "vw";
    d.style.background = COLORS[i % COLORS.length];
    d.style.animation = `fall ${1.6 + Math.random() * 1.8}s ${Math.random() * 0.5}s ease-in forwards`;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 4400);
  }
}

// ---------- toolbar ----------
$("start-btn").onclick = onStartClick;
$("back-btn").onclick = () => location.reload();
$("win-again").onclick = playAgain;
$("shuffle-btn").onclick = () => {
  const rng = Math.random;
  game.pieces.forEach((p) => {
    if (p.placed) return;
    setPos(p, rng() * (view.worldW - p.el.width), rng() * (view.worldH - p.el.height));
    raise(p);
    net.move(p.id, p.left, p.top);
  });
};
$("ghost-btn").onclick = (e) => {
  const g = $("ghost-img"); if (!g) return;
  const on = g.style.opacity === "0";
  g.style.opacity = on ? "0.18" : "0";
  e.currentTarget.classList.toggle("active", on);
};
$("preview-btn").onclick = () => $("preview").classList.remove("hidden");
$("preview").onclick = () => $("preview").classList.add("hidden");
$("sound-btn").onclick = (e) => {
  const on = !sfx.enabled;
  sfx.setEnabled(on);
  if (on) sfx.resume();
  e.currentTarget.textContent = on ? "🔊" : "🔇";
  e.currentTarget.classList.toggle("active", on);
};

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------- boot ----------
buildGallery();
buildPieceOptions();
refreshStart();
net.init({ onPlayer, onPlayerLeave, onStart, onAdmin, onSettings, onRemoteMove, onRemotePlace, onRemotePickup, onRemoteCursor });

// room code from ?room=CODE (so a shared link auto-fills the room)
const urlRoom = new URLSearchParams(location.search).get("room");
if (urlRoom) { state.room = urlRoom.toUpperCase(); $("room-code").value = state.room; refreshStart(); }

initDiscord().then((d) => { showDiag(d); applyDiscord(d); }).catch((e) => showDiag({ error: e }));

// on-screen diagnostic (tap to dismiss). Hidden on a healthy launch; shows only
// when something's off, or when ?debug is in the URL.
function showDiag(d) {
  const debug = new URLSearchParams(location.search).has("debug");
  const problem = (d?.inDiscord && (!d?.instanceId || !d?.username)) || !!d?.error;
  if (!debug && !problem) return;
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:9999;max-width:90vw;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,.85);color:#9effa1;font:11px/1.4 monospace;white-space:pre-wrap;cursor:pointer";
  el.textContent = `DIAG inDiscord=${d?.inDiscord} name=${d?.username || "-"} authErr=${d?.authError || "-"} sdkErr=${d?.error?.message || d?.error || "-"}`;
  el.onclick = () => el.remove();
  document.body.appendChild(el);
}

function applyDiscord(d) {
  if (!d || !d.inDiscord) return;
  state.inDiscord = true;
  if (d.username) { state.name = d.username; $("player-name").value = d.username; }
  if (d.instanceId) {
    // shared per voice channel: run the lobby flow (manual fields hidden inside)
    state.room = "DC-" + d.instanceId;
    enterDiscord();
  }
  // if the SDK gave no instanceId, fall back to the normal manual flow
}
