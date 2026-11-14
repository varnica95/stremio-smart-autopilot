import { RANKING_PROFILES, SELECTABLE_RESOLUTIONS, type UserPreferences } from '../../core/models/preferences.js';
import { RANKING_PROFILE_DEFINITIONS } from '../../core/ranking/profiles.js';

export interface PageContext {
  publicUrl: string;
  prefs: UserPreferences;
  streamProviders: string[];
  subtitlesEnabled: boolean;
  originalLanguageAvailable: boolean;
  companionEnabled: boolean;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function options(values: readonly string[], selected: string, label: (v: string) => string = (v) => v): string {
  return values.map((v) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label(v))}</option>`).join('');
}

function checkbox(name: keyof UserPreferences, checked: boolean, text: string): string {
  return `<label class="check"><input type="checkbox" name="${name}"${checked ? ' checked' : ''}> ${esc(text)}</label>`;
}

/** Install + configuration page. Pure HTML with a small script that builds the addon URL. */
export function renderConfigurePage(ctx: PageContext): string {
  const p = ctx.prefs;
  const providers = ctx.streamProviders.length ? ctx.streamProviders.map(esc).join(', ') : 'none configured';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Smart AutoPilot · Stremio addon</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --card:#181b22; --text:#e8eaed; --muted:#9aa0a6; --accent:#7b5cff; --ok:#3ecf8e; --warn:#f5a524; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:var(--bg); color:var(--text); }
  main { max-width: 720px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 28px 0 10px; }
  p.lead { color: var(--muted); margin: 0 0 20px; }
  .card { background: var(--card); border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; }
  label { display:block; margin: 10px 0 4px; color: var(--muted); font-size: 13px; }
  label.check { color: var(--text); font-size: 15px; display:flex; gap:8px; align-items:center; }
  select, input[type=text], input[type=number] { width:100%; padding:9px 10px; border-radius:8px; border:1px solid #2c313c; background:#0f1115; color:var(--text); font-size:15px; }
  .row { display:grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .buttons { display:flex; gap:10px; flex-wrap:wrap; margin-top: 18px; }
  button, a.button { appearance:none; border:0; border-radius:8px; padding:11px 16px; font-size:15px; cursor:pointer; text-decoration:none; color:white; background:var(--accent); }
  button.secondary, a.secondary { background:#2c313c; }
  code { background:#0f1115; padding:2px 6px; border-radius:6px; word-break: break-all; }
  ul { padding-left: 18px; margin: 6px 0; } li { margin: 3px 0; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .muted { color: var(--muted); font-size: 13px; }
  @media (max-width: 560px) { .row { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <h1>Smart AutoPilot</h1>
  <p class="lead">Finds streams from your authorized sources, tests them, puts the best one first and picks subtitles in your languages.</p>

  <div class="card">
    <strong>This server</strong>
    <ul>
      <li>Stream sources: ${providers}</li>
      <li>Subtitles: ${ctx.subtitlesEnabled ? '<span class="ok">OpenSubtitles enabled</span>' : '<span class="warn">disabled (set OPENSUBTITLES_API_KEY)</span>'}</li>
      <li>"Original language" subtitles: ${ctx.originalLanguageAvailable ? '<span class="ok">available</span>' : '<span class="warn">needs TMDB_API_KEY; skipped otherwise</span>'}</li>
      <li>Automatic fallback (companion): ${ctx.companionEnabled ? '<span class="ok">on</span>' : 'off'}</li>
    </ul>
    <a class="muted" href="${esc(ctx.publicUrl)}/status">Source status →</a>
  </div>

  <form id="cfg" class="card" onsubmit="return false">
    <h2 style="margin-top:0">Ranking</h2>
    <label for="rankingProfile">Profile</label>
    <select id="rankingProfile" name="rankingProfile">${options(RANKING_PROFILES, p.rankingProfile, (v) => RANKING_PROFILE_DEFINITIONS[v as keyof typeof RANKING_PROFILE_DEFINITIONS].label)}</select>
    <div class="row">
      <div><label for="minResolution">Minimum</label><select id="minResolution" name="minResolution">${options(SELECTABLE_RESOLUTIONS, p.minResolution)}</select></div>
      <div><label for="preferredResolution">Preferred</label><select id="preferredResolution" name="preferredResolution">${options(SELECTABLE_RESOLUTIONS, p.preferredResolution)}</select></div>
      <div><label for="maxResolution">Maximum</label><select id="maxResolution" name="maxResolution">${options(SELECTABLE_RESOLUTIONS, p.maxResolution)}</select></div>
    </div>
    <label for="maxResults">Maximum results</label>
    <input id="maxResults" name="maxResults" type="number" min="1" max="50" value="${p.maxResults}">
    ${checkbox('preferSmallerFiles', p.preferSmallerFiles, 'Prefer smaller files when quality is comparable')}
    ${checkbox('preferCompatibleAudio', p.preferCompatibleAudio, 'Prefer audio that plays everywhere (AAC/AC3 over DTS/TrueHD)')}
    ${checkbox('excludeLowQuality', p.excludeLowQuality, 'Hide CAM, telesync and screener releases')}

    <h2>Subtitles</h2>
    <label for="subtitleLanguages">Languages in priority order (ISO 639-1 codes, "original" = the film's own language)</label>
    <input id="subtitleLanguages" name="subtitleLanguages" type="text" value="${esc(p.subtitleLanguages.join(', '))}">
    <label for="maxSubtitlesPerLanguage">Subtitles per language</label>
    <input id="maxSubtitlesPerLanguage" name="maxSubtitlesPerLanguage" type="number" min="1" max="20" value="${p.maxSubtitlesPerLanguage}">
    <p class="muted">Addons cannot switch subtitles on by themselves. In Stremio open Settings → Player and set the default subtitle language to your first choice (e.g. Croatian); Stremio then turns on the best-matching subtitle automatically.</p>

    <div class="buttons">
      <a id="install" class="button" href="#">Install in Stremio</a>
      <a id="installWeb" class="button secondary" href="#" target="_blank" rel="noopener">Install in Stremio Web</a>
      <button id="copy" class="secondary" type="button">Copy addon URL</button>
    </div>
    <p class="muted">Addon URL: <code id="url"></code></p>
  </form>
</main>
<script>
(function () {
  var base = ${JSON.stringify(ctx.publicUrl)};
  var form = document.getElementById('cfg');
  function config() {
    var data = {};
    ['rankingProfile','minResolution','preferredResolution','maxResolution'].forEach(function (k) { data[k] = form.elements[k].value; });
    data.maxResults = Number(form.elements.maxResults.value) || 10;
    data.maxSubtitlesPerLanguage = Number(form.elements.maxSubtitlesPerLanguage.value) || 3;
    data.subtitleLanguages = form.elements.subtitleLanguages.value.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    ['preferSmallerFiles','preferCompatibleAudio','excludeLowQuality'].forEach(function (k) { data[k] = form.elements[k].checked; });
    return data;
  }
  function update() {
    var url = base + '/' + encodeURIComponent(JSON.stringify(config())) + '/manifest.json';
    document.getElementById('url').textContent = url;
    document.getElementById('install').href = url.replace(/^https?:\\/\\//, 'stremio://');
    document.getElementById('installWeb').href = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(url);
    return url;
  }
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  document.getElementById('copy').addEventListener('click', function () {
    var url = update();
    if (navigator.clipboard) navigator.clipboard.writeText(url);
    this.textContent = 'Copied';
  });
  update();
})();
</script>
</body>
</html>`;
}
