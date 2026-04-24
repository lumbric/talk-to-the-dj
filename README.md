# 11 Jahre Werkstatt DJ (One-Page App)

Simple one-page HTML + JavaScript app that uses the Spotify API to:
- Search songs and append them to the Track Queue
- Play songs in order
- Toggle play/pause and skip tracks
- Apply configurable crossfade-style transitions between songs

## 1) Create Spotify App

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Create an app and copy your Client ID.
3. In app settings, add this Redirect URI (example):
   - `http://127.0.0.1:5500/`

## 2) Configure Client ID

Edit `app.js` and set:

```js
const SPOTIFY_CLIENT_ID = "YOUR_REAL_CLIENT_ID";
```

`app.js` is now the module entrypoint and configuration file. The implementation is split across `src/` into a small core, Spotify integration modules, UI rendering, and an isolated LLM integration stub.

## 3) Run locally

Use any local static server. Example with Python:

```bash
cd /home/peter/spotify-dj
python3 -m http.server 5500 --bind 127.0.0.1
```

Open:
- `http://127.0.0.1:5500/`

## How Track Queue + Crossfade Work

- Use the search field and click **+** to append tracks to the Track Queue.
- The first added track starts playback automatically (once connected).
- Tracks continue in Track Queue order.
- Set overlap seconds in the crossfade input (0-12, default 6).

### Crossfade note

Spotify's Web Playback SDK does not expose independent multi-deck mixing in a single browser player, so true dual-track overlap on one account/device is limited.

This app implements a practical crossfade transition by:
- Fading out the current track near its end
- Starting the next track at low volume
- Fading the next track up over the configured overlap duration

## Notes

- Spotify Web Playback SDK requires a **Spotify Premium** account.
- Browser autoplay restrictions may require a user click (buttons in the UI handle that).
- Track Queue state and playback settings are persisted in local storage. Reopening the page restores the queue and settings, but browser-player playback itself does not continue automatically.