/**
 * build-feature-map.mjs
 *
 * Renders features.json + compositions.json into a single self-contained HTML page
 * (scripts/demo/feature-map.html) for review. Server-side rendered — opens straight
 * from disk (file://), no server, no external assets. Re-run after editing either JSON.
 *
 * Two independent axes per feature:
 *   shipped — is it in the product today?   (build status)
 *   filmed  — is there demo footage for it?  (demo status)
 * A shipped-but-unfilmed feature is a filming TODO, NOT roadmap. Only !shipped is roadmap.
 *
 * Usage: node scripts/demo/build-feature-map.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(__dirname, p), 'utf8'));

const catalog = readJson('features.json');
const { compositions } = readJson('compositions.json');
const rings = catalog.rings;
const features = catalog.features;

const byId = new Map(features.map((f) => [f.id, f]));
const ringOrder = new Map(rings.map((r, i) => [r.id, i]));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const filmed = features.filter((f) => f.filmed);
const toFilm = features.filter((f) => f.shipped && !f.filmed);
const roadmap = features.filter((f) => !f.shipped);
const diffs = features.filter((f) => f.context.differentiator);

const stateOf = (f) => (!f.shipped ? 'roadmap' : (f.filmed ? 'filmed' : 'tofilm'));

/** Resolve a composition's ordered feature list (only filmable features render). */
function resolve(comp) {
	const sel = comp.select;
	if (Array.isArray(sel.order)) {
		return sel.order.map((id) => byId.get(id)).filter(Boolean);
	}
	return features
		.filter((f) => (sel.include === 'filmed' ? f.filmed : sel.include === 'shipped' ? f.shipped : true))
		.sort((a, b) => (ringOrder.get(a.context.ring) - ringOrder.get(b.context.ring)));
}

const chip = (text, cls = '') => `<span class="chip ${cls}">${esc(text)}</span>`;

function statusBadge(f) {
	const s = stateOf(f);
	if (s === 'tofilm') return '<span class="badge tofilm" title="Shipped in the product — no demo footage yet">▶ ready to film</span>';
	if (s === 'roadmap') return '<span class="badge roadmap" title="Not yet in the product">roadmap</span>';
	return '';
}

function card(f) {
	const c = f.context;
	const kinds = c.symbolKinds.map((k) => chip(k, 'sym')).join('');
	const meta = [
		f.capture.useVideo ? 'video' : 'still',
		f.capture.playbackSpeed !== 1 ? `${f.capture.playbackSpeed}×` : null,
		f.render.focus ? 'zoom' : null,
	].filter(Boolean).map((m) => chip(m, 'meta')).join('');
	return `
	<article class="card ${stateOf(f)}${c.differentiator ? ' diff' : ''}"
	         data-ring="${c.ring}" data-diff="${c.differentiator}" data-state="${stateOf(f)}">
		<div class="card-head">
			<h3>${esc(f.title)}</h3>
			<span class="badges">
				${c.differentiator ? '<span class="badge diff" title="Hard or impossible with a plain LSP">◆ beyond LSP</span>' : ''}
				${statusBadge(f)}
			</span>
		</div>
		<div class="chips">${chip(c.provider, 'prov')}${kinds}${meta}</div>
		<p class="pitch">${esc(c.pitch)}</p>
		<p class="pain">${esc(c.pain)}</p>
	</article>`;
}

function ringSection(r) {
	const items = features.filter((f) => f.context.ring === r.id);
	if (items.length === 0) return '';
	const filmedN = items.filter((f) => f.filmed).length;
	return `
	<section class="ring" data-ring="${r.id}">
		<div class="ring-head">
			<span class="ring-dot ring-${r.id}"></span>
			<h2>${esc(r.title)}</h2>
			<span class="ring-count">${filmedN}/${items.length} filmed</span>
		</div>
		<p class="ring-blurb">${esc(r.blurb)}</p>
		<div class="grid">${items.map(card).join('')}</div>
	</section>`;
}

function compCard(comp) {
	const list = resolve(comp);
	const s = comp.settings;
	const settingChips = Object.entries(s).map(([k, v]) => chip(`${k}: ${v}`, 'set')).join('');
	const reel = list.map((f) => `<li class="ring-${f.context.ring}" title="${esc(f.context.ring)}">${esc(f.title)}</li>`).join('');
	const approx = s.perClipMs ? `≈ ${((list.length * s.perClipMs + (catalog.splash?.durationMs ?? 0)) / 1000).toFixed(1)}s` : `${list.length} clips`;
	return `
	<section class="comp">
		<div class="comp-head">
			<h3>${esc(comp.title)} <span class="purpose">${esc(comp.purpose)}</span></h3>
			<code>${esc(comp.output)}</code>
		</div>
		<p class="comp-desc">${esc(comp.description ?? '')}</p>
		<div class="chips">${settingChips}</div>
		<ol class="reel">${reel}</ol>
		<div class="comp-meta">${list.length} features · ${approx}</div>
	</section>`;
}

const roadmapStat = roadmap.length > 0 ? `<div class="stat"><b>${roadmap.length}</b><span>roadmap</span></div>` : '';

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dbt Anvil — Demo Feature Map</title>
<style>
  :root {
    --bg:#0e1116; --panel:#161b22; --panel2:#1b222c; --line:#2a3038; --fg:#e6edf3; --mut:#8b949e;
    --accent:#3fb950; --film:#e3b341; --caret:#58a6ff; --file:#3fb9a8; --project:#bc8cff; --data:#e3b341;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f8fa; --panel:#fff; --panel2:#f0f3f6; --line:#d0d7de; --fg:#1f2328; --mut:#59636e; }
  }
  :root[data-theme="dark"]  { --bg:#0e1116; --panel:#161b22; --panel2:#1b222c; --line:#2a3038; --fg:#e6edf3; --mut:#8b949e; }
  :root[data-theme="light"] { --bg:#f6f8fa; --panel:#fff; --panel2:#f0f3f6; --line:#d0d7de; --fg:#1f2328; --mut:#59636e; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1180px; margin:0 auto; padding:28px 18px 64px; }
  h1 { font-size:22px; margin:0 0 4px; }
  h1 b { color:var(--accent); }
  .sub { color:var(--mut); margin:0 0 16px; max-width:70ch; }
  .axes { display:flex; gap:18px; flex-wrap:wrap; margin:0 0 18px; font-size:12.5px; color:var(--mut); }
  .axes b { color:var(--fg); }
  .stats { display:flex; gap:10px; flex-wrap:wrap; margin:0 0 20px; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:9px; padding:8px 12px; }
  .stat b { font-size:18px; }
  .stat span { color:var(--mut); margin-left:6px; font-size:12.5px; }
  .toolbar { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 24px; align-items:center; }
  .toolbar button { background:var(--panel); color:var(--fg); border:1px solid var(--line);
    border-radius:7px; padding:6px 11px; font:inherit; cursor:pointer; }
  .toolbar button.on { border-color:var(--accent); color:var(--accent); }
  .ring { margin:0 0 30px; }
  .ring-head { display:flex; align-items:center; gap:10px; border-bottom:1px solid var(--line); padding-bottom:8px; }
  .ring-head h2 { font-size:17px; margin:0; }
  .ring-count { margin-left:auto; color:var(--mut); font-size:12.5px; font-variant-numeric:tabular-nums; }
  .ring-blurb { color:var(--mut); margin:8px 0 14px; }
  .ring-dot { width:11px; height:11px; border-radius:50%; display:inline-block; }
  .ring-caret,.ring-dot.ring-caret { background:var(--caret); }
  .ring-file,.ring-dot.ring-file { background:var(--file); }
  .ring-project,.ring-dot.ring-project { background:var(--project); }
  .ring-data,.ring-dot.ring-data { background:var(--data); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:11px; padding:14px 15px; }
  .card.diff { border-color:color-mix(in srgb, var(--accent) 45%, var(--line)); }
  .card.tofilm { border-left:3px solid var(--film); }
  .card.roadmap { opacity:.6; border-style:dashed; }
  .card-head { display:flex; align-items:flex-start; gap:8px; margin-bottom:9px; }
  .card-head h3 { font-size:15px; margin:0; }
  .badges { margin-left:auto; display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
  .badge { font-size:10.5px; padding:2px 7px; border-radius:20px; white-space:nowrap; }
  .badge.diff { color:var(--accent); border:1px solid color-mix(in srgb,var(--accent) 50%,transparent); }
  .badge.tofilm { color:var(--film); border:1px solid color-mix(in srgb,var(--film) 55%,transparent); }
  .badge.roadmap { color:var(--mut); border:1px solid var(--line); }
  .chips { display:flex; flex-wrap:wrap; gap:5px; margin-bottom:10px; }
  .chip { font-size:11px; padding:2px 8px; border-radius:6px; background:var(--panel2); border:1px solid var(--line); color:var(--mut); }
  .chip.prov { color:var(--fg); border-color:color-mix(in srgb,var(--fg) 25%,var(--line)); }
  .chip.sym { color:var(--accent); }
  .chip.meta { opacity:.8; }
  .pitch { margin:0 0 6px; font-weight:500; }
  .pain { margin:0; color:var(--mut); font-size:13px; }
  .comps { margin-top:40px; }
  .comps > h2 { font-size:18px; border-bottom:1px solid var(--line); padding-bottom:8px; }
  .comp { background:var(--panel); border:1px solid var(--line); border-radius:11px; padding:16px 17px; margin:16px 0; }
  .comp-head { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  .comp-head h3 { margin:0; font-size:16px; }
  .purpose { font-size:11px; color:var(--accent); border:1px solid color-mix(in srgb,var(--accent) 50%,transparent); padding:1px 7px; border-radius:20px; margin-left:4px; }
  .comp-head code { margin-left:auto; color:var(--mut); font-size:12.5px; background:var(--panel2); padding:3px 8px; border-radius:6px; }
  .comp-desc { color:var(--mut); margin:9px 0 12px; }
  .reel { list-style:none; display:flex; flex-wrap:wrap; gap:7px; padding:0; margin:6px 0 12px; counter-reset:step; }
  .reel li { position:relative; padding:6px 11px 6px 24px; border-radius:7px; background:var(--panel2);
    border:1px solid var(--line); border-left-width:3px; font-size:13px; }
  .reel li.ring-caret { border-left-color:var(--caret); }
  .reel li.ring-file { border-left-color:var(--file); }
  .reel li.ring-project { border-left-color:var(--project); }
  .reel li.ring-data { border-left-color:var(--data); }
  .reel li::before { counter-increment:step; content:counter(step); position:absolute; left:8px; top:50%;
    transform:translateY(-50%); color:var(--mut); font-size:10.5px; font-variant-numeric:tabular-nums; }
  .comp-meta { color:var(--mut); font-size:12.5px; }
  body.only-diff .card:not(.diff) { display:none; }
  body.only-tofilm .card:not(.tofilm) { display:none; }
  footer { color:var(--mut); font-size:12px; margin-top:40px; border-top:1px solid var(--line); padding-top:14px; }
  code.k { background:var(--panel2); padding:1px 5px; border-radius:5px; }
</style>
</head>
<body>
<div class="wrap">
  <h1><b>dbt Anvil</b> — Demo Feature Map</h1>
  <p class="sub">Features are the reusable atoms; compositions are playlists over them. One capture films every feature; each video is a selection.</p>

  <div class="axes">
    <span><b>shipped</b> — in the product today (build status)</span>
    <span><b>filmed</b> — has demo footage (demo status)</span>
    <span><span class="badge tofilm">▶ ready to film</span> = shipped, no footage yet — a filming TODO, not roadmap</span>
  </div>

  <div class="stats">
    <div class="stat"><b>${features.length}</b><span>features</span></div>
    <div class="stat"><b>${filmed.length}</b><span>filmed</span></div>
    <div class="stat"><b>${toFilm.length}</b><span>ready&nbsp;to&nbsp;film</span></div>
    ${roadmapStat}
    <div class="stat"><b>${diffs.length}</b><span>beyond&nbsp;LSP</span></div>
    <div class="stat"><b>${compositions.length}</b><span>videos</span></div>
  </div>

  <div class="toolbar">
    <button id="f-all" class="on">All features</button>
    <button id="f-diff">◆ Beyond-LSP only</button>
    <button id="f-tofilm">▶ Needs filming</button>
    <span style="margin-left:auto;color:var(--mut);font-size:12.5px">Rings:
      <span class="ring-dot ring-caret"></span> caret
      <span class="ring-dot ring-file"></span> file
      <span class="ring-dot ring-project"></span> project
      <span class="ring-dot ring-data"></span> data
    </span>
  </div>

  ${rings.map(ringSection).join('')}

  <div class="comps">
    <h2>Compositions — the videos</h2>
    ${compositions.map(compCard).join('')}
  </div>

  <footer>
    Generated from <code class="k">scripts/demo/features.json</code> + <code class="k">scripts/demo/compositions.json</code>
    by <code class="k">node scripts/demo/build-feature-map.mjs</code>. Edit the JSON, re-run to refresh.
  </footer>
</div>
<script>
  const b = document.body, btn = (id) => document.getElementById(id);
  function setMode(mode) {
    b.classList.toggle('only-diff', mode === 'diff');
    b.classList.toggle('only-tofilm', mode === 'tofilm');
    btn('f-all').classList.toggle('on', mode === 'all');
    btn('f-diff').classList.toggle('on', mode === 'diff');
    btn('f-tofilm').classList.toggle('on', mode === 'tofilm');
  }
  btn('f-all').onclick = () => setMode('all');
  btn('f-diff').onclick = () => setMode(b.classList.contains('only-diff') ? 'all' : 'diff');
  btn('f-tofilm').onclick = () => setMode(b.classList.contains('only-tofilm') ? 'all' : 'tofilm');
</script>
</body>
</html>
`;

const outPath = path.join(__dirname, 'feature-map.html');
fs.writeFileSync(outPath, html);
const relOut = path.relative(path.resolve(__dirname, '../..'), outPath).replace(/\\/g, '/');
console.log(`Feature map written: ${relOut}`);
console.log(`  ${features.length} features — ${filmed.length} filmed, ${toFilm.length} ready to film, ${roadmap.length} roadmap, ${diffs.length} beyond-LSP · ${compositions.length} compositions`);
