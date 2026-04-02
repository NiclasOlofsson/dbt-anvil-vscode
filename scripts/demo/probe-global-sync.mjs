import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const videoFile = path.join(repoRoot, 'temp_auto/demo-video/9f89c2469967832f332f7ec4ef1c3a7c.seekable.mp4');

// sync.flash at tMs=4891, videoStartOffsetMs=1841 → expectedFlashPts ≈ 3.05s
// Scan 0s–7s to see all brightness values in window
const r = spawnSync(ffmpeg, [
	'-ss', '0', '-t', '7',
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
		const marker = mean > 200 ? ' *** FLASH ***' : mean > 150 ? ' (bright)' : '';
		console.log(`pts=${pt[1]}  mean=${m[1]}${marker}`);
	}
});
console.log(`\nTotal frames: ${lines.length}`);
