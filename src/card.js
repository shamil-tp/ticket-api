/**
 * shamiltp.me — Dynamic Boarding Pass PNG Renderer for Cloudflare Workers
 * Place this file at: src/card.js
 *
 * Install dependency:
 *   npm install @resvg/resvg-wasm
 *   (or: bun add @resvg/resvg-wasm)
 */

import { Resvg, initWasm } from '@resvg/resvg-wasm';
import resvgWasm from '../node_modules/@resvg/resvg-wasm/index_bg.wasm';

const FONT_URL =
  'https://cdn.jsdelivr.net/gh/JetBrains/JetBrainsMono@v2.304/fonts/ttf/JetBrainsMono-Bold.ttf';

let wasmInitialized = false;
let cachedFontBytes = null;

async function ensureResvgReady() {
  if (!wasmInitialized) {
    await initWasm(resvgWasm);
    wasmInitialized = true;
  }
  if (!cachedFontBytes) {
    const res = await fetch(FONT_URL, { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!res.ok) throw new Error(`Failed to fetch font: ${res.status}`);
    cachedFontBytes = new Uint8Array(await res.arrayBuffer());
  }
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fitTextAndFont(rawText, maxPx, baseSize, minSize = 10, charRatio = 0.62) {
  const str = String(rawText || '').trim();
  const len = Math.max(1, str.length);
  const est = len * baseSize * charRatio;
  const fs = est <= maxPx ? baseSize : Number(Math.max(minSize, maxPx / (len * charRatio)).toFixed(1));
  const maxChars = Math.max(4, Math.floor(maxPx / (fs * charRatio)));
  const clipped = str.length > maxChars ? str.slice(0, maxChars - 1) + '...' : str;
  return { text: escapeXml(clipped), fontSize: fs };
}

function buildQrCodeSvgGroup(payload, x, y, size, color, bgColor, initials = 'TP') {
  const N = 21;
  const grid = Array.from({ length: N }, () => Array(N).fill(false));
  const reserved = Array.from({ length: N }, () => Array(N).fill(false));

  function placeFinder(r0, c0) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr >= 0 && rr < N && cc >= 0 && cc < N) {
          reserved[rr][cc] = true;
          const inOuter =
            r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
          const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          grid[rr][cc] = inOuter || inInner;
        }
      }
    }
  }

  placeFinder(0, 0);
  placeFinder(0, N - 7);
  placeFinder(N - 7, 0);

  for (let i = 8; i < N - 8; i++) {
    reserved[6][i] = true;
    reserved[i][6] = true;
    grid[6][i] = i % 2 === 0;
    grid[i][6] = i % 2 === 0;
  }

  const text = String(payload || 'https://shamiltp.me').trim();
  let h1 = 2166136261;
  let h2 = 16777619;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 16777619);
    h2 ^= ch + i * 31;
    h2 = Math.imul(h2, 1103515245);
  }

  let bitIdx = 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!reserved[r][c]) {
        const charCode = text.charCodeAt(bitIdx % text.length) || 88;
        const mix =
          (h1 >>> (bitIdx % 16)) ^
          (h2 >>> ((r * 7 + c * 13) % 16)) ^
          (charCode * (r + 3) * (c + 5));
        grid[r][c] = Math.abs(mix) % 11 < 5;
        bitIdx++;
      }
    }
  }

  const cell = size / N;
  let shapes = '';
  const finderCoords = [[0, 0], [0, N - 7], [N - 7, 0]];
  const isFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= N - 7) || (r >= N - 7 && c < 7);
  const isCenter = (r, c) => r >= 8 && r <= 12 && c >= 8 && c <= 12;

  for (const [fr, fc] of finderCoords) {
    const fx = x + fc * cell;
    const fy = y + fr * cell;
    const sw = cell * 0.92;
    shapes += `<rect x="${(fx + sw / 2).toFixed(2)}" y="${(fy + sw / 2).toFixed(2)}" width="${(7 * cell - sw).toFixed(2)}" height="${(7 * cell - sw).toFixed(2)}" rx="${(cell * 0.42).toFixed(2)}" fill="none" stroke="${color}" stroke-width="${sw.toFixed(2)}" />`;
    shapes += `<rect x="${(x + (fc + 2) * cell).toFixed(2)}" y="${(y + (fr + 2) * cell).toFixed(2)}" width="${(3 * cell).toFixed(2)}" height="${(3 * cell).toFixed(2)}" rx="${(cell * 0.24).toFixed(2)}" fill="${color}" />`;
  }

  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (isFinder(r, c) || isCenter(r, c) || !grid[r][c]) continue;
      shapes += `<rect x="${(x + c * cell).toFixed(2)}" y="${(y + r * cell).toFixed(2)}" width="${(cell * 0.9).toFixed(2)}" height="${(cell * 0.9).toFixed(2)}" rx="${(cell * 0.22).toFixed(2)}" fill="${color}" />`;
    }
  }

  shapes += `<rect x="${(x + 8 * cell).toFixed(2)}" y="${(y + 8 * cell).toFixed(2)}" width="${(5 * cell).toFixed(2)}" height="${(5 * cell).toFixed(2)}" rx="${(cell * 0.8).toFixed(2)}" fill="${color}" />`;
  shapes += `<text x="${(x + 10.5 * cell).toFixed(2)}" y="${(y + 11.15 * cell).toFixed(2)}" text-anchor="middle" font-family="JetBrains Mono" font-weight="700" font-size="${(cell * 1.65).toFixed(2)}" fill="${bgColor}">${escapeXml(initials)}</text>`;
  return `<g>${shapes}</g>`;
}

function buildBarcode1D(seedStr, x, y, width, height, color) {
  const s = String(seedStr || 'TKT-808');
  let bars = '';
  let cursor = x;
  const endX = x + width;
  let idx = 0;
  while (cursor < endX - 4) {
    const code = s.charCodeAt(idx % s.length) + idx * 17;
    const barW = code % 3 === 0 ? 4.0 : code % 2 === 0 ? 2.2 : 1.2;
    const gapW = (code >> 2) % 3 === 0 ? 3.0 : 1.8;
    if (cursor + barW <= endX) {
      bars += `<rect x="${cursor.toFixed(1)}" y="${y}" width="${barW.toFixed(1)}" height="${height}" fill="${color}" />`;
    }
    cursor += barW + gapW;
    idx++;
  }
  return `<g>${bars}</g>`;
}

export function buildBoardingPassSvg(ticket, ticketUrl) {
  const bg = '#1E1E27';
  const fg = '#DF0139';
  const ink = '#F5F5F0';

  const ticketId = ticket.ticket_id || 'TKT-0000';
  const visitorName = (ticket.visitor_name || 'GUEST VISITOR').toUpperCase();
  const statusLabel = (ticket.status || 'AI_REPLIED').replace('_', ' ');
  const maskedEmail = (ticket.masked_email || 'HIDDEN').toUpperCase();
  const maskedPhone = (ticket.masked_phone || 'N/A').toUpperCase();

  const parts = visitorName.split(/\s+/);
  const initials = `${(parts[0] || 'S')[0]}${(parts[1] || parts[0] || 'T')[0]}`;

  const codeFit = fitTextAndFont(ticketId, 340, 56, 30);
  const nameFit = fitTextAndFont(visitorName, 480, 24, 14);
  const statusFit = fitTextAndFont(statusLabel, 165, 13, 9.5);
  const emailFit = fitTextAndFont(maskedEmail, 170, 12, 9);
  const phoneFit = fitTextAndFont(maskedPhone, 138, 12, 9);

  const qr = buildQrCodeSvgGroup(ticketUrl, 554, 268, 88, fg, bg, initials);
  const barcode = buildBarcode1D(ticketId + visitorName, 108, 276, 396, 58, fg);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 420" width="700" height="420">
    <rect x="0" y="0" width="700" height="420" fill="${bg}" />
    <rect x="14" y="14" width="672" height="392" fill="none" stroke="${fg}" stroke-width="5" />
    <text x="36" y="88" font-family="JetBrains Mono" font-weight="700" font-size="${codeFit.fontSize}" fill="${fg}">${codeFit.text}</text>
    <text x="38" y="132" font-family="JetBrains Mono" font-weight="700" font-size="${nameFit.fontSize}" fill="${ink}">${nameFit.text}</text>
    <line x1="556" y1="28" x2="556" y2="140" stroke="${fg}" stroke-width="3" stroke-dasharray="6,6" />
    <rect x="588" y="34" width="56" height="56" fill="none" stroke="${fg}" stroke-width="3.8" />
    <path d="M604 74 L628 50 M610 50 H628 V68" fill="none" stroke="${fg}" stroke-width="4" stroke-linecap="square" />
    <text x="616" y="114" text-anchor="middle" font-family="JetBrains Mono" font-weight="700" font-size="12" fill="${fg}">PASS</text>
    <line x1="36" y1="150" x2="664" y2="150" stroke="${fg}" stroke-width="3" />
    <rect x="36" y="160" width="234" height="46" fill="none" stroke="${fg}" stroke-width="3.2" />
    <line x1="168" y1="160" x2="168" y2="206" stroke="${fg}" stroke-width="3.2" />
    <text x="102" y="193" text-anchor="middle" font-family="JetBrains Mono" font-weight="700" font-size="28" fill="${fg}">STP</text>
    <path d="M222 195 L244 173 M228 173 H244 V189" fill="none" stroke="${fg}" stroke-width="4" />
    <text x="288" y="179" font-family="JetBrains Mono" font-weight="700" font-size="14" fill="${ink}">INQUIRY // SHAMILTP.ME</text>
    <text x="288" y="201" font-family="JetBrains Mono" font-weight="700" font-size="14" letter-spacing="3" fill="${fg}">////////////</text>
    <line x1="556" y1="160" x2="556" y2="206" stroke="${fg}" stroke-width="3" />
    <rect x="584" y="160" width="76" height="46" fill="${fg}" />
    <text x="622" y="189" text-anchor="middle" font-family="JetBrains Mono" font-weight="700" font-size="15" fill="${bg}">LIVE</text>
    <g transform="translate(36, 218)">
      <rect x="0" y="0" width="82" height="32" fill="${fg}" />
      <line x1="10" y1="32" x2="34" y2="0" stroke="${bg}" stroke-width="5.5" />
      <line x1="34" y1="32" x2="58" y2="0" stroke="${bg}" stroke-width="5.5" />
      <line x1="58" y1="32" x2="82" y2="0" stroke="${bg}" stroke-width="5.5" />
    </g>
    <text x="134" y="230" font-family="JetBrains Mono" font-weight="700" font-size="10" fill="${fg}">STATUS:</text>
    <text x="134" y="247" font-family="JetBrains Mono" font-weight="700" font-size="${statusFit.fontSize}" fill="${ink}">${statusFit.text}</text>
    <line x1="312" y1="218" x2="312" y2="252" stroke="${fg}" stroke-width="2" />
    <text x="326" y="230" font-family="JetBrains Mono" font-weight="700" font-size="10" fill="${fg}">EMAIL:</text>
    <text x="326" y="247" font-family="JetBrains Mono" font-weight="700" font-size="${emailFit.fontSize}" fill="${ink}">${emailFit.text}</text>
    <line x1="504" y1="218" x2="504" y2="252" stroke="${fg}" stroke-width="2" />
    <text x="518" y="230" font-family="JetBrains Mono" font-weight="700" font-size="10" fill="${fg}">TEL:</text>
    <text x="518" y="247" font-family="JetBrains Mono" font-weight="700" font-size="${phoneFit.fontSize}" fill="${ink}">${phoneFit.text}</text>
    <line x1="36" y1="260" x2="664" y2="260" stroke="${fg}" stroke-width="2.5" />
    <rect x="36" y="276" width="56" height="58" fill="${fg}" />
    <circle cx="64" cy="305" r="18" fill="none" stroke="${bg}" stroke-width="2" />
    <ellipse cx="64" cy="305" rx="8.5" ry="18" fill="none" stroke="${bg}" stroke-width="1.6" />
    <line x1="46" y1="305" x2="82" y2="305" stroke="${bg}" stroke-width="1.6" />
    ${barcode}
    <text x="108" y="350" font-family="JetBrains Mono" font-weight="700" font-size="10.5" fill="${fg}">VIEW LIVE THREAD // SHAMILTP.ME</text>
    <line x1="526" y1="266" x2="526" y2="358" stroke="${fg}" stroke-width="2" />
    ${qr}
    <rect x="14" y="366" width="672" height="40" fill="${fg}" />
    <text x="36" y="391" font-family="JetBrains Mono" font-weight="700" font-size="13" fill="${bg}">&gt;&gt;&gt; VERIFIED INQUIRY BOARDING PASS // ${escapeXml(ticketId)}</text>
  </svg>`;
}

export async function renderTicketCardPng(ticket, ticketUrl) {
  await ensureResvgReady();
  const svg = buildBoardingPassSvg(ticket, ticketUrl);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1400 },
    font: {
      fontBuffers: [cachedFontBytes],
      defaultFontFamily: 'JetBrains Mono',
      loadSystemFonts: false,
    },
  });
  return resvg.render().asPng();
}