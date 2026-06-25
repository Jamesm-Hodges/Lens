// LENS — /api/verdict  (POST)
// Asks an LLM for a one-line risk verdict from the panel's on-chain signals.
// Provider-agnostic (any OpenAI-compatible API). Key stays server-side.
//
// COST CONTROLS (added to stretch limited LLM credits):
//   1. Supabase cache keyed by username + a hash of the signals. Identical scans
//      reuse the stored verdict for 24h = ZERO LLM cost on repeats.
//   2. max_tokens capped low (output is one short JSON line).
//   3. Input trimmed.
//   Set LLM_MODEL to a small/cheap model for the biggest per-call saving.
//
// Env required:  LLM_API_KEY
// Env optional:  LLM_API_URL (default Venice), LLM_MODEL (default llama-3.3-70b)
// Env optional (cache): LENS_SUPABASE_URL, LENS_SUPABASE_SERVICE_KEY

import crypto from 'node:crypto';

const LLM_KEY = process.env.LLM_API_KEY;
const LLM_URL = (process.env.LLM_API_URL || 'https://api.venice.ai/api/v1').replace(/\/+$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'llama-3.2-3b';
const SB_URL = process.env.LENS_SUPABASE_URL;
const SB_KEY = process.env.LENS_SUPABASE_SERVICE_KEY;
const CACHE_HOURS = 24;

const SYSTEM = [
  'You are an on-chain risk analyst for crypto token deployers on Base / Bankrbot.',
  'Assess rug/scam risk using ONLY the signals provided. Never invent facts.',
  'Reply with STRICT JSON only, no markdown: {"level":"LOW|MEDIUM|HIGH","verdict":"<one sentence, max 24 words>"}',
  'Weigh heavily: dev sold, CA removed from bio, very high fee share, bundled/dev-funded buyers, serial deploys.',
  'If signals are thin or clean, use LOW/MEDIUM and say so briefly.',
].join(' ');

const sbHeaders = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' });
const cacheKey = (username, panel, trust) =>
  crypto.createHash('sha1').update(`${username}|${panel}|${trust ? trust.score : ''}`).digest('hex').slice(0, 40);

async function cacheGet(key) {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const cutoff = new Date(Date.now() - CACHE_HOURS * 3600 * 1000).toISOString();
    const r = await fetch(
      `${SB_URL}/rest/v1/verdict_cache?key=eq.${key}&created_at=gte.${encodeURIComponent(cutoff)}&select=level,verdict`,
      { headers: sbHeaders() });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows && rows[0] ? rows[0] : null;
  } catch (_) { return null; }
}

async function cacheSet(key, username, level, verdict) {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/verdict_cache`, {
      method: 'POST',
      headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ key, username, level, verdict, created_at: new Date().toISOString() }),
    });
  } catch (_) {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST only' });

  if (!LLM_KEY) {
    return res.status(200).json({ success: false, error: 'LLM_API_KEY not configured on the server' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const username = String(body.username || '').replace(/^@/, '').slice(0, 40);
    const panel = String(body.panel || '').slice(0, 900);   // trimmed input
    const trust = body.trust || null;

    if (!panel && !trust) {
      return res.status(200).json({ success: false, error: 'no signals provided' });
    }

    // 1) cache hit -> no LLM spend
    const key = cacheKey(username, panel, trust);
    const cached = await cacheGet(key);
    if (cached && cached.verdict) {
      return res.status(200).json({ success: true, level: cached.level, verdict: cached.verdict, cached: true, model: LLM_MODEL });
    }

    const userMsg =
      `X account: @${username || 'unknown'}\n` +
      (trust ? `Trust score: ${trust.score}/100 (${trust.label})\n` : '') +
      `LENS signals:\n${panel || '(none)'}`;

    // Call the provider with backoff. Venice returns 429 for rate-limit AND for
    // "model overloaded", so a couple of spaced retries recovers most blips.
    // Keep retries low — >20 failures in 30s triggers a 30s hard block.
    const payload = {
      model: LLM_MODEL,
      temperature: 0.2,
      max_tokens: 120,            // output is one short JSON line
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userMsg },
      ],
    };

    let r, lastStatus = 0;
    const delays = [0, 1500, 3500];   // 1 initial try + 2 retries
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await new Promise(res => setTimeout(res, delays[i]));
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      try {
        r = await fetch(`${LLM_URL}/chat/completions`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
          body: JSON.stringify(payload),
        });
      } finally {
        clearTimeout(t);
      }
      lastStatus = r.status;
      if (r.status !== 429 && r.status !== 503) break;  // only retry overload/rate-limit
    }

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      const hint = (lastStatus === 429)
        ? 'rate-limited / model overloaded — try a smaller LLM_MODEL (e.g. llama-3.2-3b) or wait a moment'
        : `provider ${lastStatus}`;
      return res.status(200).json({ success: false, error: hint, status: lastStatus, detail: txt.slice(0, 200) });
    }

    const j = await r.json();
    const msg = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
    let raw = msg.content || '';
    if (Array.isArray(raw)) raw = raw.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join(' ');
    if (!raw && msg.reasoning_content) raw = String(msg.reasoning_content);
    const out = parseVerdict(raw);
    // 2) store for next time
    cacheSet(key, username, out.level, out.verdict);
    return res.status(200).json({ success: true, ...out, model: LLM_MODEL });
  } catch (e) {
    return res.status(200).json({ success: false, error: String(e && e.message || e) });
  }
}

function parseVerdict(raw) {
  let level = 'MEDIUM', verdict = '';
  const cleaned = String(raw).replace(/```json|```/g, '').trim();
  try {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]);
      if (o.level) level = String(o.level).toUpperCase();
      if (o.verdict) verdict = String(o.verdict).trim();
    }
  } catch (e) {}
  if (!verdict) {
    verdict = cleaned.slice(0, 200) || 'Not enough signals for a confident read.';
    if (/high risk|likely rug|scam|avoid|dangerous/i.test(cleaned)) level = 'HIGH';
    else if (/low risk|looks clean|no obvious/i.test(cleaned)) level = 'LOW';
  }
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(level)) level = 'MEDIUM';
  return { level, verdict };
}
