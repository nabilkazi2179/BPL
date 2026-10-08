# BORLI PREMIER LEAGUE - SEASON 2
## Player Registration & Auction App
**Sidra and Devansh Sports present** - January 2027 - Technology partner: **KonkanTech**

This is a fresh copy of the cricket registration/auction app for Borli Premier League Season 2.
It uses its own Postgres database, its own Cloudinary folder (`bpl-season2/`) and its own link,
so nothing is shared with any earlier tournament.

## What is new in this version
- **Registration cap: 96 players.** When the 96th player registers, the public form closes automatically.
  Only the **Super Admin** can reopen it ("Force Registration Open") or change the cap number
  (Admin tab > registration box).
- **KonkanTech logo** on the registration page header and footer, ID cards, all PDFs, the auction
  (projector) screen, the sponsor ticker and the WhatsApp/social link preview.
- **Everything about the tournament name is editable by Admin** (Admin tab > "Tournament branding"):
  title, season, "presented by" name and date. No code change is needed to rename it again.
- Registration page shows a live "X/96 registered - Y slots left" line.

Everything else (Register / Teams / Admin / Auction / Owner Login tabs, Captain pre-pick, duplicate
mobile and payment-screenshot checks, Excel export, ID card lookup, Live Stage mode) works as before.

## One-time setup
1. Create a free Postgres database (Neon or Supabase) and copy its connection string.
2. Create a free Cloudinary account and copy cloud name, API key and API secret.
3. Set these environment variables (Render > Environment): `DATABASE_URL`, `CLOUDINARY_CLOUD_NAME`,
   `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `ADMIN_PASSWORD`, `SUPERADMIN_PASSWORD`.
4. `npm install` then `npm start` (local test at http://localhost:3000).

## Deploying on Render
Push to a NEW GitHub repo, create a Blueprint on render.com (it reads `render.yaml`), fill in the
environment variables, deploy. Then log in to the Admin tab and upload this tournament's payment QR.

## Admin vs Super Admin
- **Admin**: roster, Excel/PDF export, QR upload, branding text, event countdown, auction, Captain pick.
- **Super Admin**: everything Admin can do, plus edit/delete registrations, force registration open
  past the cap, and change the cap number.

## Logos
- KonkanTech logo file: `public/konkantech-logo.jpg` (replace the file to change it).
- Add more sponsors to the ticker in `buildTicker()` inside `public/index.html`.
