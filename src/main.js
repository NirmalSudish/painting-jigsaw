import { PAINTINGS, PIECE_PRESETS } from "./paintings.js";
import { buildPuzzle } from "./puzzle.js";
import { net } from "./net.js";
import { sfx } from "./audio.js";
import { initDiscord } from "./discord.js";

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
  const ok = state.imageURL || state.room;
  btn.disabled = !ok;
  btn.textContent = state.room && !state.imageURL ? "Join room" : state.imageURL ? "Start puzzle" : "Choose a painting to start";
}

$("player-name").addEventListener("input", (e) => { state.name = e.target.value.trim() || "Player"; });
$("room-code").addEventListener("input", (e) => { state.room = e.target.value.trim().toUpperCase(); refreshStart(); });
$("custom-url").addEventListener("input", (e) => { const v = e.target.value.trim(); if (v) selectPainting(null, v, "Custom image"); });
$("custom-file").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) selectPainting(null, URL.createObjectURL(f), f.name); });

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

async function startGame() {
  $("setup-error").textContent = "";

  const room = state.room || randomRoom();
  const seed = Math.floor(Math.random() * 1e9);
  const desired = state.imageURL ? { imageURL: state.imageURL, title: state.imageTitle, pieces: state.pieces, seed } : null;

  net.init({ onPlayer, onPlayerLeave, onRemoteMove, onRemotePlace, onRemotePickup, onRemoteCursor });
  const res = await net.connect(room, state.name, state.color, desired);
  const config = res.config || desired;
  if (!config || !config.imageURL) {
    $("setup-error").textContent = res.solo
      ? "No server and no image picked — choose a painting."
      : "Joined a room that hasn't started yet — ask the host to start, or pick an image to host.";
    return;
  }

  let img;
  try { img = await loadImage(config.imageURL); }
  catch (e) { $("setup-error").textContent = e.message; return; }

  game.img = img;
  game.config = config;
  game.room = room;
  state.imageTitle = config.title || state.imageTitle || "Painting";

  $("setup").classList.add("hidden");
  $("game").classList.remove("hidden");
  $("preview-img").src = config.imageURL;
  sfx.resume();

  layoutAndBuild();
  applySnapshot(res.pieces || []);
  renderInfo(res.solo);
  renderPlayers(res.solo);
  startTimer();

  window.addEventListener("resize", debounce(fitView, 150));
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
function onPlayer(id, name, color) { renderInfo(false); renderPlayers(false); }
function onPlayerLeave(id) { document.getElementById("cur-" + id)?.remove(); renderInfo(false); renderPlayers(false); }
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
  const roomTxt = solo ? `<span class="muted">· solo</span>` : `<span class="muted">· room ${game.room} · ${players} ${players === 1 ? "player" : "players"}</span>`;
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
  clearInterval(game.timerId);
  $("win-text").textContent = `${state.imageTitle} — ${game.total} pieces in ${$("timer").textContent}.`;
  $("win").classList.remove("hidden");
  sfx.win();
  confetti();
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
$("start-btn").onclick = startGame;
$("back-btn").onclick = () => location.reload();
$("win-again").onclick = () => location.reload();
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

// room code from ?room=CODE (so a shared link auto-fills the room)
const urlRoom = new URLSearchParams(location.search).get("room");
if (urlRoom) { state.room = urlRoom.toUpperCase(); $("room-code").value = state.room; refreshStart(); }

initDiscord().then(applyDiscord).catch(() => {});

function applyDiscord(d) {
  if (!d || !d.inDiscord) return;
  state.inDiscord = true;
  if (d.username) { state.name = d.username; $("player-name").value = d.username; }
  if (d.instanceId) { state.room = "DC-" + d.instanceId; }   // shared per voice channel
  // no manual name/room entry inside Discord — both come from the session
  $("name-col").classList.add("hidden");
  $("room-col").classList.add("hidden");
  const note = $("discord-note");
  note.textContent = `Connected as ${state.name}. Everyone in this voice channel shares the same puzzle — pick one to start, or wait for whoever starts first.`;
  note.classList.remove("hidden");
  refreshStart();
}
