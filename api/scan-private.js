/**
 * /api/scan-private   (LIVE)
 *
 * Zero-log private scan. Returns the same on-chain read as /api/lookup,
 * but the LENS application stores nothing about the request.
 *
 * What "private" means here, honestly:
 *   - LENS does not log or persist your query, the target, your IP, or the result
 *   - the backend proxies the read, so your client never touches the data source directly
 *   - responses are marked no-store so nothing is cached downstream
 *   - the endpoint is excluded from indexing
 *
 * What it can NOT do (so we never overclaim):
 *   - it controls the LENS application layer only
 *   - it cannot erase infrastructure edge logs your host may keep at the network level
 *   - for full network-level anonymity, route through your own VPN or proxy
 *
 * No console logging anywhere in this file, on purpose.
 */

export default async function handler(req, res) {
  // privacy + cache headers
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  // CORS (read-only, safe from any origin)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // accept both GET (?username= / ?contract=) and POST ({ username, contract })
  const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  let username = (src.username || '').toString().trim();
  let contract = (src.contract || '').toString().trim();

  // allow a single raw "target" too
  if (!username && !contract && src.target) {
    const t = src.target.toString().trim();
    if (t.toLowerCase().startsWith('0x')) contract = t; else username = t;
  }

  if (!username && !contract) {
    return res.status(400).json({
      error: 'provide a username or contract',
      private: true,
      logged: false
    });
  }

  // normalize, never stored
  if (username) username = username.replace(/^@/, '').toLowerCase();
  const isContract = !!contract;
  const target = isContract ? contract : username;
  const param = isContract ? 'contract' : 'username';

  try {
    const base = process.env.LENS_BACKEND_URL || 'https://lens-liard.vercel.app';
    const url = `${base}/api/lookup?${param}=${encodeURIComponent(target)}`;

    // proxy the read, caller identity never forwarded
    const upstream = await fetch(url, { headers: { accept: 'application/json' } });
    const data = await upstream.json();

    // nothing about this request is written anywhere
    return res.status(200).json({
      ...data,
      private: true,
      logged: false,
      note: 'this scan was not logged, no query, ip, or result was stored'
    });
  } catch (e) {
    // deliberately no error logging that could echo the target
    return res.status(502).json({
      error: 'upstream read failed, try again',
      private: true,
      logged: false
    });
  }
}
