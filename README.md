# Spotify Floating Lyrics

[English](./README.md) | [Chinese Simplified](./README.zh-CN.md)

A lightweight floating lyrics overlay for the Spotify desktop app on macOS and Windows.

This project does not inject into Spotify. It runs as a separate always-on-top window and shows the current lyric line above your desktop while Spotify is playing.

## Features

- Reads the current track from the Spotify desktop client
- Supports macOS and Windows
- Fetches lyrics from `lrclib.net`, with Netease fallback for better Chinese-song coverage
- Displays synced lyrics when available, and plain lyrics otherwise
- Splits long lyric lines into sequential segments instead of shrinking the font
- Optional translation line under the current lyric
- Hover controls for previous, play/pause, next, font size, translation, and theme
- Draggable floating overlay
- Windows desktop shortcut generator
- macOS launcher script and app launcher workflow

## How It Works

- `Electron` provides the transparent always-on-top overlay window
- `AppleScript / JXA` reads and controls Spotify on macOS
- `Windows Global System Media Transport Controls` is used on Windows
- Lyrics are fetched online from community sources

## Current Behavior

- Platform: macOS, Windows
- Playback source: local Spotify desktop app
- Lyrics source order: `lrclib.net` -> Netease fallback
- UI style: text-first floating overlay
- Theme: default light text mode plus an optional darker-text theme for bright backgrounds

## Run Locally

```bash
npm install
npm start
```

Windows launcher:

```bat
scripts\launch_windows.bat
```

## Desktop Launchers

macOS launcher scripts:

- `scripts/launch_app.sh`
- `scripts/Spotify Floating Lyrics Launcher.applescript`

Windows launcher scripts:

- `scripts/launch_windows.bat`
- `scripts/launch_windows.vbs`
- `scripts/create_windows_shortcut.ps1`

Create a Windows desktop shortcut:

```bash
npm run shortcut:windows
```

That creates a `Spotify Floating Lyrics.lnk` shortcut on the current user's desktop.

## First Launch Notes

On macOS, the first read/control attempt may trigger an Automation permission prompt. If it does not appear, check:

`System Settings > Privacy & Security > Automation`

and make sure the relevant app is allowed to control Spotify.

On Windows, Spotify playback detection depends on the system media session interface. If playback is detected but lyrics still do not show up, check the terminal logs for lines such as:

```text
[lyrics] lrclib no match: Artist - Title
[lyrics] netease matched: Artist - Title
```

## Interaction

- Drag the lyric area to move the overlay
- Hover over the overlay to reveal controls
- Use `A-` and `A+` to adjust lyric font size
- Use the translation button to toggle the translated line
- Use the `Dark` button to switch to a darker text color for bright backgrounds

## Translation

The built-in fallback translation is general-purpose, so some lyric lines can feel literal.

For more natural lyric-style translation, launch with an OpenAI API key:

```bash
OPENAI_API_KEY=your_key_here npm start
```

Optional model override:

```bash
OPENAI_TRANSLATION_MODEL=gpt-4.1-mini OPENAI_API_KEY=your_key_here npm start
```

To use the same settings from desktop launchers, create a local env file:

```bash
cp .env.example .env.local
```

Then fill in:

```bash
OPENAI_API_KEY=your_key_here
OPENAI_TRANSLATION_MODEL=gpt-4.1-mini
```

## Notes On Lyric Timing

If lyrics look slightly behind the music, there are two common causes:

- playback-position sampling delay on the local machine
- the lyric source itself being slightly offset

This project now tracks the playback sample timestamp separately to reduce renderer-side lag, but source-side lyric timing can still vary from song to song.

## Project Structure

```text
.
|-- package.json
|-- README.md
|-- README.zh-CN.md
|-- scripts
|   |-- Spotify Floating Lyrics Launcher.applescript
|   |-- create_windows_shortcut.ps1
|   |-- launch_app.sh
|   |-- launch_windows.bat
|   |-- launch_windows.vbs
|   `-- windows_spotify_bridge.ps1
`-- src
    |-- main.js
    |-- preload.js
    `-- renderer
        |-- app.js
        |-- index.html
        `-- styles.css
```

## Ideas For Future Improvements

- local lyric cache
- manual lyric import for missing tracks
- more lyric-source fallbacks
- better line timing correction
- packaged desktop builds for Windows and macOS
