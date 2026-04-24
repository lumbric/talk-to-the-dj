import { DEFAULT_PLAYER_VOLUME } from "./config.js";
import { clamp, playlistDisplayName } from "./utils.js";

export function createPlaybackController({ store, spotifyApi }) {
  let player;
  let currentPlayerVolume = DEFAULT_PLAYER_VOLUME;
  let crossfadeTimeoutId;
  let fadeIntervalId;
  let playbackTimerId;
  let connectPollId;
  let connectPreviousTrackUri = "";
  let isTransitioning = false;
  let playbackPositionMs = 0;
  let playbackDurationMs = 0;
  let playbackPaused = true;
  let playbackLastSyncTs = 0;
  let connectPollTick = 0;
  let suppressRemoteQueueReplaceUntil = 0;

  function getState() {
    return store.getState();
  }

  function suppressRemoteQueueReplace(ms = 15000) {
    suppressRemoteQueueReplaceUntil = Date.now() + ms;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function spotifyIdFromUri(uri) {
    if (!uri || typeof uri !== "string") {
      return "";
    }

    const parts = uri.split(":");
    return parts.length >= 3 ? parts[2] : "";
  }

  function trackSnapshot(track) {
    return {
      spotify_id: track.spotifyId || spotifyIdFromUri(track.uri),
      uri: track.uri,
      name: track.name,
      artists: track.artists,
      duration_ms: track.durationMs,
      album_name: track.albumName || "",
      release_date: track.releaseDate || "",
      popularity: Number.isFinite(track.popularity) ? track.popularity : null,
      image_url: track.imageUrl || "",
    };
  }

  function appendHistory(kind, track, timestamps) {
    if (!track?.uri) {
      return;
    }

    store.appendHistory(kind, {
      ...trackSnapshot(track),
      ...timestamps,
    });
  }

  function currentPlaybackSeconds() {
    const ms = Number.isFinite(getState().playback.positionMs) ? getState().playback.positionMs : playbackPositionMs;
    return Math.max(0, Math.floor((ms || 0) / 1000));
  }

  function toQueuedTrack(track) {
    const addedAt = nowIso();
    return {
      uri: track.uri,
      spotifyId: track.id || spotifyIdFromUri(track.uri),
      name: track.name,
      artists: (track.artists || []).map((artist) => artist.name).join(", "),
      durationMs: track.duration_ms,
      albumName: track.album?.name || "",
      releaseDate: track.album?.release_date || "",
      popularity: Number.isFinite(track.popularity) ? track.popularity : null,
      imageUrl: track.album?.images?.[2]?.url || track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || "",
      suggestedAt: addedAt,
      queuedAt: addedAt,
    };
  }

  function getPlaybackMode() {
    return getState().settings.playbackMode;
  }

  function getConnectDeviceId() {
    return getState().settings.connectDeviceId;
  }

  function getActiveDeviceId() {
    return getPlaybackMode() === "connect" ? getConnectDeviceId() : getState().playback.sdkDeviceId;
  }

  function stopPlaybackTicker() {
    if (playbackTimerId) {
      clearInterval(playbackTimerId);
      playbackTimerId = undefined;
    }
  }

  function updatePlaybackClock(positionMs, durationMs, paused) {
    playbackPositionMs = positionMs;
    playbackDurationMs = durationMs;
    playbackPaused = paused;
    playbackLastSyncTs = Date.now();

    store.updatePlayback({
      positionMs,
      durationMs,
      isPaused: paused,
    });

    if (paused) {
      stopPlaybackTicker();
      return;
    }

    if (!playbackTimerId) {
      playbackTimerId = setInterval(() => {
        if (playbackPaused || playbackDurationMs <= 0) {
          return;
        }

        const now = Date.now();
        const elapsedSinceSync = now - playbackLastSyncTs;
        store.updatePlayback({
          positionMs: Math.min(playbackPositionMs + elapsedSinceSync, playbackDurationMs),
          durationMs: playbackDurationMs,
          isPaused: playbackPaused,
        });
      }, 400);
    }
  }

  function resetPlaybackClock() {
    playbackPositionMs = 0;
    playbackDurationMs = 0;
    playbackPaused = true;
    playbackLastSyncTs = 0;
    stopPlaybackTicker();
    store.updatePlayback({
      positionMs: 0,
      durationMs: 0,
      isPaused: true,
    });
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

  function stopConnectPolling() {
    if (connectPollId) {
      clearInterval(connectPollId);
      connectPollId = undefined;
    }
    connectPollTick = 0;
  }

  async function loadDevices() {
    const devices = await spotifyApi.listDevices();
    store.setAvailableDevices(devices);

    if (!devices.length) {
      store.updateSettings({ connectDeviceId: "" });
      return;
    }

    const currentId = getConnectDeviceId();
    const active = devices.find((device) => device.id === currentId)
      || devices.find((device) => device.is_active)
      || devices[0];
    store.updateSettings({ connectDeviceId: active.id });
  }

  async function syncConnectState() {
    if (!spotifyApi.getAccessToken()) {
      return;
    }

    const remoteState = await spotifyApi.fetchPlayerState();
    if (!remoteState) {
      return;
    }

    updatePlaybackClock(remoteState.progress_ms || 0, remoteState.item?.duration_ms || 0, !remoteState.is_playing);

    const currentUri = remoteState.item?.uri || "";
    if (currentUri) {
      connectPreviousTrackUri = currentUri;
    }

    if (currentUri) {
      const latestState = getState();
      const latestIndex = latestState.playlist.findIndex((track) => track.uri === currentUri);

      // Local queue is out of sync with the device: do not fetch/replace from remote.
      if (latestIndex < 0) {
        return;
      }

      if (latestIndex >= 0 && latestIndex !== latestState.currentTrackIndex) {
        const previousTrack = latestState.currentTrackIndex >= 0
          ? latestState.playlist[latestState.currentTrackIndex]
          : null;
        if (previousTrack?.uri && previousTrack.uri !== currentUri) {
          appendHistory("played", previousTrack, { played_at: nowIso() });
        }

        const track = latestState.playlist[latestIndex];

        // Drop already-played tracks from the local queue so current is always index 0.
        if (latestIndex > 0) {
          store.replacePlaylist(latestState.playlist.slice(latestIndex), 0);
        } else {
          store.setCurrentTrackIndex(0);
        }

        appendHistory("playing", track, { playing_at: nowIso() });
        const trimmedState = getState();
        store.setStatus(`Now playing (1/${trimmedState.playlist.length}): ${playlistDisplayName(track)}`);

        enqueueImmediateNextForCurrent().catch(() => {
          // Best effort: local queue remains authoritative.
        });
      }
    }
  }

  async function enqueueImmediateNextIfNeededAfterAppend(addedTrackUri) {
    if (getPlaybackMode() !== "connect") {
      return;
    }

    const deviceId = getConnectDeviceId();
    if (!deviceId) {
      return;
    }

    const state = getState();
    if (state.currentTrackIndex < 0 || state.currentTrackIndex >= state.playlist.length) {
      return;
    }

    const nextTrack = state.playlist[state.currentTrackIndex + 1] || null;
    if (!nextTrack?.uri || nextTrack.uri !== addedTrackUri) {
      return;
    }

    await spotifyApi.enqueue(deviceId, nextTrack.uri);
  }

  async function enqueueImmediateNextForCurrent() {
    if (getPlaybackMode() !== "connect") {
      return;
    }

    const deviceId = getConnectDeviceId();
    if (!deviceId) {
      return;
    }

    const state = getState();
    if (state.currentTrackIndex < 0 || state.currentTrackIndex >= state.playlist.length) {
      return;
    }

    const nextTrack = state.playlist[state.currentTrackIndex + 1] || null;
    if (!nextTrack?.uri) {
      return;
    }

    await spotifyApi.enqueue(deviceId, nextTrack.uri);
  }

  async function playUrisForMode(index) {
    const activeDeviceId = getActiveDeviceId();
    if (!activeDeviceId) {
      throw new Error("No active playback device yet.");
    }

    const playlist = getState().playlist;
    const uris = getPlaybackMode() === "connect"
      ? playlist.slice(index).map((track) => track.uri)
      : [playlist[index].uri];

    await spotifyApi.playUris(activeDeviceId, uris);
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
          store.setStatus("Volume change failed during transition.");
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
    const state = getState();
    if (state.settings.playbackMode === "connect" || index < 0 || index >= state.playlist.length - 1) {
      return;
    }

    const track = state.playlist[index];
    const fireInMs = Math.max(track.durationMs - state.settings.crossfadeSeconds * 1000, 0);
    crossfadeTimeoutId = setTimeout(() => {
      startCrossfadeToNext().catch((error) => {
        isTransitioning = false;
        store.setStatus(`Crossfade failed: ${error.message}`);
      });
    }, fireInMs);
  }

  async function playTrackAtIndex(index, options = {}) {
    const state = getState();
    if (index < 0 || index >= state.playlist.length) {
      return;
    }

    const previousTrack = state.currentTrackIndex >= 0 ? state.playlist[state.currentTrackIndex] : null;
    const nextTrack = state.playlist[index];
    if (previousTrack?.uri && previousTrack.uri !== nextTrack.uri && !options.skipRecordPreviousAsPlayed) {
      appendHistory("played", previousTrack, { played_at: nowIso() });
    }

    clearTransitionTimers();
    store.setCurrentTrackIndex(index);

    const track = getState().playlist[index];
    if (getPlaybackMode() === "connect") {
      await playUrisForMode(index);
      connectPreviousTrackUri = track.uri;
      startConnectPolling();
      appendHistory("playing", track, { playing_at: nowIso() });
      store.setStatus(`Now playing (${index + 1}/${getState().playlist.length}): ${playlistDisplayName(track)}`);
      return;
    }

    const startMuted = Boolean(options.startMuted);
    if (startMuted) {
      await setPlayerVolume(0);
    }

    await playUrisForMode(index);

    if (!startMuted) {
      await setPlayerVolume(DEFAULT_PLAYER_VOLUME);
    }

    store.setStatus(`Now playing (${index + 1}/${getState().playlist.length}): ${playlistDisplayName(track)}`);

    if (!options.skipAutoCrossfade) {
      scheduleCrossfadeForTrack(index);
    }
  }

  async function startCrossfadeToNext() {
    const state = getState();
    if (isTransitioning || state.currentTrackIndex < 0 || state.currentTrackIndex >= state.playlist.length - 1) {
      return;
    }

    const nextIndex = state.currentTrackIndex + 1;
    const overlapSeconds = state.settings.crossfadeSeconds;
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
    scheduleCrossfadeForTrack(getState().currentTrackIndex);
  }

  function startConnectPolling() {
    if (connectPollId) {
      return;
    }

    connectPollTick = 0;
    syncConnectState().catch(() => {
      // Ignore initial sync failures; interval will retry.
    });

    connectPollId = setInterval(async () => {
      if (!spotifyApi.getAccessToken()) {
        return;
      }

      try {
        connectPollTick += 1;
        const isPaused = getState().playback.isPaused;
        if (isPaused && connectPollTick % 3 !== 0) {
          return;
        }
        await syncConnectState();
      } catch {
        // Ignore transient polling failures.
      }
    }, 3000);
  }

  function bindSdkPlayerListeners() {
    player.addListener("ready", ({ device_id: readyDeviceId }) => {
      store.updatePlayback({
        sdkDeviceId: readyDeviceId,
        isReady: true,
      });
      store.setStatus("Connected. Add songs to build the Track Queue.");

      const state = getState();
      if (state.playlist.length && state.currentTrackIndex >= 0) {
        store.setStatus("Track Queue restored. Press Play to resume or pick the next song.");
      }
    });

    player.addListener("not_ready", () => {
      store.updatePlayback({
        sdkDeviceId: "",
        isReady: false,
      });
      resetPlaybackClock();
      store.setStatus("Player went offline. Refresh and reconnect.");
    });

    player.addListener("player_state_changed", (state) => {
      if (!state || getPlaybackMode() === "connect") {
        return;
      }

      updatePlaybackClock(state.position, state.duration, state.paused);

      const playingUri = state.track_window.current_track?.uri;
      if (playingUri) {
        const matchedIndex = getState().playlist.findIndex((track) => track.uri === playingUri);
        if (matchedIndex >= 0 && matchedIndex !== getState().currentTrackIndex) {
          store.setCurrentTrackIndex(matchedIndex);
          clearTransitionTimers();
          scheduleCrossfadeForTrack(matchedIndex);
        }
      }

      if (!isTransitioning) {
        const remainingMs = state.duration - state.position;
        const thresholdMs = getState().settings.crossfadeSeconds * 1000 + 250;
        if (remainingMs > 0 && remainingMs <= thresholdMs && getState().currentTrackIndex < getState().playlist.length - 1) {
          startCrossfadeToNext().catch((error) => {
            isTransitioning = false;
            store.setStatus(`Crossfade failed: ${error.message}`);
          });
        }

        if (remainingMs <= 250 && getState().currentTrackIndex === getState().playlist.length - 1) {
          store.setStatus("Track Queue finished.");
        }
      }
    });

    player.addListener("initialization_error", ({ message }) => store.setStatus(`Player init error: ${message}`));
    player.addListener("authentication_error", ({ message }) => store.setStatus(`Auth error: ${message}`));
    player.addListener("account_error", ({ message }) => store.setStatus(`Account error: ${message}`));
  }

  let sdkReadyCallback = null;
  let sdkReadyFired = false;

  function registerSdkCallback() {
    window.onSpotifyWebPlaybackSDKReady = () => {
      sdkReadyFired = true;
      if (sdkReadyCallback) {
        sdkReadyCallback();
        sdkReadyCallback = null;
      }
    };
  }

  function setupPlayer() {
    const initPlayer = () => {
      player = new Spotify.Player({
        name: "Spotify DJ Web Player",
        getOAuthToken: (callback) => callback(spotifyApi.getAccessToken()),
        volume: DEFAULT_PLAYER_VOLUME,
      });
      bindSdkPlayerListeners();
      player.connect();
    };

    if (sdkReadyFired || window.Spotify) {
      initPlayer();
      return;
    }

    sdkReadyCallback = initPlayer;
  }

  return {
    registerSdkCallback,
    setupPlayer,
    async refreshDevices() {
      await loadDevices();
    },
    async setMode(mode) {
      const nextMode = mode === "connect" ? "connect" : "connect";
      store.updateSettings({ playbackMode: nextMode });
      stopConnectPolling();
      connectPreviousTrackUri = "";
      if (spotifyApi.getAccessToken()) {
        await loadDevices();
        await syncConnectState();
        startConnectPolling();
      }
    },
    selectConnectDevice(deviceId) {
      store.updateSettings({ connectDeviceId: deviceId });
    },
    setCrossfadeSeconds(seconds) {
      store.updateSettings({ crossfadeSeconds: seconds });
      const currentIndex = getState().currentTrackIndex;
      if (currentIndex >= 0 && !isTransitioning) {
        clearTransitionTimers();
        scheduleCrossfadeForTrack(currentIndex);
      }
    },
    async getTrackSuggestions(query) {
      if (!query || !query.trim()) {
        return [];
      }

      const normalizedQuery = query.trim().toLowerCase();
      const localSuggestions = getState().playlist
        .filter((track) => {
          const haystack = `${track.name || ""} ${track.artists || ""} ${track.albumName || ""}`.toLowerCase();
          return haystack.includes(normalizedQuery);
        })
        .slice(0, 7)
        .map((track) => ({
          uri: track.uri,
          spotifyId: track.spotifyId || spotifyIdFromUri(track.uri),
          name: track.name,
          artists: track.artists,
          durationMs: track.durationMs,
          albumName: track.albumName || "",
          releaseDate: track.releaseDate || "",
          popularity: track.popularity ?? null,
          imageUrl: track.imageUrl || "",
        }));

      if (!spotifyApi.getAccessToken()) {
        return localSuggestions;
      }

      try {
        const tracks = await spotifyApi.searchTracks(query.trim(), 7);
        const remoteSuggestions = tracks.map((track) => ({
          uri: track.uri,
          spotifyId: track.id || spotifyIdFromUri(track.uri),
          name: track.name,
          artists: (track.artists || []).map((artist) => artist.name).join(", "),
          durationMs: track.duration_ms,
          albumName: track.album?.name || "",
          releaseDate: track.album?.release_date || "",
          popularity: Number.isFinite(track.popularity) ? track.popularity : null,
          imageUrl: track.album?.images?.[2]?.url || track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || "",
        }));

        if (remoteSuggestions.length) {
          return remoteSuggestions;
        }

        return localSuggestions;
      } catch {
        return localSuggestions;
      }
    },
    async addTrackByQuery(query) {
      store.setStatus("Searching for track...");
      const track = await spotifyApi.searchFirstTrack(query);
      if (!track) {
        store.setStatus("No matching song found.");
        return;
      }

      const queuedTrack = toQueuedTrack(track);

      store.appendTrack(queuedTrack);
      suppressRemoteQueueReplace();
      appendHistory("queued", queuedTrack, {
        suggested_at: queuedTrack.suggestedAt,
        queued_at: queuedTrack.queuedAt,
      });
      store.setStatus(`Added to Track Queue: ${playlistDisplayName(queuedTrack)}`);

      const state = getState();
      if (state.settings.playbackMode === "connect" && getActiveDeviceId() && state.currentTrackIndex >= 0) {
        try {
          await enqueueImmediateNextIfNeededAfterAppend(queuedTrack.uri);
        } catch {
          // Keep the track in the persisted playlist even if queue append fails.
        }
      }

      if (getActiveDeviceId() && state.currentTrackIndex === -1) {
        await playTrackAtIndex(0);
      }
    },
    async addTrackFromSuggestion(suggestion) {
      if (!suggestion?.uri) {
        return;
      }

      const addedAt = nowIso();
      const queuedTrack = {
        uri: suggestion.uri,
        spotifyId: suggestion.spotifyId || spotifyIdFromUri(suggestion.uri),
        name: suggestion.name,
        artists: suggestion.artists,
        durationMs: suggestion.durationMs || 0,
        albumName: suggestion.albumName || "",
        releaseDate: suggestion.releaseDate || "",
        popularity: suggestion.popularity ?? null,
        imageUrl: suggestion.imageUrl || "",
        suggestedAt: addedAt,
        queuedAt: addedAt,
      };

      store.appendTrack(queuedTrack);
      suppressRemoteQueueReplace();
      appendHistory("queued", queuedTrack, {
        suggested_at: queuedTrack.suggestedAt,
        queued_at: queuedTrack.queuedAt,
      });
      store.setStatus(`Added to Track Queue: ${playlistDisplayName(queuedTrack)}`);

      const state = getState();
      if (state.settings.playbackMode === "connect" && getActiveDeviceId() && state.currentTrackIndex >= 0) {
        try {
          await enqueueImmediateNextIfNeededAfterAppend(queuedTrack.uri);
        } catch {
          // Keep the track in the persisted playlist even if queue append fails.
        }
      }

      if (getActiveDeviceId() && state.currentTrackIndex === -1) {
        await playTrackAtIndex(0);
      }
    },
    async removeTrackAt(index) {
      const state = getState();
      if (index < 0 || index >= state.playlist.length) {
        return;
      }

      const removedTrack = state.playlist[index];
      const wasCurrentTrack = index === state.currentTrackIndex;

      suppressRemoteQueueReplace();
      store.removeTrack(index);
      const nextState = getState();

      if (!nextState.playlist.length) {
        if (wasCurrentTrack) {
          appendHistory("skipped", removedTrack, {
            skipped_at: nowIso(),
            skipped_after_seconds: currentPlaybackSeconds(),
          });
        }
        clearTransitionTimers();
        stopConnectPolling();
        connectPreviousTrackUri = "";
        resetPlaybackClock();
        try {
          if (getPlaybackMode() === "connect") {
            await spotifyApi.pause();
          } else if (player) {
            await player.pause();
          }
        } catch {
          // Ignore pause failures while clearing the last item.
        }
        store.setStatus("Track Queue is empty.");
        return;
      }

      if (wasCurrentTrack) {
        appendHistory("skipped", removedTrack, {
          skipped_at: nowIso(),
          skipped_after_seconds: currentPlaybackSeconds(),
        });
        const resumeIndex = Math.min(index, nextState.playlist.length - 1);
        await playTrackAtIndex(resumeIndex, { skipRecordPreviousAsPlayed: true });
      } else if (getPlaybackMode() === "connect" && getActiveDeviceId() && nextState.currentTrackIndex >= 0) {
        // Do not replay the tail in Connect mode; that would restart the current song.
        // Spotify has no direct remove-from-queue endpoint, so we keep local queue intact.
        store.setStatus(`Removed from Track Queue: ${playlistDisplayName(removedTrack)}`);
      } else {
        store.setStatus(`Removed from Track Queue: ${playlistDisplayName(removedTrack)}`);
      }
    },
    async togglePlayPause() {
      if (getPlaybackMode() === "connect") {
        const shouldPause = !getState().playback.isPaused;
        const deviceId = getConnectDeviceId();

        const isTransientGatewayError = (error) => {
          const message = String(error?.message || "").toLowerCase();
          return message.includes("502") || message.includes("bad gateway");
        };

        const wait = (ms) => new Promise((resolve) => {
          setTimeout(resolve, ms);
        });

        const runToggleOnce = async () => {
          if (shouldPause) {
            await spotifyApi.pause();
            return;
          }

          // Prefer device-targeted resume, but fallback to generic resume endpoint.
          if (deviceId) {
            try {
              await spotifyApi.resume(deviceId);
              return;
            } catch (error) {
              if (!isTransientGatewayError(error)) {
                throw error;
              }
            }
          }

          await spotifyApi.resume();
        };

        try {
          await runToggleOnce();
        } catch (error) {
          if (!isTransientGatewayError(error)) {
            throw error;
          }

          await wait(350);
          await runToggleOnce();
        }
        return;
      }

      if (!player) {
        return;
      }

      await player.togglePlay();
    },
    async playNextTrack() {
      const state = getState();
      if (state.currentTrackIndex < 0 || state.currentTrackIndex >= state.playlist.length) {
        store.setStatus("No track is currently playing.");
        return;
      }

      if (isTransitioning) {
        return;
      }

      const skippedTrack = state.playlist[state.currentTrackIndex];
      appendHistory("skipped", skippedTrack, {
        skipped_at: nowIso(),
        skipped_after_seconds: currentPlaybackSeconds(),
      });

      suppressRemoteQueueReplace();
      store.removeTrack(state.currentTrackIndex);
      const nextState = getState();
      if (!nextState.playlist.length) {
        try {
          await spotifyApi.pause();
        } catch {
          // Ignore pause errors if no active playback is present.
        }
        store.setStatus("Track Queue is empty.");
        resetPlaybackClock();
        return;
      }

      await playTrackAtIndex(nextState.currentTrackIndex, { skipRecordPreviousAsPlayed: true });
    },
    async clearPlaylist() {
      clearTransitionTimers();
      stopConnectPolling();
      connectPreviousTrackUri = "";
      suppressRemoteQueueReplace();
      store.clearPlaylist();

      if (getPlaybackMode() === "connect") {
        try {
          await spotifyApi.pause();
        } catch {
          // Ignore when no active playback exists on the remote device.
        }
        store.setStatus("Track Queue cleared locally. The next added song will replace remote playback.");
        resetPlaybackClock();
        return;
      }

      if (player) {
        try {
          await player.pause();
        } catch (error) {
          store.setStatus(`Could not pause player: ${error.message}`);
          return;
        }
      }

      store.setStatus("Track Queue cleared.");
      resetPlaybackClock();
    },
    async hydrateAfterAuth() {
      if (getPlaybackMode() === "connect") {
        await loadDevices();
        await syncConnectState();
        startConnectPolling();
      }
    },
    exportHistoryJson() {
      const state = getState();
      const payload = {
        exported_at: nowIso(),
        queue: state.playlist.map((track, index) => ({
          position: index + 1,
          ...trackSnapshot(track),
          suggested_at: track.suggestedAt || null,
          queued_at: track.queuedAt || null,
        })),
        currently_playing: state.currentTrackIndex >= 0 ? {
          ...trackSnapshot(state.playlist[state.currentTrackIndex]),
          playing_at: state.history.playing[state.history.playing.length - 1]?.playing_at || null,
        } : null,
        queued: state.history.queued,
        playing: state.history.playing,
        played: state.history.played,
        skipped: state.history.skipped,
      };

      return JSON.stringify(payload, null, 2);
    },
  };
}