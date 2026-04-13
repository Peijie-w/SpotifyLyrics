const lyricsPanelEl = document.getElementById("lyrics-panel");
const overlayCardEl = document.getElementById("overlay-card");
const previousTrackButtonEl = document.getElementById("previous-track");
const togglePlaybackButtonEl = document.getElementById("toggle-playback");
const nextTrackButtonEl = document.getElementById("next-track");
const fontDownButtonEl = document.getElementById("font-down");
const fontUpButtonEl = document.getElementById("font-up");
const toggleTranslationButtonEl = document.getElementById("toggle-translation");
const translationLanguageSelectEl = document.getElementById("translation-language");

const FONT_SIZE_STORAGE_KEY = "floating-lyrics-font-size";
const TRANSLATION_ENABLED_STORAGE_KEY = "floating-lyrics-translation-enabled";
const TRANSLATION_LANGUAGE_STORAGE_KEY = "floating-lyrics-translation-language";
const MIN_FONT_SIZE = 20;
const MAX_FONT_SIZE = 64;
const FONT_STEP = 2;
const PLAIN_SEGMENT_MS = 1600;
const TRANSLATION_LANGUAGES = [
  { code: "zh-CN", label: "中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" }
];

let snapshot = {
  playback: {
    running: false,
    state: "stopped",
    title: "",
    artist: "",
    album: "",
    durationMs: 0,
    positionMs: 0
  },
  lyrics: {
    status: "idle",
    kind: "none",
    lines: []
  },
  fetchedAt: Date.now()
};

let fontSizePx = loadFontSize();
let translationEnabled = loadTranslationEnabled();
let translationLanguage = loadTranslationLanguage();
let activeControlAction = "";
let textMeasureCanvas;
const translationPreparationInFlight = new Set();

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function loadFontSize() {
  const storedValue = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);
  const parsedValue = Number(storedValue);

  if (Number.isFinite(parsedValue) && parsedValue >= MIN_FONT_SIZE && parsedValue <= MAX_FONT_SIZE) {
    return parsedValue;
  }

  return 30;
}

function loadTranslationEnabled() {
  return window.localStorage.getItem(TRANSLATION_ENABLED_STORAGE_KEY) === "true";
}

function loadTranslationLanguage() {
  const stored = window.localStorage.getItem(TRANSLATION_LANGUAGE_STORAGE_KEY);
  if (TRANSLATION_LANGUAGES.some((item) => item.code === stored)) {
    return stored;
  }

  return "zh-CN";
}

function saveFontSize() {
  window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(fontSizePx));
}

function saveTranslationEnabled() {
  window.localStorage.setItem(TRANSLATION_ENABLED_STORAGE_KEY, String(translationEnabled));
}

function saveTranslationLanguage() {
  window.localStorage.setItem(TRANSLATION_LANGUAGE_STORAGE_KEY, translationLanguage);
}

function applyFontSize() {
  document.documentElement.style.setProperty("--lyrics-font-size", `${fontSizePx}px`);
}

function adjustFontSize(delta) {
  fontSizePx = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, fontSizePx + delta));
  applyFontSize();
  saveFontSize();
  renderLyrics();
}

function getMeasureContext() {
  if (!textMeasureCanvas) {
    textMeasureCanvas = document.createElement("canvas");
  }

  const context = textMeasureCanvas.getContext("2d");
  const bodyStyles = window.getComputedStyle(document.body);
  context.font = `700 ${fontSizePx}px ${bodyStyles.fontFamily}`;

  return context;
}

function measureTextWidth(text) {
  return getMeasureContext().measureText(text).width;
}

function splitLyricIntoSegments(text, maxWidth) {
  const normalizedText = String(text || "").replace(/\s+/g, " ").trim();

  if (!normalizedText || !maxWidth || measureTextWidth(normalizedText) <= maxWidth) {
    return [normalizedText];
  }

  const characters = Array.from(normalizedText);
  const breakChars = new Set([" ", "-", "/", "|", ",", ".", "!", "?", "，", "。", "！", "？", "、", "；", "："]);
  const segments = [];
  let start = 0;

  while (start < characters.length) {
    let end = start;
    let lastBreak = -1;

    while (end < characters.length) {
      const candidate = characters.slice(start, end + 1).join("").trim();
      if (measureTextWidth(candidate) > maxWidth) {
        break;
      }

      if (breakChars.has(characters[end])) {
        lastBreak = end;
      }

      end += 1;
    }

    if (end >= characters.length) {
      segments.push(characters.slice(start).join("").trim());
      break;
    }

    let splitIndex = lastBreak >= start + 2 ? lastBreak + 1 : end;
    if (splitIndex <= start) {
      splitIndex = start + 1;
    }

    segments.push(characters.slice(start, splitIndex).join("").trim());
    start = splitIndex;

    while (start < characters.length && characters[start] === " ") {
      start += 1;
    }
  }

  return segments.filter(Boolean);
}

function getLivePositionMs() {
  const base = snapshot.playback.positionMs || 0;
  if (snapshot.playback.state !== "playing") {
    return base;
  }

  const elapsed = Date.now() - snapshot.fetchedAt;
  return Math.min(snapshot.playback.durationMs || base, base + elapsed);
}

function renderLyricStack(text, translationText = "", translationLoading = false) {
  const translationMarkup = translationEnabled
    ? `<p class="translation-line${translationLoading ? " is-loading" : ""}">${escapeHtml(
        translationLoading ? "Translating..." : translationText
      )}</p>`
    : "";

  lyricsPanelEl.innerHTML = `
    <div class="lyrics-stack">
      <p class="single-line">${escapeHtml(text)}</p>
      ${translationMarkup}
    </div>
  `;
}

function getCurrentTranslationLanguageMeta() {
  return (
    TRANSLATION_LANGUAGES.find((item) => item.code === translationLanguage) || TRANSLATION_LANGUAGES[0]
  );
}

function renderStateLine(text) {
  lyricsPanelEl.innerHTML = `<p class="lyrics-state">${escapeHtml(text)}</p>`;
}

function setControlsDisabled(disabled) {
  previousTrackButtonEl.disabled = disabled;
  togglePlaybackButtonEl.disabled = disabled;
  nextTrackButtonEl.disabled = disabled;
}

function getActiveSyncedLineMeta(lines) {
  const positionMs = getLivePositionMs();
  let activeIndex = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].timeMs <= positionMs) {
      activeIndex = index;
    } else {
      break;
    }
  }

  return {
    text: lines[activeIndex]?.text || "",
    startMs: lines[activeIndex]?.timeMs || 0,
    endMs: lines[activeIndex + 1]?.timeMs || null
  };
}

function getSegments(text) {
  return splitLyricIntoSegments(text, lyricsPanelEl.clientWidth);
}

function getSyncedSegmentMeta(text, startMs, endMs) {
  const segments = getSegments(text);

  if (segments.length <= 1) {
    return {
      text: segments[0] || text,
      index: 0,
      total: 1
    };
  }

  const nowMs = getLivePositionMs();
  const fallbackDuration = segments.length * 1300;
  const totalDuration = Math.max(segments.length * 900, (endMs || startMs + fallbackDuration) - startMs);
  const safeElapsed = Math.max(0, nowMs - startMs);
  const ratio = Math.min(0.999, safeElapsed / totalDuration);
  const segmentIndex = Math.min(segments.length - 1, Math.floor(ratio * segments.length));

  return {
    text: segments[segmentIndex],
    index: segmentIndex,
    total: segments.length
  };
}

function getPlainSegmentMeta(text) {
  const segments = getSegments(text);

  if (segments.length <= 1) {
    return {
      text: segments[0] || text,
      index: 0,
      total: 1
    };
  }

  const segmentIndex = Math.floor(Date.now() / PLAIN_SEGMENT_MS) % segments.length;
  return {
    text: segments[segmentIndex],
    index: segmentIndex,
    total: segments.length
  };
}

function getTranslationSegment(fullTranslation, index, total) {
  const segments = getSegments(fullTranslation);

  if (segments.length <= 1) {
    return segments[0] || fullTranslation;
  }

  const mappedIndex = total > 1 ? Math.min(segments.length - 1, Math.floor((index / total) * segments.length)) : index;
  return segments[Math.min(segments.length - 1, mappedIndex)] || segments[0] || fullTranslation;
}

function getTrackLanguageKey() {
  return `${snapshot.playback.artist || ""}::${snapshot.playback.title || ""}::${translationLanguage}`;
}

function requestCurrentLanguagePreparation() {
  if (!translationEnabled || snapshot.lyrics.status !== "ready") {
    return;
  }

  const status = snapshot.lyrics.translationStatusByLanguage?.[translationLanguage];
  const trackLanguageKey = getTrackLanguageKey();

  if (!trackLanguageKey.trim() || status === "ready" || status === "loading" || translationPreparationInFlight.has(trackLanguageKey)) {
    return;
  }

  translationPreparationInFlight.add(trackLanguageKey);

  window.floatingLyrics
    .prepareTranslation(translationLanguage)
    .catch(() => {})
    .finally(() => {
      window.setTimeout(() => {
        translationPreparationInFlight.delete(trackLanguageKey);
      }, 300);
    });
}

function renderLyrics() {
  const { lyrics, playback } = snapshot;

  if (playback.state === "error") {
    if (playback.errorType === "app-not-found") {
      renderStateLine("Open Spotify to show lyrics");
      return;
    }

    if (playback.errorType === "automation-not-authorized") {
      renderStateLine("Allow Automation access to Spotify to enable lyrics");
      return;
    }

    renderStateLine("Lyrics will appear after Spotify connects");
    return;
  }

  if (!playback.running || playback.state === "stopped") {
    renderStateLine("Play Spotify and a lyric line will appear here");
    return;
  }

  if (lyrics.status === "loading") {
    renderStateLine("Loading lyrics...");
    return;
  }

  if (lyrics.status === "error") {
    renderStateLine("Lyrics are temporarily unavailable");
    return;
  }

  if (lyrics.kind === "synced" && lyrics.lines.length) {
    const activeLine = getActiveSyncedLineMeta(lyrics.lines);
    const segmentMeta = getSyncedSegmentMeta(activeLine.text, activeLine.startMs, activeLine.endMs);
    const fullTranslation = lyrics.translationsByLanguage?.[translationLanguage]?.[activeLine.text] || "";
    const translationStatus = lyrics.translationStatusByLanguage?.[translationLanguage] || "idle";
    const translationText = fullTranslation
      ? getTranslationSegment(fullTranslation, segmentMeta.index, segmentMeta.total)
      : "";
    renderLyricStack(
      segmentMeta.text || "...",
      translationText,
      translationEnabled && translationStatus === "loading" && !fullTranslation
    );
    requestCurrentLanguagePreparation();
    return;
  }

  if (lyrics.kind === "plain" && lyrics.lines.length) {
    const fullText = lyrics.lines[0]?.text || lyrics.lines[0] || "";
    const segmentMeta = getPlainSegmentMeta(fullText);
    const fullTranslation = lyrics.translationsByLanguage?.[translationLanguage]?.[fullText] || "";
    const translationStatus = lyrics.translationStatusByLanguage?.[translationLanguage] || "idle";
    const translationText = fullTranslation
      ? getTranslationSegment(fullTranslation, segmentMeta.index, segmentMeta.total)
      : "";
    renderLyricStack(
      segmentMeta.text || "...",
      translationText,
      translationEnabled && translationStatus === "loading" && !fullTranslation
    );
    requestCurrentLanguagePreparation();
    return;
  }

  renderStateLine(lyrics.message || "No lyrics found for this track");
}

function updateTransportButton() {
  togglePlaybackButtonEl.textContent = snapshot.playback.state === "playing" ? "❚❚" : "▶";
}

function updateTranslationButton() {
  toggleTranslationButtonEl.classList.toggle("is-active", translationEnabled);
}

function updateTranslationLanguageControl() {
  translationLanguageSelectEl.value = translationLanguage;
  translationLanguageSelectEl.disabled = false;
}

function render() {
  updateTransportButton();
  updateTranslationButton();
  updateTranslationLanguageControl();
  renderLyrics();
}

async function sendPlayerControl(action) {
  if (activeControlAction) {
    return;
  }

  activeControlAction = action;
  setControlsDisabled(true);

  if (action === "toggle") {
    snapshot.playback.state = snapshot.playback.state === "playing" ? "paused" : "playing";
    updateTransportButton();
  }

  try {
    const result = await window.floatingLyrics.controlPlayer(action);

    if (result?.ok === false) {
      renderStateLine("Spotify is not running");
    }
  } catch (_error) {
    renderStateLine("Spotify control failed");
  } finally {
    window.setTimeout(() => {
      activeControlAction = "";
      setControlsDisabled(false);
    }, 180);
  }
}

function bindControl(button, handler) {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    handler();
  });
}

window.floatingLyrics.onStateChange((nextSnapshot) => {
  snapshot = nextSnapshot;
  render();
});

bindControl(previousTrackButtonEl, () => {
  sendPlayerControl("previous");
});

bindControl(togglePlaybackButtonEl, () => {
  sendPlayerControl("toggle");
});

bindControl(nextTrackButtonEl, () => {
  sendPlayerControl("next");
});

bindControl(fontDownButtonEl, () => {
  adjustFontSize(-FONT_STEP);
});

bindControl(fontUpButtonEl, () => {
  adjustFontSize(FONT_STEP);
});

bindControl(toggleTranslationButtonEl, () => {
  translationEnabled = !translationEnabled;
  saveTranslationEnabled();
  render();
});

translationLanguageSelectEl.addEventListener("pointerdown", (event) => {
  event.stopPropagation();
});

translationLanguageSelectEl.addEventListener("click", (event) => {
  event.stopPropagation();
});

translationLanguageSelectEl.addEventListener("change", () => {
  translationLanguage = translationLanguageSelectEl.value;
  saveTranslationLanguage();
  render();
});

overlayCardEl.addEventListener(
  "wheel",
  (event) => {
    if (Math.abs(event.deltaY) < 2) {
      return;
    }

    event.preventDefault();
    adjustFontSize(event.deltaY > 0 ? -FONT_STEP : FONT_STEP);
  },
  { passive: false }
);

window.addEventListener("resize", () => {
  renderLyrics();
});

applyFontSize();

setInterval(() => {
  if (snapshot.playback.state === "playing") {
    renderLyrics();
  }
}, 250);

render();
