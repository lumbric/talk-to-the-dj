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
  let connectQueueSyncInFlight = false;

  function getState() {
    return store.getState();
  }

  function toQueuedTrack(track) {
    return {
      uri: track.uri,
      name: track.name,
      artists: (track.artists || []).map((artist) => artist.name).join(", "),
      durationMs: track.duration_ms,
      albumName: track.album?.name || "",
      releaseDate: track.album?.release_date || "",
      popularity: Number.isFinite(track.popularity) ? track.popularity : null,
      imageUrl: track.album?.images?.[2]?.url || track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || "",
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

  function toQueuedTrackFromPlaybackItem(track) {
    if (!track?.uri) {
      return null;
    }

    return {
      uri: track.uri,
      name: track.name,
      artists: (track.artists || []).map((artist) => artist.name).join(", "),
      durationMs: track.duration_ms || 0,
      albumName: track.album?.name || "",
      releaseDate: track.album?.release_date || "",
      popularity: Number.isFinite(track.popularity) ? track.popularity : null,
      imageUrl: track.album?.images?.[2]?.url || track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || "",
    };
  }

  function buildRemotePlaylist(currentTrack, queuedTracks = []) {
    const seenUris = new Set();
    return [currentTrack, ...queuedTracks]
      .map(toQueuedTrackFromPlaybackItem)
      .filter(Boolean)
      .filter((track) => {
        if (seenUris.has(track.uri)) {
          return false;
        }
        seenUris.add(track.uri);
        return true;
      });
  }

  async function syncConnectState({ syncQueue = false, forceReplace = false } = {}) {
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

    const localState = getState();
    const localCurrentIndex = currentUri ? localState.playlist.findIndex((track) => track.uri === currentUri) : -1;

    if ((syncQueue || forceReplace || localCurrentIndex < 0) && !connectQueueSyncInFlight) {
      connectQueueSyncInFlight = true;
      try {
        const remoteQueue = await spotifyApi.fetchQueue();
        const remotePlaylist = buildRemotePlaylist(remoteState.item, remoteQueue);
        if (remotePlaylist.length) {
          const remoteCurrentIndex = currentUri
            ? remotePlaylist.findIndex((track) => track.uri === currentUri)
            : 0;
          store.replacePlaylist(remotePlaylist, remoteCurrentIndex >= 0 ? remoteCurrentIndex : 0);
        }
      } catch {
        // Queue sync is best effort. Polling will try again.
      } finally {
        connectQueueSyncInFlight = false;
      }
    }

    if (currentUri) {
      const latestState = getState();
      const latestIndex = latestState.playlist.findIndex((track) => track.uri === currentUri);
      if (latestIndex >= 0 && latestIndex !== latestState.currentTrackIndex) {
        store.setCurrentTrackIndex(latestIndex);
        const track = latestState.playlist[latestIndex];
        store.setStatus(`Now playing (${latestIndex + 1}/${latestState.playlist.length}): ${playlistDisplayName(track)}`);
      }
    }
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

    clearTransitionTimers();
    store.setCurrentTrackIndex(index);

    const track = getState().playlist[index];
    if (getPlaybackMode() === "connect") {
      await playUrisForMode(index);
      connectPreviousTrackUri = track.uri;
      startConnectPolling();
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
    syncConnectState({ syncQueue: true }).catch(() => {
      // Ignore initial sync failures; interval will retry.
    });

    connectPollId = setInterval(async () => {
      if (!spotifyApi.getAccessToken()) {
        return;
      }

      try {
        connectPollTick += 1;
        const shouldSyncQueue = connectPollTick % 4 === 0;
        await syncConnectState({ syncQueue: shouldSyncQueue });
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
      store.updateSettings({ playbackMode: mode });
      stopConnectPolling();
      connectPreviousTrackUri = "";
      if (mode === "connect" && spotifyApi.getAccessToken()) {
        await loadDevices();
        await syncConnectState({ syncQueue: true, forceReplace: true });
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
      store.setStatus(`Added to Track Queue: ${playlistDisplayName(queuedTrack)}`);

      const state = getState();
      if (state.settings.playbackMode === "connect" && getActiveDeviceId() && state.currentTrackIndex >= 0) {
        try {
          await spotifyApi.enqueue(getConnectDeviceId(), queuedTrack.uri);
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

      const queuedTrack = {
        uri: suggestion.uri,
        name: suggestion.name,
        artists: suggestion.artists,
        durationMs: suggestion.durationMs || 0,
        albumName: suggestion.albumName || "",
        releaseDate: suggestion.releaseDate || "",
        popularity: suggestion.popularity ?? null,
        imageUrl: suggestion.imageUrl || "",
      };

      store.appendTrack(queuedTrack);
      store.setStatus(`Added to Track Queue: ${playlistDisplayName(queuedTrack)}`);

      const state = getState();
      if (state.settings.playbackMode === "connect" && getActiveDeviceId() && state.currentTrackIndex >= 0) {
        try {
          await spotifyApi.enqueue(getConnectDeviceId(), queuedTrack.uri);
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

      store.removeTrack(index);
      const nextState = getState();

      if (!nextState.playlist.length) {
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
        const resumeIndex = Math.min(index, nextState.playlist.length - 1);
        await playTrackAtIndex(resumeIndex);
      } else if (getPlaybackMode() === "connect" && getActiveDeviceId() && nextState.currentTrackIndex >= 0) {
        // Spotify Connect does not support removing a queued track directly,
        // so replaying the local tail keeps device queue and app queue aligned.
        await playUrisForMode(nextState.currentTrackIndex);
        store.setStatus(`Updated Track Queue after removing: ${playlistDisplayName(removedTrack)}`);
      } else {
        store.setStatus(`Removed from Track Queue: ${playlistDisplayName(removedTrack)}`);
      }
    },
    async togglePlayPause() {
      if (getPlaybackMode() === "connect") {
        const state = await spotifyApi.fetchPlayerState();
        if (state?.is_playing) {
          await spotifyApi.pause();
        } else {
          await spotifyApi.resume(getConnectDeviceId());
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
      if (state.currentTrackIndex >= state.playlist.length - 1) {
        store.setStatus("End of Track Queue.");
        return;
      }

      if (isTransitioning) {
        return;
      }

      if (state.settings.playbackMode === "connect") {
        await playTrackAtIndex(state.currentTrackIndex + 1);
        return;
      }

      isTransitioning = true;
      await fadeVolume(currentPlayerVolume, 0, 500);
      await playTrackAtIndex(state.currentTrackIndex + 1, { startMuted: true, skipAutoCrossfade: true });
      await fadeVolume(0, DEFAULT_PLAYER_VOLUME, 600);
      isTransitioning = false;
      scheduleCrossfadeForTrack(getState().currentTrackIndex);
    },
    async clearPlaylist() {
      clearTransitionTimers();
      stopConnectPolling();
      connectPreviousTrackUri = "";
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
        await syncConnectState({ syncQueue: true, forceReplace: true });
        startConnectPolling();
      }
    },
  };
}