/* Guardrails — pure functions, no SDK imports. Testable in plain node. */

/** Scope pre-filter: the agent only handles Bible / translation / edition /
 *  order / donation / NMV-project topics. The LLM input guardrail in agent.js
 *  does the authoritative classification; this is the cheap deterministic layer.
 *
 *  NOTE: `translation`/`translated` are deliberately word-specific — a bare
 *  `translat` prefix would also match "Translate this…" (a translation SERVICE
 *  request, which is out of scope). Those service phrasings are caught by
 *  OUT_OF_SCOPE_RE below, checked first. */
const SCOPE_RE = /bible|nmv|translation|translated|edition|volume|ebook|kindle|pdf|amazon|tovrose|donat|zeffy|gift|giving|tov rose|jesus|god|yehovah|elohim|el shaddai|adonai|messianic|tanakh|old testament|new testament|scripture|hebrew|greek|bonus|chapter|review|endors|church|order|ship|return|refund|price|cost|free|read|youversion|subscriber|email list|second edition|manuscript/i;

export function isInScope(text) {
  return SCOPE_RE.test(String(text || ''));
}

/** Deterministic out-of-scope overrides: service/topic requests that are never
 *  NMV business, checked BEFORE the scope allowlist. Word-boundaried so
 *  in-scope words ("translation") never collide with service requests
 *  ("translate this…"). */
const OUT_OF_SCOPE_RE = /\btranslate\b|cryptocurrency|\bcrypt\b|bitcoin|ethereum|\binvesting\b|\binvestment\b|file my taxes|tax filing|presidential election|who will win the|write (me )?a sermon|back pain|medical advice|quantum|chiefs game|tell me a joke|write me a poem/i;

export function isOutOfScope(text) {
  return OUT_OF_SCOPE_RE.test(String(text || ''));
}

/** Prompt-injection / jailbreak patterns in user input OR in tool-returned text. */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+|your\s+|previous\s+|prior\s+)*instructions/i,
  /disregard\s+(all\s+|your\s+|previous\s+)*instructions/i,
  /reveal\s+(your\s+|the\s+)?[\w\s]{0,24}?(prompt|instructions|message)/i,
  /what\s+(is|are)\s+your\s+(system|hidden|secret)\s*(prompt|instructions)/i,
  /jailbreak/i,
  /\bDAN\b.*mode/i,
  /do\s+anything\s+now/i,
  /developer\s+mode/i,
  /pretend\s+(you\s+are|to\s+be)\s+(not|a\s+different)/i,
  /override\s+(your|the)\s+(safety|system|guardrail)/i,
  /\[system\]/i,
  /<\|?system\|?>/i,
  /forget\s+(the\s+|your\s+|all\s+|my\s+)?(nmv|bible|instructions|everything|previous|prior)/i,
  /you are now (a|an|not)\b/i,
];

export function detectInjection(text) {
  const s = String(text || '');
  const hit = INJECTION_PATTERNS.find((re) => re.test(s));
  return hit ? hit.source : null;
}

/** Redact PII from text before it is logged or echoed. */
export function scrubPII(text) {
  return String(text || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
    .replace(/(\+?1[-.\s]?)?(\(?\d{3}\)?[-.\s]?){2}\d{4}/g, '[phone redacted]')
    .replace(/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, '[card redacted]');
}

export const REFUSAL_TEXT =
  "I don't have a verified answer for that in the NMV site's information, so I won't guess. " +
  "If you'd like, I can pass your question to the NMV team — just share your email and they'll follow up personally.";

export const OUT_OF_SCOPE_TEXT =
  "I'm the NMV Bible assistant — I can help with questions about the translation, editions, ordering, the free chapter, and donations. " +
  "For anything outside that, the team can help directly if you leave your question and email.";

/** Last-resort reply when every model provider fails mid-turn. The question is
 *  always queued for human review alongside it — never dropped silently. */
export const MODEL_ERROR_TEXT =
  "I hit a glitch pulling up the NMV information just now — I've passed your question to the NMV team and they'll follow up personally.";

/** Donation safety: the agent NEVER states amounts as commitments, NEVER takes
 *  payment, NEVER gives tax advice. It may only link the donation form. */
export function containsDonationCommitment(text) {
  // Offering to process/collect a donation, or promising tax outcomes.
  return /(i'll|i will)\s+(process|collect|take|charge)\s+(your\s+)?(donation|gift|payment|card)/i.test(text) ||
    /you\s+(will|can)\s+(deduct|write off)/i.test(text);
}
