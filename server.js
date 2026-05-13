const express    = require('express')
const ethers     = require('ethers')
const { createClient } = require('@supabase/supabase-js')
const cron       = require('node-cron')
const axios      = require('axios')
const cors       = require('cors')
require('dotenv').config()

const app = express()
app.use(express.json())
app.use(cors())

// ── CONFIG ────────────────────────────────────────────────────────────────────

const CONFIG = {
  RPC:      'https://rpc-testnet.gokite.ai/',
  CONTRACT: '0x04d8bEA0bC25f4C69D215CcCb05eeb60eC733CcC',
}

const ABI = [
  'function createMarket(string calldata question, string calldata resolutionSource, uint256 duration) external returns (uint256)',
  'function resolveMarket(uint256 marketId, uint8 outcome) external',
  'function marketCount() external view returns (uint256)',
  'event MarketCreated(uint256 indexed id, string question, uint256 expiresAt)',
]

// ── CLIENTS ───────────────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(CONFIG.RPC)
const wallet   = new ethers.Wallet(process.env.DEPLOYER_KEY, provider)
const contract = new ethers.Contract(CONFIG.CONTRACT, ABI, wallet)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

// ── HELPERS ───────────────────────────────────────────────────────────────────

function durationSeconds(dateStr) {
  return Math.floor((new Date(dateStr).getTime() - Date.now()) / 1000)
}

function durationFromMs(ms) {
  return Math.floor((ms - Date.now()) / 1000)
}

async function marketAlreadySynced(source, sourceId) {
  const { data } = await supabase
    .from('markets_sync')
    .select('id')
    .eq('source', source)
    .eq('source_id', String(sourceId))
    .maybeSingle()
  return !!data
}

async function saveMarket(source, sourceId, presagaMarketId, question, resolutionSource, closesAt) {
  await supabase.from('markets_sync').insert({
    source,
    source_id:         String(sourceId),
    presaga_market_id: presagaMarketId,
    question,
    resolution_source: resolutionSource,
    closes_at:         closesAt,
    resolved:          false,
  })
}

async function markResolved(source, sourceId, outcome) {
  await supabase
    .from('markets_sync')
    .update({ resolved: true, outcome })
    .eq('source', source)
    .eq('source_id', String(sourceId))
}

async function createOnChain(question, resolutionSource, duration) {
  const MAX            = 30 * 24 * 60 * 60
  const cappedDuration = Math.min(duration, MAX)
  const tx      = await contract.createMarket(question, resolutionSource, cappedDuration, { gasLimit: 500000 })
  const receipt = await tx.wait()
  const event   = receipt.logs
    .map(log => { try { return contract.interface.parseLog(log) } catch { return null } })
    .find(e => e?.name === 'MarketCreated')
  return event ? Number(event.args.id) : null
}

// ── POLYMARKET SYNC ───────────────────────────────────────────────────────────

async function syncPolymarket() {
  console.log('[Polymarket] Fetching markets...')
  try {
    const res = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { closed: false, limit: 50 },
      timeout: 15000,
    })

    // No date filter — sync all open binary markets
    const markets = (res.data || []).filter(m =>
      m.question &&
      m.endDate &&
      m.outcomePrices &&
      JSON.parse(m.outcomePrices).length === 2
    )

    console.log(`[Polymarket] Found ${markets.length} markets`)

    for (const m of markets) {
      const sourceId = m.conditionId || m.id?.toString()
      if (!sourceId) continue
      if (await marketAlreadySynced('polymarket', sourceId)) continue

      const duration = durationSeconds(m.endDate)
      if (duration < 3600) continue

      try {
        const presagaMarketId = await createOnChain(m.question, `polymarket:${sourceId}`, duration)
        await saveMarket('polymarket', sourceId, presagaMarketId, m.question, `polymarket:${sourceId}`, m.endDate)
        console.log(`[Polymarket] Created market #${presagaMarketId}: ${m.question.slice(0, 60)}`)
        await new Promise(r => setTimeout(r, 2000))
      } catch (e) {
        console.error(`[Polymarket] Failed to create: ${e.message}`)
      }
    }
  } catch (e) {
    console.error(`[Polymarket] Fetch failed: ${e.message}`)
  }
}

// ── MANIFOLD SYNC ─────────────────────────────────────────────────────────────

async function syncManifold() {
  console.log('[Manifold] Fetching markets...')
  try {
    const res = await axios.get('https://api.manifold.markets/v0/search-markets', {
      params: { limit: 50, sort: 'close-date', filter: 'open', outcomeType: 'BINARY' },
      timeout: 15000,
    })

    const raw     = res.data
    const markets = (Array.isArray(raw) ? raw : raw?.markets || []).filter(m =>
      m.question &&
      m.closeTime &&
      m.outcomeType === 'BINARY' &&
      !m.isResolved
    )

    console.log(`[Manifold] Found ${markets.length} markets`)

    for (const m of markets) {
      const sourceId = m.id
      if (!sourceId) continue
      if (await marketAlreadySynced('manifold', sourceId)) continue

      const closesAt = new Date(m.closeTime).toISOString()
      const duration = durationSeconds(closesAt)
      if (duration < 3600) continue

      try {
        const presagaMarketId = await createOnChain(m.question, `manifold:${sourceId}`, duration)
        await saveMarket('manifold', sourceId, presagaMarketId, m.question, `manifold:${sourceId}`, closesAt)
        console.log(`[Manifold] Created market #${presagaMarketId}: ${m.question.slice(0, 60)}`)
        await new Promise(r => setTimeout(r, 2000))
      } catch (e) {
        console.error(`[Manifold] Failed to create: ${e.message}`)
      }
    }
  } catch (e) {
    console.error(`[Manifold] Fetch failed: ${e.message}`)
  }
}

// ── LIMITLESS SYNC ────────────────────────────────────────────────────────────

async function syncLimitless() {
  console.log('[Limitless] Fetching markets...')
  try {
    const res = await axios.get('https://api.limitless.exchange/markets/active', {
      params: { limit: 50, tradeType: 'amm' },
      timeout: 15000,
    })

    const markets = (res.data?.data || res.data || []).filter(m =>
      m.title &&
      m.expirationTimestamp &&
      !m.expired &&
      !m.hidden
    )

    console.log(`[Limitless] Found ${markets.length} markets`)

    for (const m of markets) {
      const sourceId = m.id?.toString() || m.slug
      if (!sourceId) continue
      if (await marketAlreadySynced('limitless', sourceId)) continue

      const duration = durationFromMs(m.expirationTimestamp)
      if (duration < 300) continue  // contract minimum is 5 minutes

      const MAX            = 30 * 24 * 60 * 60
      const cappedDuration = Math.min(duration, MAX)
      const closesAt       = new Date(m.expirationTimestamp).toISOString()

      try {
        const presagaMarketId = await createOnChain(m.title, `limitless:${sourceId}`, cappedDuration)
        await saveMarket('limitless', sourceId, presagaMarketId, m.title, `limitless:${sourceId}`, closesAt)
        console.log(`[Limitless] Created market #${presagaMarketId}: ${m.title.slice(0, 60)}`)
        await new Promise(r => setTimeout(r, 2000))
      } catch (e) {
        console.error(`[Limitless] Failed to create: ${e.message}`)
      }
    }
  } catch (e) {
    console.error(`[Limitless] Fetch failed: ${e.message}`)
  }
}

// ── RESOLUTION SYNC ───────────────────────────────────────────────────────────

async function resolveMarkets() {
  console.log('[Resolve] Checking for resolved markets...')
  try {
    const { data: pending } = await supabase
      .from('markets_sync')
      .select('*')
      .eq('resolved', false)
      .not('presaga_market_id', 'is', null)

    if (!pending?.length) return

    for (const row of pending) {
      try {
        let outcome = null

        if (row.source === 'polymarket') {
          const res = await axios.get(`https://gamma-api.polymarket.com/markets/${row.source_id}`, { timeout: 10000 })
          const m   = res.data
          if (m?.closed && m?.resolution) {
            outcome = m.resolution.toUpperCase() === 'YES' ? 1 : 2
          }
        }

        if (row.source === 'manifold') {
          const res = await axios.get(`https://api.manifold.markets/v0/market/${row.source_id}`, { timeout: 10000 })
          const m   = res.data
          if (m?.isResolved && m?.resolution) {
            outcome = m.resolution === 'YES' ? 1 : 2
          }
        }

        if (row.source === 'limitless') {
          const res = await axios.get(`https://api.limitless.exchange/markets/${row.source_id}`, { timeout: 10000 })
          const m   = res.data
          if (m?.expired && m?.winningOutcomeIndex !== null && m?.winningOutcomeIndex !== undefined) {
            outcome = m.winningOutcomeIndex === 0 ? 1 : 2  // 0=Up=Yes, 1=Down=No
          }
        }

        if (outcome) {
          const now      = Math.floor(Date.now() / 1000)
          const closesAt = Math.floor(new Date(row.closes_at).getTime() / 1000)
          if (now < closesAt) continue

          const tx = await contract.resolveMarket(row.presaga_market_id, outcome, { gasLimit: 300000 })
          await tx.wait()

          await markResolved(row.source, row.source_id, outcome === 1 ? 'YES' : 'NO')
          console.log(`[Resolve] Market #${row.presaga_market_id} resolved: ${outcome === 1 ? 'YES' : 'NO'}`)
          await new Promise(r => setTimeout(r, 2000))
        }
      } catch (e) {
        console.error(`[Resolve] Failed for market #${row.presaga_market_id}: ${e.message}`)
      }
    }
  } catch (e) {
    console.error(`[Resolve] Error: ${e.message}`)
  }
}

// ── DEBUG ─────────────────────────────────────────────────────────────────────

app.get('/debug/polymarket', async (req, res) => {
  try {
    const r = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { closed: false, limit: 5 },
      timeout: 15000,
    })
    res.json({ status: 200, count: r.data?.length, sample: r.data?.slice(0, 2) })
  } catch (e) {
    res.json({ status: e.response?.status, error: e.message, data: e.response?.data })
  }
})

app.get('/debug/manifold', async (req, res) => {
  try {
    const r = await axios.get('https://api.manifold.markets/v0/search-markets', {
      params: { limit: 5, filter: 'open', outcomeType: 'BINARY' },
      timeout: 15000,
    })
    res.json({ status: 200, raw_type: typeof r.data, sample: (Array.isArray(r.data) ? r.data : r.data?.markets)?.slice(0, 2) })
  } catch (e) {
    res.json({ status: e.response?.status, error: e.message, data: e.response?.data })
  }
})

app.get('/debug/limitless', async (req, res) => {
  try {
    const r = await axios.get('https://api.limitless.exchange/markets/active', {
      params: { limit: 5, tradeType: 'amm' },
      timeout: 15000,
    })
    res.json({ status: 200, count: r.data?.totalMarketsCount, sample: r.data?.data?.slice(0, 2) })
  } catch (e) {
    res.json({ status: e.response?.status, error: e.message, data: e.response?.data })
  }
})

// ── MANUAL SYNC TRIGGERS ──────────────────────────────────────────────────────

app.get('/sync/polymarket', async (req, res) => {
  await syncPolymarket()
  res.json({ status: 'done' })
})

app.get('/sync/limitless', async (req, res) => {
  await syncLimitless()
  res.json({ status: 'done' })
})

app.get('/sync/resolve', async (req, res) => {
  await resolveMarkets()
  res.json({ status: 'done' })
})

// ── AGENT REGISTRATION ────────────────────────────────────────────────────────

app.post('/api/register', async (req, res) => {
  const { agentId, wallet: agentWallet } = req.body

  if (!agentId || !agentWallet) {
    return res.status(400).json({ error: 'agentId and wallet are required' })
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(agentWallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' })
  }

  if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 100) {
    return res.status(400).json({ error: 'Invalid agentId' })
  }

  try {
    const hash      = ethers.solidityPackedKeccak256(['address', 'string'], [agentWallet, agentId])
    const signature = await wallet.signMessage(ethers.getBytes(hash))
    return res.json({ signature, agentId, wallet: agentWallet })
  } catch (e) {
    console.error(`[Register] Signing failed: ${e.message}`)
    return res.status(500).json({ error: 'Signing failed' })
  }
})

// ── MARKETS API ───────────────────────────────────────────────────────────────

app.get('/api/markets', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('markets_sync')
      .select('*')
      .eq('resolved', false)
      .order('closes_at', { ascending: true })
      .limit(50)

    if (error) throw error
    return res.json(data)
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
})

// ── HEALTH ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', contract: CONFIG.CONTRACT, network: 'kite-testnet' })
})

// ── CRON JOBS ─────────────────────────────────────────────────────────────────

// Sync Polymarket + Manifold every 6 hours
cron.schedule('0 */6 * * *', async () => {
  await syncPolymarket()
  await syncManifold()
})

// Sync Limitless every 30 minutes — markets expire fast
cron.schedule('*/30 * * * *', async () => {
  await syncLimitless()
})

// Check resolutions every 10 minutes
cron.schedule('*/10 * * * *', async () => {
  await resolveMarkets()
})

// ── START ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000

app.listen(PORT, async () => {
  console.log(`Presaga backend running on port ${PORT}`)
  console.log(`Contract: ${CONFIG.CONTRACT}`)
  console.log(`Wallet:   ${wallet.address}`)

  await syncPolymarket()
  await syncManifold()
  await syncLimitless()
  await resolveMarkets()
})
