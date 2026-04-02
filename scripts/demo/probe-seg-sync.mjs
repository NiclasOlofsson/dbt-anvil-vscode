import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const videoFile = path.join(repoRoot, 'temp_auto/demo-video/9f89c2469967832f332f7ec4ef1c3a7c.seekable.mp4');

// Per-segment hover-ref detected at pts=58.480s — probe nearby to see the flash
const scanStart = 56;
const scanDur = 5;
const r = spawnSync(ffmpeg, [
	'-ss', String(scanStart), '-t', String(scanDur),
	'-i', videoFile,
	'-vf', 'crop=iw:1020:0:0,showinfo',
	'-f', 'null', '-',
], { encoding: 'utf8' });

const lines = r.stderr.split('\n').filter(l => l.includes('showinfo'));
lines.forEach(l => {
	const m = l.match(/mean:\[(\d+)/);
	const pt = l.match(/pts_time:([\d.]+)/);
	if (m && pt) {
		const mean = parseInt(m[1]);
		const absPts = (scanStart + parseFloat(pt[1])).toFixed(3);
		const marker = mean > 200 ? ' *** FLASH ***' : mean > 100 ? ' (bright)' : '';
		if (mean > 50 || marker) console.log(`pts=${absPts}  mean=${m[1]}${marker}`);
	}
});
console.log(`\nTotal frames: ${lines.length}`);
