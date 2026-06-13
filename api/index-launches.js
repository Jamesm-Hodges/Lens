const SUPABASE_URL = process.env.LENS_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.LENS_SUPABASE_SERVICE_KEY;
const ETHERSCAN_KEY = process.env.LENS_ETHERSCAN_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const results = await indexLaunches();
    res.json({ success: true, ...results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function indexLaunches() {
  const res = await fetch('https://api.bankr.bot/token-launches?limit=100');
  if (!res.ok) throw new Error('Bankr API failed');
  const listData = await res.json();
  const launches = Array.isArray(listData) ? listData : (listData.launches || []);

  let indexed = 0;
  const now = new Date().toISOString();

  for (const launch of launches) {
    const tokenAddress = (launch.tokenAddress || launch.address || '').toLowerCase();
    if (!tokenAddress) continue;

    const deployerWallet = (launch.deployer?.walletAddress || '').toLowerCase();
    const feeRecipientWallet = (launch.feeRecipient?.walletAddress || '').toLowerCase();
    const xUsername = (launch.deployer?.xUsername || '').toLowerCase();
    const xUsernameFee = (launch.feeRecipient?.xUsername || '').toLowerCase();
    const launchedAt = launch.timestamp ? new Date(launch.timestamp).toISOString() : now;
    const isNew = launch.timestamp ? (Date.now() - launch.timestamp) < 24 * 60 * 60 * 1000 : false;
    const unclaimedFees = launch.unclaimedFees || null;

    const row = {
      token_address: tokenAddress,
      token_name: launch.tokenName || launch.name,
      token_symbol: launch.tokenSymbol || launch.symbol,
      deployer_wallet: deployerWallet || null,
      fee_recipient_wallet: feeRecipientWallet || null,
      x_username: xUsername || null,
      x_username_fee: xUsernameFee || null,
      unclaimed_token: unclaimedFees?.tokenAmount || '0',
      unclaimed_weth: unclaimedFees?.wethAmount || '0',
      unclaimed_usd: parseFloat(unclaimedFees?.usdValue || 0),
      token_symbol_fees: unclaimedFees?.tokenSymbol || launch.tokenSymbol,
      launched_at: launchedAt,
      is_new: isNew,
      updated_at: now,
    };

    await supabaseUpsert('bankr_launches', row);

    if (deployerWallet) {
      await checkAndSaveClaims(deployerWallet, tokenAddress, launch.tokenSymbol);
    }
    indexed++;
  }
  return { indexed, total: launches.length };
}

async function checkAndSaveClaims(wallet, tokenAddress, tokenSymbol) {
  try {
    const url = `https://api.etherscan.io/v2/api?chainid=8453&module=account&action=txlistinternal&address=${wallet}&sort=desc&apikey=${ETHERSCAN_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== '1') return;

    const claims = data.result.filter(tx => parseInt(tx.value) > 0);
    if (!claims.length) return;

    const totalEth = claims.reduce((s, tx) => s + parseInt(tx.value) / 1e18, 0);
    const lastClaim = new Date(claims[0].timeStamp * 1000).toISOString();

    await supabaseUpsert('bankr_claim_history', {
      deployer_wallet: wallet,
      token_address: tokenAddress,
      token_symbol: tokenSymbol,
      claim_count: claims.length,
      total_eth_claimed: totalEth.toFixed(6),
      last_claimed_at: lastClaim,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {}
}

async function supabaseUpsert(table, row) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(row),
  });
}
