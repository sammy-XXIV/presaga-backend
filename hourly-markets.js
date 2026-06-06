/**
 * Presaga Hourly Markets
 * 
 * Every hour:
 * 1. Fetches current prices from CoinGecko
 * 2. Creates "Will X be above $Y in 1 hour?" markets on-chain
 * 3. Resolves expired markets by comparing open vs close price
 */

const ethers = require('ethers')
const axios  = require('axios')
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

// ── CONFIG ────────────────────────────────────────────────────────────────────

const CONTRACT = process.env.PRESAGA_ADDRESS || '0xCe1706b24BD7c0fbD37929D27851E5900b569116'
const RPC      = 'https://rpc-testnet.gokite.ai/'

const ASSETS = [
  { id: 'bitcoin',     symbol: 'BTC',  name: 'Bitcoin' },
  { id: 'ethereum',    symbol: 'ETH',  name: 'Ethereum' },
  { id: 'solana',      symbol: 'SOL',  name: 'Solana' },
  { id: 'binancecoin', symbol: 'BNB',  name: 'BNB' },
  { id: 'dogecoin',    symbol: 'DOGE', name: 'Dogecoin' },
]

const ABI = [
  'function createMarket(string calldata question, string calldata resolutionSource, uint256 duration) external returns (uint256)',
  'function resolveMarket(uint256 marketId, uint8 outcome) external',
  'event MarketCreated(uint256 indexed id, string question, uint256 expiresAt)',
]

// ── CLIENTS ───────────────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(RPC)
const wallet   = new ethers.Wallet(process.env.DEPLOYER_KEY, provider)
const contract = new ethers.Contract(CONTRACT, ABI, wallet)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function getPrices() {
  const ids = ASSETS.map(a => a.id).join(',')
  const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
    params: { ids, vs_currencies: 'usd' },
    headers: { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY },
    timeout: 10000,
  })
  return res.data
}

function formatPrice(price) {
  if (price >= 1000) return `$${Math.round(price).toLocaleString()}`
  if (price >= 1)    return `$${price.toFixed(2)}`
  return `$${price.toFixed(4)}`
}

async function createOnChainMarket(question, resolutionSource, duration, nonce) {
  const tx      = await contract.createMarket(question, resolutionSource, duration, { gasLimit: 500000, nonce })
  const receipt = await tx.wait()
  const event   = receipt.logs
    .map(log => { try { return contract.interface.parseLog(log) } catch { return null } })
    .find(e => e?.name === 'MarketCreated')
  return event ? Number(event.args.id) : null
}

// ── CREATE HOURLY MARKETS ─────────────────────────────────────────────────────

async function createHourlyMarkets() {
  console.log('[Hourly] Creating markets...')
  try {
    const prices = await getPrices()
    const now    = new Date()
    const hour   = now.getUTCHours()
    const nextHour = new Date(now)
    nextHour.setUTCHours(hour + 1, 0, 0, 0)

    const timeLabel = `${nextHour.getUTCHours()}:00 UTC`
    const duration  = Math.floor((nextHour.getTime() - Date.now()) / 1000)

    if (duration < 300) {
      console.log('[Hourly] Less than 5 minutes to next hour, skipping')
      return
    }

    // Get nonce once and increment manually to avoid collision
    let nonce = await wallet.getNonce('pending')

    for (const asset of ASSETS) {
      const price = prices[asset.id]?.usd
      if (!price) continue

      const question         = `Will ${asset.name} (${asset.symbol}) be above ${formatPrice(price)} at ${timeLabel}?`
      const resolutionSource = `presaga-oracle:${asset.id}:${price}:${nextHour.toISOString()}`

      try {
        const { data, error: dbError } = await supabase
          .from('hourly_markets')
          .select('id')
          .eq('asset', asset.id)
          .eq('open_time', now.toISOString().slice(0, 13))
          .maybeSingle()

        if (dbError) {
          console.warn(`[Hourly] Supabase unavailable (${dbError.message}) — skipping ${asset.symbol} to avoid duplicates`)
          continue
        }

        if (data) {
          console.log(`[Hourly] Already created ${asset.symbol} for this hour`)
          continue
        }

        const marketId = await createOnChainMarket(question, resolutionSource, duration, nonce)
        nonce++

        try {
          await supabase.from('hourly_markets').insert({
            asset:             asset.id,
            symbol:            asset.symbol,
            open_price:        price,
            open_time:         now.toISOString().slice(0, 13),
            close_time:        nextHour.toISOString(),
            presaga_market_id: marketId,
            question,
            resolved:          false,
          })
        } catch (saveErr) {
          console.warn(`[Hourly] Failed to save ${asset.symbol} to Supabase: ${saveErr.message}`)
        }

        console.log(`[Hourly] Created market #${marketId}: ${question}`)
      } catch (e) {
        console.error(`[Hourly] Failed for ${asset.symbol}: ${e.message}`)
        nonce++ // still increment so the next asset doesn't collide
      }
    }
  } catch (e) {
    console.error(`[Hourly] Error: ${e.message}`)
  }
}

// ── RESOLVE HOURLY MARKETS ────────────────────────────────────────────────────

async function resolveHourlyMarkets() {
  console.log('[Hourly Resolve] Checking...')
  try {
    const now = new Date()

    const { data: pending, error: dbError } = await supabase
      .from('hourly_markets')
      .select('*')
      .eq('resolved', false)
      .lt('close_time', now.toISOString())

    if (dbError) {
      console.warn(`[Hourly Resolve] Supabase unavailable: ${dbError.message}`)
      return
    }

    if (!pending?.length) {
      console.log('[Hourly Resolve] Nothing to resolve')
      return
    }

    const prices = {}
    const priceData = await getPrices()
    for (const asset of ASSETS) {
      prices[asset.id] = priceData[asset.id]?.usd
    }

    let nonce = await wallet.getNonce('pending')

    for (const row of pending) {
      const currentPrice = prices[row.asset]
      if (!currentPrice) continue

      const outcome = currentPrice >= row.open_price ? 1 : 2
      const label   = outcome === 1 ? 'YES (Up)' : 'NO (Down)'

      try {
        const tx = await contract.resolveMarket(row.presaga_market_id, outcome, { gasLimit: 300000, nonce })
        nonce++
        await tx.wait()

        try {
          await supabase
            .from('hourly_markets')
            .update({ resolved: true, close_price: currentPrice, outcome: label })
            .eq('id', row.id)
        } catch (saveErr) {
          console.warn(`[Hourly Resolve] Failed to update Supabase for market #${row.presaga_market_id}: ${saveErr.message}`)
        }

        console.log(`[Hourly Resolve] Market #${row.presaga_market_id} ${row.symbol}: open $${row.open_price} → close $${currentPrice} → ${label}`)
      } catch (e) {
        console.error(`[Hourly Resolve] Failed for market #${row.presaga_market_id}: ${e.message}`)
        nonce++
      }
    }
  } catch (e) {
    console.error(`[Hourly Resolve] Error: ${e.message}`)
  }
}

// ── EXPORT FOR USE IN server.js ───────────────────────────────────────────────

module.exports = { createHourlyMarkets, resolveHourlyMarkets }
