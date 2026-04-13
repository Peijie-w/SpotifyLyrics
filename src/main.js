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
const APP_QUIT_CHANNEL = "app:quit";
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
    translationErrorByLanguage: {},
    translationsByLanguage: {},
    ...extra
  };
}

async function parseJsonSafely(response) {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

async function createTranslationResponseError(scope, response) {
  const payload = await parseJsonSafely(response);
  const apiError = payload?.error || {};
  const error = new Error(
    apiError.message || `${scope} translation failed with ${response.status}`
  );

  error.translationScope = scope;
  error.translationStatus = response.status;
  error.translationCode = apiError.code || "";
  error.translationType = apiError.type || "";

  return error;
}

function getUserFacingTranslationError(error) {
  const code = String(error?.translationCode || error?.code || "").toLowerCase();
  const status = Number(error?.translationStatus || error?.status || 0);

  if (code === "insufficient_quota") {
    return "OpenAI quota exceeded";
  }

  if (code === "invalid_api_key" || status === 401) {
    return "Invalid OpenAI API key";
  }

  if (code === "model_not_found") {
    return "OpenAI model unavailable";
  }

  if (status === 429) {
    return "OpenAI rate limit reached";
  }

  if (code === "mymemory_unavailable") {
    return "Fallback translation limit reached";
  }

  if (code === "google_fallback_failed") {
    return "Fallback translation unavailable";
  }

  return "Translation service error";
}

function shouldUseSimpleTranslationFallback(error) {
  const code = String(error?.translationCode || error?.code || "").toLowerCase();
  const status = Number(error?.translationStatus || error?.status || 0);

  return code === "insufficient_quota" || status === 429;
}

function createTranslationServiceError(message, code = "", status = 0) {
  const error = new Error(message);
  error.translationCode = code;
  error.translationStatus = status;
  return error;
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
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function getTrackKey(playback) {
  return `${normalizeText(playback.artist)}::${normalizeText(playback.title)}`;
}

function stripTrailingMetadata(text) {
  let value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) {
    return "";
  }

  const trailingPatterns = [
    /\s*-\s*(?:live|mono|stereo|acoustic|instrumental|karaoke|edit|version|mix|demo|remaster(?:ed)?(?:\s*\d{2,4})?|radio edit|single version|album version).*$/i,
    /\s*-\s*(?:from|feat\.?|ft\.?|with)\b.*$/i,
    /\s*[\(\[][^()\[\]]*(?:live|mono|stereo|acoustic|instrumental|karaoke|edit|version|mix|demo|remaster(?:ed)?(?:\s*\d{2,4})?|radio edit|single version|album version|from|feat\.?|ft\.?|with)[^()\[\]]*[\)\]]\s*$/i
  ];

  let changed = true;
  while (changed) {
    changed = false;

    for (const pattern of trailingPatterns) {
      const nextValue = value.replace(pattern, "").replace(/\s+/g, " ").trim();
      if (nextValue && nextValue !== value) {
        value = nextValue;
        changed = true;
      }
    }
  }

  return value;
}

function getPrimaryArtistName(artist) {
  const normalizedArtist = String(artist || "").replace(/\s+/g, " ").trim();
  if (!normalizedArtist) {
    return "";
  }

  return normalizedArtist
    .split(/\s*(?:,|&|x|feat\.?|ft\.?|with|and)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean)[0] || normalizedArtist;
}

function buildPlaybackSearchVariants(playback) {
  const originalTitle = String(playback.title || "").replace(/\s+/g, " ").trim();
  const originalArtist = String(playback.artist || "").replace(/\s+/g, " ").trim();
  const cleanedTitle = stripTrailingMetadata(originalTitle);
  const cleanedArtist = stripTrailingMetadata(originalArtist);
  const primaryArtist = getPrimaryArtistName(cleanedArtist || originalArtist);
  const variants = [
    { title: originalTitle, artist: originalArtist },
    { title: cleanedTitle, artist: originalArtist },
    { title: originalTitle, artist: primaryArtist },
    { title: cleanedTitle, artist: primaryArtist },
    { title: cleanedTitle || originalTitle, artist: "" }
  ];

  const uniqueVariants = [];
  const seen = new Set();

  for (const variant of variants) {
    const title = String(variant.title || "").trim();
    const artist = String(variant.artist || "").trim();

    if (!title) {
      continue;
    }

    const key = `${normalizeText(artist)}::${normalizeText(title)}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueVariants.push({ title, artist });
  }

  return uniqueVariants;
}

function scoreNormalizedMatch(candidateValue, queryValue, exactScore, partialScore) {
  if (!candidateValue || !queryValue) {
    return 0;
  }

  if (candidateValue === queryValue) {
    return exactScore;
  }

  if (candidateValue.includes(queryValue) || queryValue.includes(candidateValue)) {
    return partialScore;
  }

  return 0;
}

function scoreCandidate(candidate, playback) {
  const normalizedTitle = normalizeText(playback.title);
  const normalizedArtist = normalizeText(playback.artist);
  const normalizedCleanTitle = normalizeText(stripTrailingMetadata(playback.title));
  const normalizedPrimaryArtist = normalizeText(getPrimaryArtistName(playback.artist));
  const candidateTitle = normalizeText(candidate.trackName);
  const candidateArtist = normalizeText(candidate.artistName);

  let score = 0;

  score += scoreNormalizedMatch(candidateTitle, normalizedTitle, 5, 2);
  score += scoreNormalizedMatch(candidateArtist, normalizedArtist, 5, 2);

  if (normalizedCleanTitle && normalizedCleanTitle !== normalizedTitle) {
    score += scoreNormalizedMatch(candidateTitle, normalizedCleanTitle, 3, 1);
  }

  if (normalizedPrimaryArtist && normalizedPrimaryArtist !== normalizedArtist) {
    score += scoreNormalizedMatch(candidateArtist, normalizedPrimaryArtist, 3, 1);
  }

  if (candidate.syncedLyrics) {
    score += 4;
  }

  return score;
}

async function fetchLyricsSearchResults(title, artist) {
  const searchUrl = new URL("https://lrclib.net/api/search");
  searchUrl.searchParams.set("track_name", title);
  if (artist) {
    searchUrl.searchParams.set("artist_name", artist);
  }

  const response = await fetch(searchUrl, {
    headers: {
      "User-Agent": "spotify-floating-lyrics/0.1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Lyrics search failed with ${response.status}`);
  }

  const results = await response.json();
  return Array.isArray(results) ? results : [];
}

function dedupeLyricsCandidates(candidates) {
  const seen = new Set();
  const uniqueCandidates = [];

  for (const candidate of candidates) {
    const key = JSON.stringify([
      normalizeText(candidate?.trackName),
      normalizeText(candidate?.artistName),
      normalizeText(candidate?.albumName),
      Number(candidate?.duration || 0)
    ]);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueCandidates.push(candidate);
  }

  return uniqueCandidates;
}

function createLyricLinesFromPlainText(text) {
  const plainLines = parsePlainLyrics(text);
  if (!plainLines.length) {
    return null;
  }

  return {
    kind: "plain",
    plainText: plainLines.join("\n"),
    lines: plainLines.map((lineText, index) => ({
      id: `${index}-${lineText}`,
      text: lineText
    }))
  };
}

function createLyricLinesFromTimedText(text) {
  const syncedLines = parseLrc(text);
  if (syncedLines.length) {
    return {
      kind: "synced",
      lines: syncedLines
    };
  }

  return createLyricLinesFromPlainText(text);
}

function normalizeNeteaseCandidate(song) {
  const artistNames = Array.isArray(song?.artists)
    ? song.artists.map((artist) => String(artist?.name || "").trim()).filter(Boolean)
    : [];

  return {
    id: String(song?.id || ""),
    trackName: String(song?.name || "").trim(),
    artistName: artistNames.join(", "),
    albumName: String(song?.album?.name || "").trim(),
    durationMs: Number(song?.duration || song?.dt || 0)
  };
}

async function fetchNeteaseSearchResults(keyword) {
  const response = await fetch("https://music.163.com/api/search/get/web?csrf_token=", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: "https://music.163.com/",
      Origin: "https://music.163.com",
      "User-Agent": "spotify-floating-lyrics/0.1.0"
    },
    body: new URLSearchParams({
      s: keyword,
      type: "1",
      offset: "0",
      limit: "10"
    })
  });

  if (!response.ok) {
    throw new Error(`Netease lyrics search failed with ${response.status}`);
  }

  const payload = await response.json();
  const songs = Array.isArray(payload?.result?.songs) ? payload.result.songs : [];
  return songs.map(normalizeNeteaseCandidate).filter((candidate) => candidate.id && candidate.trackName);
}

async function fetchNeteaseLyricsById(trackId) {
  const lyricUrl = new URL("https://music.163.com/api/song/lyric");
  lyricUrl.searchParams.set("id", trackId);
  lyricUrl.searchParams.set("lv", "-1");
  lyricUrl.searchParams.set("tv", "-1");

  const response = await fetch(lyricUrl, {
    headers: {
      Referer: "https://music.163.com/",
      "User-Agent": "spotify-floating-lyrics/0.1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Netease lyric fetch failed with ${response.status}`);
  }

  const payload = await response.json();
  const lyricText = String(payload?.lrc?.lyric || "").trim();
  if (!lyricText) {
    return null;
  }

  return createLyricLinesFromTimedText(lyricText);
}

async function searchLyricsFromNetease(playback) {
  const searchKeywords = buildPlaybackSearchVariants(playback)
    .map((variant) => [variant.title, variant.artist].filter(Boolean).join(" ").trim())
    .filter(Boolean);
  const uniqueKeywords = [...new Set(searchKeywords)];
  const candidates = [];

  for (const keyword of uniqueKeywords) {
    const results = await fetchNeteaseSearchResults(keyword);
    if (results.length) {
      candidates.push(...results);
    }
  }

  const dedupedCandidates = dedupeLyricsCandidates(candidates).sort((left, right) => {
    return scoreCandidate(right, playback) - scoreCandidate(left, playback);
  });

  for (const candidate of dedupedCandidates.slice(0, 6)) {
    const lyricState = await fetchNeteaseLyricsById(candidate.id);
    if (!lyricState) {
      continue;
    }

    return createLyricsState("ready", {
      ...lyricState,
      source: "netease"
    });
  }

  return null;
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
    throw await createTranslationResponseError("line", response);
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
    throw await createTranslationResponseError("batch", response);
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
  const translatedText = payload?.responseData?.translatedText?.trim() || "";
  const responseStatus = Number(payload?.responseStatus || 0);
  const responseDetails = String(payload?.responseDetails || "").trim();

  if (responseStatus >= 400) {
    throw createTranslationServiceError(
      responseDetails || "MyMemory translation unavailable",
      "mymemory_unavailable",
      responseStatus
    );
  }

  return translatedText;
}

async function translateLyricLineWithGoogleFallback(text, targetLanguage) {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "auto");
  url.searchParams.set("tl", targetLanguage);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "spotify-floating-lyrics/0.1.0"
    }
  });

  if (!response.ok) {
    throw createTranslationServiceError(
      `Google fallback translation failed with ${response.status}`,
      "google_fallback_failed",
      response.status
    );
  }

  const payload = await response.json();
  const segments = Array.isArray(payload?.[0]) ? payload[0] : [];
  return segments
    .map((segment) => String(segment?.[0] || "").trim())
    .filter(Boolean)
    .join("");
}

async function translateLyricLine(text, targetLanguage = "zh-CN", options = {}) {
  const normalizedText = String(text || "").replace(/\s+/g, " ").trim();
  const skipOpenAI = Boolean(options.skipOpenAI);

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
    let lastError = null;

    if (!skipOpenAI && process.env.OPENAI_API_KEY) {
      try {
        translatedText = await translateLyricLineWithOpenAIToLanguage(normalizedText, sourceLanguage, targetLanguage);
      } catch (_error) {
        translatedText = "";
      }
    }

    if (!translatedText) {
      try {
        translatedText = await translateLyricLineWithMyMemory(normalizedText, sourceLanguage, targetLanguage);
      } catch (error) {
        lastError = error;
      }
    }

    if (!translatedText) {
      try {
        translatedText = await translateLyricLineWithGoogleFallback(normalizedText, targetLanguage);
      } catch (error) {
        lastError = error;
      }
    }

    const cleanedTranslation = String(translatedText || "").trim();
    const finalText =
      cleanedTranslation && cleanedTranslation !== normalizedText ? cleanedTranslation : "";

    if (!finalText && lastError) {
      throw lastError;
    }

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
    return {
      translations: {},
      errorMessage: ""
    };
  }

  const sourceLanguage = detectSourceLanguage(lines[0]);
  const translations = {};
  let openAIError = null;
  let skipOpenAIForFallback = false;
  let fallbackError = null;

  if (process.env.OPENAI_API_KEY) {
    try {
      const batchResult = await translateLyricsBatchWithOpenAI(lines, sourceLanguage, targetLanguage);

      for (const line of lines) {
        const translated = batchResult.get(line);
        translations[line] = translated && translated !== line ? translated : "";
      }

      return {
        translations,
        errorMessage: ""
      };
    } catch (error) {
      openAIError = error;
      skipOpenAIForFallback = true;
      // Fall back to per-line translation below.
    }
  }

  const settledResults = await Promise.allSettled(
    lines.map((line) =>
      translateLyricLine(line, targetLanguage, {
        skipOpenAI: skipOpenAIForFallback
      })
    )
  );
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const result = settledResults[index];
    if (result.status === "fulfilled" && result.value) {
      translations[line] = result.value;
      continue;
    }

    if (result.status === "rejected" && !fallbackError) {
      fallbackError = result.reason;
    }

    translations[line] = "";
  }

  const hasSuccessfulTranslation = Object.values(translations).some(Boolean);
  if (!hasSuccessfulTranslation && fallbackError) {
    throw fallbackError;
  }

  if (!hasSuccessfulTranslation && openAIError && !shouldUseSimpleTranslationFallback(openAIError)) {
    throw openAIError;
  }

  return {
    translations,
    errorMessage: ""
  };
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
      translationErrorByLanguage: {
        ...(lyrics.translationErrorByLanguage || {}),
        [targetLanguage]: ""
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
    translationErrorByLanguage: {
      ...(lyrics.translationErrorByLanguage || {}),
      [targetLanguage]: ""
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
    const result = await translateLyricsCollection(lyrics, targetLanguage);

    if (trackKey !== cachedTrackKey) {
      return;
    }

    cachedLyrics = {
      ...cachedLyrics,
      translationStatusByLanguage: {
        ...(cachedLyrics.translationStatusByLanguage || {}),
        [targetLanguage]: "ready"
      },
      translationErrorByLanguage: {
        ...(cachedLyrics.translationErrorByLanguage || {}),
        [targetLanguage]: result.errorMessage || ""
      },
      translationsByLanguage: {
        ...(cachedLyrics.translationsByLanguage || {}),
        [targetLanguage]: result.translations
      }
    };
  } catch (error) {
    if (trackKey !== cachedTrackKey) {
      return;
    }

    cachedLyrics = {
      ...cachedLyrics,
      translationStatusByLanguage: {
        ...(cachedLyrics.translationStatusByLanguage || {}),
        [targetLanguage]: "error"
      },
      translationErrorByLanguage: {
        ...(cachedLyrics.translationErrorByLanguage || {}),
        [targetLanguage]: getUserFacingTranslationError(error)
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

  const searchVariants = buildPlaybackSearchVariants(playback);
  const collectedResults = [];

  for (const variant of searchVariants) {
    const results = await fetchLyricsSearchResults(variant.title, variant.artist);
    if (results.length) {
      collectedResults.push(...results);
    }
  }

  const results = dedupeLyricsCandidates(collectedResults);

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

async function searchLyricsWithFallback(playback) {
  let primaryLyrics = null;
  let primaryError = null;
  let neteaseError = null;
  const trackLabel = `${playback.artist || "Unknown Artist"} - ${playback.title || "Unknown Title"}`;

  try {
    primaryLyrics = await searchLyrics(playback);
    if (primaryLyrics?.status === "ready") {
      console.log(`[lyrics] lrclib matched: ${trackLabel}`);
      return primaryLyrics;
    }
    console.log(`[lyrics] lrclib no match: ${trackLabel} (status=${primaryLyrics?.status || "unknown"})`);
  } catch (_error) {
    primaryError = _error;
    primaryLyrics = null;
    console.warn(`[lyrics] lrclib failed: ${trackLabel}`, _error?.message || _error);
  }

  try {
    const neteaseLyrics = await searchLyricsFromNetease(playback);
    if (neteaseLyrics) {
      console.log(`[lyrics] netease matched: ${trackLabel}`);
      return neteaseLyrics;
    }
    console.log(`[lyrics] netease no match: ${trackLabel}`);
  } catch (_error) {
    neteaseError = _error;
    console.warn(`[lyrics] netease failed: ${trackLabel}`, _error?.message || _error);
    // Ignore fallback-source failures and preserve the primary result when possible.
  }

  if (primaryLyrics) {
    if (neteaseError && primaryLyrics.status === "empty") {
      return createLyricsState("empty", {
        message: "No lyrics found in lrclib, and Netease fallback is unavailable",
        error: neteaseError?.message || ""
      });
    }
    return primaryLyrics;
  }

  if (primaryError && neteaseError) {
    return createLyricsState("error", {
      message: "Both lyric sources are temporarily unavailable",
      error: `${primaryError?.message || ""}\n${neteaseError?.message || ""}`.trim()
    });
  }

  if (neteaseError) {
    return createLyricsState("empty", {
      message: "No lyrics found in lrclib, and Netease fallback is unavailable",
      error: neteaseError?.message || ""
    });
  }

  return createLyricsState("empty", {
    message: "No lyrics found in lrclib or Netease"
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
    cachedLyrics = await searchLyricsWithFallback(playback);
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

ipcMain.handle(APP_QUIT_CHANNEL, () => {
  app.quit();
  return { ok: true };
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
