/**
 * generate-demo.mjs
 *
 * Renders demo outputs from a handcrafted rendering profile plus a handcrafted
 * manuscript and a generated capture recording log.
 *
 * All compositing (scale, caption, watermark) is done by ffmpeg. Resvg is used
 * only to render caption text to a PNG that ffmpeg overlays via its filter graph.
 * No per-frame JS processing — the hot path is entirely native.
 *
 * Usage:
 *   node scripts/demo/generate-demo.mjs --config scripts/demo/rendering-config-gif.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Resvg } from '@resvg/resvg-js';
import ffmpegPath from 'ffmpeg-static';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const tempDir = path.join(repoRoot, 'temp_auto');

function fail(message) {
	console.error(`\nError: ${message}`);
	process.exit(1);
}

function parseArgs(argv) {
	const configIndex = argv.indexOf('--config');
	if (configIndex === -1 || !argv[configIndex + 1]) {
		fail('Missing required --config <path> argument');
	}

	const unknownArgs = argv.filter((arg, index) => {
		if (index === configIndex || index === configIndex + 1) return false;
		return true;
	});
	if (unknownArgs.length > 0) {
		fail(`Unknown arguments: ${unknownArgs.join(', ')}`);
	}

	return {
		configPath: path.resolve(repoRoot, argv[configIndex + 1]),
	};
}

function readJson(filePath) {
	if (!fs.existsSync(filePath)) {
		fail(`File not found: ${path.relative(repoRoot, filePath)}`);
	}
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function rel(filePath) {
	return path.relative(repoRoot, filePath).replaceAll('\\', '/');
}

function xmlEscape(text) {
	return String(text)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

function resolveTimestamp(reference, recording) {
	const offsetMs = reference.offsetMs ?? 0;
	if (reference.event) {
		const event = recording.events.find((item) => item.name === reference.event);
		if (!event) fail(`Recording event not found: ${reference.event}`);
		return event.tMs + offsetMs;
	}

	if (reference.segment) {
		const boundaryName = reference.at === 'end' ? 'segment.end' : 'segment.start';
		const event = recording.events.find((item) => item.name === boundaryName && item.segment === reference.segment);
		if (!event) fail(`Recording segment boundary not found: ${reference.segment}.${reference.at ?? 'start'}`);
		return event.tMs + offsetMs;
	}

	fail(`Invalid timing reference: ${JSON.stringify(reference)}`);
}

function buildResolvedClips(manuscript, recording) {
	const frameByName = new Map(recording.frames.map((frame) => [frame.name, frame]));
	return manuscript.clips.map((clip) => {
		const recordedFrame = frameByName.get(clip.frame);
		if (!recordedFrame) {
			fail(`Recorded frame not found for clip '${clip.id}': ${clip.frame}`);
		}
		if (!clip.caption) {
			fail(`Manuscript clip '${clip.id}' is missing required 'caption'`);
		}

		const startMs = resolveTimestamp(clip.duration.from, recording);
		const endMs = resolveTimestamp(clip.duration.to, recording);
		// For video clips, the event markers define the exact window — don't extend
		// past endMs using frame.durationMs (which is a static screenshot hold time).
		const durationMs = clip.useVideo === true
			? (endMs - startMs)
			: Math.max(clip.durationMs ?? recordedFrame.durationMs ?? 0, endMs - startMs);
		if (durationMs <= 0) {
			fail(`Clip '${clip.id}' resolved to non-positive duration (${durationMs}ms)`);
		}

		return {
			id: clip.id,
			useVideo: clip.useVideo === true,
			playbackSpeed: clip.playbackSpeed ?? 1,
			filePath: path.resolve(repoRoot, recordedFrame.file),
			caption: clip.caption,
			durationMs,
			window: { startMs, endMs },
			focus: clip.focus ?? null,
		};
	});
}

/** Read PNG width/height from IHDR chunk — no external deps. */
function readPngDimensions(filePath) {
	const buf = fs.readFileSync(filePath);
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Render caption text to a PNG file using Resvg. */
function writeCaptionPng(text, width, height, outPath) {
	const escaped = xmlEscape(text);
	const fontSize = Math.max(18, Math.floor(height * 0.48));
	const yOffset = Math.floor(height * 0.64);
	const svg = `
		<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
			<style>
				.text { fill: white; font-family: Arial, Helvetica, sans-serif; font-size: ${fontSize}px; font-weight: 500; }
			</style>
			<text x="24" y="${yOffset}" class="text">${escaped}</text>
		</svg>
	`;
	const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render();
	fs.writeFileSync(outPath, rendered.asPng());
}

/** Run ffmpeg synchronously; terminates the process on failure. */
function ffRun(args, label) {
	if (!ffmpegPath) fail('ffmpeg-static path is unavailable');
	const result = spawnSync(ffmpegPath, ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
	if (result.status !== 0) {
		fail(`ffmpeg failed (${label}):\n${result.stderr || result.stdout}`);
	}
}

/** Probe width×height of a video file by parsing ffmpeg stderr. */
function probeVideoDimensions(videoPath) {
	const result = spawnSync(ffmpegPath, ['-i', videoPath], { encoding: 'utf8' });
	// Match resolution like "1920x1080" — require 3-4 digit numbers to avoid
	// matching FourCC hex codes like "avc1 / 0x31637661" in H.264 MP4 streams.
	const m = result.stderr.match(/\b(\d{3,4})x(\d{3,4})\b/);
	if (!m) return null;
	return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/**
 * Linear-decode the whole recording once and return the PTS (seconds) of every sync
 * flash — a full-white frame (luma mean > 200) injected during capture. No seeking:
 * showinfo reports each frame's true pts_time as it decodes, so this is immune to the
 * sparse-keyframe seek imprecision the old per-segment scan-seeks fought, and it can't
 * hang the way seeking into VP8 could. Consecutive bright frames (the 80–150ms overlay
 * spans 2–4 frames) are collapsed to a single flash — its first PTS.
 */
function detectFlashes(videoFile, cropFilter = '') {
	const probe = spawnSync(ffmpegPath, [
		'-i', videoFile,
		'-vf', `${cropFilter}showinfo`,
		'-an', '-f', 'null', '-',
	], { encoding: 'utf8', maxBuffer: 1 << 30 });
	const flashes = [];
	let lastPts = -Infinity;
	for (const line of probe.stderr.split('\n')) {
		if (!line.includes('showinfo')) continue;
		const meanM = line.match(/mean:\[(\d+)/);
		const ptMatch = line.match(/pts_time:([\d.]+)/);
		if (!meanM || !ptMatch || parseInt(meanM[1], 10) <= 200) continue;
		const pts = parseFloat(ptMatch[1]);
		if (pts - lastPts < 0.3) { lastPts = pts; continue; } // later frame of the same flash
		flashes.push(pts);
		lastPts = pts;
	}
	return flashes;
}

/**
 * Build a filter_complex string (for content clips) that:
 *   - Optionally crops input 0 to cropToHeight before any scaling (removes taskbar)
 *   - Scales input 0 into the content area preserving aspect ratio (letterbox)
 *   - Extends the canvas down to make room for the caption bar
 *   - Overlays the caption PNG (input 1) at the bottom
 *   - Optionally overlays the watermark PNG (input 2) in the content area, bottom-right
 *
 * Output label is always [out].
 */
function buildContentFilter(sizing, hasWatermark, watermark, cropToHeight = null, focus = null) {
	const { outputWidth, contentHeight, outputHeight, fps } = sizing;
	const cropStep = cropToHeight ? `crop=in_w:${cropToHeight}:0:0,` : '';
	const zoomStep = focus ? `,${buildZoompanStep(focus, outputWidth, contentHeight, fps)}` : '';

	let fc = `[0:v]${cropStep}setpts=PTS-STARTPTS,scale=${outputWidth}:${contentHeight}:force_original_aspect_ratio=decrease,`;
	fc += `pad=${outputWidth}:${contentHeight}:(ow-iw)/2:(oh-ih)/2:black${zoomStep}[scaled];`;
	fc += `[scaled]pad=${outputWidth}:${outputHeight}:0:0:black[padded];`;
	fc += `[padded][1:v]overlay=0:${contentHeight}[captioned]`;

	if (hasWatermark) {
		const sizePx = watermark.sizePx ?? 32;
		const opacity = watermark.opacity ?? 0.6;
		const wmX = outputWidth - sizePx - 16;
		const wmY = contentHeight - sizePx - 16;
		fc += `;[2:v]format=rgba,colorchannelmixer=aa=${opacity},scale=${sizePx}:${sizePx}[wm]`;
		fc += `;[captioned][wm]overlay=${wmX}:${wmY}[out]`;
	} else {
		fc = fc.replace('[captioned]', '[out]');
	}

	return fc;
}

/**
 * Animated zoom into a focus RECTANGLE — replaces the old green highlight flash as the
 * "look here" cue. `focus` is the region (fractions of the frame): { x, y, w, h }, plus
 * an optional `zoom` cap and timing. Holds full-frame for holdFullMs, then eases from 1×
 * to the zoom level over zoomMs.
 *
 * The zoom level defaults to filling the region's width (capped for crispness). The
 * viewport (iw/zoom × ih/zoom) centers on the region horizontally; vertically, if the
 * region is TALLER than the viewport (e.g. a full-height sidebar pane) it anchors to the
 * TOP of the region so we show its head, not its middle — otherwise it centers.
 * zoompan outputs a constant size, so it works on both screenshots and video and can't
 * distort (aspect is preserved).
 */
function buildZoompanStep(focus, W, H, fps) {
	const bx = focus.x ?? 0, by = focus.y ?? 0, bw = focus.w ?? 1, bh = focus.h ?? 1;
	const MAX_ZOOM = 2.2; // beyond ~2.25× the 2881px source upscales and softens
	const Z = +(focus.zoom ?? Math.min(Math.max(1 / bw, 1), MAX_ZOOM)).toFixed(4);
	const vp = 1 / Z; // viewport size as a fraction of the frame (both axes)
	const clamp = (v) => +Math.max(0, Math.min(1 - vp, v)).toFixed(4);
	const x0 = clamp(bx + bw / 2 - vp / 2);               // center on the region
	const y0 = bh > vp ? clamp(by) : clamp(by + bh / 2 - vp / 2); // top-anchor if too tall
	const cx = +(x0 + vp / 2).toFixed(4);                 // resulting viewport centre
	const cy = +(y0 + vp / 2).toFixed(4);
	const HF = Math.round(((focus.holdFullMs ?? 0) / 1000) * fps);
	const ZF = Math.max(1, Math.round(((focus.zoomMs ?? 400) / 1000) * fps));
	// Linear ramp of zoom from 1× to Z over ZF frames after an HF-frame full-frame hold.
	const z = `if(lt(on,${HF}),1,min(1+(${Z}-1)*(on-${HF})/${ZF},${Z}))`;
	// Center the viewport on (cx,cy), clamped so it never leaves the frame.
	const x = `max(0,min(${cx}*iw-iw/zoom/2,iw-iw/zoom))`;
	const y = `max(0,min(${cy}*ih-ih/zoom/2,ih-ih/zoom))`;
	return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${fps}`;
}

function ensureParentDir(filePath) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/** Render splash screen to a temp MP4 using a lavfi color source + optional logo overlay. */
function renderSplashMp4(profile, splashDurationMs, sizing, outputPath) {
	const { outputWidth, outputHeight, fps } = sizing;
	const durSec = (splashDurationMs / 1000).toFixed(3);
	const bgColor = (profile.splash?.backgroundColor ?? '#1a1a2e').replace(/^#/, '0x');
	const colorSrc = `color=c=${bgColor}:size=${outputWidth}x${outputHeight}:rate=${fps}:duration=${durSec}`;

	if (profile.splash?.logoPath) {
		const logoPath = path.resolve(repoRoot, profile.splash.logoPath);
		const logoW = Math.floor(outputWidth * 0.12);
		const logoH = logoW; // source is 512×512 (square)
		const logoLeft = Math.floor((outputWidth - logoW) / 2);
		const logoTop = Math.floor((outputHeight - logoH) / 2);
		// Glint: small white sparkle on the dot of the "i" in "studio"
		// Position calibrated against resources/icons/dbt-anvil-512.png
		const glintX = logoLeft + Math.round((358 / 512) * logoW);
		const glintY = logoTop + Math.round((236 / 512) * logoH);
		const glintR2 = Math.pow(Math.max(1, Math.round(logoW * 9 / 153)), 2);
		const glintPeak = 1.0;
		const glintSigma2 = Math.pow(0.35 / 2.35, 2);
		const geq = (ch) => `ifnot(lte(0+${ch}(X,Y),0),clip(${ch}(X,Y)`
			+ `+255*exp(-((X-${glintX})^2+(Y-${glintY})^2)/${glintR2})`
			+ `*exp(-((T-${glintPeak})^2)/${glintSigma2}),0,255),0)`;
		const glintFilter = `geq=r='${geq('r')}':g='${geq('g')}':b='${geq('b')}'`;
		const fc = `[1:v]scale=${logoW}:-2:force_original_aspect_ratio=decrease[logo];`
			+ `[0:v][logo]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[composited];`
			+ `[composited]${glintFilter}[out]`;
		ffRun([
			'-f', 'lavfi', '-i', colorSrc,
			'-loop', '1', '-i', logoPath,
			'-filter_complex', fc,
			'-map', '[out]',
			'-t', durSec, '-r', String(fps), '-an',
			'-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
			outputPath,
		], 'splash');
	} else {
		ffRun([
			'-f', 'lavfi', '-i', colorSrc,
			'-t', durSec, '-r', String(fps), '-an',
			'-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
			outputPath,
		], 'splash');
	}
}

/** Render a static screenshot clip to a temp MP4. Loops the PNG for durationMs. */
function renderStaticClipMp4(clip, captionPng, watermarkPath, filterComplex, sizing, outputPath) {
	const { fps } = sizing;
	const durSec = (clip.durationMs / 1000).toFixed(3);
	const wmArgs = watermarkPath ? ['-loop', '1', '-i', watermarkPath] : [];

	ffRun([
		'-loop', '1', '-i', clip.filePath,
		'-loop', '1', '-i', captionPng,
		...wmArgs,
		'-filter_complex', filterComplex,
		'-map', '[out]',
		'-t', durSec, '-r', String(fps), '-an',
		'-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
		outputPath,
	], `static-${clip.id}`);
}

/** Render a video clip to a temp MP4 by seeking + trimming the session recording. */
function renderVideoClipMp4(clip, videoFile, captionPng, watermarkPath, filterComplex, sizing, outputPath) {
	const { fps } = sizing;
	const speed = clip.playbackSpeed ?? 1;
	const startSec = (clip.window.startMs / 1000).toFixed(3);
	// Divide output duration by speed: a 30 s clip at 2.5x plays as 12 s
	const durSec = (clip.durationMs / speed / 1000).toFixed(3);
	const wmArgs = watermarkPath ? ['-loop', '1', '-i', watermarkPath] : [];
	// When speed != 1, inject a setpts after the seek-reset to compress/expand time
	const effectiveFilter = speed !== 1
		? filterComplex.replace('setpts=PTS-STARTPTS,', `setpts=PTS-STARTPTS,setpts=PTS/${speed},`)
		: filterComplex;

	// -t is on the OUTPUT side, not the input side.
	// With input-side -t, the overlay filter's default eof_action=repeat keeps the
	// looped caption/watermark streams running forever after the video stream ends.
	// Output-side -t hard-stops the encoder after durSec regardless of filter graph.
	ffRun([
		'-ss', startSec, '-i', videoFile,
		'-loop', '1', '-i', captionPng,
		...wmArgs,
		'-filter_complex', effectiveFilter,
		'-map', '[out]',
		'-t', durSec,
		'-r', String(fps), '-an',
		'-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
		outputPath,
	], `video-${clip.id}`);
}

/**
 * Encode GIF from a concat list using two-pass palette generation.
 * Returns the palette PNG path for cleanup.
 */
function encodeGif(concatListPath, outputPath, profile) {
	const loop = profile.encoder?.loop ?? 0;
	const palettePath = path.join(path.dirname(concatListPath), 'palette.png');

	console.log('  Generating GIF palette…');
	ffRun([
		'-f', 'concat', '-safe', '0', '-i', concatListPath,
		'-vf', 'palettegen=stats_mode=diff',
		palettePath,
	], 'gif-palette');

	console.log('  Encoding GIF…');
	ffRun([
		'-f', 'concat', '-safe', '0', '-i', concatListPath,
		'-i', palettePath,
		'-lavfi', 'paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
		'-loop', String(loop),
		outputPath,
	], 'gif-encode');

	return palettePath;
}

/** Encode MP4 from a concat list by remuxing the intermediate clips without re-encoding. */
function encodeMp4(concatListPath, outputPath, profile) {
	const crf = profile.encoder?.crf ?? 23;
	const preset = profile.encoder?.preset ?? 'fast';

	console.log('  Encoding MP4…');
	ffRun([
		'-f', 'concat', '-safe', '0', '-i', concatListPath,
		// Intermediate clips are already h264/aac — re-encode with the requested quality
		'-c:v', 'libx264', '-crf', String(crf), '-preset', preset,
		'-pix_fmt', 'yuv420p',
		'-movflags', '+faststart',
		'-an',
		outputPath,
	], 'mp4-encode');
}

/** Encode animated WebP from a concat list. */
function encodeWebp(concatListPath, outputPath, profile) {
	const quality = profile.encoder?.quality ?? 80;
	const loop = profile.encoder?.loop ?? 0;

	console.log('  Encoding WebP…');
	ffRun([
		'-f', 'concat', '-safe', '0', '-i', concatListPath,
		'-c:v', 'libwebp_anim', '-loop', String(loop), '-quality', String(quality),
		'-preset', 'picture',
		outputPath,
	], 'webp-encode');
}

async function main() {
	const { configPath } = parseArgs(process.argv.slice(2));
	const profile = readJson(configPath);
	const manuscriptPath = path.resolve(repoRoot, profile.manuscriptFile);
	const manuscript = readJson(manuscriptPath);
	const recordingPath = path.resolve(repoRoot, manuscript.recordingFile ?? manuscript.recordingPath ?? 'temp_auto/demo-recording.json');
	const recording = readJson(recordingPath);

	const resolvedClips = buildResolvedClips(manuscript, recording);
	if (resolvedClips.length === 0) fail('Manuscript resolved zero clips');

	// Determine output dimensions from first screenshot (no Jimp needed)
	const { width: srcW, height: srcH } = readPngDimensions(resolvedClips[0].filePath);
	const outputWidth = profile.outputWidth ?? 1280;
	const captionHeight = profile.captionHeightPx ?? 40;
	const contentHeight = Math.round((srcH / srcW) * outputWidth / 2) * 2;
	const outputHeight = contentHeight + captionHeight;
	const fps = profile.encoder?.fps ?? 10;
	const sizing = { outputWidth, contentHeight, outputHeight, captionHeight, fps };

	console.log(`Output: ${outputWidth}×${outputHeight} (${contentHeight}px content + ${captionHeight}px caption) @ ${fps}fps`);

	// Watermark
	const watermarkPath = profile.watermark?.logoPath
		? path.resolve(repoRoot, profile.watermark.logoPath)
		: null;
	const hasWatermark = !!(watermarkPath && fs.existsSync(watermarkPath));

	// Session video file for useVideo clips
	const rawVideoFile = recording.videoFile
		? path.resolve(repoRoot, recording.videoFile.replaceAll('\\', '/'))
		: null;

	// Seek directly into the raw Playwright recording — no transcode. The old code
	// rebuilt the whole WebM as an all-keyframe MP4 (-g 1) so it could seek to each
	// flash; that intra-only rebuild inflated a 41 MB recording to ~870 MB and was the
	// bulk of render time. Flash anchors now come from one linear showinfo pass
	// (detectFlashes) and ffmpeg's default accurate_seek makes the per-clip input-side
	// -ss frame-accurate on sparse-keyframe VP8 without a rebuild.
	const videoFile = rawVideoFile;

	// If the recorded video is taller than the screenshots (e.g. Playwright records at
	// 1920×1080 but the maximized VS Code window is only 1920×1020 due to the taskbar),
	// crop the video to match the screenshot height before scaling.
	let videoCropToHeight = null;
	if (videoFile && fs.existsSync(videoFile)) {
		const vDims = probeVideoDimensions(videoFile);
		if (vDims && vDims.height > srcH) {
			videoCropToHeight = srcH;
			console.log(`  Note: video is ${vDims.width}×${vDims.height}, screenshots are ${srcW}×${srcH} — cropping video to ${srcH}px height`);
		}
	}

	// One linear showinfo pass over the recording finds every sync flash (full-white
	// frames injected during capture). From those we derive a frame-accurate
	// wall-clock→video offset: a global one from 'sync.flash', and a per-segment one from
	// each 'X.sync' that corrects accumulated VP8 PTS drift. Segments whose flash never
	// painted (renderer too busy for the ~150ms overlay) fall back to the global offset —
	// the same behaviour the old per-segment scan had when it found nothing.
	const cropFilter = videoCropToHeight ? `crop=iw:${videoCropToHeight}:0:0,` : '';
	let videoStartOffsetMs = recording.videoStartOffsetMs ?? 0;
	const segmentOffsetMs = new Map();
	if (videoFile && fs.existsSync(videoFile)) {
		const flashes = detectFlashes(videoFile, cropFilter);
		const nearestFlash = (targetSec, tolSec) => {
			let best = null;
			for (const p of flashes) {
				if (Math.abs(p - targetSec) > tolSec) continue;
				if (best === null || Math.abs(p - targetSec) < Math.abs(best - targetSec)) best = p;
			}
			return best;
		};
		const syncEvent = recording.events?.find(e => e.name === 'sync.flash');
		if (syncEvent) {
			const pts = nearestFlash((syncEvent.tMs - videoStartOffsetMs) / 1000, 3);
			if (pts !== null) {
				videoStartOffsetMs = syncEvent.tMs - Math.round(pts * 1000);
				console.log(`  Global sync flash at pts=${pts.toFixed(3)}s → videoStartOffsetMs=${videoStartOffsetMs}ms`);
			} else {
				console.warn('  ⚠ Global sync flash not detected — using videoStartOffsetMs from recording');
			}
		}
		// Per-segment anchors: predict from the (now frame-accurate) global offset, then
		// snap to the nearest real flash within ±1.5s. Segments are ≥9s apart, so no mismatch.
		for (const clip of resolvedClips) {
			if (!clip.useVideo) continue;
			const segEvent = recording.events?.find(e => e.name === `${clip.id}.sync`);
			if (!segEvent) continue;
			const pts = nearestFlash((segEvent.tMs - videoStartOffsetMs) / 1000, 1.5);
			if (pts !== null) {
				const off = segEvent.tMs - Math.round(pts * 1000);
				segmentOffsetMs.set(clip.id, off);
				console.log(`  [${clip.id}] per-segment sync at pts=${pts.toFixed(3)}s → offset=${off}ms`);
			} else {
				console.warn(`  [${clip.id}] ⚠ per-segment sync flash not detected — using global offset`);
			}
		}
	}

	const runId = Date.now();
	const workDir = path.join(tempDir, `demo-render-${runId}`);
	fs.mkdirSync(workDir, { recursive: true });
	process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

	const clipMp4s = [];

	// Splash
	if (manuscript.splash?.enabled !== false && profile.splash) {
		const splashPath = path.join(workDir, 'splash.mp4');
		const splashDurationMs = manuscript.splash?.durationMs ?? 2000;
		console.log(`  Rendering splash (${splashDurationMs}ms)…`);
		renderSplashMp4(profile, splashDurationMs, sizing, splashPath);
		clipMp4s.push(splashPath);
	}

	// Clips
	for (const clip of resolvedClips) {
		const captionPng = path.join(workDir, `${clip.id}-caption.png`);
		writeCaptionPng(clip.caption, outputWidth, captionHeight, captionPng);

		const mp4Path = path.join(workDir, `${clip.id}.mp4`);

		// Build the content filter per clip so its optional `focus` zoom is baked in.
		const filter = buildContentFilter(sizing, hasWatermark, profile.watermark, clip.useVideo ? videoCropToHeight : null, clip.focus);

		if (clip.useVideo) {
			if (!videoFile) fail(`Clip '${clip.id}' is marked useVideo but recording has no videoFile`);
			if (!fs.existsSync(videoFile)) fail(`Video file not found: ${rel(videoFile)}`);

			// Per-segment drift-corrected offset from the linear flash pass above; falls
			// back to the global offset for segments whose flash never painted.
			const effectiveOffsetMs = segmentOffsetMs.get(clip.id) ?? videoStartOffsetMs;
			const seekMs = Math.max(0, clip.window.startMs - effectiveOffsetMs);
			console.log(`  Rendering video clip '${clip.id}' (${(clip.durationMs / 1000).toFixed(1)}s from ${(seekMs / 1000).toFixed(1)}s)…`);
			renderVideoClipMp4({ ...clip, window: { ...clip.window, startMs: seekMs } }, videoFile, captionPng, hasWatermark ? watermarkPath : null, filter, sizing, mp4Path);
		} else {
			console.log(`  Rendering static clip '${clip.id}' (${(clip.durationMs / 1000).toFixed(1)}s)…`);
			renderStaticClipMp4(clip, captionPng, hasWatermark ? watermarkPath : null, filter, sizing, mp4Path);
		}

		clipMp4s.push(mp4Path);
	}

	// Write concat list (forward slashes required by ffmpeg on Windows)
	const concatListPath = path.join(workDir, 'concat.txt');
	fs.writeFileSync(concatListPath, clipMp4s.map((p) => `file '${p.replaceAll('\\', '/')}'`).join('\n'));

	// Encode final output
	const outputPath = path.resolve(repoRoot, profile.outputFile);
	ensureParentDir(outputPath);

	if (profile.format === 'gif') {
		encodeGif(concatListPath, outputPath, profile);
	} else if (profile.format === 'webp') {
		encodeWebp(concatListPath, outputPath, profile);
	} else if (profile.format === 'mp4') {
		encodeMp4(concatListPath, outputPath, profile);
	} else {
		fail(`Unsupported format: ${profile.format}`);
	}

	console.log(`\nRendered ${profile.format.toUpperCase()} to ${rel(outputPath)}`);
	console.log(`Config:     ${rel(configPath)}`);
	console.log(`Manuscript: ${rel(manuscriptPath)}`);
	console.log(`Recording:  ${rel(recordingPath)}`);
	for (const clip of resolvedClips) {
		const videoTag = clip.useVideo ? ' [video]' : '';
		console.log(`  ${clip.id}: ${clip.window.startMs}ms → ${clip.window.startMs + clip.durationMs}ms (${clip.durationMs}ms)${videoTag}`);
	}
}

main().catch((error) => {
	console.error('\nRender failed:', error);
	process.exit(1);
});
