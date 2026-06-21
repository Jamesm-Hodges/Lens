// LENS - temporary Supabase diagnostic (ESM). DELETE this file after we fix things.
// Deploy as: Lens repo -> api/tg-diag.js  ->  open https://lens-liard.vercel.app/api/tg-diag
// It only prints env var NAMES (never values) + a test insert result.

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json');

  // names only, never values
  const supaEnvNames = Object.keys(process.env).filter(k => /SUPA|^SB_|DATABASE|POSTGRES/i.test(k));

  const url = process.env.SUPABASE_URL || 'https://irtfaxhvphjtqczswrck.supabase.co';
  const key = process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_KEY;

  let testInsert = null;
  if (key) {
    try {
      const r = await fetch(`${url}/rest/v1/tg_sessions`, {
        method: 'POST',
        headers: {
          apikey: key,
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          prefer: 'return=representation',
        },
        body: JSON.stringify({
          code: 'diag_' + Date.now(),
          used: false,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60000).toISOString(),
        }),
      });
      testInsert = { status: r.status, body: (await r.text()).slice(0, 400) };
    } catch (e) { testInsert = { error: String(e) }; }
  }

  res.status(200).json({
    supabase_env_names_found: supaEnvNames,
    has_SUPABASE_URL: !!process.env.SUPABASE_URL,
    using_url: url,
    key_found: !!key,
    key_source: process.env.SUPABASE_SERVICE_KEY ? 'SUPABASE_SERVICE_KEY'
      : process.env.SUPABASE_SERVICE_ROLE_KEY ? 'SUPABASE_SERVICE_ROLE_KEY'
      : process.env.SUPABASE_KEY ? 'SUPABASE_KEY' : null,
    testInsert,
  });
}
