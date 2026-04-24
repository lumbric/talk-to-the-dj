import { DEFAULT_SETTINGS, DEFAULT_STATE } from "./config.js";

const ACCESS_TOKEN_KEY = "spotify_access_token";
const TOKEN_EXPIRY_KEY = "spotify_token_expiry";
const REFRESH_TOKEN_KEY = "spotify_refresh_token";
const PKCE_VERIFIER_KEY = "spotify_pkce_verifier";
const APP_STATE_KEY = "spotify_dj_app_state";

export function saveToken(token, expiresInSeconds) {
  localStorage.setItem(ACCESS_TOKEN_KEY, token);
  localStorage.setItem(TOKEN_EXPIRY_KEY, String(Date.now() + expiresInSeconds * 1000));
}

export function loadStoredToken() {
  const token = localStorage.getItem(ACCESS_TOKEN_KEY);
  const expiry = Number(localStorage.getItem(TOKEN_EXPIRY_KEY) || "0");

  if (token && Date.now() < expiry) {
    return token;
  }

  clearStoredToken();
  return "";
}

export function saveRefreshToken(token) {
  localStorage.setItem(REFRESH_TOKEN_KEY, token);
}

export function loadRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY) || "";
}

export function clearStoredToken() {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function savePkceVerifier(verifier) {
  localStorage.setItem(PKCE_VERIFIER_KEY, verifier);
}

export function loadPkceVerifier() {
  return localStorage.getItem(PKCE_VERIFIER_KEY) || "";
}

export function clearPkceVerifier() {
  localStorage.removeItem(PKCE_VERIFIER_KEY);
}

export function loadPersistedAppState() {
  const raw = localStorage.getItem(APP_STATE_KEY);
  if (!raw) {
    return {
      playlist: DEFAULT_STATE.playlist,
      currentTrackIndex: DEFAULT_STATE.currentTrackIndex,
      settings: { ...DEFAULT_SETTINGS },
      history: { ...DEFAULT_STATE.history },
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      playlist: Array.isArray(parsed.playlist) ? parsed.playlist : [],
      currentTrackIndex: Number.isInteger(parsed.currentTrackIndex) ? parsed.currentTrackIndex : -1,
      settings: {
        ...DEFAULT_SETTINGS,
        ...(parsed.settings || {}),
      },
      history: {
        queued: Array.isArray(parsed.history?.queued) ? parsed.history.queued : [],
        playing: Array.isArray(parsed.history?.playing) ? parsed.history.playing : [],
        played: Array.isArray(parsed.history?.played) ? parsed.history.played : [],
        skipped: Array.isArray(parsed.history?.skipped) ? parsed.history.skipped : [],
      },
    };
  } catch {
    return {
      playlist: DEFAULT_STATE.playlist,
      currentTrackIndex: DEFAULT_STATE.currentTrackIndex,
      settings: { ...DEFAULT_SETTINGS },
      history: { ...DEFAULT_STATE.history },
    };
  }
}

export function savePersistedAppState(state) {
  const snapshot = {
    playlist: state.playlist,
    currentTrackIndex: state.currentTrackIndex,
    settings: state.settings,
    history: state.history,
  };
  localStorage.setItem(APP_STATE_KEY, JSON.stringify(snapshot));
}