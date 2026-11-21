import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';

// ============================================================================
// 1. SECURITY & PRIVACY UTILITIES (Web Crypto API — Zero Node Dependencies)
// ============================================================================

/**
 * Escapes HTML special characters to prevent XSS in stored messages/names.
 */
export function sanitizeText(input = '', maxLength = 2000) {
  return String(input)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Masks an email address for safe public display on /t/[token]
 * Example: "shamil.tp@gmail.com" -> "sh***@gmail.com"
 */
export function maskEmail(email = '') {
  const clean = String(email).trim().toLowerCase();
  const atIndex = clean.indexOf('@');
  if (atIndex <= 0) return '***';

  const local = clean.slice(0, atIndex);
  const domain = clean.slice(atIndex + 1);
  const visiblePrefix = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
  return `${visiblePrefix}***@${domain}`;
}

/**
 * Masks a phone number while keeping country code prefix and last 3 digits.
 * Example: "+91 9876543160" -> "+91 ******160"
 */
export function maskPhone(phone = '') {
  const raw = String(phone).trim();
  if (!raw) return null;

  const digits = raw.replace(/\D/g, '');
  if (digits.length < 4) return '***';

  const lastThree = digits.slice(-3);
  const prefixMatch = raw.match(/^\+\d{1,3}/);
  const prefix = prefixMatch ? `${prefixMatch[0]} ` : '';
  return `${prefix}******${lastThree}`;
}

/**
 * Cryptographically random hex string using Web Crypto API.
 */
function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Random 4-digit integer (1000-9999) using Web Crypto API.
 */
function randomFourDigits() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return 1000 + (arr[0] % 9000);
}

/**
 * SHA-256 hex digest using Web Crypto SubtleCrypto.
 */
async function sha256Hex(value = '') {
  const data = new TextEncoder().encode(String(value));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string comparison via SHA-256 digests to prevent timing attacks.
 */
async function timingSafeMatch(provided = '', expected = '') {
  if (!provided || !expected) return false;
  const enc = new TextEncoder();
  const [aBuf, bBuf] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(provided))),
    crypto.subtle.digest('SHA-256', enc.encode(String(expected))),
  ]);
  const a = new Uint8Array(aBuf);
  const b = new Uint8Array(bBuf);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Lightweight per-isolate sliding-window rate limiter (no top-level setInterval).
 * Note: For strict global edge rate limiting across POPs, pair with Cloudflare WAF Rate Limiting Rules.
 */
function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  let calls = 0;

  return async (c, next) => {
    const now = Date.now();
    calls += 1;

    // Lazy cleanup every 100 requests to keep isolate memory bounded
    if (calls % 100 === 0) {
      for (const [key, entry] of hits.entries()) {
        if (now > entry.resetAt) hits.delete(key);
      }
    }

    const ip =
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      'unknown';

    const record = hits.get(ip);
    if (!record || now > record.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (record.count >= max) {
      c.header('Retry-After', String(Math.ceil((record.resetAt - now) / 1000)));
      return c.json({ error: message || 'Too many requests. Please slow down.' }, 429);
    }

    record.count += 1;
    return next();
  };
}

// ============================================================================
// 2. D1 DATA HELPERS & PUBLIC SERIALIZATION
// ============================================================================

const STATUS_LABELS = {
  RECEIVED: 'RECEIVED',
  AI_REPLIED: 'AI REPLIED',
  SHAMIL_REPLIED: 'SHAMIL REPLIED',
  CLOSED: 'CLOSED',
};

/**
 * Formats D1 ticket + message rows into a safe public pass payload for /t/[token].
 * Raw PII and admin_token_hash are never included.
 */
function toPublicPass(ticketRow, messageRows = []) {
  return {
    ticketId: ticketRow.ticket_id,
    status: ticketRow.status,
    statusBadge: STATUS_LABELS[ticketRow.status] || 'RECEIVED',
    visitor: {
      name: ticketRow.visitor_name,
      maskedEmail: ticketRow.masked_email,
      maskedPhone: ticketRow.masked_phone,
    },
    submittedAt: ticketRow.submitted_at,
    updatedAt: ticketRow.updated_at,
    messages: messageRows.map((m) => ({
      id: m.id,
      sender: m.sender,
      authorName: m.author_name,
      body: m.body,
      createdAt: m.created_at,
    })),
  };
}

/**
 * Generates a collision-safe human-readable Ticket ID (e.g. "TKT-8492") in D1.
 */
async function generateUniqueTicketId(db) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = `TKT-${randomFourDigits()}`;
    const existing = await db
      .prepare('SELECT 1 FROM tickets WHERE ticket_id = ? LIMIT 1')
      .bind(candidate)
      .first();
    if (!existing) return candidate;
  }
  return `TKT-${randomHex(3).toUpperCase()}`;
}

/**
 * Fetches all thread messages for a ticket ordered chronologically.
 */
async function getTicketMessages(db, ticketId) {
  const { results } = await db
    .prepare(
      `SELECT id, sender, author_name, body, created_at
       FROM messages
       WHERE ticket_id = ?
       ORDER BY created_at ASC`
    )
    .bind(ticketId)
    .all();
  return results || [];
}

// ============================================================================
// 3. HONO APP & MIDDLEWARE
// ============================================================================

const app = new Hono();

// Strict CORS configuration matching shamiltp.me & shamiltp.life
app.use(
  '/api/*',
  cors({
    origin: [
      'https://shamiltp.me',
      'https://www.shamiltp.me',
      'https://shamiltp.life',
      'http://localhost:3000',
    ],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'x-api-key', 'x-admin-key', 'x-admin-token'],
    maxAge: 86400,
  })
);

// Enforce 32 KB body limit on incoming JSON payloads
app.use(
  '/api/*',
  bodyLimit({
    maxSize: 32_768,
    onError: (c) => c.json({ error: 'Payload too large (max 32KB)' }, 413),
  })
);

// Rate Limiters
const readTicketLimiter = createRateLimiter({
  windowMs: 60_000, // 1 minute
  max: 30,
  message: 'Rate limit exceeded while fetching ticket pass.',
});

const postFollowUpLimiter = createRateLimiter({
  windowMs: 600_000, // 10 minutes
  max: 5,
  message: 'Too many follow-up messages. Please wait a few minutes.',
});

const adminReplyLimiter = createRateLimiter({
  windowMs: 300_000, // 5 minutes
  max: 15,
  message: 'Too many admin authentication attempts.',
});

// ============================================================================
// 4. ROUTES
// ============================================================================

/**
 * ROUTE 1: POST /api/tickets
 * Called by n8n HTTP Request node (secured with `x-api-key: N8N_API_KEY`).
 * Atomically creates the ticket + initial visitor & Gemini messages in D1.
 */
app.post('/api/tickets', async (c) => {
  try {
    const apiKey = c.req.header('x-api-key');
    if (!(await timingSafeMatch(apiKey, c.env.N8N_API_KEY))) {
      return c.json({ error: 'Unauthorized: Invalid x-api-key' }, 401);
    }

    const body = await c.req.json().catch(() => ({}));
    const { name, email, phone, message, aiReply, submittedAt } = body;

    if (!name || !email || !message) {
      return c.json({ error: 'Missing required fields: name, email, message' }, 400);
    }

    const cleanName = sanitizeText(name, 80);
    const cleanEmail = String(email).trim().toLowerCase().slice(0, 160);
    const cleanPhone = phone ? sanitizeText(phone, 30) : null;
    const cleanVisitorMsg = sanitizeText(message, 2000);
    const cleanAiReply = aiReply ? sanitizeText(aiReply, 2000) : null;

    const db = c.env.DB;
    const ticketId = await generateUniqueTicketId(db);
    const accessToken = randomHex(16); // 32-char hex visitor token
    const adminToken = randomHex(16); // 32-char hex per-ticket admin secret
    const adminTokenHash = await sha256Hex(adminToken);

    const nowIso = new Date().toISOString();
    const submittedIso = submittedAt ? new Date(submittedAt).toISOString() : nowIso;
    const status = cleanAiReply ? 'AI_REPLIED' : 'RECEIVED';
    const maskedEmail = maskEmail(cleanEmail);
    const maskedPhone = maskPhone(cleanPhone);

    const statements = [
      db
        .prepare(
          `INSERT INTO tickets (
             ticket_id, access_token, admin_token_hash, status,
             visitor_name, masked_email, masked_phone,
             raw_email, raw_phone, submitted_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          ticketId,
          accessToken,
          adminTokenHash,
          status,
          cleanName,
          maskedEmail,
          maskedPhone,
          cleanEmail,
          cleanPhone,
          submittedIso,
          nowIso,
          nowIso
        ),
      db
        .prepare(
          `INSERT INTO messages (id, ticket_id, sender, author_name, body, created_at)
           VALUES (?, ?, 'VISITOR', ?, ?, ?)`
        )
        .bind(`MSG-${randomHex(4)}`, ticketId, cleanName, cleanVisitorMsg, submittedIso),
    ];

    if (cleanAiReply) {
      statements.push(
        db
          .prepare(
            `INSERT INTO messages (id, ticket_id, sender, author_name, body, created_at)
             VALUES (?, ?, 'AI', ?, ?, ?)`
          )
          .bind(`MSG-${randomHex(4)}`, ticketId, "Shamil's AI Assistant", cleanAiReply, nowIso)
      );
    }

    await db.batch(statements);

    const baseUrl = (c.env.PUBLIC_SITE_URL || 'https://shamiltp.me').replace(/\/$/, '');
    const ticketUrl = `${baseUrl}/t/${accessToken}`;
    const adminReplyUrl = `${ticketUrl}?admin=${adminToken}`;

    return c.json(
      {
        ticketId,
        accessToken,
        adminToken,
        status,
        ticketUrl,
        adminReplyUrl,
        maskedEmail,
        maskedPhone,
      },
      201
    );
  } catch (err) {
    console.error('[POST /api/tickets] Error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * ROUTE 2: GET /api/tickets/:token
 * Public zero-login endpoint for `/t/[token]`.
 * Only selects public columns — never raw_email, raw_phone, or admin_token_hash.
 */
app.get('/api/tickets/:token', readTicketLimiter, async (c) => {
  try {
    const token = c.req.param('token');
    if (!/^[a-f0-9]{32}$/i.test(token)) {
      return c.json({ error: 'Ticket pass not found' }, 404);
    }

    const db = c.env.DB;
    const ticket = await db
      .prepare(
        `SELECT ticket_id, status, visitor_name, masked_email, masked_phone, submitted_at, updated_at
         FROM tickets
         WHERE access_token = ?
         LIMIT 1`
      )
      .bind(token.toLowerCase())
      .first();

    if (!ticket) {
      return c.json({ error: 'Ticket pass not found' }, 404);
    }

    const messages = await getTicketMessages(db, ticket.ticket_id);
    return c.json(toPublicPass(ticket, messages));
  } catch (err) {
    console.error('[GET /api/tickets/:token] Error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * ROUTE 3: POST /api/tickets/:token/messages
 * Public endpoint allowing the visitor to append a follow-up message.
 * Uses `c.executionCtx.waitUntil()` so the Discord alert completes after responding.
 */
app.post('/api/tickets/:token/messages', postFollowUpLimiter, async (c) => {
  try {
    const token = c.req.param('token');
    if (!/^[a-f0-9]{32}$/i.test(token)) {
      return c.json({ error: 'Ticket pass not found' }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const rawBody = body?.message;
    if (!rawBody || !String(rawBody).trim()) {
      return c.json({ error: 'Message body cannot be empty' }, 400);
    }

    const db = c.env.DB;
    const ticket = await db
      .prepare(
        `SELECT ticket_id, access_token, status, visitor_name, masked_email, masked_phone, submitted_at, updated_at
         FROM tickets
         WHERE access_token = ?
         LIMIT 1`
      )
      .bind(token.toLowerCase())
      .first();

    if (!ticket) {
      return c.json({ error: 'Ticket pass not found' }, 404);
    }

    if (ticket.status === 'CLOSED') {
      return c.json({ error: 'This inquiry ticket is closed.' }, 403);
    }

    const countRow = await db
      .prepare('SELECT COUNT(*) AS total FROM messages WHERE ticket_id = ?')
      .bind(ticket.ticket_id)
      .first();

    if ((countRow?.total || 0) >= 30) {
      return c.json({ error: 'Maximum thread length reached for this ticket.' }, 429);
    }

    const cleanBody = sanitizeText(rawBody, 2000);
    const nowIso = new Date().toISOString();
    const newMsg = {
      id: `MSG-${randomHex(4)}`,
      sender: 'VISITOR',
      authorName: ticket.visitor_name,
      body: cleanBody,
      createdAt: nowIso,
    };

    await db.batch([
      db
        .prepare(
          `INSERT INTO messages (id, ticket_id, sender, author_name, body, created_at)
           VALUES (?, ?, 'VISITOR', ?, ?, ?)`
        )
        .bind(newMsg.id, ticket.ticket_id, newMsg.authorName, newMsg.body, nowIso),
      db
        .prepare('UPDATE tickets SET updated_at = ? WHERE ticket_id = ?')
        .bind(nowIso, ticket.ticket_id),
    ]);

    // Non-blocking Discord webhook alert via Workers waitUntil
    if (c.env.DISCORD_WEBHOOK_URL) {
      const baseUrl = (c.env.PUBLIC_SITE_URL || 'https://shamiltp.me').replace(/\/$/, '');
      const ticketUrl = `${baseUrl}/t/${ticket.access_token}`;
      const discordPromise = fetch(c.env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'shamiltp.me // Telemetry',
          embeds: [
            {
              title: `🔴 Follow-Up on ${ticket.ticket_id}`,
              url: ticketUrl,
              color: 0xe52421,
              fields: [
                { name: 'Visitor', value: ticket.visitor_name, inline: true },
                { name: 'Ticket ID', value: `\`${ticket.ticket_id}\``, inline: true },
                { name: 'Message', value: cleanBody.slice(0, 1000) },
              ],
              timestamp: nowIso,
            },
          ],
        }),
      }).catch((err) => console.error('[Discord Webhook] Failed:', err.message));

      c.executionCtx?.waitUntil(discordPromise);
    }

    ticket.updated_at = nowIso;
    const messages = await getTicketMessages(db, ticket.ticket_id);

    return c.json(
      {
        message: newMsg,
        ticket: toPublicPass(ticket, messages),
      },
      201
    );
  } catch (err) {
    console.error('[POST /api/tickets/:token/messages] Error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * ROUTE 4: POST /api/tickets/:ticketId/admin-reply
 * Authenticated endpoint for Shamil to post a personal reply and set status to SHAMIL_REPLIED.
 * Supports either:
 *   - Header `x-admin-key: <ADMIN_API_KEY>` (global master secret)
 *   - Header `x-admin-token: <per-ticket adminToken>` or `body.adminToken` (from Discord link)
 */
app.post('/api/tickets/:ticketId/admin-reply', adminReplyLimiter, async (c) => {
  try {
    const ticketId = c.req.param('ticketId').toUpperCase().trim();
    const body = await c.req.json().catch(() => ({}));
    const { message, status, adminToken: bodyAdminToken } = body;

    if (!message || !String(message).trim()) {
      return c.json({ error: 'Reply message is required' }, 400);
    }

    const db = c.env.DB;
    const ticket = await db
      .prepare(
        `SELECT ticket_id, admin_token_hash, status, visitor_name, masked_email, masked_phone, submitted_at, updated_at
         FROM tickets
         WHERE ticket_id = ?
         LIMIT 1`
      )
      .bind(ticketId)
      .first();

    if (!ticket) {
      return c.json({ error: 'Ticket not found' }, 404);
    }

    const providedMasterKey = c.req.header('x-admin-key');
    const providedTicketToken = c.req.header('x-admin-token') || bodyAdminToken;

    const isMasterValid =
      Boolean(c.env.ADMIN_API_KEY) &&
      (await timingSafeMatch(providedMasterKey, c.env.ADMIN_API_KEY));

    const isTicketTokenValid =
      Boolean(providedTicketToken) &&
      (await timingSafeMatch(await sha256Hex(providedTicketToken), ticket.admin_token_hash));

    if (!isMasterValid && !isTicketTokenValid) {
      return c.json({ error: 'Unauthorized admin credentials' }, 401);
    }

    const cleanReply = sanitizeText(message, 2000);
    const nowIso = new Date().toISOString();
    const nextStatus = status === 'CLOSED' ? 'CLOSED' : 'SHAMIL_REPLIED';
    const replyMsg = {
      id: `MSG-${randomHex(4)}`,
      sender: 'SHAMIL',
      authorName: 'Shamil TP',
      body: cleanReply,
      createdAt: nowIso,
    };

    await db.batch([
      db
        .prepare(
          `INSERT INTO messages (id, ticket_id, sender, author_name, body, created_at)
           VALUES (?, ?, 'SHAMIL', ?, ?, ?)`
        )
        .bind(replyMsg.id, ticket.ticket_id, replyMsg.authorName, replyMsg.body, nowIso),
      db
        .prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE ticket_id = ?')
        .bind(nextStatus, nowIso, ticket.ticket_id),
    ]);

    ticket.status = nextStatus;
    ticket.updated_at = nowIso;
    const messages = await getTicketMessages(db, ticket.ticket_id);

    return c.json(
      {
        message: replyMsg,
        ticket: toPublicPass(ticket, messages),
      },
      201
    );
  } catch (err) {
    console.error('[POST /api/tickets/:ticketId/admin-reply] Error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Optional health check endpoint
// Health check endpoints (root + /api/health)
app.get('/', (c) => c.json({ ok: true, service: 'shamiltp-ticket-api', runtime: 'cloudflare-workers-d1' }));
app.get('/api/health', (c) => c.json({ ok: true, service: 'shamiltp-ticket-api', runtime: 'cloudflare-workers-d1' }));
// app.get('/api/health', (c) => c.json({ ok: true, runtime: 'cloudflare-workers-d1' }));

export default app;