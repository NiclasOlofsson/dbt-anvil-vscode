import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'child_process';

const r = spawnSync(ffmpeg, [
	'-ss', '1.5', '-t', '4',
	'-i', 'temp_auto/demo-video/recording.mp4',
	'-vf', 'crop=iw:1020:0:0,showinfo',
	'-f', 'null', '-',
], { encoding: 'utf8' });

const lines = r.stderr.split('\n').filter(l => l.includes('showinfo'));
lines.forEach(l => {
	const m = l.match(/mean:\[(\d+)/);
	const pt = l.match(/pts_time:([\d.]+)/);
	if (m && pt) console.log(`pts=${pt[1]} mean=${m[1]}`);
});
console.log('Done. Total frames scanned:', lines.length);
