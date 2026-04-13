# Spotify Floating Lyrics

[English](./README.md) | [简体中文](./README.zh-CN.md)

A lightweight macOS desktop lyrics overlay for Spotify.

This project is not a theme injected into the Spotify client. It runs as a separate floating window on top of your desktop and shows the current lyric line while Spotify is playing.

## Features

- Reads the currently playing track from the Spotify desktop app on macOS
- Fetches lyrics automatically from `lrclib.net`
- Keeps a consistent lyric font size
- Splits very long lyric lines into sequential segments instead of shrinking the text dynamically
- Shows a clean text-only overlay by default
- Supports an optional translation line under the current lyric
- Reveals hover controls for previous track, play/pause, next track, and font size
- Supports dragging the overlay anywhere on screen
- Includes a desktop launcher app for one-click startup

## Why It Is Built As A Separate Overlay

Spotify client plugins are not a great fit for true system-level floating lyrics. To make the overlay behave like a desktop lyric widget, this app uses:

- Electron for the transparent always-on-top window
- AppleScript / JXA to read and control Spotify on macOS
- An online lyrics source for synced and plain lyric fallback

## Current Behavior

- Platform: macOS
- Playback source: local Spotify desktop client
- Lyrics source: `lrclib.net`
- UI style: text-first floating overlay
- Hover controls: previous, play/pause, next, font size down, font size up
- Translation toggle: show a translated line under the current lyric

## Run Locally

```bash
npm install
npm start
```

## Desktop Launcher

A desktop launcher app is generated here:

[`/Users/peijiewang/Desktop/Spotify Floating Lyrics.app`](/Users/peijiewang/Desktop/Spotify%20Floating%20Lyrics.app)

You can launch the app by double-clicking that icon instead of running a terminal command.

The launcher now also loads environment variables from these locations before startup:

- `./.env.local`
- `./.env`

The launcher scripts in this repo are:

- [scripts/launch_app.sh](/Users/peijiewang/Documents/spotify/scripts/launch_app.sh)
- [scripts/Spotify Floating Lyrics Launcher.applescript](/Users/peijiewang/Documents/spotify/scripts/Spotify%20Floating%20Lyrics%20Launcher.applescript)

## First Launch Notes

The first time the app tries to read or control Spotify, macOS may ask for Automation permission. You need to allow it, otherwise the overlay cannot read playback state or control track playback.

If the prompt does not appear, check:

`System Settings > Privacy & Security > Automation`

and make sure the relevant app is allowed to control Spotify.

## Interaction

- Drag the lyric area to move the overlay
- Hover over the overlay to reveal playback controls
- Use `A-` and `A+` to change the global lyric font size
- Use `译` to toggle a translated line under the current lyric
- Long lyric lines are shown in sequential segments at the same font size

## Better Translation Quality

The built-in fallback translation is a general machine translation service, so some lyric lines can feel too literal.

If you want more natural lyric-style translation, you can launch the app with an OpenAI API key:

```bash
OPENAI_API_KEY=your_key_here npm start
```

Optional:

```bash
OPENAI_TRANSLATION_MODEL=gpt-4.1-mini OPENAI_API_KEY=your_key_here npm start
```

When `OPENAI_API_KEY` is present, the app will prefer a lyric-aware translation prompt and fall back to the normal translation service if that request fails.

If you want the desktop launcher app to use the same higher-quality translation, create a local env file:

```bash
cp .env.example .env.local
```

Then fill in your key:

```bash
OPENAI_API_KEY=your_key_here
OPENAI_TRANSLATION_MODEL=gpt-4.1-mini
```

After that, double-clicking the desktop app will also use the better translation path.

## Project Structure

```text
.
├── package.json
├── package-lock.json
├── README.md
├── README.zh-CN.md
├── scripts
│   ├── Spotify Floating Lyrics Launcher.applescript
│   └── launch_app.sh
└── src
    ├── main.js
    ├── preload.js
    └── renderer
        ├── app.js
        ├── index.html
        └── styles.css
```

## Ideas For Future Improvements

- Better segment timing for very long synced lines
- More lyrics source fallbacks
- Translation mode
- Window size presets
- Optional custom app icon
- Windows support
