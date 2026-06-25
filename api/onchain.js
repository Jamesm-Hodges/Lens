// LENS — GET /api/onchain?ca=<token>&deployer=<wallet>
// On-chain deep scan for the lens agent:
//   - cabal:   bundled / shared-funder clusters among early buyers + % of supply they hold
//   - funding: who first funded the deployer/dev wallet, and how many sibling wallets it fanned out to
// Self-contained: talks to Alchemy directly with LENS_ALCHEMY_KEY (server-side only).

const ALCHEMY_KEY = process.env.LENS_ALCHEMY_KEY;
const ZERO = '0x0000000000000000000000000000000000000000';

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

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return out;
}

// ── Bundle / cabal: shared-funder clusters among earliest buyers + supply % ──
async function fetchCabal(tokenAddress, deployerWallet) {
  const token = String(tokenAddress).toLowerCase();
  const dev = deployerWallet ? String(deployerWallet).toLowerCase() : null;

  // 1) earliest token transfers -> early receivers
  const tr = await alchemyRpc('alchemy_getAssetTransfers', [{
    contractAddresses: [token], category: ['erc20'], order: 'asc',
    excludeZeroValue: true, maxCount: '0x3c',
  }]);
  const transfers = (tr && tr.transfers) || [];
  const exclude = new Set([token, ZERO]);
  if (dev) exclude.add(dev);
  const seen = new Set();
  const candidates = [];
  for (const t of transfers) {
    const to = (t.to || '').toLowerCase();
    if (!to || exclude.has(to) || seen.has(to)) continue;
    seen.add(to); candidates.push(to);
    if (candidates.length >= 25) break;
  }
  if (!candidates.length) return { token, scanned: 0, clusters: [], total_pct: 0, note: 'No early holders found.' };

  // 2) keep EOAs only (drop pool / router / contracts)
  const codes = await mapLimit(candidates, 5, (a) => alchemyRpc('eth_getCode', [a, 'latest']));
  const eoas = candidates.filter((a, i) => { const c = codes[i]; return !c || c === '0x' || c === '0x0'; }).slice(0, 20);
  if (!eoas.length) return { token, scanned: 0, clusters: [], total_pct: 0, note: 'No wallet (EOA) buyers among early holders.' };

  // 3) earliest ETH funder of each EOA
  const funders = await mapLimit(eoas, 5, async (a) => {
    const inc = await alchemyRpc('alchemy_getAssetTransfers', [{
      toAddress: a, category: ['external', 'internal'], order: 'asc',
      excludeZeroValue: true, maxCount: '0xa',
    }]);
    const list = (inc && inc.transfers) || [];
    for (const x of list) {
      const f = (x.from || '').toLowerCase();
      if (f && f !== a && f !== ZERO) return f;
    }
    return null;
  });

  // 4) cluster by shared funder
  const groups = new Map();
  eoas.forEach((a, i) => {
    const f = funders[i];
    if (!f) return;
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(a);
  });
  const clusters = [];
  for (const [funder, wallets] of groups.entries()) {
    const isDev = !!(dev && funder === dev);
    if (wallets.length >= 2 || isDev) clusters.push({ funder, wallets, count: wallets.length, funder_is_dev: isDev });
  }
  if (!clusters.length) return { token, scanned: eoas.length, clusters: [], total_pct: 0, note: 'No shared-funder clusters among early buyers.' };

  // 5) % of supply held by each cluster (now)
  let totalSupply = 0n;
  try { totalSupply = BigInt(await alchemyRpc('eth_call', [{ to: token, data: '0x18160ddd' }, 'latest']) || '0x0'); } catch (e) {}
  const balOf = async (addr) => {
    try {
      const data = '0x70a08231' + addr.slice(2).padStart(64, '0');
      return BigInt(await alchemyRpc('eth_call', [{ to: token, data }, 'latest']) || '0x0');
    } catch (e) { return 0n; }
  };
  for (const c of clusters) {
    const bals = await mapLimit(c.wallets, 5, balOf);
    const sum = bals.reduce((s, b) => s + (b || 0n), 0n);
    c.supply_pct = totalSupply > 0n ? Number((sum * 10000n) / totalSupply) / 100 : null;
  }
  clusters.sort((a, b) => (Number(b.funder_is_dev) - Number(a.funder_is_dev)) || ((b.supply_pct || 0) - (a.supply_pct || 0)) || (b.count - a.count));
  const total_pct = Math.round(clusters.reduce((s, c) => s + (c.supply_pct || 0), 0) * 100) / 100;
  return { token, scanned: eoas.length, clusters, total_pct };
}

// ── Funding trail: first funder of the dev wallet + sibling fan-out ──
async function fetchDevFunding(deployer) {
  if (!deployer || !/^0x[0-9a-fA-F]{40}$/.test(deployer)) return { funder: null, siblings: [], fanout: 0 };
  const dev = deployer.toLowerCase();
  let funder = null;
  try {
    const incoming = await alchemyRpc('alchemy_getAssetTransfers', [{
      fromBlock: '0x0', toBlock: 'latest', toAddress: dev, category: ['external'], order: 'asc', maxCount: '0xa',
    }]);
    const inc = (incoming && incoming.transfers) || [];
    funder = inc.length ? ((inc[0].from || '').toLowerCase() || null) : null;
  } catch (e) {}
  if (!funder) return { funder: null, siblings: [], fanout: 0 };

  let siblings = [];
  try {
    const outgoing = await alchemyRpc('alchemy_getAssetTransfers', [{
      fromBlock: '0x0', toBlock: 'latest', fromAddress: funder, category: ['external'], order: 'asc', maxCount: '0x64',
    }]);
    const out = (outgoing && outgoing.transfers) || [];
    const set = new Set();
    for (const t of out) {
      const to = (t.to || '').toLowerCase();
      if (to && to !== dev) set.add(to);
    }
    siblings = [...set];
  } catch (e) {}

  return { funder, fanout: siblings.length, siblings: siblings.slice(0, 40) };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ca = String(req.query.ca || req.query.token || '').trim();
  const deployer = String(req.query.deployer || '').trim() || null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) return res.status(400).json({ error: 'valid ca required' });
  if (!ALCHEMY_KEY) return res.status(500).json({ error: 'alchemy key not configured' });

  try {
    const [cabal, funding] = await Promise.all([
      fetchCabal(ca, deployer).catch((e) => ({ error: String(e.message || e), clusters: [], total_pct: 0 })),
      deployer ? fetchDevFunding(deployer).catch(() => ({ funder: null, siblings: [], fanout: 0 })) : Promise.resolve(null),
    ]);
    return res.status(200).json({ ok: true, ca, deployer, cabal, funding });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
