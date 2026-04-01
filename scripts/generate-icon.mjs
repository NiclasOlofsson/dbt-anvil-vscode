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
    x="64" y="38"
    font-family="Arial, Helvetica, sans-serif"
    font-size="64"
    font-weight="700"
    fill="#777777"
    text-anchor="middle"
    dominant-baseline="middle"
    textLength="108"
    lengthAdjust="spacingAndGlyphs"
  >dbt</text>
  <text
    x="64" y="90"
    font-family="Arial, Helvetica, sans-serif"
    font-size="64"
    font-weight="500"
    fill="#777777"
    text-anchor="middle"
    dominant-baseline="middle"
    textLength="108"
    lengthAdjust="spacingAndGlyphs"
  >studio</text>
</svg>`;

function renderSvg(svgStr, size, destPath) {
  const r = new Resvg(svgStr, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  });
  const buf = r.render().asPng();
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  console.log('Written:', destPath);
}

renderSvg(svg, 128, outPath);

// Activity bar comparison render — same 16x16 viewBox, rendered at 48px (24px CSS @ 2x HiDPI)
const svgActivity = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <text
    x="8" y="4.75"
    font-family="Arial, Helvetica, sans-serif"
    font-size="8"
    font-weight="700"
    fill="#777777"
    text-anchor="middle"
    dominant-baseline="middle"
    textLength="13.5"
    lengthAdjust="spacingAndGlyphs"
  >dbt</text>
  <text
    x="8" y="11.25"
    font-family="Arial, Helvetica, sans-serif"
    font-size="8"
    font-weight="500"
    fill="#777777"
    text-anchor="middle"
    dominant-baseline="middle"
    textLength="13.5"
    lengthAdjust="spacingAndGlyphs"
  >studio</text>
</svg>`;

const outActivity = path.join(__dirname, '..', 'resources', 'icons', 'dbt-studio-activity-preview.png');
renderSvg(svgActivity, 48, outActivity);

// White version for dark splash screens — 256px, white text on transparent background
const svgWhite = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <text
    x="64" y="38"
    font-family="Arial, Helvetica, sans-serif"
    font-size="64"
    font-weight="700"
    fill="#ffffff"
    text-anchor="middle"
    dominant-baseline="middle"
    textLength="108"
    lengthAdjust="spacingAndGlyphs"
  >dbt</text>
  <text
    x="64" y="90"
    font-family="Arial, Helvetica, sans-serif"
    font-size="64"
    font-weight="500"
    fill="#ffffff"
    text-anchor="middle"
    dominant-baseline="middle"
    textLength="108"
    lengthAdjust="spacingAndGlyphs"
  >studio</text>
</svg>`;

const outWhite = path.join(__dirname, '..', 'resources', 'icons', 'dbt-studio-white-256.png');
renderSvg(svgWhite, 256, outWhite);

// Grey 512px — high-res source for splash screen (avoids upscale blur)
const out512 = path.join(__dirname, '..', 'resources', 'icons', 'dbt-studio-512.png');
renderSvg(svg, 512, out512);
