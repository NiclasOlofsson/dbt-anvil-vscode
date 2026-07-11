# Demo Pipeline

Two-step pipeline: **capture** → **render**.

## Prerequisites

```
# 1. dbt manifest must exist in the sample project
cd samples/nba-monte-carlo
uv run dbt parse --profiles-dir .

# 2. Extension must be compiled (watch task covers this)
npm run compile
```

`playwright` must be installed in the repo root (`npm install` covers it).
`ffmpeg-static` lives in `scripts/node_modules/` (`cd scripts && npm install`).

---

## Step 1 — Capture

```
npm run demo:capture
```

Launches VS Code Insiders via Playwright Electron, drives through every segment
automatically, saves screenshots to `temp_auto/demo-frames/` and records a video
to `temp_auto/demo-video/`. Writes timing metadata to `temp_auto/demo-recording.json`.

To re-capture a single segment without a full run:

```
npm run demo:capture -- --step profiler
```

Valid `--step` ids match the `id` fields in `manuscript.json`.

---

## Step 2 — Render

```
npm run demo:render:webp   # → images/demo.webp  (recommended; smaller, better quality)
npm run demo:render:gif    # → images/demo.gif   (larger, ~3× slower to encode)
```

Both commands call `generate-demo.mjs` with a rendering config. Intermediates
(per-clip MP4s, caption PNGs, concat list, palette) are written to a
`temp_auto/demo-render-<runId>/` subfolder and deleted automatically on exit.

---

## File Map

| File | Purpose |
|---|---|
| `capture-demo.mjs` | Playwright driver: launches VS Code, runs segments, saves frames + video |
| `generate-demo.mjs` | ffmpeg renderer: composes clips into GIF or animated WebP |
| `manuscript.json` | Clip list: id, caption, timing references, `useVideo` flag |
| `rendering-config-gif.json` | Output settings for GIF (quality, loop, dimensions) |
| `rendering-config-webp.json` | Output settings for WebP (fps, quality, dimensions) |
| `demo-config.json` | Legacy static-frame config: **not used by current pipeline** |

---

## How Timing Works in `manuscript.json`

Each clip has a `duration` with `from` and `to` markers. Two formats:

```jsonc
// Segment-relative — tied to the capture run's segment start/end timestamps
{ "segment": "hover-ref", "at": "start", "offsetMs": 0 }

// Event-relative — tied to a named event emitted during capture (used for video clips)
{ "event": "profiler.command-sent", "offsetMs": -300 }
```

Clips with `"useVideo": true` extract a window from the recorded `.webm` instead
of looping a static screenshot. The profiler and query-results clips use this.

---

## Outputs

| Path | Description |
|---|---|
| `temp_auto/demo-frames/` | Screenshots per segment (gitignored) |
| `temp_auto/demo-video/` | Recorded `.webm` from the capture session (gitignored) |
| `temp_auto/demo-recording.json` | Segment/event timestamps (gitignored) |
| `images/demo.webp` | Final animated WebP (gitignored) |
| `images/demo.gif` | Final GIF (gitignored) |

---

## Troubleshooting

**`demo-recording.json` not found**: run capture first, or check that the watch
task is running (compile must succeed before capture launches VS Code).

**Profiler clip encodes forever**: old bug; fixed by putting `-t` on the output
side (not the input) and resetting PTS with `setpts=PTS-STARTPTS`.

**Segment screenshot looks wrong**: re-run capture for that segment only:
`npm run demo:capture -- --step <id>`, then re-render.
