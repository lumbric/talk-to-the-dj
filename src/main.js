import { createDjAgent } from "./llm.js";
import { createPlaybackController } from "./playback-controller.js";
import { createSpotifyApi } from "./spotify-api.js";
import { createStore } from "./state.js";
import { loadStoredToken } from "./storage.js";
import { createUI } from "./ui.js";

export async function initApp({ spotifyClientId }) {
  const store = createStore();
  const spotifyApi = createSpotifyApi({
    clientId: spotifyClientId,
    onToken: () => {},
  });
  const playbackController = createPlaybackController({ store, spotifyApi });
  createDjAgent();

  const actions = {
    connectSpotify: async () => {
      try {
        await spotifyApi.connectSpotify();
      } catch (error) {
        store.setStatus(error.message);
      }
    },
    addTrackByQuery: (query) => playbackController.addTrackByQuery(query),
    addTrackFromSuggestion: (suggestion) => playbackController.addTrackFromSuggestion(suggestion),
    getTrackSuggestions: (query) => playbackController.getTrackSuggestions(query),
    togglePlayPause: () => playbackController.togglePlayPause(),
    playNextTrack: () => playbackController.playNextTrack(),
    clearPlaylist: () => playbackController.clearPlaylist(),
    setCrossfadeSeconds: (value) => playbackController.setCrossfadeSeconds(value),
    setMode: (mode) => playbackController.setMode(mode),
    selectConnectDevice: (deviceId) => playbackController.selectConnectDevice(deviceId),
    refreshDevices: () => playbackController.refreshDevices(),
  };

  createUI(store, actions);

  if (!spotifyClientId || spotifyClientId === "YOUR_REAL_CLIENT_ID") {
    store.setStatus("Set SPOTIFY_CLIENT_ID in app.js, then click Connect Spotify.");
    return;
  }

  try {
    const fromCallback = await spotifyApi.exchangeAuthCode();
    const storedToken = loadStoredToken();
    if (storedToken) {
      spotifyApi.setAccessToken(storedToken);
    }

    if (fromCallback || storedToken) {
      store.setStatus("Authorizing player...");
      playbackController.setupPlayer();
      await playbackController.hydrateAfterAuth();
    } else {
      store.setStatus("Click Connect Spotify to authorize.");
    }
  } catch (error) {
    store.setStatus(error.message);
  }
}