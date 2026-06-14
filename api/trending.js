// /api/trending — recently active Bankrbot devs/tokens.
// Reads from the indexed bankr_launches table and returns the most recent
// launches grouped by dev, so the popup can show a "Trending Devs" list.
//
// Vercel env vars: LENS_SUPABASE_URL, LENS_SUPABASE_ANON_KEY

const SUPABASE_URL = process.env.LENS_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.LENS_SUPABASE_ANON_KEY;

async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // small cache so we don't hammer Supabase on every popup open
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  try {
    const limit = Math.min(parseInt(req.query.limit || '40', 10) || 40, 100);
    const rows = await sbFetch(
      `bankr_launches?select=token_address,token_name,token_symbol,deployer_wallet,x_username,launched_at,is_new,unclaimed_usd&order=launched_at.desc&limit=${limit}`,
      SUPABASE_ANON_KEY
    );

    // group by dev (x_username if present, else deployer_wallet)
    const byDev = new Map();
    for (const r of rows) {
      const key = (r.x_username || r.deployer_wallet || '').toLowerCase();
      if (!key) continue;
      if (!byDev.has(key)) {
        byDev.set(key, {
          x_username: r.x_username || null,
          deployer_wallet: r.deployer_wallet || null,
          token_count: 0,
          latest_token: r.token_symbol || null,
          latest_at: r.launched_at || null,
          has_new: false,
        });
      }
      const dev = byDev.get(key);
      dev.token_count += 1;
      if (r.is_new) dev.has_new = true;
      // rows are desc by launched_at, so first seen is the latest
    }

    const devs = [...byDev.values()]
      .sort((a, b) => new Date(b.latest_at || 0) - new Date(a.latest_at || 0))
      .slice(0, 12);

    return res.json({ success: true, count: devs.length, devs });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function sbFetch(path, anonKey) {
  const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}
