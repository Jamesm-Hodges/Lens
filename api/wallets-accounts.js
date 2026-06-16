// LENS — /api/wallets-accounts?wallets=0x..,0x..   (GET)
// Given wallets, returns which archived X usernames mention each one.
// Used by serial-rugger linking to tie funding siblings back to known accounts.
//
// Env required: LENS_SUPABASE_URL, LENS_SUPABASE_SERVICE_KEY

const SUPABASE_URL = process.env.LENS_SUPABASE_URL;
const SERVICE_KEY = process.env.LENS_SUPABASE_SERVICE_KEY;
const REST = `${SUPABASE_URL}/rest/v1`;

function H() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const raw = String((req.query && req.query.wallets) || '');
  const wallets = [...new Set(raw.split(',').map(w => w.trim().toLowerCase()).filter(w => /^0x[0-9a-f]{40}$/.test(w)))].slice(0, 60);
  if (!wallets.length) return res.status(200).json({ success: true, accounts: {} });

  try {
    const inList = wallets.map(w => `"${w}"`).join(',');
    const r = await fetch(`${REST}/wallet_mentions?wallet=in.(${encodeURIComponent(inList)})&select=username,wallet`, { headers: H() });
    if (!r.ok) throw new Error(`q ${r.status}`);
    const rows = await r.json();
    const accounts = {};
    for (const row of rows || []) {
      const w = String(row.wallet || '').toLowerCase();
      const u = String(row.username || '').toLowerCase();
      if (!w || !u) continue;
      if (!accounts[w]) accounts[w] = [];
      if (!accounts[w].includes(u)) accounts[w].push(u);
    }
    return res.status(200).json({ success: true, accounts });
  } catch (e) {
    return res.status(200).json({ success: false, error: String(e && e.message || e), accounts: {} });
  }
}
