// LENS — /api/alchemy  (POST)
// Server-side Alchemy proxy so the extension never sees the key. Forwards a safe
// allowlist of READ-ONLY JSON-RPC methods to Base mainnet.
// Body: { method, params }   →   returns Alchemy's raw { result } | { error }
//
// Env required: LENS_ALCHEMY_KEY

const ALCHEMY_KEY = process.env.LENS_ALCHEMY_KEY;
const BASE_RPC = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

const ALLOWED = new Set([
  'eth_call',
  'eth_getCode',
  'eth_getBalance',
  'eth_blockNumber',
  'eth_chainId',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getLogs',
  'alchemy_getAssetTransfers',
  'alchemy_getTokenMetadata',
  'alchemy_getTokenBalances',
  'alchemy_getTokenAllowance',
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'POST only' } });
  if (!ALCHEMY_KEY) return res.status(200).json({ error: { message: 'LENS_ALCHEMY_KEY not configured' } });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const method = String(body.method || '');
    const params = Array.isArray(body.params) ? body.params : [];

    if (!ALLOWED.has(method)) {
      return res.status(200).json({ error: { message: `method not allowed: ${method}` } });
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(BASE_RPC, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    });
    clearTimeout(t);
    const json = await r.json();
    // pass Alchemy's response straight through ({ result } or { error })
    return res.status(200).json(json);
  } catch (e) {
    return res.status(200).json({ error: { message: String(e && e.message || e) } });
  }
}
