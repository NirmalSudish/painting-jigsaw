# 🧩 Painting Jigsaw

Jigsaw puzzle of famous paintings. Pick a masterpiece, choose how many pieces,
drag pieces from the tray onto the board — they **snap and stick** when placed
right. Built as a plain web app, structured so multiplayer + Discord Activity
bolt on later without rewriting the game.

## Run it

```bash
cd puzzle
npm install          # one time (gets `ws`)
npm start            # serves the app + multiplayer server on http://localhost:3001
```

Open http://localhost:3001. **To play together**, share a room code (or a
`?room=CODE` link) — everyone who enters the same code joins the same puzzle and
sees each other's named cursors live. Two browser tabs = two players for testing.

Single-player also works from any plain static host (no server) — it just runs
in "solo" mode with no remote cursors.

## Features

- **Choose piece count** — Easy (~12) to Expert (~192). Grid auto-fits the painting's aspect ratio.
- **Famous paintings** — Mona Lisa, Starry Night, The Great Wave, etc. (public-domain, from Wikimedia).
- **Pieces in a bottom tray** — drag up onto the board.
- **Pieces stick in place** — snap to their slot and lock when close enough.
- **Real interlocking shapes** — knobbed jigsaw edges, gap-free seams.
- **Ghost hint** + **shuffle tray** buttons. **Use your own image** (URL or file) too.

## Layout

| File | Role |
|------|------|
| `index.html` / `styles.css` | Setup screen + game shell |
| `src/paintings.js` | Painting list + difficulty presets |
| `src/puzzle.js` | Jigsaw geometry — interlocking piece paths |
| `src/main.js` | Setup UI, rendering, drag / snap / lock, win |
| `src/net.js` | Networking seam (no-op today) |

## Sound

Effects are synthesized with the Web Audio API ([src/audio.js](src/audio.js)) —
no audio files, so nothing extra to host and it passes Discord's CSP. Toggle with
the 🔊 button.

## Upload to Discord (Activity)

The app is self-contained — paintings live in [`assets/`](assets/) and the SDK is
vendored at [`vendor/discord-sdk.js`](vendor/discord-sdk.js) — so it makes **no
external network calls** and needs **no URL mappings beyond the root**. No build
step: the same `server.js` you run locally is what you deploy.

1. **Host `server.js`** on a public HTTPS host that supports WebSockets —
   Railway, Render, or Fly.io all work free. Push this folder to GitHub, deploy
   from the repo, start command `node server.js` (it reads `process.env.PORT`).
   You get a URL like `https://your-app.up.railway.app`; confirm it loads.
2. **Create the app** at <https://discord.com/developers/applications> and copy
   the **Application ID**. Paste it into `CLIENT_ID` in
   [src/discord.js](src/discord.js), commit, redeploy.
3. In the app → **Activities** (enable) → **URL Mappings**: map root `/` to your
   host. That's the only mapping needed.
4. Add the app to a server you're in, join a voice channel, open the **Activity
   launcher** (rocket icon) and pick it.

The Discord SDK wiring in [src/discord.js](src/discord.js) auto-detects whether
it's inside Discord and otherwise runs standalone, so local dev is unaffected.

**Player names from Discord (optional):** the OAuth handshake in `discord.js`
needs a small `POST /api/token` endpoint that swaps the code for an access token
using your app's Client Secret. Without it the activity still runs — players type
their own name.

**Regenerating the vendored SDK** (after `npm update`): `npm run bundle:sdk`.

## Multiplayer (live)

- [server.js](server.js) — Node server: serves the app **and** runs the room
  WebSocket on one port. Rooms keyed by code; keeps authoritative piece state so
  late joiners sync; broadcasts moves, placements, pickups, and cursors.
- [src/net.js](src/net.js) — WebSocket client. Falls back to solo if no server.
- Puzzles are **seeded** ([src/puzzle.js](src/puzzle.js)) and laid out in a fixed
  shared world coordinate space ([src/main.js](src/main.js)), so every player sees
  identical pieces in matching positions regardless of screen size.

Play with friends over the internet: run `server.js` on a public host, or tunnel
it — `cloudflared tunnel --url http://localhost:3001` — and share the URL +
room code. For Discord, the same server can host the static build and the socket.
