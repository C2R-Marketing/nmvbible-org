/* Escalation review queue — D1-backed, idempotent writes.
 * NOTHING in this queue is ever sent automatically. A human reviews every item
 * in the admin view and follows up manually. (PR #470 owner lock.) */

export async function initQueue(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    session_id TEXT NOT NULL,
    question TEXT NOT NULL,
    email TEXT,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    resolved_at TEXT,
    resolved_note TEXT
  )`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status, created_at)`);
}

/** Deterministic idempotency key: same session + same question = same key. */
export async function idempotencyKey(sessionId, question) {
  const data = new TextEncoder().encode(`${sessionId}::${String(question).trim().toLowerCase()}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Propose an escalation. INSERT OR IGNORE on the idempotency key means a
 * retried/duplicate submission can never create two queue items.
 * Returns { id, created: boolean }.
 */
export async function enqueueEscalation(db, { sessionId, question, email = null, reason }) {
  const id = await idempotencyKey(sessionId, question);
  const now = new Date().toISOString();
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO escalations (id, created_at, session_id, question, email, reason, status)
       VALUES (?, ?, ?, ?, ?, ?, 'open')`
    )
    .bind(id, now, sessionId, question, email, reason)
    .run();
  // D1: res.meta.changes === 0 means the row already existed.
  const created = (res.meta && typeof res.meta.changes === 'number') ? res.meta.changes > 0 : true;
  return { id, created };
}

export async function listEscalations(db, status = 'open', limit = 100) {
  const res = await db
    .prepare(`SELECT id, created_at, session_id, question, email, reason, status FROM escalations WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(status, limit)
    .all();
  return res.results || [];
}

export async function resolveEscalation(db, id, note = '') {
  const now = new Date().toISOString();
  await db
    .prepare(`UPDATE escalations SET status = 'resolved', resolved_at = ?, resolved_note = ? WHERE id = ?`)
    .bind(now, note, id)
    .run();
  return { id, status: 'resolved' };
}
