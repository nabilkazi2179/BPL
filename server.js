// BORLI PREMIER LEAGUE (SEASON 2) - Live Registration Server
// Data is stored in a free hosted Postgres database (Supabase/Neon).
// Photos, payment proofs, and the QR code are stored in Cloudinary (free tier).
// This keeps everything on Render's FREE web service plan — no paid disk needed.

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { renderTeamPdf } = require('./teamPdf');
const fs = require('fs');


// ---------- BRANDING (editable by Admin from the Admin tab, stored in the settings table) ----------
// Tournament title, presenter and date are NOT hard-coded: the Admin tab can change them any time and
// every ID card, PDF, QR text and share-preview picks the new values up automatically.
const DEFAULT_BRAND = {
  line1: 'BORLI PREMIER LEAGUE',
  line2: 'SEASON 2',
  presenter: 'Sidra and Devansh Sports',
  dateText: 'January 2027'
};
let brandCache = null;
async function getBrand() {
  if (brandCache) return brandCache;
  let saved = {};
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'branding'`);
    if (r.rows[0]?.value) saved = JSON.parse(r.rows[0].value);
  } catch (e) {}
  brandCache = { ...DEFAULT_BRAND, ...saved };
  return brandCache;
}
function brandTitle(b) { return `${b.line1} ${b.line2}`.trim(); }
const KT_LOGO_PATH = path.join(__dirname, 'public', 'konkantech-logo.jpg');
const KT_LOGO_RATIO = 707 / 160; // width / height of the KonkanTech logo file

// Shared gold-and-black PDF header with the KonkanTech logo on a white badge
function drawBrandHeader(doc, subtitle, brand) {
  const W = doc.page.width, M = doc.page.margins.left;
  doc.save().rect(0, 0, W, 92).fill('#0B0B0D').restore();
  doc.rect(0, 92, W, 3).fill('#D4AF37');
  const logoH = 36, logoW = logoH * KT_LOGO_RATIO, bx = W - M - logoW - 16, by = 28;
  doc.save().roundedRect(bx, by, logoW + 16, logoH + 12, 8).fill('#FFFFFF').restore();
  doc.fillColor('#D4AF37').font('Helvetica-Bold').fontSize(6.5).text('MADE BY KONKANTECH', bx, by - 11, { width: logoW + 16, align: 'right', characterSpacing: 1, lineBreak: false });
  try { doc.image(KT_LOGO_PATH, bx + 8, by + 6, { height: logoH }); } catch (e) {}
  const tw = bx - M - 14;
  doc.fillColor('#D4AF37').font('Helvetica-Bold').fontSize(8).text(`${brand.presenter} PRESENTS`.toUpperCase(), M, 22, { width: tw, characterSpacing: 1, lineBreak: false });
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(18).text(brand.line1, M, 38, { width: tw, lineBreak: false });
  doc.fillColor('#F3E3A0').font('Helvetica-Bold').fontSize(12).text(`${brand.line2}${brand.dateText ? '  |  ' + brand.dateText : ''}`, M, 62, { width: tw, lineBreak: false });
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(13).text(subtitle, M, 108, { width: W - 2 * M, align: 'center' });
  doc.y = 130;
}

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'legends@2026';
let currentAdminPassword = DEFAULT_ADMIN_PASSWORD; // overridden from DB on startup if a saved password exists
// Super Admin can do everything Admin can, PLUS destructive actions like deleting a registration.
// Regular Admin cannot delete players — this protects against accidental or unauthorized deletions.
const DEFAULT_SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || 'legends@Super2026';
let currentSuperAdminPassword = DEFAULT_SUPERADMIN_PASSWORD;
// Registration auto-closes once this many players are ACTIVE (deleting a player frees a slot).
// Super Admin can force registration open past the cap using the settings toggle below.
// Default is 96 for Borli Premier League Season 2. Super Admin can change it from the Admin tab
// (stored in settings as 'registration_cap'), so it never needs a code change again.
const DEFAULT_REGISTRATION_CAP = 96;
async function getRegCap() {
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'registration_cap'`);
    const n = parseInt(r.rows[0]?.value, 10);
    if (n > 0) return n;
  } catch (e) {}
  return DEFAULT_REGISTRATION_CAP;
}

// Age category defaults to "Under 40" whenever it's missing/invalid — only "40 Plus" players
// need to actively pick something different. Keeps every player's age category always filled,
// which is what makes filtering/exporting by category reliable.
const DEFAULT_AGE_CATEGORY = 'Under 40';
function normalizeAgeCategory(value) {
  return value === '40 Plus' ? '40 Plus' : DEFAULT_AGE_CATEGORY;
}
// Short prefix used for the per-category serial shown on ID cards, rosters, and exports
// (e.g. "U40-007", "40P-003") — separate from the player's DB id / registration number,
// purely so physical cards/lists can be sorted by category at a glance.
function categoryPrefix(ageCategory) {
  return ageCategory === '40 Plus' ? '40P' : 'U40';
}

// Core Pick slots that can be assigned directly to a team, bypassing the live auction.
// This tournament only pre-assigns a Captain (any role) — Batsman Pick / Bowler Pick have been
// removed, so every other player (including future all-rounders/batsmen/bowlers) goes through
// the live auction as usual. No "Retained" flag is required for this — the admin can pick any
// currently Available registered player as a team's Captain, same as assigning an Owner.
const CORE_PICK_ROLES = {
  'Captain': null // null = any role is eligible
};

// ---------- CLOUDINARY (free image storage) ----------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

function uploadToCloudinary(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder }, (err, result) => {
      if (err) reject(err); else resolve(result);
    });
    stream.end(buffer);
  });
}

// Generates a QR code as a data URL, entirely server-side (no browser CDN dependency,
// so it can never silently fail to load on a player's device).
async function generateQrDataUrl(payload) {
  return QRCode.toDataURL(payload, { margin: 0, width: 300, color: { dark: '#1C1B17', light: '#F3EEDD' } });
}

// ---------- OWNER LOGIN CREDENTIAL GENERATION ----------
// Username defaults to the owner's first name. Password defaults to the first 3 letters
// of their first name + "12345". If two owners share a first name, the second one gets
// a trailing number appended ("rajesh", "rajesh1", "rajesh2", ...).
function baseUsernameOf(fullName) {
  const firstName = (fullName || '').trim().split(/\s+/)[0] || 'owner';
  return firstName.replace(/[^a-zA-Z]/g, '').toLowerCase() || 'owner';
}
function generateUniqueUsername(fullName, usedUsernamesLowerSet) {
  const base = baseUsernameOf(fullName);
  if (!usedUsernamesLowerSet.has(base)) return base;
  let n = 1;
  while (usedUsernamesLowerSet.has(base + n)) n++;
  return base + n;
}
function generateDefaultPassword(fullName) {
  const initials = baseUsernameOf(fullName).slice(0, 3).padEnd(3, 'x');
  return initials + '12345';
}

// ---------- DATABASE (free hosted Postgres) ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT NOT NULL,
      mobile TEXT NOT NULL,
      role TEXT NOT NULL,
      photo_url TEXT,
      proof_url TEXT,
      txn_ref TEXT,
      created_at TEXT NOT NULL
    );
  `);
  // Hash of the payment proof image, used to catch the same screenshot being reused across registrations
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS proof_hash TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS owners (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      budget_total NUMERIC NOT NULL DEFAULT 0,
      budget_spent NUMERIC NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  // Owner login password, set by admin when the owner/team is created
  await pool.query(`ALTER TABLE owners ADD COLUMN IF NOT EXISTS owner_password TEXT;`);
  // Owners are always a registered member/player picked by the admin (not a free-typed outside name).
  // This links each owner row back to the players row they were created from.
  await pool.query(`ALTER TABLE owners ADD COLUMN IF NOT EXISTS owner_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL;`);
  // The public-facing team name (shown on the board/ID cards), separate from the owner's personal name.
  await pool.query(`ALTER TABLE owners ADD COLUMN IF NOT EXISTS team_name TEXT;`);
  // Custom team crest uploaded by the admin (Cloudinary URL). NULL means the Teams tab falls
  // back to the auto-generated monogram crest for this team.
  await pool.query(`ALTER TABLE owners ADD COLUMN IF NOT EXISTS logo_url TEXT;`);
  // The username an owner types to log in (auto-generated from their first name, deduped with
  // a trailing number — "rajesh", "rajesh1", "rajesh2" — if two owners share a first name).
  // Kept separate from `name` (their full registered name, still used for display everywhere).
  await pool.query(`ALTER TABLE owners ADD COLUMN IF NOT EXISTS login_username TEXT;`);
  // Tags a player as pre-assigned to a team (Owner / Captain / Batsman Pick / Bowler Pick) rather
  // than won in the live auction. NULL means a normal, auctioned player.
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS pick_tag TEXT;`);
  // Auction-related columns on players (added safely if they don't already exist)
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Available';`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES owners(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS sold_price NUMERIC;`);
  // Age category, chosen at registration: '40 Plus' or 'Under 40'.
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS age_category TEXT;`);
  // Age categories were renamed from 48 -> 40; relabel any rows saved under the old names.
  await pool.query(`UPDATE players SET age_category = '40 Plus' WHERE age_category = '48 Plus';`);
  await pool.query(`UPDATE players SET age_category = 'Under 40' WHERE age_category = 'Under 48';`);
  // Retained: admin-only flag marking a player as kept from a previous season. Only players
  // marked Retained = Yes show up as choices for a team's Captain / Batsman / Bowler core pick.
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS retained BOOLEAN NOT NULL DEFAULT false;`);

  // Backfill login_username for any owners created before this feature existed, so their
  // logins keep working (their existing owner_password, if any, is left untouched).
  const ownersNeedingUsername = await pool.query(
    `SELECT id, name FROM owners WHERE login_username IS NULL OR login_username = ''`
  );
  if (ownersNeedingUsername.rows.length > 0) {
    const existing = await pool.query(`SELECT login_username FROM owners WHERE login_username IS NOT NULL AND login_username != ''`);
    const used = new Set(existing.rows.map(r => r.login_username.toLowerCase()));
    for (const row of ownersNeedingUsername.rows) {
      const username = generateUniqueUsername(row.name, used);
      used.add(username);
      await pool.query(`UPDATE owners SET login_username = $1 WHERE id = $2`, [username, row.id]);
    }
  }

  const saved = await pool.query(`SELECT value FROM settings WHERE key = 'admin_password'`);
  if (saved.rows[0]?.value) {
    currentAdminPassword = saved.rows[0].value;
  }
  const savedSuper = await pool.query(`SELECT value FROM settings WHERE key = 'superadmin_password'`);
  if (savedSuper.rows[0]?.value) {
    currentSuperAdminPassword = savedSuper.rows[0].value;
  }
}

// ---------- APP SETUP ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json());

// The home page is served with the CURRENT branding injected, so the WhatsApp/social link preview
// (title, description, KonkanTech logo) and the very first paint always match what the Admin set.
const escAttr = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
async function sendIndex(req, res) {
  try {
    const b = await getBrand();
    const base = `${req.protocol}://${req.get('host')}`;
    const title = `${brandTitle(b)} — Player Registration`;
    const desc = `${b.presenter} presents ${brandTitle(b)}${b.dateText ? ' · ' + b.dateText : ''}. Made by KonkanTech. Register now.`;
    const tags = [
      `<meta property="og:type" content="website">`,
      `<meta property="og:title" content="${escAttr(title)}">`,
      `<meta property="og:description" content="${escAttr(desc)}">`,
      `<meta property="og:image" content="${base}/konkantech-logo.jpg">`,
      `<meta name="twitter:card" content="summary_large_image">`
    ].join('\n');
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escAttr(title)}</title>\n${tags}`);
    html = html.replace('/*__BRAND_JSON__*/ null', JSON.stringify(b).replace(/</g, '\\u003c'));
    res.type('html').send(html);
  } catch (err) { console.error(err); res.sendFile(path.join(__dirname, 'public', 'index.html')); }
}
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(path.join(__dirname, 'public')));

// multer now holds uploads in memory (not on disk) — they get forwarded straight to Cloudinary
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ---------- ADMIN AUTH MIDDLEWARE ----------
function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-password'] || req.query.pw;
  // Super Admin can do anything a regular Admin can, so either password is accepted here.
  if (pass !== currentAdminPassword && pass !== currentSuperAdminPassword) {
    return res.status(401).json({ error: 'Incorrect admin password.' });
  }
  next();
}

// Reserved for destructive/high-trust actions (e.g. deleting a registration) — the regular
// Admin password is NOT accepted here, only the Super Admin password.
function requireSuperAdmin(req, res, next) {
  const pass = req.headers['x-admin-password'] || req.query.pw;
  if (pass !== currentSuperAdminPassword) {
    return res.status(403).json({ error: 'This action requires the Super Admin password.' });
  }
  next();
}

// ---------- OWNER AUTH MIDDLEWARE ----------
// Owners authenticate with their login username (defaults to their first name) + the
// password the admin set for them. Every owner-facing request re-checks these headers
// against the DB (no server-side sessions to keep things stateless).
async function requireOwner(req, res, next) {
  try {
    const name = req.headers['x-owner-name'];
    const pass = req.headers['x-owner-password'];
    if (!name || !pass) {
      return res.status(401).json({ error: 'Owner login required.' });
    }
    const result = await pool.query(
      `SELECT * FROM owners WHERE LOWER(login_username) = LOWER($1) LIMIT 1`,
      [name]
    );
    const owner = result.rows[0];
    if (!owner || !owner.owner_password || owner.owner_password !== pass) {
      return res.status(401).json({ error: 'Incorrect owner name or password.' });
    }
    req.owner = owner;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not verify owner login.' });
  }
}

// ---------- ROUTES ----------

// Register a new player
app.post('/api/register', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'proof', maxCount: 1 }]), async (req, res) => {
  try {
    const { name, mobile, role, txnRef, ageCategory } = req.body;
    // This league is only for Borli players, so the location is fixed server-side (ignores whatever the browser sends).
    const location = 'Borli';
    if (!name || !mobile || !role) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (!/^\d{10}$/.test(mobile)) {
      return res.status(400).json({ error: 'Mobile number must be 10 digits.' });
    }
    // Defaults to "Under 40" if left unselected/invalid — only "40 Plus" needs an explicit choice.
    const finalAgeCategory = normalizeAgeCategory(ageCategory);
    if (!req.files || !req.files.photo || !req.files.proof) {
      return res.status(400).json({ error: 'Photo and payment proof are both required.' });
    }

    // Registration cap — auto-closes once the active player count hits the cap (default 96),
    // unless Super Admin has manually forced registration open.
    const forcedOpenRow = await pool.query(`SELECT value FROM settings WHERE key = 'registration_forced_open'`);
    const forcedOpen = forcedOpenRow.rows[0]?.value === 'true';
    if (!forcedOpen) {
      const countRow = await pool.query('SELECT COUNT(*)::int AS count FROM players');
      const cap = await getRegCap();
      if (countRow.rows[0].count >= cap) {
        return res.status(400).json({
          error: `Registration is full (${cap}/${cap} players). Please contact the admin if you still need to register.`
        });
      }
    }

    // Block a second registration on the same mobile number
    const mobileCheck = await pool.query('SELECT name FROM players WHERE mobile = $1 LIMIT 1', [mobile]);
    if (mobileCheck.rows.length > 0) {
      return res.status(400).json({
        error: `This mobile number is already registered (as "${mobileCheck.rows[0].name}"). Each player can only register once.`
      });
    }

    // Block the exact same payment screenshot being reused for a different registration
    // (e.g. one transaction's proof uploaded again for a second player)
    const proofHash = crypto.createHash('sha256').update(req.files.proof[0].buffer).digest('hex');
    const proofCheck = await pool.query('SELECT name FROM players WHERE proof_hash = $1 LIMIT 1', [proofHash]);
    if (proofCheck.rows.length > 0) {
      return res.status(400).json({
        error: `This payment screenshot has already been used for "${proofCheck.rows[0].name}"'s registration. Please upload the screenshot of your own transaction.`
      });
    }

    const [photoResult, proofResult] = await Promise.all([
      uploadToCloudinary(req.files.photo[0].buffer, 'bpl-season2/photos'),
      uploadToCloudinary(req.files.proof[0].buffer, 'bpl-season2/proofs')
    ]);
    const createdAt = new Date().toISOString();

    const result = await pool.query(
      `INSERT INTO players (name, location, mobile, role, photo_url, proof_url, txn_ref, created_at, proof_hash, age_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [name, location, mobile, role, photoResult.secure_url, proofResult.secure_url, txnRef || '', createdAt, proofHash, finalAgeCategory]
    );
    const id = result.rows[0].id;
    const regNo = String(id).padStart(3, '0');

    // Category serial: this player's position among everyone registered so far in the same
    // age category (e.g. "U40-007"). Used on the ID card and physical/print lists so cards
    // can be sorted by category by hand.
    const serialCountRow = await pool.query(
      `SELECT COUNT(*)::int AS n FROM players WHERE age_category = $1 AND id <= $2`,
      [finalAgeCategory, id]
    );
    const categorySerial = `${categoryPrefix(finalAgeCategory)}-${String(serialCountRow.rows[0].n).padStart(3, '0')}`;

    const brandNow = await getBrand();
    const qrPayload = `${brandTitle(brandNow)}\nPlayer: ${name}\nReg No: ${regNo}\nRole: ${role}\nAge Category: ${finalAgeCategory}\nLocation: ${location}\nStatus: Registered`;
    const qrDataUrl = await generateQrDataUrl(qrPayload);

    res.json({ success: true, id, regNo, ageCategory: finalAgeCategory, categorySerial, qrDataUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while saving registration.' });
  }
});

// Public: current registration status, so the Register tab can show remaining slots
// or a "Full" message before the person even fills out the form.

// ---------- EVENT INFO (countdown + venue shown on the public header) ----------
app.get('/api/event-info', async (req, res) => {
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'event_info'`);
    res.json(r.rows.length ? JSON.parse(r.rows[0].value) : {});
  } catch (err) { res.json({}); }
});
app.post('/api/event-info', requireAdmin, async (req, res) => {
  try {
    const clean = v => String(v || '').slice(0, 160);
    const info = { auctionAt: clean(req.body.auctionAt), label: clean(req.body.label), venue: clean(req.body.venue), note: clean(req.body.note) };
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('event_info', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(info)]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save event details.' }); }
});

// ---------- BRANDING (public read, Admin edit) ----------
app.get('/api/branding', async (req, res) => { res.json(await getBrand()); });
app.post('/api/branding', requireAdmin, async (req, res) => {
  try {
    const clean = (v, fallback) => { const t = String(v == null ? '' : v).trim().slice(0, 80); return t || fallback; };
    const b = {
      line1: clean(req.body.line1, DEFAULT_BRAND.line1),
      line2: clean(req.body.line2, DEFAULT_BRAND.line2),
      presenter: clean(req.body.presenter, DEFAULT_BRAND.presenter),
      dateText: String(req.body.dateText == null ? '' : req.body.dateText).trim().slice(0, 40) // may be empty on purpose
    };
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('branding', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(b)]);
    brandCache = b;
    res.json({ success: true, brand: b });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save branding.' }); }
});

// Super Admin: change the registration cap (default 96)
app.post('/api/registration-cap', requireSuperAdmin, async (req, res) => {
  try {
    const n = parseInt(req.body.cap, 10);
    if (!(n >= 1 && n <= 5000)) return res.status(400).json({ error: 'Enter a cap between 1 and 5000.' });
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('registration_cap', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(n)]);
    res.json({ success: true, cap: n });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save the cap.' }); }
});

app.get('/api/registration-status', async (req, res) => {
  try {
    const countRow = await pool.query('SELECT COUNT(*)::int AS count FROM players');
    const forcedOpenRow = await pool.query(`SELECT value FROM settings WHERE key = 'registration_forced_open'`);
    const forcedOpen = forcedOpenRow.rows[0]?.value === 'true';
    const count = countRow.rows[0].count;
    const cap = await getRegCap();
    res.json({
      count,
      cap,
      forcedOpen,
      open: forcedOpen || count < cap
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check registration status.' });
  }
});

// Super Admin: force registration open past the cap, or restore the normal cap
app.post('/api/registration-toggle', requireSuperAdmin, async (req, res) => {
  try {
    const { forcedOpen } = req.body;
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('registration_forced_open', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [forcedOpen ? 'true' : 'false']
    );
    res.json({ success: true, forcedOpen: !!forcedOpen });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update registration status.' });
  }
});


app.get('/api/my-id-card', async (req, res) => {
  try {
    const mobile = (req.query.mobile || '').trim();
    if (!/^\d{10}$/.test(mobile)) {
      return res.status(400).json({ error: 'Enter the 10-digit mobile number used at registration.' });
    }
    const result = await pool.query(
      `SELECT id, name, location, mobile, role, photo_url, age_category FROM players WHERE mobile = $1 LIMIT 1`,
      [mobile]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No registration found for that mobile number.' });
    }
    const p = result.rows[0];
    const ageCategory = normalizeAgeCategory(p.age_category);
    const regNo = String(p.id).padStart(3, '0');
    const serialCountRow = await pool.query(
      `SELECT COUNT(*)::int AS n FROM players WHERE age_category = $1 AND id <= $2`,
      [ageCategory, p.id]
    );
    const categorySerial = `${categoryPrefix(ageCategory)}-${String(serialCountRow.rows[0].n).padStart(3, '0')}`;
    const brandNow = await getBrand();
    const qrPayload = `${brandTitle(brandNow)}\nPlayer: ${p.name}\nReg No: ${regNo}\nRole: ${p.role}\nAge Category: ${ageCategory}\nLocation: ${p.location}\nStatus: Registered`;
    const qrDataUrl = await generateQrDataUrl(qrPayload);
    res.json({
      name: p.name,
      location: p.location,
      mobile: p.mobile,
      role: p.role,
      photo_url: p.photo_url,
      ageCategory,
      regNo,
      categorySerial,
      qrDataUrl
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not look up your registration.' });
  }
});

// Get the current payment QR code (public)
app.get('/api/qr-code', async (req, res) => {
  try {
    const result = await pool.query(`SELECT value FROM settings WHERE key = 'qr_url'`);
    res.json({ url: result.rows[0]?.value || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load QR code.' });
  }
});

// Admin uploads / replaces the QR code
app.post('/api/qr-code', requireAdmin, upload.single('qr'), async (req, res) => {
  try {
    const result = await uploadToCloudinary(req.file.buffer, 'bpl-season2/qr');
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('qr_url', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [result.secure_url]
    );
    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save QR code.' });
  }
});

// Admin: list all players
app.get('/api/players', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, o.name AS owner_name, o.team_name AS owner_team_name
      FROM players p
      LEFT JOIN owners o ON o.id = p.owner_id
      ORDER BY p.id ASC
    `);
    // Normalize age category and compute each player's category serial (position among
    // everyone in the same category, in registration order) for display in the admin roster.
    const categoryCounters = { 'Under 40': 0, '40 Plus': 0 };
    const players = result.rows.map(p => {
      const age_category = p.age_category === '40 Plus' ? '40 Plus' : 'Under 40';
      categoryCounters[age_category] += 1;
      return {
        ...p,
        age_category,
        category_serial: `${categoryPrefix(age_category)}-${String(categoryCounters[age_category]).padStart(3, '0')}`
      };
    });
    res.json(players);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load players.' });
  }
});

// Admin: mark/unmark a player as Retained. Only Retained = Yes players can be chosen
// as a team's Captain / Batsman Pick / Bowler Pick core pick.
app.post('/api/players/:id/retained', requireAdmin, async (req, res) => {
  try {
    const { retained } = req.body;
    const result = await pool.query(
      `UPDATE players SET retained = $1 WHERE id = $2 RETURNING id, retained`,
      [!!retained, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Player not found.' });
    res.json({ success: true, retained: result.rows[0].retained });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update retained status.' });
  }
});

// Admin: export Excel — Players (with photos), Filterable List, By Owner (full squads),
// Retained, Under 40, 40 Plus, and a Summary dashboard sheet. 40 Plus players are shown in
// bold red wherever their name appears, so they're identifiable at a glance on every sheet.
app.get('/api/export', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, o.name AS owner_name, o.team_name AS owner_team_name
      FROM players p
      LEFT JOIN owners o ON o.id = p.owner_id
      ORDER BY p.id ASC
    `);
    const players = result.rows;

    // Normalize age category (defensive, in case of old rows) and compute each player's
    // category serial — their position among everyone in the same category, in registration
    // order (safe because the query is ORDER BY p.id ASC).
    const categoryCounters = { 'Under 40': 0, '40 Plus': 0 };
    players.forEach(p => {
      p.age_category = p.age_category === '40 Plus' ? '40 Plus' : 'Under 40';
      categoryCounters[p.age_category] += 1;
      p.category_serial = `${categoryPrefix(p.age_category)}-${String(categoryCounters[p.age_category]).padStart(3, '0')}`;
      p.team_display = p.owner_team_name || p.owner_name || '';
    });

    const workbook = new ExcelJS.Workbook();
    const AGE_HIGHLIGHT_FONT = { bold: true, color: { argb: 'FFCC0000' } };

    // Fetch an image URL and return it as a buffer, or null if it fails
    async function fetchImageBuffer(url) {
      if (!url) return null;
      try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const arrayBuf = await resp.arrayBuffer();
        return Buffer.from(arrayBuf);
      } catch {
        return null;
      }
    }

    // ---------- Sheet 1: Players (with embedded photos + payment proof) ----------
    const sheet = workbook.addWorksheet('Players');
    sheet.columns = [
      { header: 'Serial', key: 'category_serial', width: 12 },
      { header: '#', key: 'num', width: 6 },
      { header: 'Photo', key: 'photo', width: 14 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Location', key: 'location', width: 18 },
      { header: 'Mobile', key: 'mobile', width: 14 },
      { header: 'Role', key: 'role', width: 14 },
      { header: 'Age Category', key: 'age_category', width: 14 },
      { header: 'Retained', key: 'retained', width: 10 },
      { header: 'Payment Proof', key: 'proof', width: 20 },
      { header: 'Transaction Ref', key: 'txn_ref', width: 18 },
      { header: 'Registered On', key: 'created_at', width: 22 },
      { header: 'Auction Status', key: 'status', width: 14 },
      { header: 'Sold To', key: 'owner_name', width: 18 },
      { header: 'Sold Price', key: 'sold_price', width: 12 }
    ];
    sheet.getRow(1).font = { bold: true };

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const rowIndex = i + 2; // header is row 1
      const row = sheet.addRow({
        category_serial: p.category_serial,
        num: i + 1,
        name: p.name,
        location: p.location,
        mobile: p.mobile,
        role: p.role,
        age_category: p.age_category,
        retained: p.retained ? 'Yes' : 'No',
        txn_ref: p.txn_ref,
        created_at: p.created_at,
        status: p.status,
        owner_name: p.team_display,
        sold_price: p.sold_price || ''
      });
      row.height = 70;
      if (p.age_category === '40 Plus') {
        row.getCell('name').font = AGE_HIGHLIGHT_FONT;
        row.getCell('age_category').font = AGE_HIGHLIGHT_FONT;
      }

      const [photoBuf, proofBuf] = await Promise.all([
        fetchImageBuffer(p.photo_url),
        fetchImageBuffer(p.proof_url)
      ]);

      if (photoBuf) {
        const imgId = workbook.addImage({ buffer: photoBuf, extension: 'jpeg' });
        sheet.addImage(imgId, {
          tl: { col: 2.1, row: rowIndex - 1 + 0.1 },
          ext: { width: 60, height: 60 }
        });
      }
      if (proofBuf) {
        const imgId = workbook.addImage({ buffer: proofBuf, extension: 'jpeg' });
        sheet.addImage(imgId, {
          tl: { col: 9.1, row: rowIndex - 1 + 0.1 },
          ext: { width: 90, height: 60 }
        });
      }
    }

    // ---------- Sheet 2: a plain filterable list (no images) with AutoFilter turned on ----------
    const filterSheet = workbook.addWorksheet('Filterable List');
    filterSheet.columns = [
      { header: 'Serial', key: 'category_serial', width: 12 },
      { header: '#', key: 'num', width: 6 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Location', key: 'location', width: 18 },
      { header: 'Mobile', key: 'mobile', width: 14 },
      { header: 'Role', key: 'role', width: 14 },
      { header: 'Age Category', key: 'age_category', width: 14 },
      { header: 'Retained', key: 'retained', width: 10 },
      { header: 'Auction Status', key: 'status', width: 14 },
      { header: 'Team (Owner)', key: 'owner_name', width: 20 },
      { header: 'Sold Price', key: 'sold_price', width: 12 }
    ];
    filterSheet.getRow(1).font = { bold: true };
    filterSheet.views = [{ state: 'frozen', ySplit: 1 }];

    players.forEach((p, i) => {
      const row = filterSheet.addRow({
        category_serial: p.category_serial,
        num: i + 1,
        name: p.name,
        location: p.location,
        mobile: p.mobile,
        role: p.role,
        age_category: p.age_category,
        retained: p.retained ? 'Yes' : 'No',
        status: p.status,
        owner_name: p.team_display,
        sold_price: p.sold_price || ''
      });
      if (p.age_category === '40 Plus') {
        row.getCell('name').font = AGE_HIGHLIGHT_FONT;
        row.getCell('age_category').font = AGE_HIGHLIGHT_FONT;
      }
    });

    filterSheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: players.length + 1, column: filterSheet.columns.length }
    };

    // ---------- Helper for the segregated plain-roster sheets (Retained / Under 40 / 40 Plus) ----------
    function addPlainRosterSheet(name, rows) {
      const s = workbook.addWorksheet(name);
      s.columns = [
        { header: 'Serial', key: 'category_serial', width: 12 },
        { header: '#', key: 'num', width: 6 },
        { header: 'Name', key: 'name', width: 22 },
        { header: 'Location', key: 'location', width: 18 },
        { header: 'Mobile', key: 'mobile', width: 14 },
        { header: 'Role', key: 'role', width: 14 },
        { header: 'Age Category', key: 'age_category', width: 14 },
        { header: 'Retained', key: 'retained', width: 10 },
        { header: 'Auction Status', key: 'status', width: 14 },
        { header: 'Team (Owner)', key: 'owner_name', width: 20 },
        { header: 'Sold Price', key: 'sold_price', width: 12 }
      ];
      s.getRow(1).font = { bold: true };
      s.views = [{ state: 'frozen', ySplit: 1 }];
      rows.forEach((p, i) => {
        const row = s.addRow({
          category_serial: p.category_serial,
          num: i + 1,
          name: p.name,
          location: p.location,
          mobile: p.mobile,
          role: p.role,
          age_category: p.age_category,
          retained: p.retained ? 'Yes' : 'No',
          status: p.status,
          owner_name: p.team_display,
          sold_price: p.sold_price || ''
        });
        if (p.age_category === '40 Plus') {
          row.getCell('name').font = AGE_HIGHLIGHT_FONT;
          row.getCell('age_category').font = AGE_HIGHLIGHT_FONT;
        }
      });
      if (rows.length > 0) {
        s.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: s.columns.length } };
      }
      return s;
    }

    // ---------- Sheets 3–5: Retained / Under 40 / 40 Plus, fully segregated ----------
    addPlainRosterSheet('Retained', players.filter(p => p.retained));
    addPlainRosterSheet('Under 40', players.filter(p => p.age_category === 'Under 40'));
    addPlainRosterSheet('40 Plus', players.filter(p => p.age_category === '40 Plus'));

    // ---------- Sheet 6: By Owner — each team's full squad, grouped under a header row ----------
    const byOwnerSheet = workbook.addWorksheet('By Owner');
    byOwnerSheet.columns = [
      { header: 'Serial', key: 'category_serial', width: 12 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Role', key: 'role', width: 14 },
      { header: 'Age Category', key: 'age_category', width: 14 },
      { header: 'Pick Type', key: 'pick_tag', width: 16 },
      { header: 'Sold Price', key: 'sold_price', width: 12 }
    ];
    byOwnerSheet.getRow(1).font = { bold: true };

    const teamGroupHeaderFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E0C0' } };
    const tagOrder = { 'Owner': 0, 'Captain': 1, 'Batsman Pick': 2, 'Bowler Pick': 3 };
    const ownersMap = new Map();
    players.forEach(p => {
      if (!p.team_display) return;
      if (!ownersMap.has(p.team_display)) ownersMap.set(p.team_display, []);
      ownersMap.get(p.team_display).push(p);
    });
    for (const [teamName, squad] of ownersMap) {
      const headerRow = byOwnerSheet.addRow({ category_serial: '', name: teamName.toUpperCase(), role: '', age_category: '', pick_tag: '', sold_price: '' });
      headerRow.font = { bold: true, size: 12 };
      headerRow.eachCell(c => { c.fill = teamGroupHeaderFill; });
      squad
        .slice()
        .sort((a, b) => (tagOrder[a.pick_tag] ?? 9) - (tagOrder[b.pick_tag] ?? 9) || a.name.localeCompare(b.name))
        .forEach(p => {
          const row = byOwnerSheet.addRow({
            category_serial: p.category_serial,
            name: p.name,
            role: p.role,
            age_category: p.age_category,
            pick_tag: p.pick_tag || '',
            sold_price: p.sold_price || ''
          });
          if (p.age_category === '40 Plus') {
            row.getCell('name').font = AGE_HIGHLIGHT_FONT;
            row.getCell('age_category').font = AGE_HIGHLIGHT_FONT;
          }
        });
      byOwnerSheet.addRow({});
    }
    const unassigned = players.filter(p => !p.team_display);
    if (unassigned.length > 0) {
      const headerRow = byOwnerSheet.addRow({ category_serial: '', name: 'NOT YET ASSIGNED (AVAILABLE / UNSOLD)', role: '', age_category: '', pick_tag: '', sold_price: '' });
      headerRow.font = { bold: true, size: 12 };
      headerRow.eachCell(c => { c.fill = teamGroupHeaderFill; });
      unassigned.forEach(p => {
        const row = byOwnerSheet.addRow({
          category_serial: p.category_serial,
          name: p.name,
          role: p.role,
          age_category: p.age_category,
          pick_tag: p.status,
          sold_price: ''
        });
        if (p.age_category === '40 Plus') {
          row.getCell('name').font = AGE_HIGHLIGHT_FONT;
          row.getCell('age_category').font = AGE_HIGHLIGHT_FONT;
        }
      });
    }

    // ---------- Sheet 7: Summary / Dashboard ----------
    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.columns = [{ width: 30 }, { width: 18 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 14 }];

    summarySheet.addRow(['OVERALL']).font = { bold: true, size: 13 };
    summarySheet.addRow(['Total Registered Players', players.length]);
    summarySheet.addRow(['Under 40', players.filter(p => p.age_category === 'Under 40').length]);
    summarySheet.addRow(['40 Plus', players.filter(p => p.age_category === '40 Plus').length]);
    summarySheet.addRow(['Retained', players.filter(p => p.retained).length]);
    summarySheet.addRow(['Sold', players.filter(p => p.status === 'Sold').length]);
    summarySheet.addRow(['Available', players.filter(p => p.status === 'Available').length]);
    summarySheet.addRow(['Unsold (passed over in auction)', players.filter(p => p.status === 'Unsold').length]);
    summarySheet.addRow([]);

    const ownersResult = await pool.query(`SELECT name, team_name, budget_total, budget_spent FROM owners ORDER BY id ASC`);
    if (ownersResult.rows.length > 0) {
      summarySheet.addRow(['TEAMS']).font = { bold: true, size: 13 };
      const headerRow = summarySheet.addRow(['Team', 'Owner', 'Players', 'Budget', 'Spent', 'Remaining']);
      headerRow.font = { bold: true };
      ownersResult.rows.forEach(o => {
        const teamName = o.team_name || o.name;
        const squadCount = players.filter(p => p.team_display === teamName).length;
        const remaining = Number(o.budget_total) - Number(o.budget_spent);
        summarySheet.addRow([teamName, o.name, squadCount, Number(o.budget_total), Number(o.budget_spent), remaining]);
      });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="bpl-season2-players.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not export players.' });
  }
});

// Admin: export a PDF roster with player photos (handy for printing / sharing offline)
app.get('/api/export-pdf', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, o.name AS owner_name, o.team_name AS owner_team_name
      FROM players p
      LEFT JOIN owners o ON o.id = p.owner_id
      ORDER BY p.id ASC
    `);
    const players = result.rows;
    const categoryCounters = { 'Under 40': 0, '40 Plus': 0 };
    players.forEach(p => {
      p.age_category = p.age_category === '40 Plus' ? '40 Plus' : 'Under 40';
      categoryCounters[p.age_category] += 1;
      p.category_serial = `${categoryPrefix(p.age_category)}-${String(categoryCounters[p.age_category]).padStart(3, '0')}`;
    });

    async function fetchImageBuffer(url) {
      if (!url) return null;
      try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const arrayBuf = await resp.arrayBuffer();
        return Buffer.from(arrayBuf);
      } catch {
        return null;
      }
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="bpl-season2-players.pdf"');

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    doc.pipe(res);

    drawBrandHeader(doc, 'Registered Players Roster', await getBrand());

    const rowHeight = 74;
    const pageBottom = doc.page.height - doc.page.margins.bottom;

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (doc.y + rowHeight > pageBottom) {
        doc.addPage();
      }
      const top = doc.y;
      const photoBuf = await fetchImageBuffer(p.photo_url);
      if (photoBuf) {
        try {
          doc.image(photoBuf, doc.page.margins.left, top, { width: 56, height: 56 });
        } catch {
          // skip unreadable image, still print the row's text
        }
      }
      const textX = doc.page.margins.left + 66;
      const textWidth = doc.page.width - doc.page.margins.right - textX;
      // 40 Plus players are printed in bold red so they're instantly identifiable on the sheet.
      const isPlus40 = p.age_category === '40 Plus';
      doc.fillColor(isPlus40 ? '#CC0000' : '#000000')
        .font('Helvetica-Bold').fontSize(12)
        .text(`${p.category_serial}  ${p.name}${isPlus40 ? '  (40+)' : ''}`, textX, top, { width: textWidth });
      doc.fillColor('#000000').font('Helvetica').fontSize(10)
        .text(`${p.role}  •  ${p.location}  •  ${p.mobile}`, textX, top + 17, { width: textWidth })
        .text(`Registered: ${new Date(p.created_at).toLocaleString()}`, textX, top + 32, { width: textWidth })
        .text(`Status: ${p.status}${(p.owner_team_name || p.owner_name) ? '  •  Sold to: ' + (p.owner_team_name || p.owner_name) + (p.sold_price ? ' (₹' + p.sold_price + ')' : '') : ''}`, textX, top + 47, { width: textWidth });

      doc.y = top + rowHeight;
      doc.moveTo(doc.page.margins.left, doc.y - 6)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y - 6)
        .strokeColor('#DCD5BC').stroke();
    }

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not export players to PDF.' });
  }
});

// Super Admin: edit a player's registration details (fix a typo, wrong role/location, etc.)
// Also accepts an optional new "photo" file (multipart/form-data) to replace the player's photo.
app.put('/api/players/:id', requireSuperAdmin, upload.single('photo'), async (req, res) => {
  try {
    const playerId = req.params.id;
    const { name, location, mobile, role, ageCategory } = req.body;
    if (!name || !location || !mobile || !role) {
      return res.status(400).json({ error: 'Name, location, mobile, and role are all required.' });
    }
    if (!/^\d{10}$/.test(mobile)) {
      return res.status(400).json({ error: 'Mobile number must be 10 digits.' });
    }
    if (ageCategory && !['40 Plus', 'Under 40'].includes(ageCategory)) {
      return res.status(400).json({ error: 'Age category must be "40 Plus" or "Under 40".' });
    }
    const mobileCheck = await pool.query(
      'SELECT name FROM players WHERE mobile = $1 AND id != $2 LIMIT 1',
      [mobile, playerId]
    );
    if (mobileCheck.rows.length > 0) {
      return res.status(400).json({
        error: `This mobile number is already used by "${mobileCheck.rows[0].name}"'s registration.`
      });
    }

    // If a replacement photo was uploaded, push it to Cloudinary first so we have
    // the new URL ready to save alongside the rest of the edited fields.
    let newPhotoUrl = null;
    if (req.file) {
      const photoResult = await uploadToCloudinary(req.file.buffer, 'bpl-season2/photos');
      newPhotoUrl = photoResult.secure_url;
    }

    const result = newPhotoUrl
      ? await pool.query(
          `UPDATE players SET name = $1, location = $2, mobile = $3, role = $4, photo_url = $5, age_category = COALESCE($6, age_category) WHERE id = $7 RETURNING id`,
          [name, location, mobile, role, newPhotoUrl, ageCategory || null, playerId]
        )
      : await pool.query(
          `UPDATE players SET name = $1, location = $2, mobile = $3, role = $4, age_category = COALESCE($5, age_category) WHERE id = $6 RETURNING id`,
          [name, location, mobile, role, ageCategory || null, playerId]
        );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Player not found.' });
    res.json({ success: true, photo_url: newPhotoUrl || undefined });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update this registration.' });
  }
});

// Admin: delete a player's registration entirely.
// If the player was already sold, first refund the owner's spent budget so numbers stay correct.
app.delete('/api/players/:id', requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const playerId = req.params.id;
    await client.query('BEGIN');
    const playerCheck = await client.query('SELECT owner_id, sold_price FROM players WHERE id = $1 FOR UPDATE', [playerId]);
    if (playerCheck.rows.length === 0) throw new Error('Player not found.');
    const { owner_id, sold_price } = playerCheck.rows[0];
    if (owner_id) {
      await client.query(
        `UPDATE owners SET budget_spent = budget_spent - $1 WHERE id = $2`,
        [Number(sold_price) || 0, owner_id]
      );
    }
    await client.query('DELETE FROM players WHERE id = $1', [playerId]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'Could not delete this registration.' });
  } finally {
    client.release();
  }
});

// Admin login check (used by the front-end lock screen) — reports whether this
// is the regular Admin password or the Super Admin password, so the UI can show
// or hide destructive actions (like deleting a registration) accordingly.
app.post('/api/admin-login', (req, res) => {
  const { password } = req.body;
  if (password === currentSuperAdminPassword) return res.json({ success: true, role: 'superadmin' });
  if (password === currentAdminPassword) return res.json({ success: true, role: 'admin' });
  res.status(401).json({ success: false });
});

// Admin: change the admin password (saved to the database, so it persists across restarts)
app.post('/api/change-admin-password', requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters.' });
    }
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('admin_password', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [newPassword]
    );
    currentAdminPassword = newPassword;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update password.' });
  }
});

// Super Admin: change the Super Admin password (saved to the database, persists across restarts)
app.post('/api/change-superadmin-password', requireSuperAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters.' });
    }
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('superadmin_password', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [newPassword]
    );
    currentSuperAdminPassword = newPassword;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update password.' });
  }
});

// ---------- AUCTION: OWNERS ----------

// Admin: list owners with budget totals/spent/remaining (owner_password never sent to the browser)
app.get('/api/owners', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, team_name, budget_total, budget_spent, created_at, owner_player_id, login_username, logo_url FROM owners ORDER BY id ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load owners.' });
  }
});

// ---------- TEAM PDF + UNSOLD LIST ----------
// Cloudinary photos may be webp; ask for a small JPG so PDFKit can embed them.
async function fetchPdfImage(url) {
  if (!url) return null;
  try {
    let u = url;
    if (u.includes('res.cloudinary.com') && u.includes('/upload/')) {
      u = u.replace('/upload/', '/upload/f_jpg,w_160,h_160,c_fill,g_face/');
    }
    const resp = await fetch(u);
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch { return null; }
}
async function fetchPdfImages(urls) {
  const out = [];
  for (let i = 0; i < urls.length; i += 8) {
    out.push(...await Promise.all(urls.slice(i, i + 8).map(fetchPdfImage)));
  }
  return out;
}
const PDF_TAG_ORDER = "CASE p.pick_tag WHEN 'Owner' THEN 1 WHEN 'Captain' THEN 2 WHEN 'Batsman Pick' THEN 3 WHEN 'Bowler Pick' THEN 4 ELSE 5 END";

// One team's PDF: colourful banner (logo + team colours), owner name, budget, and the complete
// squad in an aligned table. Public (same data as the Teams tab). Layout lives in teamPdf.js.
async function fetchLogoPng(url) {
  if (!url) return null;
  try {
    let u = url;
    if (u.includes('res.cloudinary.com') && u.includes('/upload/')) {
      u = u.replace('/upload/', '/upload/f_png,w_400,h_400,c_fill/');
    }
    const resp = await fetch(u);
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch { return null; }
}
app.get('/api/teams/:id/pdf', async (req, res) => {
  try {
    const ownerRes = await pool.query(
      'SELECT id, name, team_name, budget_total, budget_spent, logo_url FROM owners WHERE id = $1', [req.params.id]
    );
    const owner = ownerRes.rows[0];
    if (!owner) return res.status(404).json({ error: 'Team not found.' });
    const squadRes = await pool.query(
      `SELECT p.name, p.role, p.photo_url, p.pick_tag, p.age_category, p.sold_price, p.mobile, p.location
       FROM players p WHERE p.owner_id = $1 ORDER BY ${PDF_TAG_ORDER}, p.name ASC`, [owner.id]
    );
    const squad = squadRes.rows;
    const [photos, logoBuf] = await Promise.all([
      fetchPdfImages(squad.map(p => p.photo_url)),
      fetchLogoPng(owner.logo_url)
    ]);
    const teamName = owner.team_name || owner.name;
    const safeFile = teamName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'team';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFile}-squad.pdf"`);
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, bufferPages: true });
    doc.pipe(res);
    await renderTeamPdf(doc, { owner, squad, photos, logoBuf, brand: await getBrand() });
    doc.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not build team PDF.' });
    else res.end();
  }
});

// Unsold = anyone not sold yet (status Available, or Unsold = passed over in the auction).
// Only non-sensitive fields are returned (no mobile numbers) since the Teams tab is public.
async function loadUnsoldPlayers() {
  const r = await pool.query(
    `SELECT id, name, role, photo_url, age_category, status FROM players
     WHERE status != 'Sold' ORDER BY name ASC`
  );
  return r.rows.map(p => ({ ...p, age_category: p.age_category === '40 Plus' ? '40 Plus' : 'Under 40' }));
}
app.get('/api/unsold', async (req, res) => {
  try { res.json(await loadUnsoldPlayers()); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Could not load unsold players.' }); }
});
app.get('/api/unsold/pdf', async (req, res) => {
  try {
    const list = await loadUnsoldPlayers();
    const photos = await fetchPdfImages(list.map(p => p.photo_url));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="unsold-players.pdf"');
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    doc.pipe(res);
    const L = doc.page.margins.left, R = doc.page.width - doc.page.margins.right;
    drawBrandHeader(doc, 'Unsold Players', await getBrand());
    doc.font('Helvetica').fontSize(10).fillColor('#555').text(`${list.length} player${list.length === 1 ? '' : 's'} not sold yet`, { align: 'center' });
    doc.moveDown(0.6);
    doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#0B5D3B').lineWidth(1.5).stroke();
    doc.moveDown(0.8);
    const rowH = 50, bottom = doc.page.height - doc.page.margins.bottom;
    if (list.length === 0) doc.fillColor('#555').fontSize(12).text('Every player has been sold.', { align: 'center' });
    list.forEach((p, i) => {
      if (doc.y + rowH > bottom) doc.addPage();
      const top = doc.y;
      doc.fillColor('#888').font('Helvetica').fontSize(10).text(String(i + 1), L, top + 16, { width: 24 });
      if (photos[i]) { try { doc.image(photos[i], L + 28, top, { width: 40, height: 40 }); } catch {} }
      const tx = L + 78, tw = R - tx - 110;
      const is40 = p.age_category === '40 Plus';
      doc.fillColor(is40 ? '#CC0000' : '#000').font('Helvetica-Bold').fontSize(12)
        .text(`${p.name}${is40 ? '  (40+)' : ''}`, tx, top + 4, { width: tw });
      doc.fillColor('#555').font('Helvetica').fontSize(10).text(p.role || '', tx, top + 22, { width: tw });
      doc.fillColor(p.status === 'Unsold' ? '#B45309' : '#0B5D3B').font('Helvetica-Bold').fontSize(10)
        .text(p.status === 'Unsold' ? 'Passed in auction' : 'Available', R - 104, top + 14, { width: 104, align: 'right' });
      doc.y = top + rowH;
      doc.moveTo(L, doc.y - 4).lineTo(R, doc.y - 4).strokeColor('#DCD5BC').lineWidth(0.5).stroke();
    });
    doc.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not build unsold PDF.' });
  }
});


// Public: the finalized teams — team name, owner, budget, crest, their pre-assigned core
// (Owner / Captain / Batsman pick / Bowler pick), AND the full squad of everyone bought via
// the live auction. No admin password needed; anyone can view this — this is the list an
// owner gets once the auction is done. Each player includes age_category so the frontend
// can mark 40 Plus players in red/bold.
app.get('/api/teams', async (req, res) => {
  try {
    const ownersResult = await pool.query(
      `SELECT id, name, team_name, budget_total, budget_spent, logo_url FROM owners ORDER BY id ASC`
    );
    const squadResult = await pool.query(
      `SELECT owner_id, name, role, photo_url, pick_tag, age_category, sold_price, mobile, location
       FROM players
       WHERE owner_id IS NOT NULL
       ORDER BY CASE pick_tag WHEN 'Owner' THEN 1 WHEN 'Captain' THEN 2 WHEN 'Batsman Pick' THEN 3 WHEN 'Bowler Pick' THEN 4 ELSE 5 END, name ASC`
    );
    const teams = ownersResult.rows.map(o => {
      const squad = squadResult.rows.filter(p => p.owner_id === o.id);
      return {
        ...o,
        core: squad.filter(p => p.pick_tag), // Owner/Captain/Batsman Pick/Bowler Pick only, kept for backward compatibility
        squad // everyone bought for this team, core picks + live-auction buys alike
      };
    });
    res.json(teams);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load teams.' });
  }
});

// Admin: add a new owner/team. Owners are always an existing registered member — the admin
// picks a playerId from the registration list rather than typing an outside name, so every
// owner is guaranteed to already be enrolled. We copy their registered name onto the owner row.
app.post('/api/owners', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { playerId, teamName, budget } = req.body;
    if (!playerId) {
      return res.status(400).json({ error: 'Select a registered member to make owner.' });
    }
    if (!teamName || !teamName.trim()) {
      return res.status(400).json({ error: 'A team name is required.' });
    }
    if (budget === undefined || budget === null || isNaN(Number(budget))) {
      return res.status(400).json({ error: 'A valid starting budget is required.' });
    }
    await client.query('BEGIN');
    const memberResult = await client.query('SELECT id, name, status FROM players WHERE id = $1 FOR UPDATE', [playerId]);
    const member = memberResult.rows[0];
    if (!member) throw new Error('That member could not be found in the registration list.');
    if (member.status === 'Sold') throw new Error('That member is already assigned to a team.');
    const alreadyOwner = await client.query('SELECT id FROM owners WHERE owner_player_id = $1', [playerId]);
    if (alreadyOwner.rows.length > 0) throw new Error('This member is already an owner.');

    // Auto-generate the owner's login credentials: username = first name (deduped with a
    // trailing number if another owner already has that first name), password = first 3
    // letters of their name + "12345". Admin can still change either from the Owners panel.
    const existingUsernames = await client.query(`SELECT login_username FROM owners WHERE login_username IS NOT NULL AND login_username != ''`);
    const usedUsernames = new Set(existingUsernames.rows.map(r => r.login_username.toLowerCase()));
    const loginUsername = generateUniqueUsername(member.name, usedUsernames);
    const generatedPassword = generateDefaultPassword(member.name);

    const createdAt = new Date().toISOString();
    const ownerResult = await client.query(
      `INSERT INTO owners (name, team_name, budget_total, budget_spent, created_at, owner_password, owner_player_id, login_username)
       VALUES ($1, $2, $3, 0, $4, $5, $6, $7)
       RETURNING id, name, team_name, budget_total, budget_spent, created_at, owner_player_id, login_username`,
      [member.name, teamName.trim(), Number(budget), createdAt, generatedPassword, member.id, loginUsername]
    );
    const owner = ownerResult.rows[0];
    // The generated password is only ever handed back in this one response, right after
    // creation, so the admin can pass it on to the owner — it isn't shown again later.
    owner.generated_password = generatedPassword;

    // The owner is automatically locked to their own team at ₹0 — they don't go into the auction pool.
    await client.query(
      `UPDATE players SET status = 'Sold', owner_id = $1, sold_price = 0, pick_tag = 'Owner' WHERE id = $2`,
      [owner.id, playerId]
    );

    await client.query('COMMIT');
    res.json({ success: true, owner });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(400).json({ error: err.message || 'Could not add owner.' });
  } finally {
    client.release();
  }
});

// Admin: edit an owner/team — rename the team and/or change who the owner is.
// The new owner is picked from ANY registered player who isn't already sold or an owner elsewhere.
// The previous owner goes back into the pool as an Available player. Budget, crest and squad stay.
app.put('/api/owners/:id', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const ownerId = Number(req.params.id);
    const { teamName, playerId } = req.body;
    await client.query('BEGIN');
    const ownerRes = await client.query('SELECT * FROM owners WHERE id = $1 FOR UPDATE', [ownerId]);
    const owner = ownerRes.rows[0];
    if (!owner) throw new Error('Owner not found.');

    let newTeamName = owner.team_name;
    if (teamName !== undefined) {
      if (!String(teamName).trim()) throw new Error('Team name cannot be empty.');
      newTeamName = String(teamName).trim();
    }

    let generatedPassword = null;
    let newName = owner.name;
    let newLogin = owner.login_username;
    let newPlayerId = owner.owner_player_id;

    if (playerId !== undefined && playerId !== null && Number(playerId) !== owner.owner_player_id) {
      const memberRes = await client.query('SELECT id, name, status FROM players WHERE id = $1 FOR UPDATE', [Number(playerId)]);
      const member = memberRes.rows[0];
      if (!member) throw new Error('That member could not be found in the registration list.');
      if (member.status === 'Sold') throw new Error('That member is already sold / assigned to a team.');
      const already = await client.query('SELECT id FROM owners WHERE owner_player_id = $1 AND id != $2', [member.id, ownerId]);
      if (already.rows.length > 0) throw new Error('This member is already an owner of another team.');

      // Old owner goes back to the pool
      if (owner.owner_player_id) {
        await client.query(
          `UPDATE players SET status = 'Available', owner_id = NULL, sold_price = NULL, pick_tag = NULL
           WHERE id = $1 AND owner_id = $2 AND pick_tag = 'Owner'`,
          [owner.owner_player_id, ownerId]
        );
      }
      // New owner is locked to this team at ₹0
      await client.query(
        `UPDATE players SET status = 'Sold', owner_id = $1, sold_price = 0, pick_tag = 'Owner' WHERE id = $2`,
        [ownerId, member.id]
      );
      // Login: username = first name by default (unique), password = default pattern. Admin can reset anytime.
      const others = await client.query(
        `SELECT login_username FROM owners WHERE id != $1 AND login_username IS NOT NULL AND login_username != ''`, [ownerId]
      );
      const used = new Set(others.rows.map(r => r.login_username.toLowerCase()));
      newLogin = generateUniqueUsername(member.name, used);
      generatedPassword = generateDefaultPassword(member.name);
      newName = member.name;
      newPlayerId = member.id;
    }

    const upd = await client.query(
      `UPDATE owners SET team_name = $1, name = $2, owner_player_id = $3, login_username = $4,
         owner_password = COALESCE($5, owner_password)
       WHERE id = $6
       RETURNING id, name, team_name, budget_total, budget_spent, owner_player_id, login_username, logo_url`,
      [newTeamName, newName, newPlayerId, newLogin, generatedPassword, ownerId]
    );
    await client.query('COMMIT');
    const out = upd.rows[0];
    if (generatedPassword) out.generated_password = generatedPassword;
    res.json({ success: true, owner: out });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(400).json({ error: err.message || 'Could not update owner.' });
  } finally {
    client.release();
  }
});

// Admin: reset an owner's login password
app.post('/api/owners/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || String(password).length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters.' });
    }
    const result = await pool.query(
      `UPDATE owners SET owner_password = $1 WHERE id = $2 RETURNING id`,
      [String(password), req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Owner not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

// Admin: upload/replace a team's crest image. When set, this overrides the auto-generated
// monogram crest for this team everywhere it's shown (Teams tab).
app.post('/api/owners/:id/logo', requireAdmin, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
    const result = await uploadToCloudinary(req.file.buffer, 'bpl-season2/team-logos');
    const update = await pool.query(
      `UPDATE owners SET logo_url = $1 WHERE id = $2 RETURNING id, logo_url`,
      [result.secure_url, req.params.id]
    );
    if (update.rows.length === 0) return res.status(404).json({ error: 'Owner not found.' });
    res.json({ success: true, logo_url: update.rows[0].logo_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not upload team logo.' });
  }
});

// Admin: remove a team's custom crest, reverting to the auto-generated monogram crest.
app.delete('/api/owners/:id/logo', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE owners SET logo_url = NULL WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Owner not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove team logo.' });
  }
});

// Admin: delete an owner (only allowed if no other players besides themself are sold to them).
// Deleting the owner also releases their own player row (the auto "Owner" pick) back to Available.
app.delete('/api/owners/:id', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const ownerId = req.params.id;
    await client.query('BEGIN');
    const check = await client.query(
      `SELECT COUNT(*) FROM players WHERE owner_id = $1 AND (pick_tag IS NULL OR pick_tag != 'Owner')`,
      [ownerId]
    );
    if (Number(check.rows[0].count) > 0) {
      throw new Error('Cannot delete an owner with players already sold to them. Undo those sales first.');
    }
    await client.query(
      `UPDATE players SET status = 'Available', owner_id = NULL, sold_price = NULL, pick_tag = NULL WHERE owner_id = $1`,
      [ownerId]
    );
    await client.query('DELETE FROM owners WHERE id = $1', [ownerId]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(400).json({ error: err.message || 'Could not delete owner.' });
  } finally {
    client.release();
  }
});

// ---------- AUCTION: SELL / UNDO ----------

// Admin: mark a player as sold to an owner for a given price
app.post('/api/auction/sell', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { playerId, ownerId, price, tag } = req.body;
    if (!playerId || !ownerId || price === undefined || price === null || isNaN(Number(price)) || Number(price) < 0) {
      return res.status(400).json({ error: 'Player, owner, and a valid price are required.' });
    }
    const allowedTags = Object.keys(CORE_PICK_ROLES); // just 'Captain' this tournament
    const pickTag = tag && allowedTags.includes(tag) ? tag : null;
    await client.query('BEGIN');
    // Lock this player's row so an owner's self-buy can't sneak in between our check and our update
    const playerCheck = await client.query('SELECT status, role FROM players WHERE id = $1 FOR UPDATE', [playerId]);
    if (playerCheck.rows.length === 0) throw new Error('Player not found.');
    if (playerCheck.rows[0].status === 'Sold') throw new Error('This player is already sold. Undo the existing sale first.');

    // Server-side enforcement of Core Pick eligibility — never trust the dropdown alone.
    // This tournament pre-assigns only one Captain per team, directly (like an Owner
    // assignment) — no "Retained" flag needed, and any registered role is eligible.
    if (pickTag) {
      const { role } = playerCheck.rows[0];
      const eligibleRoles = CORE_PICK_ROLES[pickTag];
      if (eligibleRoles && !eligibleRoles.includes(role)) {
        throw new Error(`${pickTag} must be a ${eligibleRoles.join(' or ')} — this player's role is ${role}.`);
      }
    }

    await client.query(
      `UPDATE players SET status = 'Sold', owner_id = $1, sold_price = $2, pick_tag = $3 WHERE id = $4`,
      [ownerId, Number(price), pickTag, playerId]
    );
    await client.query(
      `UPDATE owners SET budget_spent = budget_spent + $1 WHERE id = $2`,
      [Number(price), ownerId]
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'Could not complete the sale.' });
  } finally {
    client.release();
  }
});

// Admin: mark an unsold player as "Unsold" (passed over in the live auction) or move them
// back to "Available" so they re-enter the normal pool. Has no effect on Sold players —
// undo the sale first if you need to change a Sold player's status.
app.post('/api/players/:id/unsold', requireAdmin, async (req, res) => {
  try {
    const { unsold } = req.body;
    const check = await pool.query('SELECT status FROM players WHERE id = $1', [req.params.id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Player not found.' });
    if (check.rows[0].status === 'Sold') {
      return res.status(400).json({ error: 'This player is already sold. Undo the sale first if you need to change their status.' });
    }
    const newStatus = unsold ? 'Unsold' : 'Available';
    const result = await pool.query(
      `UPDATE players SET status = $1 WHERE id = $2 RETURNING id, status`,
      [newStatus, req.params.id]
    );
    res.json({ success: true, status: result.rows[0].status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update status.' });
  }
});

// Admin: undo a sale, returning the player to Available and refunding the owner's budget
app.post('/api/auction/undo', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: 'playerId is required.' });

    await client.query('BEGIN');
    const playerCheck = await client.query('SELECT owner_id, sold_price, pick_tag FROM players WHERE id = $1 FOR UPDATE', [playerId]);
    if (playerCheck.rows.length === 0) throw new Error('Player not found.');
    const { owner_id, sold_price, pick_tag } = playerCheck.rows[0];
    if (!owner_id) throw new Error('This player is not currently sold.');
    if (pick_tag === 'Owner') throw new Error('This member is the team owner — delete the owner (from the Owners list) instead of undoing this.');

    await client.query(
      `UPDATE players SET status = 'Available', owner_id = NULL, sold_price = NULL, pick_tag = NULL WHERE id = $1`,
      [playerId]
    );
    await client.query(
      `UPDATE owners SET budget_spent = budget_spent - $1 WHERE id = $2`,
      [Number(sold_price) || 0, owner_id]
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(400).json({ error: err.message || 'Could not undo the sale.' });
  } finally {
    client.release();
  }
});

// ---------- AUCTION: OWNER SELF-SERVICE ----------

// Owner login (public) — checks name + password, returns owner info (no password) if valid.
// The front-end then re-sends these same name/password as headers on every owner request below.
app.post('/api/owner-login', async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password) {
      return res.status(400).json({ error: 'Enter your owner name and password.' });
    }
    const result = await pool.query(`SELECT * FROM owners WHERE LOWER(login_username) = LOWER($1) LIMIT 1`, [name]);
    const owner = result.rows[0];
    if (!owner || !owner.owner_password || owner.owner_password !== password) {
      return res.status(401).json({ error: 'Incorrect owner name or password.' });
    }
    res.json({
      success: true,
      owner: {
        id: owner.id,
        name: owner.name,
        team_name: owner.team_name,
        logo_url: owner.logo_url,
        budget_total: owner.budget_total,
        budget_spent: owner.budget_spent
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

// Owner: get my own up-to-date budget (in case another purchase happened elsewhere)
app.get('/api/owner/me', requireOwner, async (req, res) => {
  res.json({
    id: req.owner.id,
    name: req.owner.name,
    team_name: req.owner.team_name,
    budget_total: req.owner.budget_total,
    budget_spent: req.owner.budget_spent
  });
});

// Owner: view the live player board (same data admin sees, minus other owners' contact details)
app.get('/api/owner/board', requireOwner, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.name, p.location, p.role, p.photo_url, p.status, p.sold_price, p.pick_tag,
             p.age_category, p.owner_id, o.name AS owner_name, o.team_name AS owner_team_name
      FROM players p
      LEFT JOIN owners o ON o.id = p.owner_id
      ORDER BY p.id ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the player board.' });
  }
});

// Owner: buy a player for themselves, live, from their own device.
// Row-locked so two owners racing on the same player can't both win it,
// and re-checks their remaining budget server-side (never trust the client).
app.post('/api/owner/buy', requireOwner, async (req, res) => {
  const client = await pool.connect();
  try {
    const { playerId, price } = req.body;
    const numericPrice = Number(price);
    if (!playerId || price === undefined || price === null || isNaN(numericPrice) || numericPrice < 0) {
      return res.status(400).json({ error: 'A player and a valid price are required.' });
    }

    await client.query('BEGIN');

    // Lock the player row first, then the owner row — prevents double-buys and overspend races
    const playerCheck = await client.query('SELECT status FROM players WHERE id = $1 FOR UPDATE', [playerId]);
    if (playerCheck.rows.length === 0) throw new Error('Player not found.');
    if (playerCheck.rows[0].status === 'Sold') throw new Error('Too slow — someone already bought this player.');

    const ownerCheck = await client.query('SELECT budget_total, budget_spent FROM owners WHERE id = $1 FOR UPDATE', [req.owner.id]);
    if (ownerCheck.rows.length === 0) throw new Error('Owner not found.');
    const remaining = Number(ownerCheck.rows[0].budget_total) - Number(ownerCheck.rows[0].budget_spent);
    if (numericPrice > remaining) throw new Error(`Not enough budget left. You have ₹${remaining.toLocaleString()} remaining.`);

    await client.query(
      `UPDATE players SET status = 'Sold', owner_id = $1, sold_price = $2 WHERE id = $3`,
      [req.owner.id, numericPrice, playerId]
    );
    await client.query(
      `UPDATE owners SET budget_spent = budget_spent + $1 WHERE id = $2`,
      [numericPrice, req.owner.id]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(400).json({ error: err.message || 'Could not complete the purchase.' });
  } finally {
    client.release();
  }
});

// ---------- START ----------
initDb().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('  BORLI PREMIER LEAGUE SEASON 2 — Registration Server');
    console.log('  ------------------------------------------------');
    console.log('  Running at:  http://localhost:' + PORT);
    console.log('  Database: connected (Postgres)');
    console.log('  Press Ctrl+C to stop the server.');
    console.log('');
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
