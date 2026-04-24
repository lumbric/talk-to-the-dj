import { formatDuration, playlistDisplayName } from "./utils.js";

export function createUI(store, actions) {
  let suggestionTimerId;
  let suggestionRequestId = 0;
  let suggestions = [];
  let highlightedSuggestionIndex = -1;

  const elements = {
    settingsBtn: document.getElementById("settingsBtn"),
    settingsDialog: document.getElementById("settingsDialog"),
    closeSettingsBtn: document.getElementById("closeSettingsBtn"),
    songInput: document.getElementById("songInput"),
    suggestions: document.getElementById("suggestions"),
    addBtn: document.getElementById("addBtn"),
    playPauseBtn: document.getElementById("playPauseBtn"),
    nextBtn: document.getElementById("nextBtn"),
    clearBtn: document.getElementById("clearBtn"),
    crossfadeInput: document.getElementById("crossfadeInput"),
    crossfadePanel: document.getElementById("crossfadePanel"),
    devicePanel: document.getElementById("devicePanel"),
    deviceSelect: document.getElementById("deviceSelect"),
    modeSDKBtn: document.getElementById("modeSDKBtn"),
    modeConnectBtn: document.getElementById("modeConnectBtn"),
    refreshDevicesBtn: document.getElementById("refreshDevicesBtn"),
    timeReadout: document.getElementById("timeReadout"),
    progressFill: document.getElementById("progressFill"),
    playlist: document.getElementById("playlist"),
    connectBtn: document.getElementById("connectBtn"),
    status: document.getElementById("status"),
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

  function renderPlaylist(state) {
    if (!state.playlist.length) {
      elements.playlist.innerHTML = "<li class=\"playlist-empty\">No songs yet. Search and add one.</li>";
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

        return `<li class="playlist-item${activeClass}">
          <div class="playlist-main">
            ${image}
            <div class="playlist-text">
              <p class="playlist-title">${index + 1}. ${playlistDisplayName(track)}</p>
              <p class="playlist-meta">${meta}</p>
            </div>
          </div>
          <span class="playlist-duration">${formatDuration(track.durationMs)}</span>
        </li>`;
      })
      .join("");
  }

  function renderTimeReadout(state) {
    const safeDuration = Math.max(state.playback.durationMs || 0, 0);
    const safePosition = Math.min(Math.max(state.playback.positionMs || 0, 0), safeDuration || 0);
    const remainingMs = Math.max(safeDuration - safePosition, 0);

    elements.timeReadout.textContent = `Elapsed ${formatDuration(safePosition)} | Remaining -${formatDuration(remainingMs)}`;

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
    const ready = state.settings.playbackMode === "connect"
      ? Boolean(state.settings.connectDeviceId)
      : Boolean(state.playback.sdkDeviceId);

    elements.playPauseBtn.disabled = !ready;
    elements.nextBtn.disabled = !ready || !hasNextTrack;
    elements.clearBtn.disabled = !hasTracks;
    elements.playPauseBtn.textContent = state.playback.isPaused ? "Play" : "Pause";
  }

  function renderSuggestions() {
    if (!suggestions.length) {
      elements.suggestions.innerHTML = "";
      elements.suggestions.classList.add("hidden");
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

    elements.suggestions.classList.remove("hidden");
  }

  function clearSuggestions() {
    suggestions = [];
    highlightedSuggestionIndex = -1;
    renderSuggestions();
  }

  async function fetchSuggestions(query) {
    if (!query.trim()) {
      clearSuggestions();
      return;
    }

    const requestId = suggestionRequestId + 1;
    suggestionRequestId = requestId;

    try {
      const result = await actions.getTrackSuggestions(query.trim());
      if (requestId !== suggestionRequestId) {
        return;
      }

      suggestions = result;
      highlightedSuggestionIndex = -1;
      renderSuggestions();
    } catch {
      clearSuggestions();
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

  function render(state) {
    elements.modeSDKBtn.classList.toggle("mode-active", state.settings.playbackMode === "sdk");
    elements.modeConnectBtn.classList.toggle("mode-active", state.settings.playbackMode === "connect");
    elements.crossfadePanel.classList.toggle("hidden", state.settings.playbackMode === "connect");
    elements.devicePanel.classList.toggle("hidden", state.settings.playbackMode === "sdk");
    elements.crossfadeInput.value = String(state.settings.crossfadeSeconds);
    elements.status.textContent = state.status;

    renderPlaylist(state);
    renderTimeReadout(state);
    renderDevices(state);
    renderControls(state);
  }

  function bindEvents() {
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
      queueSuggestionFetch(elements.songInput.value);
    });

    elements.songInput.addEventListener("blur", () => {
      setTimeout(() => {
        clearSuggestions();
      }, 120);
    });

    elements.songInput.addEventListener("focus", () => {
      if (elements.songInput.value.trim()) {
        queueSuggestionFetch(elements.songInput.value);
      }
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

    elements.addBtn.addEventListener("click", onAddSong);

    elements.playPauseBtn.addEventListener("click", async () => {
      try {
        await actions.togglePlayPause();
      } catch (error) {
        store.setStatus(`Play/Pause failed: ${error.message}`);
      }
    });

    elements.nextBtn.addEventListener("click", async () => {
      try {
        await actions.playNextTrack();
      } catch (error) {
        store.setStatus(`Skip failed: ${error.message}`);
      }
    });

    elements.clearBtn.addEventListener("click", async () => {
      try {
        await actions.clearPlaylist();
      } catch (error) {
        store.setStatus(`Clear failed: ${error.message}`);
      }
    });

    elements.crossfadeInput.addEventListener("change", () => {
      actions.setCrossfadeSeconds(elements.crossfadeInput.value);
    });

    elements.modeSDKBtn.addEventListener("click", () => {
      actions.setMode("sdk");
    });

    elements.modeConnectBtn.addEventListener("click", () => {
      actions.setMode("connect");
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
