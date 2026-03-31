import { Resvg } from '@resvg/resvg-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, '..', 'resources', 'icons', 'dbt-studio-128.png');

// Marketplace icon: 128x128, transparent background
// "dbt" bold on top, "studio" lighter below
// #777777 works on both dark and light VS Code themes
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <text
    x="64" y="52"
    font-family="Arial, Helvetica, sans-serif"
    font-size="68"
    font-weight="700"
    fill="#777777"
    text-anchor="middle"
    dominant-baseline="middle"
    textLength="118"
    lengthAdjust="spacingAndGlyphs"
  >dbt</text>
  <text
    x="64" y="90"
    font-family="Arial, Helvetica, sans-serif"
    font-size="34"
    font-weight="400"
    fill="#777777"
    text-anchor="middle"
    dominant-baseline="middle"
    textLength="118"
    lengthAdjust="spacingAndGlyphs"
  >studio</text>
</svg>`;

const resvg = new Resvg(svg, {
	fitTo: { mode: 'width', value: 128 },
	background: 'rgba(0,0,0,0)',
});

const pngData = resvg.render();
const pngBuffer = pngData.asPng();

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, pngBuffer);
console.log('Written:', outPath);
