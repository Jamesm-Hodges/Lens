// LENS — /api/linked-accounts?username=<handle>
// Sockpuppet / network detection: returns OTHER X profiles in the archive that
// mention the same wallet(s) as this profile. Shared EOAs/CAs across a small set
// of accounts hint at alts or a coordinated promo network.
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

  const username = String((req.query && req.query.username) || '').toLowerCase().replace(/^@/, '');
  if (!username) return res.status(200).json({ success: false, linked: [] });

  try {
    // 1) this profile's wallets
    const r1 = await fetch(`${REST}/wallet_mentions?username=eq.${encodeURIComponent(username)}&select=wallet`, { headers: H() });
    if (!r1.ok) throw new Error(`mine ${r1.status}`);
    const mine = await r1.json();
    const wallets = [...new Set((mine || []).map(m => String(m.wallet || '').toLowerCase()).filter(Boolean))];
    if (!wallets.length) return res.status(200).json({ success: true, linked: [], wallets: 0, total_accounts: 0 });

    // 2) everyone who mentions those same wallets
    const inList = wallets.map(w => `"${w}"`).join(',');
    const r2 = await fetch(`${REST}/wallet_mentions?wallet=in.(${encodeURIComponent(inList)})&select=username,wallet`, { headers: H() });
    if (!r2.ok) throw new Error(`others ${r2.status}`);
    const rows = await r2.json();

    // 3) group other usernames per wallet (exclude self)
    const byWallet = new Map();
    const allAccounts = new Set();
    for (const row of rows || []) {
      const w = String(row.wallet || '').toLowerCase();
      const u = String(row.username || '').toLowerCase();
      if (!w || !u || u === username) continue;
      if (!byWallet.has(w)) byWallet.set(w, new Set());
      byWallet.get(w).add(u);
      allAccounts.add(u);
    }

    const linked = [];
    for (const [wallet, set] of byWallet.entries()) {
      const accounts = [...set];
      if (!accounts.length) continue;
      // heuristic: a wallet shared by a small cluster looks like alts/network;
      // shared by a large crowd usually means a popular token CA.
      const tag = accounts.length >= 12 ? 'crowd' : 'cluster';
      linked.push({ wallet, accounts: accounts.slice(0, 12), count: accounts.length, tag });
    }
    // smallest clusters first (more suspicious), crowds last
    linked.sort((a, b) => a.count - b.count);

    return res.status(200).json({
      success: true,
      wallets: wallets.length,
      total_accounts: allAccounts.size,
      linked,
    });
  } catch (e) {
    return res.status(200).json({ success: false, error: String(e && e.message || e), linked: [] });
  }
}
