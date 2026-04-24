import { REDIRECT_URI, SCOPES } from "./config.js";
import {
  clearPkceVerifier,
  loadPkceVerifier,
  savePkceVerifier,
  saveToken,
} from "./storage.js";
import { buildPkceChallenge, randomString } from "./utils.js";

export function createSpotifyApi({ clientId, onToken }) {
  let accessToken = "";

  function setAccessToken(token) {
    accessToken = token;
    onToken?.(token);
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