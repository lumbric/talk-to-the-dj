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
export const MIN_QUEUE_LENGTH = 1;
export const MAX_QUEUE_LENGTH = 500;

export const DEFAULT_SETTINGS = {
  playbackMode: "connect",
  connectDeviceId: "",
  crossfadeSeconds: 6,
  maxQueueLength: 50,
};

export const DEFAULT_STATE = {
  playlist: [],
  currentTrackIndex: -1,
  settings: DEFAULT_SETTINGS,
  status: "Not connected.",
  history: {
    queued: [],
    playing: [],
    played: [],
    skipped: [],
  },
  playback: {
    sdkDeviceId: "",
    availableDevices: [],
    isReady: false,
    isPaused: true,
    positionMs: 0,
    durationMs: 0,
  },
};