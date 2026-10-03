/* NMV support-agent Worker entry.
 * Routes:
 *   POST /chat           — visitor chat turn  { session_id, message } -> { reply, type }
 *   GET  /health         — liveness + KB stats (public, no secrets)
 *   GET  /admin          — escalation review queue (basic auth; HUMAN review only)
 *   POST /admin/resolve  — mark a queue item resolved (basic auth)
 *
 * Env bindings: DB (D1), AI (Workers AI). Secrets: CEREBRAS_API_KEY,
 * GEMINI_API_KEY (fallback LLM providers), ADMIN_USER, ADMIN_PASS.
 * Optional var: MODEL (default '@cf/meta/llama-3.1-8b-instruct-fp8'), ALLOWED_ORIGINS (csv).
 */
import { runTurn } from './agent.js';
import { modelConfigured } from './model.js';
import { scrubPII, REFUSAL_TEXT } from './guardrails.js';
import { initQueue, listEscalations, resolveEscalation } from './queue.js';
import { kbMeta } from './kb.js';

const MAX_TURNS_PER_SESSION = 30;
const MAX_MESSAGE_LEN = 500;

async function initDb(db) {
  // NOTE: D1 binding exec() rejects multi-line SQL ("incomplete input") —
  // keep these statements on a single line.
  await db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, history TEXT NOT NULL DEFAULT '[]', turns INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`);
  await initQueue(db);
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS ||
    'https://nmvbible.org,https://www.nmvbible.org,https://c2r-marketing.github.io').split(',').map((s) => s.trim());
  const h = { 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(data, status = 200, req = null, env = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...(req && env ? corsHeaders(req, env) : {}) },
  });
}

/* --- admin basic auth (timing-safe) --- */
function timingSafeEqual(a, b) {
  const ab = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let d = 0;
  for (let i = 0; i < ab.length; i++) d |= ab[i] ^ bb[i];
  return d === 0;
}
function checkAdmin(req, env) {
  const hdr = req.headers.get('Authorization') || '';
  const m = hdr.match(/^Basic (.+)$/);
  if (!m || !env.ADMIN_USER || !env.ADMIN_PASS) return false;
  let decoded = '';
  try { decoded = atob(m[1]); } catch { return false; }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  return timingSafeEqual(decoded.slice(0, idx), env.ADMIN_USER) &&
         timingSafeEqual(decoded.slice(idx + 1), env.ADMIN_PASS);
}
function unauthorized() {
  return new Response('Authentication required', {
    status: 401, headers: { 'WWW-Authenticate': 'Basic realm="nmv-support-agent admin"' },
  });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function adminPage(env) {
  const open = await listEscalations(env.DB, 'open', 100);
  const done = await listEscalations(env.DB, 'resolved', 50);
  const row = (e) => `<tr><td>${esc(e.created_at.slice(0, 16).replace('T', ' '))}</td>` +
    `<td>${esc(e.question)}</td><td>${esc(e.email || '—')}</td><td>${esc(e.reason)}</td>` +
    (e.status === 'open'
      ? `<td><form method="POST" action="/admin/resolve" style="display:inline"><input type="hidden" name="id" value="${esc(e.id)}">` +
        `<input type="text" name="note" placeholder="resolution note" size="18"> <button type="submit">Resolve</button></form></td>`
      : `<td>resolved</td>`) + `</tr>`;
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>NMV support queue</title><style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px}` +
    `table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:8px;text-align:left;vertical-align:top}` +
    `.warn{background:#fff8e6;border:1px solid #e2d6b8;padding:12px;border-radius:8px}</style></head><body>` +
    `<h1>NMV support-agent — review queue</h1>` +
    `<p class="warn"><strong>Human review only.</strong> Nothing here is ever sent automatically. ` +
    `Follow up with the visitor manually (email/ZEFFY), then mark resolved. Owner lock PR #470: no agent sends, ever.</p>` +
    `<h2>Open (${open.length})</h2><table><tr><th>When (UTC)</th><th>Question</th><th>Email</th><th>Reason</th><th></th></tr>` +
    open.map(row).join('') + `</table>` +
    `<h2>Resolved (${done.length})</h2><table><tr><th>When (UTC)</th><th>Question</th><th>Email</th><th>Reason</th><th></th></tr>` +
    done.map(row).join('') + `</table></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req, env) });

      if (url.pathname === '/health' && req.method === 'GET') {
        return json({ ok: true, kb: kbMeta(), time: new Date().toISOString() });
      }

      await initDb(env.DB);

      if (url.pathname === '/admin' && req.method === 'GET') {
        if (!checkAdmin(req, env)) return unauthorized();
        return adminPage(env);
      }
      if (url.pathname === '/admin/resolve' && req.method === 'POST') {
        if (!checkAdmin(req, env)) return unauthorized();
        const form = await req.formData();
        await resolveEscalation(env.DB, String(form.get('id') || ''), String(form.get('note') || ''));
        return Response.redirect(url.origin + '/admin', 303);
      }

      if (url.pathname === '/chat' && req.method === 'POST') {
        let body;
        try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, 400, req, env); }
        const sessionId = String(body.session_id || '').slice(0, 64);
        const message = scrubPII(String(body.message || '')).slice(0, MAX_MESSAGE_LEN);
        if (!sessionId || !message.trim()) return json({ error: 'session_id and message required' }, 400, req, env);
        if (!modelConfigured(env)) return json({ error: 'agent not configured' }, 503, req, env);

        const row = await env.DB.prepare('SELECT history, turns FROM sessions WHERE id = ?').bind(sessionId).first();
        const turns = row ? row.turns : 0;
        if (turns >= MAX_TURNS_PER_SESSION) {
          return json({
            reply: 'We\'ve covered a lot — to make sure you get a proper answer, I\'ve noted this conversation for the NMV team and they\'ll follow up personally.',
            type: 'escalated',
          }, 200, req, env);
        }
        const history = row ? JSON.parse(row.history) : [];
        const { reply, type, history: newHistory } = await runTurn({
          db: env.DB, sessionId, message, history, env,
          waitUntil: ctx.waitUntil.bind(ctx),
        });
        const now = new Date().toISOString();
        await env.DB.prepare(
          `INSERT INTO sessions (id, history, turns, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET history=excluded.history, turns=excluded.turns, updated_at=excluded.updated_at`
        ).bind(sessionId, JSON.stringify(newHistory || []), turns + 1, now).run();
        return json({ reply, type }, 200, req, env);
      }

      return json({ error: 'not found' }, 404, req, env);
    } catch (err) {
      console.error('worker error', err && err.message);
      return json({ reply: REFUSAL_TEXT, type: 'error' }, 500, req, env);
    }
  },
};
