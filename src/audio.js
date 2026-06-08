// Sound effects, synthesized with the Web Audio API — no audio files to host,
// so it stays within a Discord Activity's strict CSP. Toggle with sfx.setEnabled.

let ctx = null;
let enabled = true;

function ensure() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

function note(freq, dur, type = "sine", peak = 0.18, slideTo = null) {
  if (!enabled) return;
  ensure();
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sfx = {
  get enabled() { return enabled; },
  setEnabled(v) { enabled = v; },
  // browsers require a user gesture before audio can start
  resume() { try { ensure(); if (ctx.state === "suspended") ctx.resume(); } catch {} },

  pickup() { note(300, 0.07, "triangle", 0.09, 390); },
  place() {
    note(540, 0.09, "sine", 0.18, 660);
    setTimeout(() => note(840, 0.12, "sine", 0.15), 55);
  },
  win() {
    [523, 659, 784, 1047].forEach((f, i) =>
      setTimeout(() => note(f, 0.5, "triangle", 0.2), i * 120)
    );
  },
};
