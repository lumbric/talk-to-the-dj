const SPOTIFY_CLIENT_ID = "71aada5264bb4fafafe88289bfd492da";
const REDIRECT_URI = window.location.origin + window.location.pathname;
const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-modify-playback-state",
  "user-read-playback-state",
];

const ACCESS_TOKEN_KEY = "spotify_access_token";
const TOKEN_EXPIRY_KEY = "spotify_token_expiry";
const PKCE_VERIFIER_KEY = "spotify_pkce_verifier";
const DEFAULT_PLAYER_VOLUME = 0.8;
const MAX_CROSSFADE_SECONDS = 12;

const elements = {
  songInput: document.getElementById("songInput"),
  addBtn: document.getElementById("addBtn"),
  playPauseBtn: document.getElementById("playPauseBtn"),
  nextBtn: document.getElementById("nextBtn"),
  clearBtn: document.getElementById("clearBtn"),
  crossfadeInput: document.getElementById("crossfadeInput"),
  crossfadePanel: document.getElementById("crossfadePanel"),
  devicePanel: document.getElementById("devicePanel"),
  deviceSelect: document.getElementById("deviceSelect"),
  modeSDKBtn: document.getElementById("modeSDKBtn"),
  modeConnectBtn: document.getElementById("modeConnectBtn"),
  refreshDevicesBtn: document.getElementById("refreshDevicesBtn"),
  timeReadout: document.getElementById("timeReadout"),
  playlist: document.getElementById("playlist"),
  connectBtn: document.getElementById("connectBtn"),
  status: document.getElementById("status"),
};

let player;
let deviceId = "";
let accessToken = "";
let playlist = [];
let currentTrackIndex = -1;
let isTransitioning = false;
let currentPlayerVolume = DEFAULT_PLAYER_VOLUME;
let crossfadeTimeoutId;
let fadeIntervalId;
let playbackTimerId;
let playbackMode = "sdk";
let connectDeviceId = "";
let connectPollId;
let connectPreviousTrackUri = "";
let playbackPositionMs = 0;
let playbackDurationMs = 0;
let playbackPaused = true;
let playbackLastSyncTs = 0;

function setStatus(message) {
  elements.status.textContent = message;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getActiveDeviceId() {
  return playbackMode === "connect" ? connectDeviceId : deviceId;
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function setTimeReadout(positionMs, durationMs) {
  const safeDuration = Math.max(durationMs, 0);
  const safePosition = clamp(positionMs, 0, safeDuration || 0);
  const remainingMs = Math.max(safeDuration - safePosition, 0);
  elements.timeReadout.textContent = `Elapsed ${formatDuration(safePosition)} | Remaining -${formatDuration(remainingMs)}`;
}

function stopPlaybackTicker() {
  if (playbackTimerId) {
    clearInterval(playbackTimerId);
    playbackTimerId = undefined;
  }
}

function startPlaybackTicker() {
  if (playbackTimerId) {
    return;
  }

  playbackTimerId = setInterval(() => {
    if (playbackPaused || playbackDurationMs <= 0) {
      return;
    }

    const now = Date.now();
    const elapsedSinceSync = now - playbackLastSyncTs;
    const nextPosition = Math.min(playbackPositionMs + elapsedSinceSync, playbackDurationMs);
    setTimeReadout(nextPosition, playbackDurationMs);
  }, 400);
}

function syncPlaybackState(state) {
  playbackPositionMs = state.position;
  playbackDurationMs = state.duration;
  playbackPaused = state.paused;
  playbackLastSyncTs = Date.now();

  setTimeReadout(playbackPositionMs, playbackDurationMs);

  if (playbackPaused) {
    stopPlaybackTicker();
    return;
  }

  startPlaybackTicker();
}

function resetPlaybackClock() {
  playbackPositionMs = 0;
  playbackDurationMs = 0;
  playbackPaused = true;
  playbackLastSyncTs = 0;
  stopPlaybackTicker();
  setTimeReadout(0, 0);
}

function playlistDisplayName(track) {
  return `${track.name} - ${track.artists}`;
}

function getCrossfadeSeconds() {
  const raw = Number(elements.crossfadeInput.value || "0");
  return clamp(Number.isFinite(raw) ? raw : 0, 0, MAX_CROSSFADE_SECONDS);
}

function setControlState() {
  const hasTracks = playlist.length > 0;
  const hasNextTrack = currentTrackIndex >= 0 && currentTrackIndex < playlist.length - 1;
  const ready = playbackMode === "connect" ? Boolean(connectDeviceId) : Boolean(deviceId);

  elements.playPauseBtn.disabled = !ready;
  elements.nextBtn.disabled = !ready || !hasNextTrack;
  elements.clearBtn.disabled = !hasTracks;
}

function renderPlaylist() {
  if (!playlist.length) {
    elements.playlist.innerHTML = "<li class=\"playlist-empty\">No songs yet. Search and add one.</li>";
    setControlState();
    return;
  }

  elements.playlist.innerHTML = playlist
    .map((track, index) => {
      const activeClass = index === currentTrackIndex ? " playlist-item-active" : "";
      return `<li class=\"playlist-item${activeClass}\"><span>${index + 1}. ${playlistDisplayName(track)}</span><span>${formatDuration(track.durationMs)}</span></li>`;
    })
    .join("");

  setControlState();
}

async function loadDevices() {
  try {
    const data = await spotifyFetch("/me/player/devices");
    const devices = data?.devices || [];
    if (!devices.length) {
      elements.deviceSelect.innerHTML = "<option value=\"\">No devices found — open Spotify on any device.</option>";
      connectDeviceId = "";
      setControlState();
      return;
    }

    elements.deviceSelect.innerHTML = devices
      .map((d) => `<option value="${d.id}">${d.name} (${d.type})</option>`)
      .join("");

    const active = devices.find((d) => d.is_active) || devices[0];
    connectDeviceId = active.id;
    elements.deviceSelect.value = connectDeviceId;
    setControlState();
  } catch (error) {
    elements.deviceSelect.innerHTML = "<option value=\"\">Could not load devices.</option>";
    setStatus(`Device load failed: ${error.message}`);
  }
}

function startConnectPolling() {
  if (connectPollId) {
    return;
  }

  connectPollId = setInterval(async () => {
    if (!accessToken) {
      return;
    }

    try {
      const state = await spotifyFetch("/me/player");
      if (!state) {
        return;
      }

      playbackPositionMs = state.progress_ms || 0;
      playbackDurationMs = state.item?.duration_ms || 0;
      playbackPaused = !state.is_playing;
      playbackLastSyncTs = Date.now();
      setTimeReadout(playbackPositionMs, playbackDurationMs);

      if (playbackPaused) {
        stopPlaybackTicker();
      } else {
        startPlaybackTicker();
      }

      elements.playPauseBtn.textContent = state.is_playing ? "Pause" : "Play";

      const currentUri = state.item?.uri;
      if (currentUri && currentUri !== connectPreviousTrackUri) {
        connectPreviousTrackUri = currentUri;
        const newIndex = playlist.findIndex((t) => t.uri === currentUri);
        if (newIndex >= 0 && newIndex !== currentTrackIndex) {
          currentTrackIndex = newIndex;
          renderPlaylist();
          setStatus(`Now playing (${newIndex + 1}/${playlist.length}): ${playlistDisplayName(playlist[newIndex])}`);
          if (newIndex >= playlist.length - 1) {
            setStatus("Last track playing — playlist will end soon.");
          }
          setControlState();
        }
      }
    } catch {
      // ignore transient poll errors
    }
  }, 3000);
}

function stopConnectPolling() {
  if (connectPollId) {
    clearInterval(connectPollId);
    connectPollId = undefined;
  }
}

function setMode(mode) {
  playbackMode = mode;
  elements.modeSDKBtn.classList.toggle("mode-active", mode === "sdk");
  elements.modeConnectBtn.classList.toggle("mode-active", mode === "connect");
  elements.crossfadePanel.classList.toggle("hidden", mode === "connect");
  elements.devicePanel.classList.toggle("hidden", mode === "sdk");

  stopConnectPolling();
  connectPreviousTrackUri = "";

  if (mode === "connect" && accessToken) {
    loadDevices();
  }

  setControlState();
}

function setToken(token, expiresInSeconds) {
  accessToken = token;
  localStorage.setItem(ACCESS_TOKEN_KEY, token);
  localStorage.setItem(TOKEN_EXPIRY_KEY, String(Date.now() + expiresInSeconds * 1000));
}

function loadStoredToken() {
  const token = localStorage.getItem(ACCESS_TOKEN_KEY);
  const expiry = Number(localStorage.getItem(TOKEN_EXPIRY_KEY) || "0");

  if (token && Date.now() < expiry) {
    accessToken = token;
    return true;
  }

  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
  return false;
}

function clearTransitionTimers() {
  if (crossfadeTimeoutId) {
    clearTimeout(crossfadeTimeoutId);
    crossfadeTimeoutId = undefined;
  }

  if (fadeIntervalId) {
    clearInterval(fadeIntervalId);
    fadeIntervalId = undefined;
  }
}

function randomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function sha256(plain) {
  const data = new TextEncoder().encode(plain);
  return window.crypto.subtle.digest("SHA-256", data);
}

function base64UrlEncode(arrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function buildPkceChallenge(verifier) {
  return base64UrlEncode(await sha256(verifier));
}

async function connectSpotify() {
  if (!SPOTIFY_CLIENT_ID || SPOTIFY_CLIENT_ID === "YOUR_SPOTIFY_CLIENT_ID") {
    setStatus("Set your Spotify Client ID in app.js first.");
    return;
  }

  const verifier = randomString(64);
  const challenge = await buildPkceChallenge(verifier);
  localStorage.setItem(PKCE_VERIFIER_KEY, verifier);

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: challenge,
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function exchangeAuthCode() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) {
    return false;
  }

  const verifier = localStorage.getItem(PKCE_VERIFIER_KEY);
  if (!verifier) {
    setStatus("Missing PKCE verifier. Try connecting again.");
    return false;
  }

  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    setStatus("Token exchange failed. Check redirect URI and client ID.");
    return false;
  }

  const data = await response.json();
  setToken(data.access_token, data.expires_in);

  localStorage.removeItem(PKCE_VERIFIER_KEY);
  window.history.replaceState({}, document.title, REDIRECT_URI);
  return true;
}

async function spotifyFetch(path, options = {}) {
  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Spotify API error");
  }

  return response.json();
}

async function searchFirstTrack(query) {
  const searchParams = new URLSearchParams({
    q: query,
    type: "track",
    limit: "1",
  });
  const data = await spotifyFetch(`/search?${searchParams.toString()}`);
  return data.tracks?.items?.[0] || null;
}

async function playTrackUri(uri) {
  const activeDeviceId = getActiveDeviceId();
  if (!activeDeviceId) {
    throw new Error("No active playback device yet.");
  }

  await spotifyFetch(`/me/player/play?device_id=${encodeURIComponent(activeDeviceId)}`, {
    method: "PUT",
    body: JSON.stringify({
      uris: [uri],
    }),
  });
}

async function playPlaylistSliceFromIndex(index) {
  const activeDeviceId = getActiveDeviceId();
  if (!activeDeviceId) {
    throw new Error("No active playback device yet.");
  }

  const remainingUris = playlist.slice(index).map((track) => track.uri);
  if (!remainingUris.length) {
    return;
  }

  await spotifyFetch(`/me/player/play?device_id=${encodeURIComponent(activeDeviceId)}`, {
    method: "PUT",
    body: JSON.stringify({
      uris: remainingUris,
    }),
  });
}

async function enqueueTrackOnConnect(uri) {
  if (!connectDeviceId) {
    return;
  }

  const encodedUri = encodeURIComponent(uri);
  const encodedDeviceId = encodeURIComponent(connectDeviceId);
  await spotifyFetch(`/me/player/queue?uri=${encodedUri}&device_id=${encodedDeviceId}`, { method: "POST" });
}

async function setPlayerVolume(volume) {
  currentPlayerVolume = clamp(volume, 0, 1);
  if (!player) {
    return;
  }

  await player.setVolume(currentPlayerVolume);
}

function fadeVolume(from, to, durationMs) {
  return new Promise((resolve) => {
    if (durationMs <= 0) {
      setPlayerVolume(to).finally(resolve);
      return;
    }

    const steps = Math.max(Math.floor(durationMs / 140), 1);
    const stepMs = Math.max(Math.floor(durationMs / steps), 60);
    let currentStep = 0;

    clearTransitionTimers();
    fadeIntervalId = setInterval(() => {
      currentStep += 1;
      const progress = currentStep / steps;
      const nextVolume = from + (to - from) * progress;

      setPlayerVolume(nextVolume).catch(() => {
        setStatus("Volume change failed during transition.");
      });

      if (currentStep >= steps) {
        clearInterval(fadeIntervalId);
        fadeIntervalId = undefined;
        resolve();
      }
    }, stepMs);
  });
}

function scheduleCrossfadeForTrack(index) {
  if (playbackMode === "connect" || index < 0 || index >= playlist.length - 1) {
    return;
  }

  const overlapSeconds = getCrossfadeSeconds();
  const track = playlist[index];
  const fireInMs = Math.max(track.durationMs - overlapSeconds * 1000, 0);

  crossfadeTimeoutId = setTimeout(() => {
    startCrossfadeToNext().catch((error) => {
      isTransitioning = false;
      setStatus(`Crossfade failed: ${error.message}`);
    });
  }, fireInMs);
}

async function playTrackAtIndex(index, options = {}) {
  if (index < 0 || index >= playlist.length) {
    return;
  }

  if (!getActiveDeviceId()) {
    throw new Error("No active playback device yet.");
  }

  clearTransitionTimers();
  currentTrackIndex = index;
  renderPlaylist();

  const track = playlist[index];

  if (playbackMode === "connect") {
    await playPlaylistSliceFromIndex(index);
    setStatus(`Now playing (${index + 1}/${playlist.length}): ${playlistDisplayName(track)}`);
    connectPreviousTrackUri = track.uri;
    startConnectPolling();
    setControlState();
    return;
  }

  const startMuted = Boolean(options.startMuted);

  if (startMuted) {
    await setPlayerVolume(0);
  }

  await playTrackUri(track.uri);

  if (!startMuted) {
    await setPlayerVolume(DEFAULT_PLAYER_VOLUME);
  }

  setStatus(`Now playing (${index + 1}/${playlist.length}): ${playlistDisplayName(track)}`);

  if (!options.skipAutoCrossfade) {
    scheduleCrossfadeForTrack(index);
  }

  setControlState();
}

async function startCrossfadeToNext() {
  if (isTransitioning || currentTrackIndex < 0 || currentTrackIndex >= playlist.length - 1) {
    return;
  }

  const overlapSeconds = getCrossfadeSeconds();
  const nextIndex = currentTrackIndex + 1;
  isTransitioning = true;

  if (overlapSeconds <= 0) {
    await playTrackAtIndex(nextIndex);
    isTransitioning = false;
    return;
  }

  await fadeVolume(currentPlayerVolume, 0, overlapSeconds * 1000);
  await playTrackAtIndex(nextIndex, { startMuted: true, skipAutoCrossfade: true });
  await fadeVolume(0, DEFAULT_PLAYER_VOLUME, overlapSeconds * 1000);
  isTransitioning = false;
  scheduleCrossfadeForTrack(currentTrackIndex);
}

async function queueTrack(query) {
  setStatus("Searching for track...");
  const track = await searchFirstTrack(query);
  if (!track) {
    setStatus("No matching song found.");
    return;
  }

  const queuedTrack = {
    uri: track.uri,
    name: track.name,
    artists: track.artists.map((artist) => artist.name).join(", "),
    durationMs: track.duration_ms,
  };

  playlist.push(queuedTrack);
  renderPlaylist();
  setStatus(`Added to playlist: ${playlistDisplayName(queuedTrack)}`);

  if (playbackMode === "connect" && getActiveDeviceId() && currentTrackIndex >= 0) {
    try {
      await enqueueTrackOnConnect(queuedTrack.uri);
    } catch {
      // The list still contains the track; manual Next remains available as fallback.
    }
  }

  if (getActiveDeviceId() && currentTrackIndex === -1) {
    await playTrackAtIndex(0);
  }
}

async function playNextTrack() {
  if (currentTrackIndex >= playlist.length - 1) {
    setStatus("End of playlist.");
    return;
  }

  if (isTransitioning) {
    return;
  }

  if (playbackMode === "connect") {
    await playTrackAtIndex(currentTrackIndex + 1);
    return;
  }

  isTransitioning = true;
  await fadeVolume(currentPlayerVolume, 0, 500);
  await playTrackAtIndex(currentTrackIndex + 1, { startMuted: true, skipAutoCrossfade: true });
  await fadeVolume(0, DEFAULT_PLAYER_VOLUME, 600);
  isTransitioning = false;
  scheduleCrossfadeForTrack(currentTrackIndex);
}

async function togglePlayPause() {
  if (playbackMode === "connect") {
    const state = await spotifyFetch("/me/player");
    if (state?.is_playing) {
      await spotifyFetch("/me/player/pause", { method: "PUT" });
    } else {
      await spotifyFetch(`/me/player/play?device_id=${encodeURIComponent(connectDeviceId)}`, { method: "PUT" });
    }
    return;
  }
  await player.togglePlay();
}

function setupPlayer() {
  const initPlayer = () => {
    player = new Spotify.Player({
      name: "Spotify DJ Web Player",
      getOAuthToken: (cb) => cb(accessToken),
      volume: DEFAULT_PLAYER_VOLUME,
    });

    player.addListener("ready", ({ device_id: readyDeviceId }) => {
      deviceId = readyDeviceId;
      setControlState();
      setStatus("Connected. Add songs to build the playlist.");

      if (playlist.length && currentTrackIndex === -1) {
        playTrackAtIndex(0).catch((error) => {
          setStatus(`Could not start playback: ${error.message}`);
        });
      }
    });

    player.addListener("not_ready", () => {
      deviceId = "";
      resetPlaybackClock();
      setControlState();
      setStatus("Player went offline. Refresh and reconnect.");
    });

    player.addListener("player_state_changed", (state) => {
      if (!state || playbackMode === "connect") {
        return;
      }

      syncPlaybackState(state);

      elements.playPauseBtn.textContent = state.paused ? "Play" : "Pause";

      const playingUri = state.track_window.current_track?.uri;
      if (playingUri) {
        const matchedIndex = playlist.findIndex((track) => track.uri === playingUri);
        if (matchedIndex >= 0 && matchedIndex !== currentTrackIndex) {
          currentTrackIndex = matchedIndex;
          renderPlaylist();
          clearTransitionTimers();
          scheduleCrossfadeForTrack(currentTrackIndex);
        }
      }

      if (!isTransitioning) {
        const remainingMs = state.duration - state.position;
        const thresholdMs = getCrossfadeSeconds() * 1000 + 250;
        if (remainingMs > 0 && remainingMs <= thresholdMs && currentTrackIndex < playlist.length - 1) {
          startCrossfadeToNext().catch((error) => {
            isTransitioning = false;
            setStatus(`Crossfade failed: ${error.message}`);
          });
        }

        if (remainingMs <= 250 && currentTrackIndex === playlist.length - 1) {
          setStatus("Playlist finished.");
        }
      }

      setControlState();
    });

    player.addListener("initialization_error", ({ message }) => setStatus(`Player init error: ${message}`));
    player.addListener("authentication_error", ({ message }) => setStatus(`Auth error: ${message}`));
    player.addListener("account_error", ({ message }) => setStatus(`Account error: ${message}`));

    player.connect();
  };

  if (window.Spotify) {
    initPlayer();
    return;
  }

  window.onSpotifyWebPlaybackSDKReady = initPlayer;
}

function wireEvents() {
  elements.connectBtn.addEventListener("click", connectSpotify);

  const onAddSong = async () => {
    const query = elements.songInput.value.trim();
    if (!query) {
      setStatus("Type a song name first.");
      return;
    }

    try {
      await queueTrack(query);
      elements.songInput.value = "";
    } catch (error) {
      setStatus(`Could not add song: ${error.message}`);
    }
  };

  elements.addBtn.addEventListener("click", onAddSong);
  elements.songInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      onAddSong();
    }
  });

  elements.playPauseBtn.addEventListener("click", async () => {
    if (playbackMode === "sdk" && !player) {
      return;
    }

    try {
      await togglePlayPause();
    } catch (error) {
      setStatus(`Play/Pause failed: ${error.message}`);
    }
  });

  elements.nextBtn.addEventListener("click", async () => {
    try {
      await playNextTrack();
    } catch (error) {
      isTransitioning = false;
      setStatus(`Skip failed: ${error.message}`);
    }
  });

  elements.clearBtn.addEventListener("click", async () => {
    playlist = [];
    currentTrackIndex = -1;
    clearTransitionTimers();
    stopConnectPolling();
    connectPreviousTrackUri = "";
    renderPlaylist();

    if (playbackMode === "connect") {
      try {
        await spotifyFetch("/me/player/pause", { method: "PUT" });
      } catch {
        // ignore if nothing is playing
      }

      setStatus("Playlist cleared.");
      resetPlaybackClock();
      return;
    }

    if (player) {
      try {
        await player.pause();
      } catch (error) {
        setStatus(`Could not pause player: ${error.message}`);
        return;
      }
    }

    setStatus("Playlist cleared.");
    resetPlaybackClock();
  });

  elements.crossfadeInput.addEventListener("change", () => {
    elements.crossfadeInput.value = String(getCrossfadeSeconds());

    if (currentTrackIndex >= 0 && !isTransitioning) {
      clearTransitionTimers();
      scheduleCrossfadeForTrack(currentTrackIndex);
    }
  });

  elements.modeSDKBtn.addEventListener("click", () => setMode("sdk"));
  elements.modeConnectBtn.addEventListener("click", () => setMode("connect"));

  elements.deviceSelect.addEventListener("change", () => {
    connectDeviceId = elements.deviceSelect.value;
    setControlState();
  });

  elements.refreshDevicesBtn.addEventListener("click", () => {
    loadDevices();
  });
}

async function init() {
  wireEvents();
  renderPlaylist();
  setTimeReadout(0, 0);

  if (!SPOTIFY_CLIENT_ID || SPOTIFY_CLIENT_ID === "YOUR_SPOTIFY_CLIENT_ID") {
    setStatus("Set SPOTIFY_CLIENT_ID in app.js, then click Connect Spotify.");
    return;
  }

  const fromCallback = await exchangeAuthCode();
  const hasStored = loadStoredToken();

  if (fromCallback || hasStored) {
    setStatus("Authorizing player...");
    setupPlayer();
  } else {
    setStatus("Click Connect Spotify to authorize.");
  }
}

init();