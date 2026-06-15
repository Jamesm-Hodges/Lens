// LENS — /api/trending
// Feeds the popup Dashboard "Trending Devs" + "Live Launches" lists.
// Aggregates recent Bankrbot token launches by deployer (dev).
//
// Deploy: drop this file into the lens-liard repo at `api/trending.js`.
// Frontend calls https://lnsx.io/api/trending?limit=40
// (lnsx.io/api/* is rewritten to lens-liard.vercel.app/api/* via vercel.json)

export default async function handler(req, res) {
  // Extension fetches cross-origin; allow it (harmless when same-origin too).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  const q = (req.query && req.query.limit) || 40;
  const limit = Math.min(Math.max(parseInt(q, 10) || 40, 1), 100);

  try {
    const r = await fetch('https://api.bankr.bot/token-launches?limit=100');
    if (!r.ok) return res.status(200).json({ success: false, devs: [] });

    const data = await r.json();
    const launches = Array.isArray(data) ? data : (data.launches || []);

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const byDev = new Map();

    for (const t of launches) {
      // Field names match those already used in the extension background.js.
      const xUsername = t.deployer?.xUsername || null;
      const wallet = (t.deployer?.walletAddress || '').toLowerCase() || null;
      const key = xUsername ? 'x:' + xUsername.toLowerCase() : (wallet ? 'w:' + wallet : null);
      if (!key) continue;

      const symbol = t.tokenSymbol || t.symbol || null;
      // Bankr timestamp field name varies — try the common ones.
      const tsRaw = t.createdAt || t.launchedAt || t.timestamp || t.created_at || t.launch_time || null;
      const ts = tsRaw ? new Date(tsRaw).getTime() : 0;

      let d = byDev.get(key);
      if (!d) {
        d = {
          x_username: xUsername,
          deployer_wallet: wallet,
          token_count: 0,
          latest_token: symbol,
          latest_ts: ts,
          has_new: false,
        };
        byDev.set(key, d);
      }
      d.token_count += 1;
      if (ts && ts > d.latest_ts) { d.latest_ts = ts; d.latest_token = symbol; }
      if (ts && (now - ts) < DAY) d.has_new = true;
    }

    const devs = [...byDev.values()]
      // Fresh launches first, then most recently active, then most prolific.
      .sort((a, b) =>
        (Number(b.has_new) - Number(a.has_new)) ||
        (b.latest_ts - a.latest_ts) ||
        (b.token_count - a.token_count)
      )
      .slice(0, limit)
      .map(d => ({
        x_username: d.x_username,
        deployer_wallet: d.deployer_wallet,
        token_count: d.token_count,
        latest_token: d.latest_token,
        has_new: d.has_new,
      }));

    return res.status(200).json({ success: true, devs });
  } catch (e) {
    return res.status(200).json({ success: false, devs: [], error: String((e && e.message) || e) });
  }
}
