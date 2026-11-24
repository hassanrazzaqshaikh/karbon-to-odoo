// KarboSync branding, taken from teakwoodglobal.com: teak brown #513729, wood #946946, sand #A79F8D, linen #E7E2DB,
// Darker Grotesque for the name and headings, Roboto for text. Shared by every page the server renders.

export const APP_NAME = 'KarboSync';
export const TAGLINE = 'Karbon invoices, posted to Odoo';

// White line icon on a rounded wood-brown square, like the icons on teakwoodglobal.com: a "K" inside sync arrows.
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${APP_NAME} logo">
<rect width="64" height="64" rx="15" fill="#946946"/>
<g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5">
<path d="M15.5 22.5A19 19 0 0 1 48.5 22.5"/><path d="M49 15.3 48.5 22.5 42 19.3"/>
<path d="M48.5 41.5A19 19 0 0 1 15.5 41.5"/><path d="M15 48.7 15.5 41.5 22 44.7"/>
<path stroke-width="4" d="M26.5 23.5v17M37.5 23.5 28 32l9.5 8.5"/>
</g>
</svg>`;

const FAVICON = `data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}`;

// Everything a page needs in its <head> for the brand: favicon, theme colour and fonts.
export const BRAND_HEAD = `<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<meta name="theme-color" content="#513729">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Darker+Grotesque:wght@600;700;800&family=Roboto:wght@400;500;700&display=swap">`;

// Colour tokens and base type for the pages. --accent is the brand colour for buttons, links and focus.
export const BRAND_CSS = `
  :root {
    color-scheme: light;
    --bg: #faf8f5; --surface: #ffffff; --panel: #f3efe9; --fg: #2b211b; --muted: #6f6357; --line: #e0d8cd;
    --accent: #513729; --accent-hover: #6b4a37; --accent-fg: #ffffff; --wood: #946946; --sand: #a79f8d;
    --ok: #2f6b1a; --warn: #8a5a00; --bad: #b3261e; --row-hover: #f6f1ea; --focus: rgba(148, 105, 70, 0.35);
    --font-brand: 'Darker Grotesque', 'Segoe UI', system-ui, sans-serif;
    --font-text: Roboto, system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #17120e; --surface: #201914; --panel: #2a211b; --fg: #f1e9e1; --muted: #b5a797; --line: #3d3128;
      --accent: #c9a07a; --accent-hover: #d8b391; --accent-fg: #1d1510; --wood: #b0835c; --sand: #a79f8d;
      --ok: #7cc35d; --warn: #e0aa45; --bad: #f2867e; --row-hover: #261e18; --focus: rgba(201, 160, 122, 0.35);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 var(--font-text); background: var(--bg); color: var(--fg); }
  :focus-visible { outline: 3px solid var(--focus); outline-offset: 1px; }
  .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; color: var(--fg); }
  .brand svg { width: 36px; height: 36px; flex: none; }
  .brand-name { font-family: var(--font-brand); font-weight: 800; font-size: 1.85rem; line-height: 1; letter-spacing: 0.01em; color: var(--accent); }
  .brand-tag { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; }
`;
