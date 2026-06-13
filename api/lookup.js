const SUPABASE_URL = process.env.LENS_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.LENS_SUPABASE_ANON_KEY;
const ALCHEMY_KEY = process.env.LENS_ALCHEMY_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  const { username, wallet } = req.query;
  if (!username && !wallet) return res.status(400).json({ error: 'username or wallet required' });
  try {
    const data = await lookupProfile({ username, wallet });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function alchemyRpc(method, params) {
  if (!ALCHEMY_KEY) throw new Error('No Alchemy key');
  const res = await fetch(`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Alchemy RPC error');
  return json.result;
}

async function lookupProfile({ username, wallet }) {
  let tokens = [];

  if (username) {
    const url = `${SUPABASE_URL}/rest/v1/bankr_launches?or=(x_username.eq.${username.toLowerCase()},x_username_fee.eq.${username.toLowerCase()})&select=*&order=launched_at.desc`;
    const res = await fetch(url, {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (res.ok) tokens = await res.json();
  }

  if (wallet && tokens.length === 0) {
    const url = `${SUPABASE_URL}/rest/v1/bankr_launches?or=(deployer_wallet.eq.${wallet.toLowerCase()},fee_recipient_wallet.eq.${wallet.toLowerCase()})&select=*&order=launched_at.desc`;
    const res = await fetch(url, {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (res.ok) tokens = await res.json();
  }

  if (!tokens.length) return { found: false };

  const deployerWallets = [...new Set(tokens.map(t => t.deployer_wallet).filter(Boolean))];
  let claimData = [];

  for (const w of deployerWallets.slice(0, 3)) {
    const url = `${SUPABASE_URL}/rest/v1/bankr_claim_history?deployer_wallet=eq.${w}&select=*`;
    const res = await fetch(url, {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (res.ok) { const rows = await res.json(); claimData.push(...rows); }
  }

  const sells = [];
  for (const token of tokens.slice(0, 4)) {
    if (!token.deployer_wallet || !token.token_address) continue;
    try {
      const result = await alchemyRpc('alchemy_getAssetTransfers', [{
        fromAddress: token.deployer_wallet,
        contractAddresses: [token.token_address],
        category: ['erc20'],
