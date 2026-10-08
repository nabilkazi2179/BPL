// Colourful team-squad PDF: banner in the team's colours (taken from the uploaded logo, or the
// same colour the team's monogram crest uses), logo, owner name, budget boxes and a neatly aligned
// table: # | Photo | Name | Role | Mobile | Location | Remarks (tag + price).

const CLUB_COLORS = [
  { bg: '#7E2718', trim: '#E4CE9A' },
  { bg: '#163422', trim: '#C79A46' },
  { bg: '#2C4A63', trim: '#E4CE9A' },
  { bg: '#7A5A2E', trim: '#F3EEDD' },
  { bg: '#4A1F44', trim: '#C79A46' },
  { bg: '#1F4A3C', trim: '#E4CE9A' },
  { bg: '#8C4A1E', trim: '#F3EEDD' },
  { bg: '#2E2E38', trim: '#C79A46' },
];

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
  return Math.abs(h);
}
function monogram(name) {
  const w = (name || '').trim().split(/\s+/).filter(Boolean);
  if (w.length >= 2) return (w[0][0] + w[1][0]).toUpperCase();
  return (w[0] || '??').slice(0, 2).toUpperCase();
}

// ---- colour helpers ----
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex(r, g, b) { return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
function mix(hexA, hexB, t) { const a = hexToRgb(hexA), b = hexToRgb(hexB); return rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t); }
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  let r, g, b;
  if (s === 0) { r = g = b = l; } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3);
  }
  return rgbToHex(r * 255, g * 255, b * 255);
}

function themeFromPalette(bg, accent) {
  return { bg, accent, accentText: mix(accent, '#FFFFFF', 0.35), tint: mix(bg, '#FFFFFF', 0.92), tintStrong: mix(bg, '#FFFFFF', 0.82) };
}

// Pull the two most prominent colourful hues out of the logo and turn them into a theme.
async function themeFromLogo(buf, fallbackName) {
  try {
    const sharp = require('sharp');
    const { data } = await sharp(buf).resize(48, 48, { fit: 'cover' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;
      const [h, s, l] = rgbToHsl(r, g, b);
      if (l > 0.93 || l < 0.07 || s < 0.22) continue; // skip white / black / grey
      const key = Math.round(h / 20) % 18;
      const w = s * s;
      const e = buckets.get(key) || { w: 0, r: 0, g: 0, b: 0, h: 0 };
      e.w += w; e.r += r * w; e.g += g * w; e.b += b * w; e.h = key * 20;
      buckets.set(key, e);
    }
    const list = [...buckets.values()].filter(e => e.w > 0).sort((a, b) => b.w - a.w);
    if (list.length === 0) throw new Error('no colourful pixels');
    const avg = e => rgbToHsl(e.r / e.w, e.g / e.w, e.b / e.w);
    const [ph, ps, pl] = avg(list[0]);
    const bg = hslToHex(ph, Math.max(ps, 0.4), Math.min(Math.max(pl, 0.2), 0.36)); // dark enough for white text
    let accent;
    const second = list.slice(1).find(e => { const d = Math.abs(e.h - list[0].h); return Math.min(d, 360 - d) >= 40; });
    if (second) { const [h2, s2] = avg(second); accent = hslToHex(h2, Math.max(s2, 0.55), 0.6); }
    else accent = hslToHex(ph, 0.6, 0.72);
    return themeFromPalette(bg, accent);
  } catch (e) {
    const c = CLUB_COLORS[hashStr(fallbackName || '') % CLUB_COLORS.length];
    return themeFromPalette(c.bg, c.trim);
  }
}

const TAG_STYLE = {
  'Owner':        { bg: null,       fg: '#FFFFFF' }, // team colour
  'Captain':      { bg: '#C79A46',  fg: '#2B1B00' },
  'Batsman Pick': { bg: '#B3261E',  fg: '#FFFFFF' },
  'Bowler Pick':  { bg: '#1F5FA8',  fg: '#FFFFFF' },
  '':             { bg: '#7A7A7A',  fg: '#FFFFFF' },
};

function rs(n) { return 'Rs ' + Number(n || 0).toLocaleString('en-IN'); }

async function renderTeamPdf(doc, { owner, squad, photos, logoBuf, brand }) {
  brand = brand || { line1: 'BORLI PREMIER LEAGUE', line2: 'SEASON 2', presenter: 'Sidra and Devansh Sports', dateText: 'January 2027' };
  const brandTitle = `${brand.line1} ${brand.line2}`.trim();
  const teamName = owner.team_name || owner.name;
  const theme = logoBuf ? await themeFromLogo(logoBuf, teamName)
    : (() => { const c = CLUB_COLORS[hashStr(teamName) % CLUB_COLORS.length]; return themeFromPalette(c.bg, c.trim); })();

  const PW = doc.page.width, PH = doc.page.height;
  const M = 30, UW = PW - M * 2;
  const cols = [
    { key: 'no', label: '#', w: 28, align: 'center' },
    { key: 'photo', label: '', w: 46, align: 'center' },
    { key: 'name', label: 'PLAYER NAME', w: 172 },
    { key: 'role', label: 'ROLE', w: 112 },
    { key: 'mobile', label: 'MOBILE', w: 98 },
    { key: 'loc', label: 'LOCATION', w: 130 },
    { key: 'rem', label: 'REMARKS / PRICE', w: UW - (28 + 46 + 172 + 112 + 98 + 130) },
  ];
  let cx = M; cols.forEach(c => { c.x = cx; cx += c.w; });

  const HEADER_H = 24, ROW_H = 44, BOTTOM = PH - 42;

  function fitText(text, x, y, w, font, size, color, opts) {
    doc.font(font).fontSize(size).fillColor(color);
    let t = String(text || '');
    if (doc.widthOfString(t) > w) {
      while (t.length > 1 && doc.widthOfString(t + '...') > w) t = t.slice(0, -1);
      t = t.trimEnd() + '...';
    }
    doc.text(t, x, y, Object.assign({ width: w, lineBreak: false }, opts || {}));
  }

  // ---------- banner ----------
  const BANNER_H = 104;
  doc.rect(0, 0, PW, BANNER_H).fill(theme.bg);
  doc.rect(0, BANNER_H, PW, 5).fill(theme.accent);
  // soft decorative circles
  doc.save(); doc.fillOpacity(0.07).fillColor('#FFFFFF');
  doc.circle(PW - 40, -10, 90).fill(); doc.circle(PW - 150, BANNER_H + 20, 60).fill(); doc.restore();

  // logo / crest
  const lcx = M + 46, lcy = BANNER_H / 2, lr = 38;
  doc.circle(lcx, lcy, lr + 3).fill('#FFFFFF');
  let drewLogo = false;
  if (logoBuf) {
    try {
      doc.save(); doc.circle(lcx, lcy, lr).clip();
      doc.image(logoBuf, lcx - lr, lcy - lr, { width: lr * 2, height: lr * 2 });
      doc.restore(); drewLogo = true;
    } catch (e) { doc.restore(); }
  }
  if (!drewLogo) {
    doc.circle(lcx, lcy, lr).fill(theme.bg);
    doc.circle(lcx, lcy, lr - 4).lineWidth(1.2).strokeColor(theme.accent).stroke();
    doc.font('Helvetica-Bold').fontSize(26).fillColor(theme.accent)
      .text(monogram(teamName), lcx - lr, lcy - 10, { width: lr * 2, align: 'center', lineBreak: false });
  }

  // right-hand budget boxes
  const boxes = [
    ['BUDGET', rs(owner.budget_total)],
    ['SPENT', rs(owner.budget_spent)],
    ['REMAINING', rs(Number(owner.budget_total) - Number(owner.budget_spent))],
    ['PLAYERS', String(squad.length)],
  ];
  const bw = 88, bh = 46, gap = 8;
  const bx0 = PW - M - (bw * boxes.length + gap * (boxes.length - 1));
  boxes.forEach((b, i) => {
    const x = bx0 + i * (bw + gap), y = (BANNER_H - bh) / 2;
    doc.save(); doc.fillOpacity(0.16).roundedRect(x, y, bw, bh, 6).fill('#FFFFFF'); doc.restore();
    doc.roundedRect(x, y, bw, bh, 6).lineWidth(0.6).strokeOpacity(0.5).strokeColor(theme.accentText).stroke().strokeOpacity(1);
    doc.font('Helvetica').fontSize(7.5).fillColor(theme.accentText).text(b[0], x, y + 9, { width: bw, align: 'center', lineBreak: false, characterSpacing: 1 });
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF').text(b[1], x, y + 22, { width: bw, align: 'center', lineBreak: false });
  });

  // titles
  const tx = lcx + lr + 22, tw = bx0 - tx - 16;
  doc.font('Helvetica').fontSize(8).fillColor(theme.accentText)
    .text(`${brandTitle}  |  ${brand.presenter}`.toUpperCase(), tx, 17, { width: tw, lineBreak: false, characterSpacing: 1 });
  let ts = 28; doc.font('Helvetica-Bold').fontSize(ts);
  while (ts > 15 && doc.widthOfString(teamName) > tw) { ts -= 1; doc.fontSize(ts); }
  doc.fillColor('#FFFFFF').text(teamName, tx, 32, { width: tw, lineBreak: false });
  doc.font('Helvetica').fontSize(10.5).fillColor(theme.accentText).text('OWNER', tx, 71, { lineBreak: false, characterSpacing: 1.5 });
  const ow = doc.widthOfString('OWNER') + 14;
  fitText(owner.name, tx + ow, 67, tw - ow, 'Helvetica-Bold', 17, '#FFFFFF');

  // ---------- table ----------
  let y = BANNER_H + 5 + 16;

  function drawTableHeader() {
    doc.rect(M, y, UW, HEADER_H).fill(theme.bg);
    cols.forEach(c => {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF')
        .text(c.label, c.x + (c.align === 'center' ? 0 : 8), y + 8, { width: c.w - (c.align === 'center' ? 0 : 12), align: c.align || 'left', lineBreak: false, characterSpacing: 0.6 });
    });
    doc.rect(M, y + HEADER_H, UW, 2).fill(theme.accent);
    y += HEADER_H + 2;
  }
  drawTableHeader();

  if (squad.length === 0) {
    doc.font('Helvetica').fontSize(12).fillColor('#666').text('No players bought yet.', M, y + 24, { width: UW, align: 'center' });
  }

  for (let i = 0; i < squad.length; i++) {
    if (y + ROW_H > BOTTOM) {
      doc.addPage();
      y = M;
      drawTableHeader();
    }
    const p = squad[i];
    if (i % 2 === 0) doc.rect(M, y, UW, ROW_H).fill(theme.tint); else doc.rect(M, y, UW, ROW_H).fill('#FFFFFF');
    doc.moveTo(M, y + ROW_H).lineTo(M + UW, y + ROW_H).lineWidth(0.4).strokeColor(theme.tintStrong).stroke();

    const mid = y + ROW_H / 2;
    const is48 = p.age_category === '48 Plus';
    const tag = p.pick_tag || '';

    // #
    fitText(String(i + 1), cols[0].x, mid - 5, cols[0].w, 'Helvetica-Bold', 10, '#888', { align: 'center' });
    // photo (round, with team-colour ring)
    const pcx = cols[1].x + cols[1].w / 2, pr = 17;
    doc.circle(pcx, mid, pr + 1.5).fill(theme.accent);
    if (photos[i]) {
      try { doc.save(); doc.circle(pcx, mid, pr).clip(); doc.image(photos[i], pcx - pr, mid - pr, { width: pr * 2, height: pr * 2 }); doc.restore(); }
      catch (e) { doc.restore(); doc.circle(pcx, mid, pr).fill('#DDD'); }
    } else { doc.circle(pcx, mid, pr).fill('#DDD'); }
    // name
    fitText(p.name + (is48 ? '  (48+)' : ''), cols[2].x + 8, mid - 7, cols[2].w - 12, 'Helvetica-Bold', 11.5, is48 ? '#CC0000' : '#1A1A1A');
    // role, mobile, location
    fitText(p.role || '-', cols[3].x + 8, mid - 5.5, cols[3].w - 12, 'Helvetica', 10, '#333');
    fitText(p.mobile || '-', cols[4].x + 8, mid - 5.5, cols[4].w - 12, 'Helvetica', 10.5, '#333');
    fitText(p.location || '-', cols[5].x + 8, mid - 5.5, cols[5].w - 12, 'Helvetica', 10, '#333');
    // remarks: tag badge + price
    const st = TAG_STYLE[tag] || TAG_STYLE[''];
    const label = tag || 'Auction Buy';
    doc.font('Helvetica-Bold').fontSize(8.5);
    const bwid = doc.widthOfString(label.toUpperCase()) + 16;
    const rx = cols[6].x + 8;
    doc.roundedRect(rx, mid - 15, bwid, 14, 7).fill(st.bg || theme.bg);
    doc.fillColor(st.fg).text(label.toUpperCase(), rx, mid - 11.5, { width: bwid, align: 'center', lineBreak: false });
    const price = tag === 'Owner' ? 'Rs 0' : rs(p.sold_price);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1A1A1A').text(price, rx, mid + 2, { width: cols[6].w - 12, lineBreak: false });
    y += ROW_H;
  }

  // ---------- footer on every page ----------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // stop PDFKit from spilling a new page for footer text
    doc.moveTo(M, PH - 30).lineTo(PW - M, PH - 30).lineWidth(0.6).strokeColor(theme.accent).stroke();
    doc.font('Helvetica').fontSize(8).fillColor('#777')
      .text(`${brandTitle}  •  ${teamName}  •  Owner: ${owner.name}`, M, PH - 23, { width: UW - 260, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#9A7B1C').text('MADE BY', PW - M - 240, PH - 20, { width: 34, lineBreak: false, characterSpacing: 1 });
    try { doc.image(require('path').join(__dirname, 'public', 'konkantech-logo.jpg'), PW - M - 200, PH - 27, { height: 20 }); } catch (e) {}
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, PW - M - 90, PH - 23, { width: 90, align: 'right', lineBreak: false });
  }
}

module.exports = { renderTeamPdf };
