// LENS — /api/report  (crowd-sourced ingest)
// Receives wallet-mention reports from LENS extensions: what tweets a user saw on
// a profile right now. Archives them, and flags previously-seen wallet tweets that
// are missing from the visible range as DELETED after MISS_THRESHOLD independent sightings.
//
// Env required: SUPABASE_URL, SUPABASE_SERVICE_KEY

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MISS_THRESHOLD = 2; // independent "not seen in range" reports before flagging deleted

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ success: false });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const username = String(body.username || '').toLowerCase().replace(/^@/, '');
    if (!username || !/^[a-z0-9_]{1,20}$/.test(username)) return res.status(200).json({ success: false });

    const range = body.range || {};
    const incoming = Array.isArray(body.tweets) ? body.tweets.slice(0, 50) : [];
    const now = new Date().toISOString();

    await supabase.from('tracked_profiles').upsert({ username, active: true }, { onConflict: 'username', ignoreDuplicates: true });

    const seenIds = [];
    const tweetRows = [];
    const mentionRows = [];
    for (const t of incoming) {
      const id = String(t.id || '').replace(/[^0-9]/g, '');
      if (!id) continue;
      seenIds.push(id);
      tweetRows.push({
        id, username,
        text: String(t.text || '').slice(0, 2000),
        created_at: t.created_at || null,
        last_seen_at: now, miss_count: 0, deleted: false, deleted_at: null,
      });
      const wallets = Array.isArray(t.wallets) ? t.wallets.slice(0, 10) : [];
      for (const w of wallets) {
        const chain = w.chain === 'sol' ? 'sol' : 'evm';
        const wallet = chain === 'evm' ? String(w.wallet || '').toLowerCase() : String(w.wallet || '');
        if (chain === 'evm' && !/^0x[a-f0-9]{40}$/.test(wallet)) continue;
        if (chain === 'sol' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) continue;
        mentionRows.push({ username, wallet, chain, tweet_id: id });
      }
    }

    if (tweetRows.length) await supabase.from('tweets').upsert(tweetRows, { onConflict: 'id' });
    if (mentionRows.length) await supabase.from('wallet_mentions').upsert(mentionRows, { onConflict: 'wallet,tweet_id', ignoreDuplicates: true });

    // Deletion detection within the reported visible range.
    if (range.oldest && range.newest) {
      const { data: stored } = await supabase
        .from('tweets').select('id, miss_count, deleted')
        .eq('username', username)
        .gte('created_at', range.oldest).lte('created_at', range.newest);

      const missing = (stored || []).filter(s => !s.deleted && !seenIds.includes(s.id));
      for (const s of missing) {
        const mc = (s.miss_count || 0) + 1;
        const patch = mc >= MISS_THRESHOLD ? { miss_count: mc, deleted: true, deleted_at: now } : { miss_count: mc };
        await supabase.from('tweets').update(patch).eq('id', s.id);
      }
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(200).json({ success: false, error: String((e && e.message) || e) });
  }
}
