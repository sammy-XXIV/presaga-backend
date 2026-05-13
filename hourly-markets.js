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
const cron   = require('node-cron')
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

// ── CONFIG ────────────────────────────────────────────────────────────────────

const CONTRACT = process.env.PRESAGA_ADDRESS || '0x04d8bEA0bC25f4C69D215CcCb05eeb60eC733CcC'
const RPC      = 'https://rpc-testnet.gokite.ai/'

const ASSETS = [
  { id: 'bitcoin',  symbol: 'BTC',  name: 'Bitcoin' },
  { id: 'ethereum', symbol: 'ETH',  name: 'Ethereum' },
  { id: 'solana',   symbol: 'SOL',  name: 'Solana' },
  { id: 'binancecoin', symbol: 'BNB', name: 'BNB' },
  { id: 'dogecoin', symbol: 'DOGE', name: 'Dogecoin' },
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
    timeout: 10000,
  })
  return res.data
}

function formatPrice(price) {
  if (price >= 1000) return `$${Math.round(price).toLocaleString()}`
  if (price >= 1)    return `$${price.toFixed(2)}`
  return `$${price.toFixed(4)}`
}

async function createOnChainMarket(question, resolutionSource, duration) {
  const tx      = await contract.createMarket(question, resolutionSource, duration, { gasLimit: 500000 })
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

    for (const asset of ASSETS) {
      const price = prices[asset.id]?.usd
      if (!price) continue

      const question        = `Will ${asset.name} (${asset.symbol}) be above ${formatPrice(price)} at ${timeLabel}?`
      const resolutionSource = `presaga-oracle:${asset.id}:${price}:${nextHour.toISOString()}`

      try {
        // Check if already created this hour
        const { data } = await supabase
          .from('hourly_markets')
          .select('id')
          .eq('asset', asset.id)
          .eq('open_time', now.toISOString().slice(0, 13))  // YYYY-MM-DDTHH
          .maybeSingle()

        if (data) {
          console.log(`[Hourly] Already created ${asset.symbol} for this hour`)
          continue
        }

        const marketId = await createOnChainMarket(question, resolutionSource, duration)

        await supabase.from('hourly_markets').insert({
          asset:          asset.id,
          symbol:         asset.symbol,
          open_price:     price,
          open_time:      now.toISOString().slice(0, 13),
          close_time:     nextHour.toISOString(),
          presaga_market_id: marketId,
          question,
          resolved:       false,
        })

        console.log(`[Hourly] Created market #${marketId}: ${question}`)
        await new Promise(r => setTimeout(r, 2000))
      } catch (e) {
        console.error(`[Hourly] Failed for ${asset.symbol}: ${e.message}`)
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

    const { data: pending } = await supabase
      .from('hourly_markets')
      .select('*')
      .eq('resolved', false)
      .lt('close_time', now.toISOString())

    if (!pending?.length) {
      console.log('[Hourly Resolve] Nothing to resolve')
      return
    }

    // Fetch current prices
    const prices = await getPrices()

    for (const row of pending) {
      const currentPrice = prices[row.asset]?.usd
      if (!currentPrice) continue

      // YES = price is above open price, NO = price is below
      const outcome = currentPrice >= row.open_price ? 1 : 2
      const label   = outcome === 1 ? 'YES (Up)' : 'NO (Down)'

      try {
        const tx = await contract.resolveMarket(row.presaga_market_id, outcome, { gasLimit: 300000 })
        await tx.wait()

        await supabase
          .from('hourly_markets')
          .update({ resolved: true, close_price: currentPrice, outcome: label })
          .eq('id', row.id)

        console.log(`[Hourly Resolve] Market #${row.presaga_market_id} ${row.symbol}: open $${row.open_price} → close $${currentPrice} → ${label}`)
        await new Promise(r => setTimeout(r, 2000))
      } catch (e) {
        console.error(`[Hourly Resolve] Failed for market #${row.presaga_market_id}: ${e.message}`)
      }
    }
  } catch (e) {
    console.error(`[Hourly Resolve] Error: ${e.message}`)
  }
}

// ── EXPORT FOR USE IN server.js ───────────────────────────────────────────────

module.exports = { createHourlyMarkets, resolveHourlyMarkets }

