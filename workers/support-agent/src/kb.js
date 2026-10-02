/* KB search — pure functions, no SDK imports. Testable in plain node. */
import faqData from '../kb/faq.json' with { type: 'json' };
import productsData from '../../../products.json' with { type: 'json' };
import donateData from '../../../donate.json' with { type: 'json' };

const STOP = new Set(
  'a,an,the,and,or,but,of,to,in,on,for,with,at,by,from,as,is,are,was,were,be,been,being,have,has,had,do,does,did,will,would,can,could,should,may,might,must,shall,it,its,it\'s,this,that,these,those,i,me,my,you,he,she,we,they,them,his,her,our,your,their,mine,yours,myself,him,us,what,whats,what\'s,which,who,whom,whose,when,where,why,how,there,here,not,no,yes,if,then,than,so,such,very,just,about,into,over,after,before,between,through,during,each,other,some,any,all,both,own,same,too,also,only,say,said,says'.split(',')
);

export function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9$.\s']/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w && !STOP.has(w) && w.length > 1);
}

function scoreEntry(entry, qtokens) {
  const qtext = entry.questions.join(' ').toLowerCase();
  const atext = entry.answer.toLowerCase();
  let score = 0;
  for (const t of qtokens) {
    if (qtext.includes(t)) score += 3;
    else if (atext.includes(t)) score += 1;
  }
  return score;
}

/**
 * Search the curated FAQ. Returns [{id, answer, sources, score}] sorted by
 * score, only entries scoring >= threshold. Empty array = out of KB.
 */
export function searchFaq(query, limit = 3, threshold = 5) {
  const qt = tokenize(query);
  if (qt.length === 0) return [];
  return faqData.faqs
    .map((f) => ({ id: f.id, answer: f.answer, sources: f.sources, note: f.note, score: scoreEntry(f, qt) }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function getFaqById(id) {
  return faqData.faqs.find((f) => f.id === id) || null;
}

/** Find a product by keyword (name/id). Returns the products.json record or null. */
export function findProduct(query) {
  const qt = tokenize(query);
  if (qt.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const p of productsData.products) {
    const text = `${p.id} ${p.name}`.toLowerCase();
    let score = 0;
    for (const t of qt) if (text.includes(t)) score += t.length > 4 ? 2 : 1;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= 2 ? best : null;
}

export function listProducts() { return productsData.products; }
export function getDonateInfo() { return donateData; }
export function kbMeta() { return { faqs: faqData.faqs.length, products: productsData.products.length, updated: faqData._meta.updated }; }
