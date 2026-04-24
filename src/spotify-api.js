import { REDIRECT_URI, SCOPES } from "./config.js";
import {
  clearPkceVerifier,
  loadPkceVerifier,
  loadRefreshToken,
  savePkceVerifier,
  saveRefreshToken,
  saveToken,
} from "./storage.js";
import { buildPkceChallenge, randomString } from "./utils.js";

export function createSpotifyApi({ clientId, onToken }) {
  let accessToken = "";
  let isRefreshing = false;

  function setAccessToken(token) {
    accessToken = token;
    onToken?.(token);
  }

  async function refreshAccessToken() {
    if (isRefreshing) return;
    const refreshToken = loadRefreshToken();
    if (!refreshToken) throw new Error("No refresh token stored. Please reconnect.");

    isRefreshing = true;
    try {
      const body = new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });

      const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      if (!response.ok) throw new Error("Token refresh failed. Please reconnect.");

      const data = await response.json();
      saveToken(data.access_token, data.expires_in);
      if (data.refresh_token) {
        saveRefreshToken(data.refresh_token);
      }
      setAccessToken(data.access_token);
    } finally {
      isRefreshing = false;
    }
  }

  async function spotifyFetch(path, options = {}, isRetry = false) {
    const response = await fetch(`https://api.spotify.com/v1${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    // Any 2xx with no body is a success (204, or empty response from other endpoints)
    if (response.status === 204 || !response.body) {
      return null;
    }

    if (response.status === 401 && !isRetry) {
      await refreshAccessToken();
      return spotifyFetch(path, options, true);
    }

    const text = await response.text();
    const trimmed = text.trim();

    if (!response.ok) {
      if (!trimmed) {
        throw new Error("Spotify API error");
      }

      try {
        const parsed = JSON.parse(trimmed);
        const message = parsed?.error?.message || trimmed;
        throw new Error(message);
      } catch {
        throw new Error(trimmed);
      }
    }

    // Empty response body after success status is OK
    if (!trimmed) {
      return null;
    }

    try {
      return JSON.parse(trimmed);
    } catch (err) {
      // Log the problematic response for debugging
      const preview = trimmed.substring(0, 100);
      console.error("JSON parse failed for Spotify response:", preview, err);
      throw new Error(`Unexpected response format: ${preview || "(empty)"}`);
    }
  }

  return {
    setAccessToken,
    getAccessToken() {
      return accessToken;
    },
    async connectSpotify() {
      if (!clientId || clientId === "YOUR_REAL_CLIENT_ID") {
        throw new Error("Set your Spotify Client ID in app.js first.");
      }

      const verifier = randomString(64);
      const challenge = await buildPkceChallenge(verifier);
      savePkceVerifier(verifier);

      const params = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        scope: SCOPES.join(" "),
        code_challenge_method: "S256",
        code_challenge: challenge,
      });

      window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
    },
    async exchangeAuthCode() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      if (!code) {
        return false;
      }

      const verifier = loadPkceVerifier();
      if (!verifier) {
        throw new Error("Missing PKCE verifier. Try connecting again.");
      }

      const body = new URLSearchParams({
        client_id: clientId,
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
        throw new Error("Token exchange failed. Check redirect URI and client ID.");
      }

      const data = await response.json();
      saveToken(data.access_token, data.expires_in);
      if (data.refresh_token) {
        saveRefreshToken(data.refresh_token);
      }
      setAccessToken(data.access_token);
      clearPkceVerifier();
      window.history.replaceState({}, document.title, REDIRECT_URI);
      return true;
    },
    spotifyFetch,
    async searchFirstTrack(query) {
      const searchParams = new URLSearchParams({
        q: query,
        type: "track",
        limit: "1",
      });
      const data = await spotifyFetch(`/search?${searchParams.toString()}`);
      return data.tracks?.items?.[0] || null;
    },
    async searchTracks(query, limit = 6) {
      const searchParams = new URLSearchParams({
        q: query,
        type: "track",
        limit: String(limit),
      });
      const data = await spotifyFetch(`/search?${searchParams.toString()}`);
      return data.tracks?.items || [];
    },
    async listDevices() {
      const data = await spotifyFetch("/me/player/devices");
      return data?.devices || [];
    },
    async fetchPlayerState() {
      return spotifyFetch("/me/player");
    },
    async fetchQueue() {
      const data = await spotifyFetch("/me/player/queue");
      return data?.queue || [];
    },
    async playUris(deviceId, uris) {
      return spotifyFetch(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
        method: "PUT",
        body: JSON.stringify({ uris }),
      });
    },
    async pause() {
      return spotifyFetch("/me/player/pause", { method: "PUT" });
    },
    async resume(deviceId) {
      return spotifyFetch(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
        method: "PUT",
      });
    },
    async enqueue(deviceId, uri) {
      return spotifyFetch(
        `/me/player/queue?uri=${encodeURIComponent(uri)}&device_id=${encodeURIComponent(deviceId)}`,
        { method: "POST" },
      );
    },
  };
}