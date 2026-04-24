import { formatDuration, playlistDisplayName } from "./utils.js";

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5.2 19 12 8 18.8z" /></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 5h4v14H7zm6 0h4v14h-4z" /></svg>',
};

const ADMIN_ICONS = {
  locked: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="8" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M11.5 12h8M17 12v2M19.5 12v1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>',
  unlocked: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="8" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M11.5 12h8M17 12v2M19.5 12v1.5M4 20 20 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>',
};

export function createUI(store, actions) {
  let suggestionTimerId;
  let suggestionRequestId = 0;
  let suggestions = [];
  let highlightedSuggestionIndex = -1;
  let suggestionsLoading = false;
  let inputHasFocus = false;
  let lastRenderedStatus = "";
  let lastPlaylistSignature = "";
  let lastHistorySignature = "";
  let lastNowPlayingSignature = "";
  let lastDevicesSignature = "";
  let lastControlsSignature = "";
  let lastCrossfadeValue = "";
  let lastMaxQueueLengthValue = "";
  let adminUnlocked = false;

  const elements = {
    settingsBtn: document.getElementById("settingsBtn"),
    adminToggleBtn: document.getElementById("adminToggleBtn"),
    adminOverlay: document.getElementById("adminOverlay"),
    adminUnlockForm: document.getElementById("adminUnlockForm"),
    adminPasswordInput: document.getElementById("adminPasswordInput"),
    adminUnlockCancelBtn: document.getElementById("adminUnlockCancelBtn"),
    settingsDialog: document.getElementById("settingsDialog"),
    closeSettingsBtn: document.getElementById("closeSettingsBtn"),
    songInput: document.getElementById("songInput"),
    suggestions: document.getElementById("suggestions"),
    addBtn: document.getElementById("addBtn"),
    playPauseBtn: document.getElementById("playPauseBtn"),
    nextBtn: document.getElementById("nextBtn"),
    clearBtn: document.getElementById("clearBtn"),
    exportHistoryBtn: document.getElementById("exportHistoryBtn"),
    crossfadeInput: document.getElementById("crossfadeInput"),
    maxQueueLengthInput: document.getElementById("maxQueueLengthInput"),
    crossfadePanel: document.getElementById("crossfadePanel"),
    devicePanel: document.getElementById("devicePanel"),
    deviceSelect: document.getElementById("deviceSelect"),
    refreshDevicesBtn: document.getElementById("refreshDevicesBtn"),
    nowPlayingArt: document.getElementById("nowPlayingArt"),
    nowPlayingTitle: document.getElementById("nowPlayingTitle"),
    nowPlayingMeta: document.getElementById("nowPlayingMeta"),
    elapsedTime: document.getElementById("elapsedTime"),
    remainingTime: document.getElementById("remainingTime"),
    progressFill: document.getElementById("progressFill"),
    playlist: document.getElementById("playlist"),
    previousHistoryList: document.getElementById("previousHistoryList"),
    previousCount: document.getElementById("previousCount"),
    connectBtn: document.getElementById("connectBtn"),
    status: document.getElementById("status"),
    errorToast: document.getElementById("errorToast"),
    errorToastText: document.getElementById("errorToastText"),
    errorToastSettingsBtn: document.getElementById("errorToastSettingsBtn"),
    errorToastDismissBtn: document.getElementById("errorToastDismissBtn"),
  };

  function openSettingsDialog() {
    if (!elements.settingsDialog.open) {
      elements.settingsDialog.showModal();
    }
  }

  function closeSettingsDialog() {
    if (elements.settingsDialog.open) {
      elements.settingsDialog.close();
    }
  }

  function formatTimestamp(isoString) {
    if (!isoString) {
      return "-";
    }

    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return "-";
    }

    return date.toLocaleString();
  }

  function renderPlaylist(state) {
    if (!state.playlist.length) {
      elements.playlist.innerHTML = "<li class=\"playlist-empty\">Track Queue is empty. Search above and add your first track.</li>";
      return;
    }

    elements.playlist.innerHTML = state.playlist
      .map((track, index) => {
        const activeClass = index === state.currentTrackIndex ? " playlist-item-active" : "";
        const image = track.imageUrl
          ? `<img src="${track.imageUrl}" alt="Album cover" class="playlist-thumb" loading="lazy" />`
          : "<div class=\"playlist-thumb playlist-thumb-fallback\" aria-hidden=\"true\"></div>";

        const releaseYear = track.releaseDate ? String(track.releaseDate).slice(0, 4) : "";
        const albumMeta = track.albumName || "Unknown album";
        const popularityMeta = Number.isFinite(track.popularity) ? `Popularity ${track.popularity}` : "";
        const meta = [albumMeta, releaseYear, popularityMeta].filter(Boolean).join(" · ");
        const queuedAtText = formatTimestamp(track.queuedAt || track.suggestedAt);

        const removeButton = adminUnlocked
          ? `<button
              type="button"
              class="queue-remove"
              data-remove-index="${index}"
              aria-label="Remove ${playlistDisplayName(track)} from Track Queue"
              title="Remove from Track Queue"
            >&times;</button>`
          : "";

        return `<li class="playlist-item${activeClass}">
          <div class="playlist-main">
            ${image}
            <div class="playlist-text">
              <p class="playlist-title">${index + 1}. ${playlistDisplayName(track)}</p>
              <p class="playlist-meta">${meta}</p>
              <p class="playlist-added">Added to Track Queue at: ${queuedAtText}</p>
            </div>
          </div>
          <div class="playlist-actions">
            <span class="playlist-duration">${formatDuration(track.durationMs)}</span>
            ${removeButton}
          </div>
        </li>`;
      })
      .join("");
  }

  function renderHistoryList(listElement, items) {
    if (!listElement) {
      return;
    }

    if (!items.length) {
      listElement.innerHTML = "<li class=\"history-empty\">No tracks yet.</li>";
      return;
    }

    const recentItems = [...items]
      .sort((a, b) => {
        const aTs = Date.parse(a.event_at || 0);
        const bTs = Date.parse(b.event_at || 0);
        return bTs - aTs;
      })
      .slice(0, 200);

    listElement.innerHTML = recentItems
      .map((item) => {
        const timestampText = formatTimestamp(item.event_at);
        const skippedSeconds = Number.isFinite(item.skipped_after_seconds)
          ? Math.max(0, Math.round(item.skipped_after_seconds))
          : null;
        const metaText = item.kind === "skipped"
          ? `Skipped after ${skippedSeconds ?? "-"} seconds · ${timestampText}`
          : `Played at ${timestampText}`;
        const skippedClass = item.kind === "skipped" ? " history-item-skipped" : "";

        return `<li class="history-item${skippedClass}">
          <p class="history-title">${item.name || "Unknown track"}${item.artists ? ` · ${item.artists}` : ""}</p>
          <p class="history-meta">${metaText}</p>
        </li>`;
      })
      .join("");
  }

  function renderHistory(state) {
    const played = state.history?.played || [];
    const skipped = state.history?.skipped || [];
    const combined = [
      ...played.map((item) => ({ ...item, kind: "played", event_at: item.played_at })),
      ...skipped.map((item) => ({ ...item, kind: "skipped", event_at: item.skipped_at })),
    ];

    if (elements.previousCount) {
      elements.previousCount.textContent = String(combined.length);
    }

    renderHistoryList(elements.previousHistoryList, combined);
  }

  function renderNowPlaying(state) {
    const currentTrack = state.currentTrackIndex >= 0 ? state.playlist[state.currentTrackIndex] : null;
    if (!currentTrack) {
      elements.nowPlayingArt.className = "now-playing-art now-playing-art-fallback";
      elements.nowPlayingArt.innerHTML = "";
      elements.nowPlayingTitle.textContent = "No track selected";
      elements.nowPlayingMeta.textContent = "Add a song to start your Track Queue.";
      return;
    }

    if (currentTrack.imageUrl) {
      elements.nowPlayingArt.className = "now-playing-art";
      elements.nowPlayingArt.innerHTML = `<img src="${currentTrack.imageUrl}" alt="Cover art" loading="lazy" />`;
    } else {
      elements.nowPlayingArt.className = "now-playing-art now-playing-art-fallback";
      elements.nowPlayingArt.innerHTML = "";
    }

    elements.nowPlayingTitle.textContent = playlistDisplayName(currentTrack);
    elements.nowPlayingMeta.textContent = currentTrack.albumName || "Single / Unknown album";
  }

  function renderTimeReadout(state) {
    const safeDuration = Math.max(state.playback.durationMs || 0, 0);
    const safePosition = Math.min(Math.max(state.playback.positionMs || 0, 0), safeDuration || 0);
    const remainingMs = Math.max(safeDuration - safePosition, 0);

    elements.elapsedTime.textContent = formatDuration(safePosition);
    elements.remainingTime.textContent = `-${formatDuration(remainingMs)}`;

    const progressPercent = safeDuration > 0 ? (safePosition / safeDuration) * 100 : 0;
    elements.progressFill.style.width = `${progressPercent}%`;
  }

  function renderDevices(state) {
    const devices = state.playback.availableDevices;
    if (!devices.length) {
      elements.deviceSelect.innerHTML = "<option value=\"\">No devices found - open Spotify on any device.</option>";
      return;
    }

    elements.deviceSelect.innerHTML = devices
      .map((device) => `<option value="${device.id}">${device.name} (${device.type})</option>`)
      .join("");

    if (state.settings.connectDeviceId) {
      elements.deviceSelect.value = state.settings.connectDeviceId;
    }
  }

  function renderControls(state) {
    const hasTracks = state.playlist.length > 0;
    const hasNextTrack = state.currentTrackIndex >= 0 && state.currentTrackIndex < state.playlist.length - 1;
    const ready = Boolean(state.settings.connectDeviceId);
    const locked = !adminUnlocked;

    elements.playPauseBtn.classList.toggle("hidden", locked);
    elements.nextBtn.classList.toggle("hidden", locked);
    elements.clearBtn.classList.toggle("hidden", locked);

    elements.playPauseBtn.disabled = locked || !ready;
    elements.nextBtn.disabled = locked || !ready || !hasNextTrack;
    elements.clearBtn.disabled = locked || !hasTracks;
    elements.playPauseBtn.innerHTML = state.playback.isPaused ? ICONS.play : ICONS.pause;
    elements.playPauseBtn.title = state.playback.isPaused ? "Play" : "Pause";
    elements.playPauseBtn.setAttribute("aria-label", state.playback.isPaused ? "Play" : "Pause");
  }

  function maybeShowErrorToast(status) {
    const lowered = String(status || "").toLowerCase();
    const isError = /(error|failed|could not|no active playback device|not connected|authorize|token)/.test(lowered);
    if (!isError) {
      elements.errorToast.classList.add("hidden");
      return;
    }

    const shouldShowSettingsAction = /not connected|authorize|token|auth|device|connect spotify/.test(lowered);
    const guidance = shouldShowSettingsAction
      ? `${status} Open Settings and use Connect Spotify.`
      : status;

    elements.errorToastSettingsBtn.classList.toggle("hidden", !shouldShowSettingsAction);
    elements.errorToastText.textContent = guidance;
    elements.errorToast.classList.remove("hidden");
  }

  function renderSuggestions() {
    const query = elements.songInput.value.trim();
    if (!inputHasFocus || !query) {
      elements.suggestions.innerHTML = "";
      elements.suggestions.classList.add("hidden");
      return;
    }

    if (suggestionsLoading) {
      elements.suggestions.innerHTML = "<li class=\"suggestion-empty\">Searching Track Queue suggestions...</li>";
      elements.suggestions.classList.remove("hidden");
      return;
    }

    if (!suggestions.length) {
      elements.suggestions.innerHTML = "<li class=\"suggestion-empty\">No suggestions found. Press + to add this search to Track Queue.</li>";
      elements.suggestions.classList.remove("hidden");
      return;
    }

    elements.suggestions.innerHTML = suggestions
      .map((suggestion, index) => {
        const activeClass = index === highlightedSuggestionIndex ? " suggestion-active" : "";
        const image = suggestion.imageUrl
          ? `<img src="${suggestion.imageUrl}" alt="" class="suggestion-thumb" loading="lazy" />`
          : "<div class=\"suggestion-thumb suggestion-thumb-fallback\" aria-hidden=\"true\"></div>";

        return `<li>
          <button type="button" class="suggestion-item${activeClass}" data-suggestion-index="${index}">
            ${image}
            <span class="suggestion-text">
              <strong>${suggestion.name}</strong>
              <small>${suggestion.artists}${suggestion.albumName ? ` · ${suggestion.albumName}` : ""}</small>
            </span>
          </button>
        </li>`;
      })
      .join("");
  }

  function clearSuggestions() {
    suggestions = [];
    highlightedSuggestionIndex = -1;
    suggestionsLoading = false;
    renderSuggestions();
  }

  async function fetchSuggestions(query) {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      clearSuggestions();
      return;
    }

    const requestId = suggestionRequestId + 1;
    suggestionRequestId = requestId;
    suggestionsLoading = true;
    renderSuggestions();

    try {
      const result = await actions.getTrackSuggestions(normalizedQuery);
      if (requestId !== suggestionRequestId) {
        return;
      }

      if (elements.songInput.value.trim() !== normalizedQuery) {
        return;
      }

      suggestions = result;
      highlightedSuggestionIndex = -1;
      suggestionsLoading = false;
      renderSuggestions();
    } catch {
      if (requestId !== suggestionRequestId) {
        return;
      }

      suggestions = [];
      highlightedSuggestionIndex = -1;
      suggestionsLoading = false;
      renderSuggestions();
    }
  }

  function queueSuggestionFetch(query) {
    if (suggestionTimerId) {
      clearTimeout(suggestionTimerId);
    }

    suggestionTimerId = setTimeout(() => {
      fetchSuggestions(query);
    }, 180);
  }

  function playlistSignature(state) {
    return `${adminUnlocked}|${state.currentTrackIndex}|${state.playlist.map((track) => `${track.uri}:${track.queuedAt || ""}`).join("|")}`;
  }

  function historySignature(state) {
    const played = state.history?.played || [];
    const skipped = state.history?.skipped || [];
    const playedLast = played.length ? (played[played.length - 1].played_at || "") : "";
    const skippedLast = skipped.length ? (skipped[skipped.length - 1].skipped_at || "") : "";
    return `${played.length}:${playedLast}|${skipped.length}:${skippedLast}`;
  }

  function nowPlayingSignature(state) {
    const currentTrack = state.currentTrackIndex >= 0 ? state.playlist[state.currentTrackIndex] : null;
    if (!currentTrack) {
      return "none";
    }
    return `${currentTrack.uri}|${currentTrack.imageUrl || ""}|${currentTrack.albumName || ""}`;
  }

  function devicesSignature(state) {
    const devices = state.playback.availableDevices || [];
    return `${state.settings.connectDeviceId}|${devices.map((d) => `${d.id}:${d.name}:${d.type}`).join("|")}`;
  }

  function controlsSignature(state) {
    return `${adminUnlocked}|${state.playback.isPaused}|${state.settings.connectDeviceId}|${state.playlist.length}|${state.currentTrackIndex}`;
  }

  function toggleAdminControls() {
    if (adminUnlocked) {
      adminUnlocked = false;
      store.setStatus("Admin controls locked.");
      render(store.getState());
      return;
    }

    elements.adminOverlay.classList.remove("hidden");
    elements.adminPasswordInput.value = "";
    elements.adminPasswordInput.focus();
  }

  function closeAdminOverlay() {
    elements.adminOverlay.classList.add("hidden");
    elements.adminPasswordInput.value = "";
  }

  function submitAdminUnlock(event) {
    event.preventDefault();
    const entered = elements.adminPasswordInput.value;

    if (entered !== "blabla") {
      store.setStatus("Wrong admin password.");
      elements.adminPasswordInput.value = "";
      elements.adminPasswordInput.focus();
      return;
    }

    adminUnlocked = true;
    closeAdminOverlay();
    store.setStatus("Admin controls unlocked.");
    render(store.getState());
  }

  function render(state) {
    const crossfadeValue = String(state.settings.crossfadeSeconds);
    if (crossfadeValue !== lastCrossfadeValue) {
      lastCrossfadeValue = crossfadeValue;
      elements.crossfadeInput.value = crossfadeValue;
    }

    const maxQueueLengthValue = String(state.settings.maxQueueLength);
    if (maxQueueLengthValue !== lastMaxQueueLengthValue) {
      lastMaxQueueLengthValue = maxQueueLengthValue;
      elements.maxQueueLengthInput.value = maxQueueLengthValue;
    }

    elements.crossfadePanel.classList.add("hidden");
    elements.devicePanel.classList.remove("hidden");
    elements.status.textContent = "";
    elements.adminToggleBtn.innerHTML = adminUnlocked ? ADMIN_ICONS.unlocked : ADMIN_ICONS.locked;
    elements.adminToggleBtn.setAttribute("aria-label", adminUnlocked ? "Admin controls unlocked" : "Admin controls locked");
    elements.adminToggleBtn.setAttribute("aria-pressed", String(adminUnlocked));

    const currentPlaylistSignature = playlistSignature(state);
    if (currentPlaylistSignature !== lastPlaylistSignature) {
      lastPlaylistSignature = currentPlaylistSignature;
      renderPlaylist(state);
    }

    const currentHistorySignature = historySignature(state);
    if (currentHistorySignature !== lastHistorySignature) {
      lastHistorySignature = currentHistorySignature;
      renderHistory(state);
    }

    const currentNowPlayingSignature = nowPlayingSignature(state);
    if (currentNowPlayingSignature !== lastNowPlayingSignature) {
      lastNowPlayingSignature = currentNowPlayingSignature;
      renderNowPlaying(state);
    }

    renderTimeReadout(state);

    const currentDevicesSignature = devicesSignature(state);
    if (currentDevicesSignature !== lastDevicesSignature) {
      lastDevicesSignature = currentDevicesSignature;
      renderDevices(state);
    }

    const currentControlsSignature = controlsSignature(state);
    if (currentControlsSignature !== lastControlsSignature) {
      lastControlsSignature = currentControlsSignature;
      renderControls(state);
    }

    if (state.status !== lastRenderedStatus) {
      lastRenderedStatus = state.status;
      maybeShowErrorToast(state.status);
    }
  }

  function bindEvents() {
    elements.adminToggleBtn.addEventListener("click", toggleAdminControls);
    elements.adminUnlockForm.addEventListener("submit", submitAdminUnlock);
    elements.adminUnlockCancelBtn.addEventListener("click", closeAdminOverlay);
    elements.adminOverlay.addEventListener("click", (event) => {
      if (event.target === elements.adminOverlay) {
        closeAdminOverlay();
      }
    });
    elements.settingsBtn.addEventListener("click", openSettingsDialog);
    elements.closeSettingsBtn.addEventListener("click", closeSettingsDialog);
    elements.settingsDialog.addEventListener("click", (event) => {
      if (event.target === elements.settingsDialog) {
        closeSettingsDialog();
      }
    });

    elements.connectBtn.addEventListener("click", () => {
      actions.connectSpotify();
    });

    elements.errorToastSettingsBtn.addEventListener("click", () => {
      openSettingsDialog();
    });

    elements.errorToastDismissBtn.addEventListener("click", () => {
      elements.errorToast.classList.add("hidden");
    });

    const onAddSong = async (explicitQuery) => {
      const query = (explicitQuery ?? elements.songInput.value).trim();
      if (!query) {
        store.setStatus("Type a song name first.");
        return;
      }

      try {
        await actions.addTrackByQuery(query);
        elements.songInput.value = "";
        clearSuggestions();
      } catch (error) {
        store.setStatus(`Could not add song: ${error.message}`);
      }
    };

    const onPickSuggestion = async (index) => {
      const suggestion = suggestions[index];
      if (!suggestion) {
        return;
      }

      try {
        await actions.addTrackFromSuggestion(suggestion);
        elements.songInput.value = "";
        clearSuggestions();
      } catch (error) {
        store.setStatus(`Could not add song: ${error.message}`);
      }
    };

    elements.songInput.addEventListener("input", () => {
      inputHasFocus = true;
      queueSuggestionFetch(elements.songInput.value);
    });

    elements.songInput.addEventListener("blur", () => {
      inputHasFocus = false;
      setTimeout(() => {
        renderSuggestions();
      }, 120);
    });

    elements.songInput.addEventListener("focus", () => {
      inputHasFocus = true;
      if (elements.songInput.value.trim()) {
        queueSuggestionFetch(elements.songInput.value);
        return;
      }

      renderSuggestions();
    });

    elements.songInput.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" && suggestions.length) {
        event.preventDefault();
        highlightedSuggestionIndex = Math.min(highlightedSuggestionIndex + 1, suggestions.length - 1);
        renderSuggestions();
        return;
      }

      if (event.key === "ArrowUp" && suggestions.length) {
        event.preventDefault();
        highlightedSuggestionIndex = Math.max(highlightedSuggestionIndex - 1, 0);
        renderSuggestions();
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();

        if (highlightedSuggestionIndex >= 0) {
          onPickSuggestion(highlightedSuggestionIndex);
          return;
        }

        if (suggestions.length) {
          onPickSuggestion(0);
          return;
        }

        onAddSong();
      }

      if (event.key === "Escape") {
        clearSuggestions();
      }
    });

    elements.suggestions.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-suggestion-index]");
      if (!button) {
        return;
      }

      const index = Number(button.dataset.suggestionIndex);
      onPickSuggestion(index);
    });

    elements.playlist.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-remove-index]");
      if (!button) {
        return;
      }

      if (!adminUnlocked) {
        store.setStatus("Admin controls are locked.");
        return;
      }

      const index = Number(button.dataset.removeIndex);
      if (!Number.isInteger(index)) {
        return;
      }

      try {
        await actions.removeTrackAt(index);
      } catch (error) {
        store.setStatus(`Could not remove track: ${error.message}`);
      }
    });

    elements.addBtn.addEventListener("click", onAddSong);

    elements.playPauseBtn.addEventListener("click", async () => {
      if (!adminUnlocked) {
        store.setStatus("Admin controls are locked.");
        return;
      }

      try {
        await actions.togglePlayPause();
      } catch (error) {
        store.setStatus(`Play/Pause failed: ${error.message}`);
      }
    });

    elements.nextBtn.addEventListener("click", async () => {
      if (!adminUnlocked) {
        store.setStatus("Admin controls are locked.");
        return;
      }

      try {
        await actions.playNextTrack();
      } catch (error) {
        store.setStatus(`Skip failed: ${error.message}`);
      }
    });

    elements.clearBtn.addEventListener("click", async () => {
      if (!adminUnlocked) {
        store.setStatus("Admin controls are locked.");
        return;
      }

      try {
        await actions.clearPlaylist();
      } catch (error) {
        store.setStatus(`Clear failed: ${error.message}`);
      }
    });

    elements.exportHistoryBtn.addEventListener("click", () => {
      const payload = actions.exportHistoryJson?.();
      if (!payload) {
        return;
      }

      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `track-queue-history-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    });

    elements.crossfadeInput.addEventListener("change", () => {
      actions.setCrossfadeSeconds(elements.crossfadeInput.value);
    });

    elements.maxQueueLengthInput.addEventListener("change", () => {
      actions.setMaxQueueLength(elements.maxQueueLengthInput.value);
    });

    elements.deviceSelect.addEventListener("change", () => {
      actions.selectConnectDevice(elements.deviceSelect.value);
    });

    elements.refreshDevicesBtn.addEventListener("click", () => {
      actions.refreshDevices();
    });
  }

  bindEvents();
  store.subscribe(render);

  return { render };
}
