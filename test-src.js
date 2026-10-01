const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { spawn } = require("child_process");

const SCOPES = "user-read-playback-state user-modify-playback-state";
const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";
const AUTH_TIMEOUT_MS = 180000;
const DEFAULT_PORT = 8899;

let dataDir = null;
let authInProgress = false;

function tokenFile() {
  return path.join(dataDir || __dirname, "spotify-tokens.json");
}

function loadTokens() {
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenFile(), "utf8"));
    if (parsed && typeof parsed.accessToken === "string" && typeof parsed.refreshToken === "string") {
      return parsed;
    }
  } catch (_) {}
  return null;
}

function saveTokens(tokens) {
  try {
    fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
    fs.writeFileSync(tokenFile(), JSON.stringify(tokens, null, 2));
  } catch (e) {
    throw new Error("Could not save Spotify tokens: " + e.message);
  }
}

function clearTokens() {
  try {
    fs.unlinkSync(tokenFile());
  } catch (_) {}
}

function httpJson(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? Buffer.from(body) : null;
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: Object.assign({}, headers, data ? { "Content-Length": data.length } : {})
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null });
          } catch (_) {
            resolve({ status: res.statusCode, body: chunks });
          }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function tokenRequest(params) {
  return httpJson(
    "POST",
    TOKEN_ENDPOINT,
    { "Content-Type": "application/x-www-form-urlencoded" },
    new URLSearchParams(params).toString()
  );
}

function generateCodeVerifier() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(64);
  let out = "";
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

function codeChallengeFrom(verifier) {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function browserArgs(platform, url) {
  if (platform === "win32") {
    return {
      cmd: "cmd",
      args: ["/c", "start", '""', '"' + url + '"'],
      options: { windowsVerbatimArguments: true }
    };
  }
  if (platform === "darwin") {
    return { cmd: "open", args: [url], options: {} };
  }
  return { cmd: "xdg-open", args: [url], options: {} };
}

function openBrowser(url) {
  try {
    const { cmd, args, options } = browserArgs(process.platform, url);
    spawn(cmd, args, Object.assign({ stdio: "ignore", detached: true }, options)).unref();
  } catch (_) {}
}

function redirectUriFor(port) {
  return "http://127.0.0.1:" + port + "/callback";
}

function startAuthFlow(clientId, port) {
  if (authInProgress) return Promise.reject(new Error("Authorization already in progress"));
  authInProgress = true;

  const verifier = generateCodeVerifier();
  const challenge = codeChallengeFrom(verifier);
  const redirectUri = redirectUriFor(port);
  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", crypto.randomBytes(16).toString("hex"));
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("code_challenge", challenge);

  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      authInProgress = false;
      if (err) reject(err);
      else resolve(value);
    };

    server.on("request", (req, res) => {
      const u = new URL(req.url, "http://127.0.0.1:" + port);
      if (u.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const errorParam = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html" });
      if (errorParam) {
        res.end("<h1>Spotify authorization failed</h1><p>You can close this tab.</p>");
        finish(new Error(errorParam));
        return;
      }
      if (!code) {
        res.end("<h1>Missing authorization code</h1>");
        return;
      }
      res.end("<h1>Spotify connected</h1><p>You can close this tab.</p>");
      tokenRequest({
        client_id: clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier
      })
        .then((r) => {
          if (r.status === 200 && r.body && r.body.access_token) {
            const prev = loadTokens();
            saveTokens({
              accessToken: r.body.access_token,
              refreshToken: r.body.refresh_token || (prev ? prev.refreshToken : null),
              expiresAt: Date.now() + (r.body.expires_in || 3600) * 1000
            });
            finish(null);
          } else {
            const msg = (r.body && (r.body.error_description || r.body.error)) || "Token exchange failed";
            finish(new Error(msg));
          }
        })
        .catch((e) => finish(e));
    });

    server.on("error", (e) => finish(e));
    server.listen(port, "127.0.0.1");
    const timer = setTimeout(() => finish(new Error("Authorization timed out")), AUTH_TIMEOUT_MS);
    openBrowser(authUrl.toString());
  });
}

async function getAccessToken(clientId) {
  const stored = loadTokens();
  if (!stored) return null;
  if (stored.accessToken && stored.expiresAt > Date.now() + 60000) return stored.accessToken;
  if (!stored.refreshToken) return null;
  const r = await tokenRequest({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken
  });
  if (r.status === 200 && r.body && r.body.access_token) {
    saveTokens({
      accessToken: r.body.access_token,
      refreshToken: r.body.refresh_token || stored.refreshToken,
      expiresAt: Date.now() + (r.body.expires_in || 3600) * 1000
    });
    return r.body.access_token;
  }
  clearTokens();
  return null;
}

function apiErrorText(res) {
  if (res.body && typeof res.body === "object") {
    if (res.body.error && res.body.error.message) return res.body.error.message;
    if (typeof res.body.error === "string") return res.body.error;
  }
  return "HTTP " + res.status;
}

async function spotifyGet(pathname, token) {
  const res = await httpJson("GET", API_BASE + pathname, { Authorization: "Bearer " + token });
  if (res.status === 401) throw new Error("Spotify session expired");
  if (res.status >= 400) {
    const err = new Error(apiErrorText(res));
    err.status = res.status;
    throw err;
  }
  return res.body;
}

async function spotifyPost(pathname, token) {
  const res = await httpJson("POST", API_BASE + pathname, { Authorization: "Bearer " + token });
  if (res.status === 401) throw new Error("Spotify session expired");
  if (res.status >= 400) {
    const err = new Error(apiErrorText(res));
    err.status = res.status;
    throw err;
  }
  return res.body;
}

function queueEndpoint(deviceId, uri) {
  return "/me/player/queue?device_id=" + encodeURIComponent(deviceId) + "&uri=" + encodeURIComponent(uri);
}

function extractQuery(trigger) {
  const meta = (trigger && trigger.metadata) || {};
  let args = [];
  if (trigger && trigger.type === "command" && meta.userCommand && Array.isArray(meta.userCommand.args)) {
    args = meta.userCommand.args.slice();
  }
  const cmdName = String(meta.commandName || (meta.userCommand && meta.userCommand.command) || "")
    .replace(/^[!#&$+]+/, "")
    .trim()
    .toLowerCase();
  if (cmdName && args.length) {
    const first = String(args[0]).replace(/^[!#&$+]+/, "").trim().toLowerCase();
    if (first === cmdName) args = args.slice(1);
  }
  let query = args.join(" ").trim();
  if (/^[!#&$+]/.test(query)) query = query.replace(/^\S+\s*/, "").trim();
  return query;
}

function parseSpotifyLink(input) {
  const uri = input.match(/spotify:(track|album|playlist|episode|show):([A-Za-z0-9]+)/);
  if (uri) return { type: uri[1], id: uri[2] };
  const url = input.match(/open\.spotify\.com\/(?:intl-[A-Za-z]{2}\/)?(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/);
  if (url) return { type: url[1], id: url[2] };
  return null;
}

function quoteTerm(s) {
  return '"' + s.replace(/["“”\\]/g, "").trim() + '"';
}

function searchCandidates(query) {
  const cleaned = query.replace(/["“”\\]/g, " ").replace(/\s+/g, " ").trim();
  const parts = cleaned.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  if (parts.length >= 2) {
    const a = parts[0];
    const b = parts.slice(1).join(" ");
    out.push("track:" + quoteTerm(a) + " artist:" + quoteTerm(b));
    out.push("track:" + quoteTerm(b) + " artist:" + quoteTerm(a));
  }
  if (cleaned) out.push("track:" + quoteTerm(cleaned));
  const free = cleaned
    .replace(/\s+[-–—]\s+/g, " ")
    .replace(/(^|\s)[\-–—]/g, "$1")
    .replace(/\b(AND|OR|NOT)\b/g, " ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (free && free !== cleaned) out.push(free);
  return out;
}

function respond(message) {
  return {
    success: true,
    effects: [{ type: "firebot:chat", message, chatter: "Streamer" }]
  };
}

exports.getScriptManifest = () => ({
  name: "Spotify Song Requests",
  description: "Viewers request songs in chat and they get queued into your active Spotify session.",
  author: "firebot-spotify",
  version: "1.0.0",
  firebotVersion: "5"
});

exports.getDefaultParameters = () => ({
  clientId: {
    type: "string",
    description: "Spotify App Client ID",
    secondaryDescription:
      "Create an app at developer.spotify.com, add http://127.0.0.1:<port>/callback as its Redirect URI (Spotify requires the loopback IP, not localhost), and paste the Client ID here. A Spotify Premium account is required.",
    showBottomHr: true
  },
  callbackPort: {
    type: "number",
    description: "OAuth callback port",
    default: DEFAULT_PORT,
    secondaryDescription: "Must match the redirect URI registered in your Spotify app."
  }
});

exports.run = async (runRequest) => {
  const logger = runRequest.modules.logger;
  if (runRequest.scriptDataDir) dataDir = runRequest.scriptDataDir;
  const params = runRequest.parameters || {};
  const clientId = String(params.clientId || "").trim();
  const port = Number(params.callbackPort) || DEFAULT_PORT;

  if (runRequest.trigger.type === "startup_script") {
    const tokens = loadTokens();
    logger.info(
      tokens
        ? "[Spotify Song Requests] Connected - ready to queue songs."
        : "[Spotify Song Requests] Not connected yet. Run the song command once and approve the browser prompt that opens."
    );
    return;
  }

  if (!clientId) {
    return respond("Song requests are not set up yet. Add your Spotify App Client ID to this script's parameters.");
  }

  const trigger = runRequest.trigger;
  const username = (trigger.metadata && trigger.metadata.username) || "the streamer";
  const query = extractQuery(trigger);

  if (!query) {
    return respond(
      "Usage: run the song request command followed by a song name or Spotify track link, e.g. !song Bohemian Rhapsody or !song https://open.spotify.com/track/..."
    );
  }

  let token;
  try {
    token = await getAccessToken(clientId);
  } catch (e) {
    logger.error("[Spotify Song Requests] Token refresh failed: " + e.message);
    return respond("Could not connect to Spotify. Check the Firebot console for details.");
  }

  if (!token) {
    if (authInProgress) {
      return respond("Spotify is still connecting - approve the browser prompt, then try again.");
    }
    logger.info("[Spotify Song Requests] Starting Spotify authorization in your browser...");
    startAuthFlow(clientId, port)
      .then(() => logger.info("[Spotify Song Requests] Connected successfully."))
      .catch((e) => logger.error("[Spotify Song Requests] Authorization failed: " + e.message));
    return respond(
      "Opening Spotify authorization in your browser - approve it, then run the song command again."
    );
  }

  try {
    const link = parseSpotifyLink(query);
    let track = null;
    if (link) {
      if (link.type !== "track") {
        return respond("Only Spotify track links can be requested right now.");
      }
      try {
        track = await spotifyGet("/tracks/" + encodeURIComponent(link.id), token);
      } catch (e) {
        if (e.status === 404) return respond("Could not find that track on Spotify.");
        throw e;
      }
    } else {
      const candidates = searchCandidates(query);
      logger.info("[Spotify Song Requests] Search candidates: " + JSON.stringify(candidates));
      for (const candidate of candidates) {
        const search = await spotifyGet("/search?type=track&limit=1&q=" + encodeURIComponent(candidate), token);
        const items = search && search.tracks && Array.isArray(search.tracks.items) ? search.tracks.items : [];
        if (items.length) {
          track = items[0];
          break;
        }
      }
    }
    if (!track) {
      return respond("Could not find \"" + query + "\" on Spotify.");
    }
    const artists = (track.artists || []).map((a) => a.name).join(", ");

    let player;
    try {
      player = await spotifyGet("/me/player", token);
    } catch (e) {
      if (e.status === 404) {
        return respond("No active Spotify session found. Start playing something in your Spotify app first.");
      }
      throw e;
    }
    const device = player && player.device;
    if (!device) {
      return respond("No active Spotify session found. Start playing something in your Spotify app first.");
    }

    let position = 1;
    try {
      const queue = await spotifyGet("/me/player/queue", token);
      if (queue && Array.isArray(queue.queue)) position = queue.queue.length + 1;
    } catch (_) {}

    await spotifyPost(queueEndpoint(device.id, track.uri), token);
    logger.info("[Spotify Song Requests] " + username + ' queued "' + track.name + '"');
    return respond(
      username + ' requested "' + track.name + '"' + (artists ? " by " + artists : "") + " - added to the queue (" + position + " up)"
    );
  } catch (e) {
    if (e.message === "Spotify session expired") {
      clearTokens();
      return respond("Spotify connection expired. Run the song command again to reconnect.");
    }
    if (e.status === 404) {
      return respond("No active Spotify session found. Start playing something in your Spotify app first.");
    }
    logger.error("[Spotify Song Requests] " + e.message);
    return respond("Failed to queue the song: " + e.message);
  }
};
;console.log(JSON.stringify({
  run: typeof exports.run,
  getDefaultParameters: typeof exports.getDefaultParameters,
  getScriptManifest: typeof exports.getScriptManifest,
}));
console.log(JSON.stringify(exports.getDefaultParameters()));
const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
console.log('challenge:', codeChallengeFrom(v));
const u = 'https://accounts.spotify.com/authorize?response_type=code&client_id=abc&code_challenge=x';
const a = browserArgs('win32', u);
console.log('win32 args:', JSON.stringify(a));
console.log('win32 url passed as one quoted token:', a.args[3] === '"' + u + '"');
console.log('win32 empty title placeholder before url:', a.args[2] === '""' && a.args[0] === '/c' && a.args[1] === 'start');
console.log('win32 windowsVerbatimArguments set:', a.options && a.options.windowsVerbatimArguments === true);
console.log('redirect uri uses loopback ip not localhost:', redirectUriFor(8899) === 'http://127.0.0.1:8899/callback' && !redirectUriFor(8899).includes('localhost'));
const os = require('os');
dataDir = path.join(os.tmpdir(), 'fsr-test-' + Date.now(), 'missing', 'nested');
saveTokens({ accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 1000 });
const saved = loadTokens();
console.log('save tokens into missing nested dir works:', !!saved && saved.accessToken === 'tok' && saved.refreshToken === 'ref');
clearTokens(); dataDir = null;
console.log('queue endpoint is POST /me/player/queue with device_id and uri:', queueEndpoint('dev 1', 'spotify:track:abc&x') === '/me/player/queue?device_id=dev%201&uri=spotify%3Atrack%3Aabc%26x');
const q1 = extractQuery({ type: 'command', metadata: { commandName: 'ssr', userCommand: { command: 'ssr', args: ['beautiful', 'people', '-', 'marilyn', 'manson'] } } });
console.log('extractQuery joins args:', q1 === 'beautiful people - marilyn manson');
const q2 = extractQuery({ type: 'command', metadata: { commandName: 'ssr', userCommand: { command: 'ssr', args: ['!ssr'] } } });
console.log('extractQuery strips leading command token so bare command shows usage:', q2 === '');
const q3 = extractQuery({ type: 'command', metadata: { commandName: 'ssr', userCommand: { command: 'ssr', args: [] } } });
console.log('extractQuery empty args stays empty:', q3 === '');
const q4 = extractQuery({ type: 'command', metadata: { userCommand: { args: ['!ssr', 'nickelback', 'photograph'] } } });
console.log('extractQuery strips leading !command token without commandName metadata:', q4 === 'nickelback photograph');
const q5 = extractQuery({ type: 'command', metadata: { userCommand: { args: ['!ssr nickelback photograph'] } } });
console.log('extractQuery strips command token when whole message is one arg:', q5 === 'nickelback photograph');
const q6 = extractQuery({ type: 'command', metadata: { userCommand: { args: ['!ssr'] } } });
console.log('extractQuery bare prefixed command yields empty so usage shows:', q6 === '');
const c1 = searchCandidates('beautiful people - marilyn manson');
console.log('hyphen query becomes structured track/artist search:', c1[0] === 'track:"beautiful people" artist:"marilyn manson"');
console.log('reversed artist/title order tried as fallback:', c1[1] === 'track:"marilyn manson" artist:"beautiful people"');
console.log('no bare hyphen operator left outside quoted phrases:', c1.every((c) => !/[-–—]/.test(c.replace(/"[^"]*"/g, '""'))));
const c2 = searchCandidates('Bohemian Rhapsody');
console.log('plain query quoted as track search:', c2[0] === 'track:"Bohemian Rhapsody"' && c2.length === 1);
const c3 = searchCandidates('cats (live) AND hounds');
console.log('free-text fallback strips spotify operators:', c3[c3.length - 1] === 'cats live hounds');
const l1 = parseSpotifyLink('https://open.spotify.com/track/1lRmQ9D6oNYiuCXdGlKCs0?si=81596043d06e43c0');
console.log('track url with si param parsed:', !!l1 && l1.type === 'track' && l1.id === '1lRmQ9D6oNYiuCXdGlKCs0');
const l2 = parseSpotifyLink('https://open.spotify.com/intl-de/track/1lRmQ9D6oNYiuCXdGlKCs0');
console.log('intl track url parsed:', !!l2 && l2.type === 'track' && l2.id === '1lRmQ9D6oNYiuCXdGlKCs0');
const l3 = parseSpotifyLink('spotify:track:1lRmQ9D6oNYiuCXdGlKCs0');
console.log('spotify uri parsed:', !!l3 && l3.type === 'track' && l3.id === '1lRmQ9D6oNYiuCXdGlKCs0');
const l4 = parseSpotifyLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
console.log('playlist url detected as non-track:', !!l4 && l4.type === 'playlist');
console.log('plain text is not a link:', parseSpotifyLink('nickelback photograph') === null);