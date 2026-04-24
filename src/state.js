import { DEFAULT_STATE, DEFAULT_SETTINGS, MAX_CROSSFADE_SECONDS } from "./config.js";
import { loadPersistedAppState, savePersistedAppState } from "./storage.js";

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeSettings(settings) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    playbackMode: "connect",
    crossfadeSeconds: clamp(Number(settings?.crossfadeSeconds ?? DEFAULT_SETTINGS.crossfadeSeconds), 0, MAX_CROSSFADE_SECONDS),
  };
}

function createInitialState() {
  const persisted = loadPersistedAppState();
  return {
    ...DEFAULT_STATE,
    playlist: persisted.playlist,
    currentTrackIndex: persisted.currentTrackIndex,
    settings: normalizeSettings(persisted.settings),
  };
}

export function createStore() {
  let state = createInitialState();
  const listeners = new Set();

  function emit() {
    savePersistedAppState(state);
    listeners.forEach((listener) => listener(state));
  }

  return {
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    setStatus(status) {
      state = { ...state, status };
      emit();
    },
    appendTrack(track) {
      state = {
        ...state,
        playlist: [...state.playlist, track],
      };
      emit();
    },
    removeTrack(index) {
      if (index < 0 || index >= state.playlist.length) {
        return;
      }

      const nextPlaylist = state.playlist.filter((_, trackIndex) => trackIndex !== index);
      let nextCurrentTrackIndex = state.currentTrackIndex;

      if (!nextPlaylist.length) {
        nextCurrentTrackIndex = -1;
      } else if (index < state.currentTrackIndex) {
        nextCurrentTrackIndex = state.currentTrackIndex - 1;
      } else if (index === state.currentTrackIndex) {
        nextCurrentTrackIndex = Math.min(state.currentTrackIndex, nextPlaylist.length - 1);
      }

      state = {
        ...state,
        playlist: nextPlaylist,
        currentTrackIndex: nextCurrentTrackIndex,
      };
      emit();
    },
    clearPlaylist() {
      state = {
        ...state,
        playlist: [],
        currentTrackIndex: -1,
      };
      emit();
    },
    replacePlaylist(playlist, currentTrackIndex = state.currentTrackIndex) {
      state = {
        ...state,
        playlist,
        currentTrackIndex,
      };
      emit();
    },
    setCurrentTrackIndex(currentTrackIndex) {
      state = {
        ...state,
        currentTrackIndex,
      };
      emit();
    },
    updateSettings(patch) {
      state = {
        ...state,
        settings: normalizeSettings({
          ...state.settings,
          ...patch,
        }),
      };
      emit();
    },
    setAvailableDevices(availableDevices) {
      state = {
        ...state,
        playback: {
          ...state.playback,
          availableDevices,
        },
      };
      emit();
    },
    updatePlayback(patch) {
      state = {
        ...state,
        playback: {
          ...state.playback,
          ...patch,
        },
      };
      emit();
    },
  };
}