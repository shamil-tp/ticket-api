# shamiltp.me — Inquiry Ticket / Pass API (`ticket-api`)

Lightweight, edge-deployed inquiry ticket and threaded messaging backend for [`shamiltp.me`](https://shamiltp.me), built with **Hono**, **Cloudflare Workers**, and **Cloudflare D1 (SQLite)**.

---

## Architecture Overview

1. Visitor submits the contact form on `shamiltp.me/contact/index.html`.
2. **n8n** (self-hosted on `neo`) normalizes the payload, runs **Google Gemini** for an initial helpful reply, and calls `POST /api/tickets` on this Worker with `x-api-key`.
3. The Worker stores the ticket + initial messages atomically in **Cloudflare D1**, masking PII (`sh***@gmail.com`, `+91 ******160`) for public display while keeping raw contact details out of public queries.
4. **n8n** sends one consolidated Nothing-OS HTML confirmation email with the unique `https://shamiltp.me/t/<accessToken>` pass link, plus a Discord alert with the private `?admin=<adminToken>` reply link.
5. Visitors view their live status (`RECEIVED` / `AI REPLIED` / `SHAMIL REPLIED` / `CLOSED`) and post follow-up messages (triggering instant Discord webhook alerts via `waitUntil`).

---

## Project Structure

```text
ticket-api/
├── src/
│   └── index.js         # Hono API routes, Web Crypto auth, PII masking, rate limiter
├── schema.sql           # Cloudflare D1 tables (tickets, messages) & indexes
├── wrangler.jsonc       # Cloudflare Worker & D1 database binding config
└── package.json
```

---

## Setup & Deployment (PowerShell / CLI)

### 1. Install Dependencies & Login
```bash
npm install
npx wrangler login
```

### 2. Create & Bind the D1 Database
```bash
npx wrangler d1 create shamiltp-tickets
```
Copy the returned `database_id` into `wrangler.jsonc`:
```jsonc
{
  "main": "src/index.js",
  "vars": {
    "PUBLIC_SITE_URL": "https://shamiltp.me"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "shamiltp-tickets",
      "database_id": "YOUR_D1_DATABASE_ID"
    }
  ]
}
```

### 3. Initialize Database Tables
```bash
# Local dev database
npx wrangler d1 execute shamiltp-tickets --local --file=./schema.sql

# Remote production database
npx wrangler d1 execute shamiltp-tickets --remote --file=./schema.sql
```

### 4. Configure Secrets
Generate two 32-byte hex keys (PowerShell example):
```powershell
[BitConverter]::ToString((1..32 | ForEach-Object { Get-Random -Maximum 256 })).Replace('-','').ToLower()
```
Upload your three secrets to Cloudflare Workers:
```bash
npx wrangler secret put N8N_API_KEY
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put DISCORD_WEBHOOK_URL
```
*(For local `wrangler dev`, place these three keys in a `.dev.vars` file—never commit `.dev.vars` to Git).*

### 5. Deploy & Attach Custom Domain
```bash
npx wrangler deploy
```
In **Cloudflare Dashboard → Workers & Pages → `ticket-api` → Settings → Domains & Routes**, add Custom Domain `api.shamiltp.me`.

---

## API Endpoints

| Method | Endpoint | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Public | Health check (`{ ok: true, runtime: "cloudflare-workers-d1" }`) |
| `POST` | `/api/tickets` | `x-api-key` | Called by n8n to create a ticket + initial visitor & AI messages |
| `GET` | `/api/tickets/:token` | 32-char hex URL token | Public read endpoint for `/t/[token]` (masked PII + thread only) |
| `POST` | `/api/tickets/:token/messages` | 32-char hex URL token | Visitor appends a follow-up message (triggers Discord webhook) |
| `POST` | `/api/tickets/:ticketId/admin-reply` | `x-admin-key` or `x-admin-token` | Shamil posts a personal reply & updates status to `SHAMIL_REPLIED` or `CLOSED` |

---

## Quick Verification

```bash
# Health check
curl https://api.shamiltp.me/api/health

# Create a test ticket
curl -X POST https://api.shamiltp.me/api/tickets \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_N8N_API_KEY" \
  -d '{
    "name": "Test Visitor",
    "email": "visitor@example.com",
    "phone": "+91 9876543160",
    "message": "Interested in an embedded + web dashboard project.",
    "aiReply": "Thanks for reaching out! Shamil will review your project scope shortly."
  }'
```

---

## Security & Privacy Notes

- **Zero-Login Privacy:** `GET /api/tickets/:token` strictly selects only `visitor_name`, `masked_email`, and `masked_phone`. Raw email/phone and `admin_token_hash` are never returned.
- **Constant-Time Auth:** All API keys and per-ticket admin tokens are verified using SHA-256 constant-time byte comparison via the Web Crypto API.
- **Input Hardening:** All user text is length-capped, control-character stripped, and HTML-escaped before storage, with a 32 KB JSON body limit and per-endpoint rate limiting.
