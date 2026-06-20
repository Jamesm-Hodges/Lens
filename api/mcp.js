// LENS — /api/mcp  (Streamable HTTP / JSON-RPC 2.0 MCP server)
// Connect: claude mcp add --transport http lens https://lens-liard.vercel.app/api/mcp

export const config = { maxDuration: 60 };

const SELF = 'https://lens-liard.vercel.app';

const TOOLS = [
  {
    name: 'lens_check_token',
    description: 'Scan a Base token contract address for rug risk. Returns a CLEAR/CAUTION/STOP verdict with triggered red lines.',
    inputSchema: {
      type: 'object',
      properties: {
        contract: { type: 'string', description: 'Base token contract address (0x...)' }
      },
      required: ['contract']
    }
  },
  {
    name: 'lens_check_handle',
    description: 'Scan an X/Twitter handle for on-chain deployer history, dev sells, fee claims, and rug risk.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'X/Twitter handle (without @)' }
      },
      required: ['username']
    }
  },
  {
    name: 'lens_check_wallet',
    description: 'Scan a deployer wallet address for full on-chain history, trust score, and rug risk signals.',
    inputSchema: {
      type: 'object',
      properties: {
        wallet: { type: 'string', description: 'EVM wallet address (0x...)' }
      },
      required: ['wallet']
    }
  }
];

async function callLookup(params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${SELF}/api/lookup?${qs}`);
  if (!r.ok) throw new Error(`lookup ${r.status}`);
  return r.json();
}

function formatResult(data) {
  if (!data.success) return `Error: ${data.error || 'lookup failed'}`;
  const d = data.data || {};
  if (!d.found) return 'No on-chain record found. Treat as unproven, not safe.';

  const lines = [];

  // Token/contract scan
  if (d.source === 'b20') {
    lines.push(`B20 Token Scan`);
    if (d.verdict) lines.push(`Verdict: ${d.verdict}`);
    if (d.red_lines?.length) {
      lines.push('Red lines: ' + d.red_lines.map(r => `${r.flag} — ${r.label}`).join('; '));
    }
    return lines.join('\n');
  }

  // Deployer/wallet/handle scan
  if (d.verdict) lines.push(`Verdict: ${d.verdict}`);
  if (d.trust_score != null) lines.push(`Trust score: ${d.trust_score}/100`);
  if (d.token_count != null) lines.push(`Tokens deployed: ${d.token_count}`);
  if (d.sells?.has_sold) lines.push(`Dev sold: YES (${d.sells.total_tokens_sold} token(s))`);
  else if (d.sells) lines.push('Dev sold: none detected');
  if (d.claims?.has_claimed) lines.push(`Fees claimed: ${d.claims.total_eth_claimed} ETH`);
  if (d.has_please_bro) lines.push(`PleaseBro: earns fees from tokens deployed by others`);
  if (d.red_lines?.length) {
    lines.push('Red lines: ' + d.red_lines.map(r => `${r.flag} — ${r.label}`).join('; '));
  }
  if (!lines.length) lines.push('Found on-chain but no signals detected.');
  return lines.join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // MCP initialize ping (GET)
  if (req.method === 'GET') {
    return res.json({
      jsonrpc: '2.0', id: null,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'lens', version: '1.0.0' },
        capabilities: { tools: {} }
      }
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }
  body = body || {};

  const { jsonrpc, id, method, params } = body;

  // tools/list
  if (method === 'tools/list') {
    return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }

  // tools/call
  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    try {
      let result = '';
      if (name === 'lens_check_token') {
        const data = await callLookup({ contract: args.contract });
        result = formatResult(data);
      } else if (name === 'lens_check_handle') {
        const data = await callLookup({ username: args.username });
        result = formatResult(data);
      } else if (name === 'lens_check_wallet') {
        const data = await callLookup({ wallet: args.wallet });
        result = formatResult(data);
      } else {
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
      }
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: result }] }
      });
    } catch (e) {
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      });
    }
  }

  // initialize
  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'lens', version: '1.0.0' },
        capabilities: { tools: {} }
      }
    });
  }

  return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}
