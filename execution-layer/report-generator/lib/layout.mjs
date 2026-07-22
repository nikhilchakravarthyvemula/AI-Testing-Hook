// The page shell — one self-contained HTML file: inline CSS + a few lines of
// inline JS, no external requests (p0-08 §3, acceptance 4). Theme-aware (honours
// the OS, with a manual toggle) and print-friendly (the PDF is this same HTML).

import { esc } from './html.mjs';

export function renderPage({ title, subtitle, tiles = '', nav = [], sections = '' }) {
  const navHtml = nav.map((n) => `<a href="#${esc(n.id)}">${esc(n.label)}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="top__id">
    <h1>${esc(title)}</h1>
    ${subtitle ? `<p class="top__sub">${esc(subtitle)}</p>` : ''}
  </div>
  <button class="theme" onclick="__toggleTheme()" aria-label="Toggle theme">◐</button>
</header>
<nav class="nav">${navHtml}</nav>
${tiles ? `<div class="tiles">${tiles}</div>` : ''}
<main>${sections}</main>
<div id="lightbox" class="lightbox" onclick="this.classList.remove('on')"><img alt="screenshot"></div>
<script>${JS}</script>
</body>
</html>`;
}

const CSS = `
:root{--bg:#fff;--fg:#1a1d21;--muted:#5c636e;--card:#f6f7f9;--line:#e3e6ea;--accent:#2f6fed;
  --ok:#1a7f45;--okbg:#e6f4ec;--bad:#c0392b;--badbg:#fbeae8;--warn:#9a6b00;--warnbg:#fbf1dc;}
:root[data-theme=dark]{--bg:#0f1216;--fg:#e6e8eb;--muted:#9aa2ad;--card:#181c22;--line:#2a2f37;
  --accent:#6ea0ff;--ok:#5ad18a;--okbg:#12241a;--bad:#ff8a7a;--badbg:#2a1613;--warn:#e6b64c;--warnbg:#241d0d;}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1216;--fg:#e6e8eb;--muted:#9aa2ad;
  --card:#181c22;--line:#2a2f37;--accent:#6ea0ff;--ok:#5ad18a;--okbg:#12241a;--bad:#ff8a7a;--badbg:#2a1613;--warn:#e6b64c;--warnbg:#241d0d;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
.top{display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1px solid var(--line);}
.top h1{margin:0;font-size:20px}
.top__sub{margin:2px 0 0;color:var(--muted);font-size:13px}
.theme{background:var(--card);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:6px 10px;cursor:pointer;font-size:16px}
.nav{position:sticky;top:0;z-index:5;display:flex;gap:4px;flex-wrap:wrap;padding:10px 24px;background:var(--bg);border-bottom:1px solid var(--line);}
.nav a{color:var(--muted);text-decoration:none;padding:6px 12px;border-radius:8px;font-size:13px;font-weight:600}
.nav a:hover{background:var(--card);color:var(--fg)}
.tiles{display:flex;gap:12px;flex-wrap:wrap;padding:20px 24px}
.tile{flex:1;min-width:120px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.tile__num{font-size:26px;font-weight:700}
.tile__label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
.tile--ok .tile__num{color:var(--ok)} .tile--bad .tile__num{color:var(--bad)} .tile--warn .tile__num{color:var(--warn)}
main{padding:0 24px 60px;max-width:1100px}
.sec{padding:28px 0;border-bottom:1px solid var(--line)}
.sec__h{font-size:17px;margin:0 0 4px}
.sec__note{color:var(--muted);margin:0 0 14px;font-size:13px}
.empty{color:var(--muted);background:var(--card);border:1px dashed var(--line);border-radius:10px;padding:16px;font-size:14px}
.tbl{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px;display:block;overflow-x:auto}
.tbl th,.tbl td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.tbl th{color:var(--muted);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.03em}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700}
.pill--ok{background:var(--okbg);color:var(--ok)} .pill--bad{background:var(--badbg);color:var(--bad)}
.pill--warn{background:var(--warnbg);color:var(--warn)} .pill--muted{background:var(--card);color:var(--muted)}
.sub{font-weight:700;margin:20px 0 6px;font-size:14px}
.bar{height:8px;border-radius:6px;background:var(--line);overflow:hidden;min-width:60px}
.bar>i{display:block;height:100%;background:var(--accent)}
.shot{width:54px;height:36px;object-fit:cover;border-radius:6px;border:1px solid var(--line);cursor:zoom-in}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.lightbox{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:50;align-items:center;justify-content:center;cursor:zoom-out}
.lightbox.on{display:flex} .lightbox img{max-width:92vw;max-height:92vh;border-radius:8px}
@media print{.nav,.theme,.lightbox{display:none!important}.sec{break-inside:avoid}body{font-size:11px}}
`;

const JS = `
function __toggleTheme(){var r=document.documentElement,d=r.getAttribute('data-theme')==='dark';
  r.setAttribute('data-theme',d?'light':'dark');}
document.addEventListener('click',function(e){var t=e.target;
  if(t.classList&&t.classList.contains('shot')){var lb=document.getElementById('lightbox');
    lb.querySelector('img').src=t.src;lb.classList.add('on');}});
`;
