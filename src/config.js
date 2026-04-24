export const REDIRECT_URI = window.location.origin + window.location.pathname;

export const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-modify-playback-state",
  "user-read-playback-state",
];

export const DEFAULT_PLAYER_VOLUME = 0.8;
export const MAX_CROSSFADE_SECONDS = 12;

export const DEFAULT_SETTINGS = {
  playbackMode: "sdk",
  connectDeviceId: "",
  crossfadeSeconds: 6,
};

export const DEFAULT_STATE = {
  playlist: [],
  currentTrackIndex: -1,
  settings: DEFAULT_SETTINGS,
  status: "Not connected.",
  playback: {
    sdkDeviceId: "",
    availableDevices: [],
    isReady: false,
    isPaused: true,
    positionMs: 0,
    durationMs: 0,
  },
};