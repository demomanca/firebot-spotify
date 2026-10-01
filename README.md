# Firebot Spotify Song Requests

A single-file custom script for [Firebot v5](https://firebot.app) that lets viewers request songs in chat and have them queued directly into your active Spotify session.

No dependencies — just Node.js built-ins. Drop one file into Firebot and you're done.

## Features

- Queue songs by name (`!song Bohemian Rhapsody`) or by Spotify track link/URI
- Smart search: understands `Artist - Title` format (either order) and falls back to free-text search
- One-time browser login (OAuth PKCE) — tokens are stored locally and refreshed automatically
- Confirms each request in chat with the track, artist, and its position in the queue

## Requirements

- Firebot v5
- Spotify Premium (the Web API queue endpoints require Premium)
- A Spotify app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)

## Setup

1. **Create a Spotify app** at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard):
   - Type: **Web**
   - Add this Redirect URI (replace `8899` only if you change the port):
     ```
     http://127.0.0.1:8899/callback
     ```
     Spotify requires the loopback IP `127.0.0.1` — `localhost` will not work.
   - Copy the **Client ID**. (You do not need the Client Secret — this script uses PKCE.)

2. **Add the script to Firebot**:
   - Firebot → Manager → Scripts → `+` → Custom Script
   - Select `song-request.js`
   - Paste your Client ID into the **Spotify App Client ID** parameter
   - If you changed the redirect URI port, set the matching **OAuth callback port**

3. **Create a command** (e.g. `!song`) that runs the script.

4. **First run**: use the command once (e.g. `!song never gonna give you up`). Your browser opens with a Spotify approval prompt — approve it, then run the command again. The startup script logs the connection status to the Firebot console.

## Usage

```
!song Bohemian Rhapsody
!song Nickelback - Photograph        (or: Photograph - Nickelback)
!song https://open.spotify.com/track/1lRmQ9D6oNYiuCXdGlKCs0
!song spotify:track:1lRmQ9D6oNYiuCXdGlKCs0
```

On success, chat gets: `viewer requested "Photograph" by Nickelback - added to the queue (2 up)`.

## How it works

- The script starts a tiny local HTTP server on the callback port for the OAuth redirect, then opens your browser. Tokens are saved to `spotify-tokens.json` next to the script (in Firebot's script data dir when available) and refreshed automatically.
- Text queries are turned into Spotify search candidates (`track:"..." artist:"..."`, reversed order, then free text); the first hit wins.
- Tracks are added via `POST /me/player/queue` to whichever device is currently active.

## Troubleshooting

| Message | Fix |
|---|---|
| "No active Spotify session found" | Open Spotify and start playing anything — the API needs an active device to queue into. |
| "Opening Spotify authorization..." never connects | Check the redirect URI matches exactly (`http://127.0.0.1:<port>/callback`) and the port isn't in use. |
| "Spotify connection expired" | Run the command again to re-authenticate. |
| Force re-auth | Delete `spotify-tokens.json` next to the script. |
| "Only Spotify track links can be requested" | Album/playlist links aren't supported yet — request individual tracks. |

## Development

`test-src.js` is generated — never edit it directly. Edit `song-request.js`, then:

```
node build-test.js
node test-src.js
```

Tests run fully offline.

## License

MIT
