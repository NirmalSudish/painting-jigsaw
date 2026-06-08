// Discord Embedded App SDK wrapper.
//
// Runs the game as a Discord Activity when launched inside Discord, and falls
// back to a normal standalone web app everywhere else (so dev still works).
//
// SETUP (see README "Upload to Discord"):
//   1. Create an app at https://discord.com/developers/applications
//   2. Enable Activities, map the root URL (/) to your hosted server.js
//   3. Paste the application's Client ID below
//
// The SDK is vendored locally at /vendor/discord-sdk.js (no CDN), and all images
// are local, so the activity needs no extra URL mappings beyond the root.
//
// The OAuth step (to read the player's Discord name) is optional and needs a
// tiny server endpoint at /api/token. Without it the activity still runs; the
// player just types their own name. initDiscord() never throws.

const CLIENT_ID = "1513594815617437706"; // Discord application Client ID
// must be added under the app's OAuth2 → Redirects, and match the server's
const REDIRECT_URI = "https://painting-jigsaw-production.up.railway.app";

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timeout")), ms))]);

export async function initDiscord() {
  // Discord injects these as query params on the activity iframe. Reading them
  // directly means the lobby works even if the SDK handshake is slow or fails.
  const params = new URLSearchParams(location.search);
  const frameId = params.get("frame_id");
  const instanceParam = params.get("instance_id");
  if (!frameId && !instanceParam) return { inDiscord: false };

  // shared room key from the query param — available immediately, no SDK needed
  const result = { inDiscord: true, instanceId: instanceParam || frameId };
  if (!CLIENT_ID) { console.warn("[discord] CLIENT_ID not set"); return result; }

  try {
    const { DiscordSDK } = await import("../vendor/discord-sdk.js?v=6");
    const sdk = new DiscordSDK(CLIENT_ID);
    await withTimeout(sdk.ready(), 5000, "ready");
    result.sdk = sdk;
    if (sdk.instanceId) result.instanceId = sdk.instanceId;

    // optional: resolve the player's Discord name (needs /api/token + secret)
    try {
      const { code } = await withTimeout(sdk.commands.authorize({
        client_id: CLIENT_ID, response_type: "code", state: "", scope: ["identify"], redirect_uri: REDIRECT_URI,
      }), 8000, "authorize");
      const res = await fetch("/api/token", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
      });
      const tok = await res.json().catch(() => ({}));
      if (!tok.access_token) {
        result.authError = "token:" + (tok.error || res.status);
      } else {
        const auth = await withTimeout(sdk.commands.authenticate({ access_token: tok.access_token }), 6000, "authenticate");
        result.username = auth?.user?.global_name || auth?.user?.username;
        if (!result.username) result.authError = "no-username";
      }
    } catch (e) {
      result.authError = e.message;
      console.warn("[discord] name lookup failed:", e.message);
    }
  } catch (e) {
    console.warn("[discord] SDK init failed, running with query-param room:", e.message);
  }
  return result; // always has inDiscord + instanceId so the lobby can run
}
