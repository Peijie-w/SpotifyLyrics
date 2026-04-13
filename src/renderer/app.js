const lyricsPanelEl = document.getElementById("lyrics-panel");
const overlayCardEl = document.getElementById("overlay-card");
const previousTrackButtonEl = document.getElementById("previous-track");
const togglePlaybackButtonEl = document.getElementById("toggle-playback");
const nextTrackButtonEl = document.getElementById("next-track");
const fontDownButtonEl = document.getElementById("font-down");
const fontUpButtonEl = document.getElementById("font-up");

const FONT_SIZE_STORAGE_KEY = "floating-lyrics-font-size";
const MIN_FONT_SIZE = 20;
const MAX_FONT_SIZE = 64;
const FONT_STEP = 2;
const PLAIN_SEGMENT_MS = 1600;

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
let activeControlAction = "";
let textMeasureCanvas;

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

function saveFontSize() {
  window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(fontSizePx));
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

function renderLine(text, className = "single-line") {
  lyricsPanelEl.innerHTML = `<p class="${className}">${escapeHtml(text)}</p>`;
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

function pickSegmentForSyncedLyric(text, startMs, endMs) {
  const availableWidth = lyricsPanelEl.clientWidth;
  const segments = splitLyricIntoSegments(text, availableWidth);

  if (segments.length <= 1) {
    return segments[0] || text;
  }

  const nowMs = getLivePositionMs();
  const fallbackDuration = segments.length * 1300;
  const totalDuration = Math.max(segments.length * 900, (endMs || startMs + fallbackDuration) - startMs);
  const safeElapsed = Math.max(0, nowMs - startMs);
  const ratio = Math.min(0.999, safeElapsed / totalDuration);
  const segmentIndex = Math.min(segments.length - 1, Math.floor(ratio * segments.length));

  return segments[segmentIndex];
}

function pickSegmentForPlainLyric(text) {
  const availableWidth = lyricsPanelEl.clientWidth;
  const segments = splitLyricIntoSegments(text, availableWidth);

  if (segments.length <= 1) {
    return segments[0] || text;
  }

  const segmentIndex = Math.floor(Date.now() / PLAIN_SEGMENT_MS) % segments.length;
  return segments[segmentIndex];
}

function renderLyrics() {
  const { lyrics, playback } = snapshot;

  if (playback.state === "error") {
    if (playback.errorType === "app-not-found") {
      renderLine("打开 Spotify 后这里会显示歌词", "lyrics-state");
      return;
    }

    if (playback.errorType === "automation-not-authorized") {
      renderLine("允许自动化控制 Spotify 后即可显示歌词", "lyrics-state");
      return;
    }

    renderLine("Spotify 连接后会自动显示歌词", "lyrics-state");
    return;
  }

  if (!playback.running || playback.state === "stopped") {
    renderLine("播放 Spotify 后这里会出现一句歌词", "lyrics-state");
    return;
  }

  if (lyrics.status === "loading") {
    renderLine("正在加载歌词...", "lyrics-state");
    return;
  }

  if (lyrics.status === "error") {
    renderLine("歌词暂时不可用", "lyrics-state");
    return;
  }

  if (lyrics.kind === "synced" && lyrics.lines.length) {
    const activeLine = getActiveSyncedLineMeta(lyrics.lines);
    renderLine(pickSegmentForSyncedLyric(activeLine.text, activeLine.startMs, activeLine.endMs) || "...");
    return;
  }

  if (lyrics.kind === "plain" && lyrics.lines.length) {
    renderLine(pickSegmentForPlainLyric(lyrics.lines[0]?.text || lyrics.lines[0] || "") || "...");
    return;
  }

  renderLine(lyrics.message || "暂时没有这首歌的歌词", "lyrics-state");
}

function updateTransportButton() {
  togglePlaybackButtonEl.textContent = snapshot.playback.state === "playing" ? "❚❚" : "▶";
}

function render() {
  updateTransportButton();
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
      renderLine("Spotify 没有在运行", "lyrics-state");
    }
  } catch (_error) {
    renderLine("Spotify 控制失败", "lyrics-state");
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
