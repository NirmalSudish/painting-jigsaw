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

function inDiscord() {
  return new URLSearchParams(location.search).has("frame_id");
}

export async function initDiscord() {
  if (!inDiscord()) return { inDiscord: false };
  if (!CLIENT_ID) {
    console.warn("[discord] Set CLIENT_ID in src/discord.js to run as an Activity.");
    return { inDiscord: true, error: "missing CLIENT_ID" };
  }
  try {
    const { DiscordSDK } = await import("../vendor/discord-sdk.js");
    const sdk = new DiscordSDK(CLIENT_ID);
    await sdk.ready();

    let username;
    try {
      const { code } = await sdk.commands.authorize({
        client_id: CLIENT_ID,
        response_type: "code",
        state: "",
        prompt: "none",
        scope: ["identify"],
      });
      const res = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const { access_token } = await res.json();
      const auth = await sdk.commands.authenticate({ access_token });
      username = auth?.user?.global_name || auth?.user?.username;
    } catch (e) {
      // OAuth is optional — run anonymously if there's no /api/token endpoint.
    }
    // instanceId is unique per launched activity in a voice channel -> use it as
    // the room code so everyone who joins the activity shares one puzzle.
    return { inDiscord: true, sdk, username, instanceId: sdk.instanceId };
  } catch (e) {
    console.warn("[discord] SDK init failed:", e);
    return { inDiscord: true, error: e };
  }
}
