const path = require("path");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const WINDOWS_BRIDGE_SCRIPT = path.join(__dirname, "..", "scripts", "windows_spotify_bridge.ps1");
const POLL_INTERVAL_MS = 500;
const STATE_CHANNEL = "lyrics:state";
const PLAYER_CONTROL_CHANNEL = "spotify:player-control";
const PREPARE_TRANSLATION_CHANNEL = "lyrics:prepare-translation";
const OPENAI_TRANSLATION_MODEL = process.env.OPENAI_TRANSLATION_MODEL || "gpt-4.1-mini";

let mainWindow;
let pollTimer;
let latestSnapshot = createEmptySnapshot();
let cachedTrackKey = "";
let cachedLyrics = createLyricsState("idle");
let refreshBurstTimers = [];
const translationCache = new Map();
const translationInFlight = new Map();

function createEmptySnapshot() {
  return {
    playback: {
      running: false,
      state: "stopped",
      title: "",
      artist: "",
      album: "",
      durationMs: 0,
      positionMs: 0
    },
    lyrics: createLyricsState("idle"),
    fetchedAt: Date.now()
  };
}

function createLyricsState(status, extra = {}) {
  return {
    status,
    kind: "none",
    source: "",
    lines: [],
    plainText: "",
    message: "",
    translationStatusByLanguage: {},
    translationsByLanguage: {},
    ...extra
  };
}

function detectSourceLanguage(text) {
  if (/[\u4e00-\u9fff]/.test(text)) {
    return "zh-CN";
  }

  if (/[\u3040-\u30ff]/.test(text)) {
    return "ja";
  }

  if (/[\uac00-\ud7af]/.test(text)) {
    return "ko";
  }

  if (/[\u0400-\u04ff]/.test(text)) {
    return "ru";
  }

  return "en";
}

function normalizeText(input) {
  return (input || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getTrackKey(playback) {
  return `${normalizeText(playback.artist)}::${normalizeText(playback.title)}`;
}

function scoreCandidate(candidate, playback) {
  const normalizedTitle = normalizeText(playback.title);
  const normalizedArtist = normalizeText(playback.artist);
  const candidateTitle = normalizeText(candidate.trackName);
  const candidateArtist = normalizeText(candidate.artistName);

  let score = 0;

  if (candidateTitle === normalizedTitle) {
    score += 5;
  } else if (candidateTitle.includes(normalizedTitle) || normalizedTitle.includes(candidateTitle)) {
    score += 2;
  }

  if (candidateArtist === normalizedArtist) {
    score += 5;
  } else if (candidateArtist.includes(normalizedArtist) || normalizedArtist.includes(candidateArtist)) {
    score += 2;
  }

  if (candidate.syncedLyrics) {
    score += 4;
  }

  return score;
}

function parseLrc(lrcText) {
  const lines = [];
  const rawLines = (lrcText || "").split(/\r?\n/);

  for (const rawLine of rawLines) {
    const matches = [...rawLine.matchAll(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const lyricText = rawLine.replace(/\[[^\]]+\]/g, "").trim();

    if (!matches.length || !lyricText) {
      continue;
    }

    for (const match of matches) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fractionRaw = match[3] || "0";
      const fractionMs = Number(fractionRaw.padEnd(3, "0"));

      lines.push({
        timeMs: minutes * 60_000 + seconds * 1_000 + fractionMs,
        text: lyricText
      });
    }
  }

  return lines.sort((left, right) => left.timeMs - right.timeMs);
}

function parsePlainLyrics(text) {
  return (text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function runSpotifyJxa(scriptBody) {
  const jxaScript = `
    const spotify = Application("Spotify");
    ${scriptBody}
  `;

  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", jxaScript], {
    timeout: 5000
  });

  return JSON.parse(stdout.trim());
}

async function runWindowsSpotifyBridge(args) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WINDOWS_BRIDGE_SCRIPT, ...args],
    {
      timeout: 7000
    }
  );

  return JSON.parse(stdout.trim());
}

async function getSpotifyPlayback() {
  if (process.platform === "win32") {
    try {
      return await runWindowsSpotifyBridge(["-Mode", "status"]);
    } catch (error) {
      return {
        running: false,
        state: "error",
        title: "",
        artist: "",
        album: "",
        durationMs: 0,
        positionMs: 0,
        error: error.message || "",
        errorType: "windows-media-session-failed"
      };
    }
  }

  if (process.platform !== "darwin") {
    return {
      running: false,
      state: "error",
      title: "",
      artist: "",
      album: "",
      durationMs: 0,
      positionMs: 0,
      error: `Unsupported platform: ${process.platform}`,
      errorType: "unsupported-platform"
    };
  }

  try {
    return await runSpotifyJxa(`
      if (!spotify.running()) {
        JSON.stringify({ running: false, state: "stopped" });
      } else {
        const state = spotify.playerState().toString();
        if (state === "stopped") {
          JSON.stringify({ running: true, state: "stopped" });
        } else {
          const track = spotify.currentTrack();
          JSON.stringify({
            running: true,
            state,
            title: track.name(),
            artist: track.artist(),
            album: track.album(),
            durationMs: track.duration(),
            positionMs: Math.round(spotify.playerPosition() * 1000)
          });
        }
      }
    `);
  } catch (error) {
    const message = error.message || "";
    let errorType = "unknown";

    if (/application can't be found/i.test(message)) {
      errorType = "app-not-found";
    } else if (/\(-1743\)|not authorized|not authorised/i.test(message)) {
      errorType = "automation-not-authorized";
    }

    return {
      running: false,
      state: "error",
      title: "",
      artist: "",
      album: "",
      durationMs: 0,
      positionMs: 0,
      error: message,
      errorType
    };
  }
}

async function controlSpotify(action) {
  if (process.platform === "win32") {
    return runWindowsSpotifyBridge(["-Mode", "control", "-Action", action]);
  }

  if (process.platform !== "darwin") {
    return {
      ok: false,
      reason: "unsupported-platform"
    };
  }

  const actionMap = {
    previous: "previousTrack",
    next: "nextTrack",
    toggle: "playpause"
  };
  const command = actionMap[action];

  if (!command) {
    throw new Error(`Unsupported action: ${action}`);
  }

  return runSpotifyJxa(`
    if (!spotify.running()) {
      JSON.stringify({ ok: false, reason: "not-running" });
    } else {
      spotify.${command}();
      JSON.stringify({ ok: true });
    }
  `);
}

function extractOpenAIResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const outputs = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of outputs) {
    const contents = Array.isArray(item?.content) ? item.content : [];
    for (const content of contents) {
      if (content?.type === "output_text" && typeof content.text === "string" && content.text.trim()) {
        return content.text.trim();
      }
    }
  }

  return "";
}

async function translateLyricLineWithOpenAI(text, sourceLanguage) {
  return translateLyricLineWithOpenAIToLanguage(text, sourceLanguage, "zh-CN");
}

function getTargetLanguageLabel(targetLanguage) {
  const labels = {
    "zh-CN": "Simplified Chinese",
    en: "English",
    ja: "Japanese",
    ko: "Korean",
    es: "Spanish",
    fr: "French"
  };

  return labels[targetLanguage] || targetLanguage;
}

async function translateLyricLineWithOpenAIToLanguage(text, sourceLanguage, targetLanguage) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_TRANSLATION_MODEL,
      input: [
        {
          role: "developer",
          content:
            `You translate song lyrics into natural, elegant ${getTargetLanguageLabel(targetLanguage)}. Preserve mood, imagery, and singable flow. Prefer graceful sense-for-sense translation over literal word-for-word translation. Keep it concise. Output only the translated lyric line with no quotes and no explanation.`
        },
        {
          role: "user",
          content: `Source language: ${sourceLanguage}\nTarget language: ${targetLanguage}\nLyric line:\n${text}`
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI translation failed with ${response.status}`);
  }

  const payload = await response.json();
  return extractOpenAIResponseText(payload);
}

async function translateLyricsBatchWithOpenAI(lines, sourceLanguage, targetLanguage) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_TRANSLATION_MODEL,
      input: [
        {
          role: "developer",
          content:
            `Translate song lyric lines into natural, elegant ${getTargetLanguageLabel(targetLanguage)}. Preserve mood and imagery. Return strict JSON only in this shape: {"translations":[{"source":"...","target":"..."}]}. Keep the same number and order of items as the input lines.`
        },
        {
          role: "user",
          content: JSON.stringify({
            sourceLanguage,
            targetLanguage,
            lines
          })
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI batch translation failed with ${response.status}`);
  }

  const payload = await response.json();
  const rawText = extractOpenAIResponseText(payload);
  const parsed = JSON.parse(rawText);
  const items = Array.isArray(parsed?.translations) ? parsed.translations : [];
  const result = new Map();

  for (const item of items) {
    const source = String(item?.source || "").trim();
    const target = String(item?.target || "").trim();

    if (source && target) {
      result.set(source, target);
    }
  }

  return result;
}

async function translateLyricLineWithMyMemory(text, sourceLanguage, targetLanguage) {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", `${sourceLanguage}|${targetLanguage}`);
  url.searchParams.set("mt", "1");

  const response = await fetch(url, {
    headers: {
      "User-Agent": "spotify-floating-lyrics/0.1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Translation request failed with ${response.status}`);
  }

  const payload = await response.json();
  return payload?.responseData?.translatedText?.trim() || "";
}

async function translateLyricLine(text, targetLanguage = "zh-CN") {
  const normalizedText = String(text || "").replace(/\s+/g, " ").trim();

  if (!normalizedText) {
    return "";
  }

  const sourceLanguage = detectSourceLanguage(normalizedText);
  if (sourceLanguage === targetLanguage) {
    return normalizedText;
  }

  const cacheKey = `${sourceLanguage}|${targetLanguage}|${normalizedText}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  if (translationInFlight.has(cacheKey)) {
    return translationInFlight.get(cacheKey);
  }

  const task = (async () => {
    let translatedText = "";

    if (process.env.OPENAI_API_KEY) {
      try {
        translatedText = await translateLyricLineWithOpenAIToLanguage(normalizedText, sourceLanguage, targetLanguage);
      } catch (_error) {
        translatedText = "";
      }
    }

    if (!translatedText) {
      translatedText = await translateLyricLineWithMyMemory(normalizedText, sourceLanguage, targetLanguage);
    }

    const cleanedTranslation = String(translatedText || "").trim();
    const finalText =
      cleanedTranslation && cleanedTranslation !== normalizedText ? cleanedTranslation : "";

    translationCache.set(cacheKey, finalText);
    return finalText;
  })();

  translationInFlight.set(cacheKey, task);

  try {
    return await task;
  } finally {
    translationInFlight.delete(cacheKey);
  }
}

function getUniqueLyricLinesForTranslation(lyrics, targetLanguage) {
  const uniqueLines = new Set();

  for (const line of lyrics?.lines || []) {
    const text = String(line?.text || line || "").trim();
    if (!text) {
      continue;
    }

    const sourceLanguage = detectSourceLanguage(text);
    if (sourceLanguage === targetLanguage) {
      continue;
    }

    uniqueLines.add(text);
  }

  return [...uniqueLines];
}

async function translateLyricsCollection(lyrics, targetLanguage) {
  const lines = getUniqueLyricLinesForTranslation(lyrics, targetLanguage);
  if (!lines.length) {
    return {};
  }

  const sourceLanguage = detectSourceLanguage(lines[0]);
  const translations = {};

  if (process.env.OPENAI_API_KEY) {
    try {
      const batchResult = await translateLyricsBatchWithOpenAI(lines, sourceLanguage, targetLanguage);

      for (const line of lines) {
        const translated = batchResult.get(line);
        translations[line] = translated && translated !== line ? translated : "";
      }

      return translations;
    } catch (_error) {
      // Fall back to per-line translation below.
    }
  }

  const settledResults = await Promise.allSettled(lines.map((line) => translateLyricLine(line, targetLanguage)));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const result = settledResults[index];
    translations[line] = result.status === "fulfilled" && result.value ? result.value : "";
  }

  return translations;
}

async function pretranslateLyricsForCurrentTrack(trackKey, lyrics, targetLanguage = "zh-CN") {
  if (!trackKey || trackKey !== cachedTrackKey || lyrics.status !== "ready") {
    return;
  }

  const translatableLines = getUniqueLyricLinesForTranslation(lyrics, targetLanguage);
  if (!translatableLines.length) {
    cachedLyrics = {
      ...lyrics,
      translationStatusByLanguage: {
        ...(lyrics.translationStatusByLanguage || {}),
        [targetLanguage]: "ready"
      },
      translationsByLanguage: {
        ...(lyrics.translationsByLanguage || {}),
        [targetLanguage]: {}
      }
    };
    if (trackKey === cachedTrackKey) {
      broadcastState();
    }
    return;
  }

  cachedLyrics = {
    ...lyrics,
    translationStatusByLanguage: {
      ...(lyrics.translationStatusByLanguage || {}),
      [targetLanguage]: "loading"
    },
    translationsByLanguage: {
      ...(lyrics.translationsByLanguage || {}),
      [targetLanguage]: lyrics.translationsByLanguage?.[targetLanguage] || {}
    }
  };
  if (trackKey === cachedTrackKey) {
    broadcastState();
  }

  try {
    const translations = await translateLyricsCollection(lyrics, targetLanguage);

    if (trackKey !== cachedTrackKey) {
      return;
    }

    cachedLyrics = {
      ...cachedLyrics,
      translationStatusByLanguage: {
        ...(cachedLyrics.translationStatusByLanguage || {}),
        [targetLanguage]: "ready"
      },
      translationsByLanguage: {
        ...(cachedLyrics.translationsByLanguage || {}),
        [targetLanguage]: translations
      }
    };
  } catch (_error) {
    if (trackKey !== cachedTrackKey) {
      return;
    }

    cachedLyrics = {
      ...cachedLyrics,
      translationStatusByLanguage: {
        ...(cachedLyrics.translationStatusByLanguage || {}),
        [targetLanguage]: "error"
      },
      translationsByLanguage: {
        ...(cachedLyrics.translationsByLanguage || {}),
        [targetLanguage]: {}
      }
    };
  }

  if (trackKey === cachedTrackKey) {
    broadcastState();
  }
}

async function searchLyrics(playback) {
  if (!playback.title || !playback.artist) {
    return createLyricsState("idle");
  }

  const searchUrl = new URL("https://lrclib.net/api/search");
  searchUrl.searchParams.set("track_name", playback.title);
  searchUrl.searchParams.set("artist_name", playback.artist);

  const response = await fetch(searchUrl, {
    headers: {
      "User-Agent": "spotify-floating-lyrics/0.1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Lyrics search failed with ${response.status}`);
  }

  const results = await response.json();

  if (!Array.isArray(results) || !results.length) {
    return createLyricsState("empty", {
      message: "没有找到对应歌词。"
    });
  }

  const bestMatch = [...results].sort((left, right) => {
    return scoreCandidate(right, playback) - scoreCandidate(left, playback);
  })[0];

  if (bestMatch?.syncedLyrics) {
    const lines = parseLrc(bestMatch.syncedLyrics);

    if (lines.length) {
      return createLyricsState("ready", {
        kind: "synced",
        source: "lrclib",
        lines
      });
    }
  }

  const plainLines = parsePlainLyrics(bestMatch?.plainLyrics);
  if (plainLines.length) {
    return createLyricsState("ready", {
      kind: "plain",
      source: "lrclib",
      plainText: plainLines.join("\n"),
      lines: plainLines.map((text, index) => ({
        id: `${index}-${text}`,
        text
      }))
    });
  }

  return createLyricsState("empty", {
    message: "找到了歌曲，但歌词内容为空。"
  });
}

async function getLyricsForPlayback(playback) {
  const nextTrackKey = getTrackKey(playback);

  if (!nextTrackKey) {
    cachedTrackKey = "";
    cachedLyrics = createLyricsState("idle");
    return cachedLyrics;
  }

  if (nextTrackKey === cachedTrackKey) {
    return cachedLyrics;
  }

  cachedTrackKey = nextTrackKey;
  cachedLyrics = createLyricsState("loading", {
    message: "正在搜索歌词..."
  });
  broadcastState();

  try {
    cachedLyrics = await searchLyrics(playback);
    const readyLyrics = cachedLyrics;
    const trackKeyForTranslation = nextTrackKey;
    void pretranslateLyricsForCurrentTrack(trackKeyForTranslation, readyLyrics, "zh-CN");
  } catch (error) {
    cachedLyrics = createLyricsState("error", {
      message: "歌词服务暂时不可用。",
      error: error.message
    });
  }

  return cachedLyrics;
}

function computeWindowBounds() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const width = 980;
  const height = 206;

  return {
    width,
    height,
    x: Math.round((workAreaSize.width - width) / 2),
    y: Math.max(40, workAreaSize.height - height - 120)
  };
}

function createWindow() {
  const bounds = computeWindowBounds();

  mainWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    fullscreenable: false,
    minimizable: true,
    maximizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true
  });
  mainWindow.webContents.on("did-finish-load", () => {
    broadcastState();
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  latestSnapshot = {
    ...latestSnapshot,
    fetchedAt: Date.now()
  };

  mainWindow.webContents.send(STATE_CHANNEL, latestSnapshot);
}

function clearRefreshBurst() {
  for (const timer of refreshBurstTimers) {
    clearTimeout(timer);
  }
  refreshBurstTimers = [];
}

async function refreshState() {
  const playbackBeforeFetch = await getSpotifyPlayback();
  const refreshStartedAt = Date.now();
  const lyrics = await getLyricsForPlayback(playbackBeforeFetch);
  let playback = playbackBeforeFetch;

  // If lyrics fetching took noticeable time, resample playback so the first shown
  // lyric line is aligned with the current song position instead of an older snapshot.
  if (Date.now() - refreshStartedAt > 250) {
    const playbackAfterFetch = await getSpotifyPlayback();

    if (getTrackKey(playbackAfterFetch) === getTrackKey(playbackBeforeFetch)) {
      playback = playbackAfterFetch;
    }
  }

  latestSnapshot = {
    ...latestSnapshot,
    playback,
    lyrics
  };

  broadcastState();
}

function scheduleRefreshBurst() {
  clearRefreshBurst();

  const delays = [0, 140, 420, 900];
  refreshBurstTimers = delays.map((delay) => {
    return setTimeout(() => {
      refreshState();
    }, delay);
  });
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }

  scheduleRefreshBurst();
  pollTimer = setInterval(refreshState, POLL_INTERVAL_MS);
}

ipcMain.handle(PLAYER_CONTROL_CHANNEL, async (_event, action) => {
  const result = await controlSpotify(action);
  scheduleRefreshBurst();

  return result;
});

ipcMain.handle(PREPARE_TRANSLATION_CHANNEL, async (_event, targetLanguage) => {
  const language = String(targetLanguage || "zh-CN").trim() || "zh-CN";

  if (cachedLyrics.status !== "ready" || !cachedTrackKey) {
    return { ok: false, reason: "lyrics-not-ready" };
  }

  const status = cachedLyrics.translationStatusByLanguage?.[language];
  if (status === "ready" || status === "loading") {
    return { ok: true, status };
  }

  void pretranslateLyricsForCurrentTrack(cachedTrackKey, cachedLyrics, language);
  return { ok: true, status: "loading" };
});

app.whenReady().then(() => {
  createWindow();
  startPolling();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      startPolling();
    }
  });
});

app.on("window-all-closed", () => {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  clearRefreshBurst();
  app.quit();
});
