const path = require("path");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 1000;
const STATE_CHANNEL = "lyrics:state";
const PLAYER_CONTROL_CHANNEL = "spotify:player-control";

let mainWindow;
let pollTimer;
let latestSnapshot = createEmptySnapshot();
let cachedTrackKey = "";
let cachedLyrics = createLyricsState("idle");
let refreshBurstTimers = [];

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
    ...extra
  };
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

async function getSpotifyPlayback() {
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
  const height = 176;

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
  const playback = await getSpotifyPlayback();
  const lyrics = await getLyricsForPlayback(playback);

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
