/**
 * One-time backfill: reads all on-chain markets and populates
 * markets_sync (polymarket/manifold/limitless) and
 * hourly_markets (presaga-oracle) in Supabase.
 */

const ethers     = require('ethers')
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const RPC      = 'https://rpc-testnet.gokite.ai/'
const CONTRACT = '0xCe1706b24BD7c0fbD37929D27851E5900b569116'

const MARKET_ABI = [
  'function getMarket(uint256 marketId) external view returns (tuple(uint256 id, string question, string resolutionSource, uint256 expiresAt, uint256 createdAt, uint256 totalYes, uint256 totalNo, uint256 protocolFeePool, uint8 status, uint8 outcome))',
  'event MarketCreated(uint256 indexed id, string question, uint256 expiresAt)',
]

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY

const provider   = new ethers.JsonRpcProvider(RPC)
const contract   = new ethers.Contract(CONTRACT, MARKET_ABI, provider)
const supabase   = createClient(SUPABASE_URL, SUPABASE_KEY)

const BATCH_SIZE  = 30   // parallel getMarket calls per batch
const DELAY_MS    = 500  // pause between batches

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Parse resolutionSource into { source, sourceId } or null for hourly/unknown
function parseSource(resolutionSource) {
  if (!resolutionSource) return null
  if (resolutionSource.startsWith('polymarket:')) {
    return { type: 'markets_sync', source: 'polymarket', sourceId: resolutionSource.slice('polymarket:'.length) }
  }
  if (resolutionSource.startsWith('manifold:')) {
    return { type: 'markets_sync', source: 'manifold', sourceId: resolutionSource.slice('manifold:'.length) }
  }
  if (resolutionSource.startsWith('limitless:')) {
    return { type: 'markets_sync', source: 'limitless', sourceId: resolutionSource.slice('limitless:'.length) }
  }
  if (resolutionSource.startsWith('presaga-oracle:')) {
    // format: presaga-oracle:{assetId}:{openPrice}:{closeTimeISO}
    const parts = resolutionSource.split(':')
    return { type: 'hourly_markets', assetId: parts[1], openPrice: parseFloat(parts[2]), closeTime: parts[3] }
  }
  return null
}

const ASSET_SYMBOLS = {
  bitcoin:     'BTC',
  ethereum:    'ETH',
  solana:      'SOL',
  binancecoin: 'BNB',
  dogecoin:    'DOGE',
}

async function main() {
  console.log('Fetching MarketCreated events...')

  const filter = contract.filters.MarketCreated()
  let allIds = []

  // Paginate logs in 5000-block chunks (RPC limit)
  const FROM_BLOCK = 21389000
  const latestHex = await provider.send('eth_blockNumber', [])
  const latest    = parseInt(latestHex, 16)
  console.log(`Scanning blocks ${FROM_BLOCK} → ${latest}`)

  for (let from = FROM_BLOCK; from <= latest; from += 5000) {
    const to = Math.min(from + 4999, latest)
    try {
      const events = await contract.queryFilter(filter, from, to)
      events.forEach(e => allIds.push(Number(e.args.id)))
      process.stdout.write(`\r  Got ${allIds.length} market IDs so far (block ${to})...`)
    } catch (e) {
      console.warn(`\n  Block range ${from}-${to} failed: ${e.message}, skipping`)
    }
  }

  console.log(`\nTotal market IDs: ${allIds.length}`)

  // Deduplicate ids (just in case)
  allIds = [...new Set(allIds)].sort((a, b) => a - b)

  // Check what's already in Supabase to avoid re-inserting
  const { data: existingSync } = await supabase.from('markets_sync').select('presaga_market_id')
  const { data: existingHourly } = await supabase.from('hourly_markets').select('presaga_market_id')

  const alreadySyncedIds = new Set([
    ...(existingSync  || []).map(r => r.presaga_market_id),
    ...(existingHourly || []).map(r => r.presaga_market_id),
  ])
  console.log(`Already in Supabase: ${alreadySyncedIds.size} markets`)

  const toFetch = allIds.filter(id => !alreadySyncedIds.has(id))
  console.log(`Need to fetch: ${toFetch.length} markets`)

  let syncInserts   = []
  let hourlyInserts = []
  let skipped = 0
  let failed  = 0

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE)

    const results = await Promise.allSettled(batch.map(id => contract.getMarket(id)))

    results.forEach((res, j) => {
      const id = batch[j]
      if (res.status === 'rejected') {
        failed++
        return
      }
      const m   = res.value
      const src = parseSource(m.resolutionSource)

      if (!src) {
        skipped++
        return
      }

      const status   = Number(m.status)   // 0=open, 1=resolved, 2=cancelled
      const outcome  = Number(m.outcome)  // 0=none, 1=yes, 2=no
      const expiresAt = Number(m.expiresAt)
      const closesAt  = new Date(expiresAt * 1000).toISOString()
      const resolved  = status === 1
      const outcomeStr = resolved ? (outcome === 1 ? 'YES' : 'NO') : null

      if (src.type === 'markets_sync') {
        syncInserts.push({
          source:            src.source,
          source_id:         src.sourceId,
          presaga_market_id: id,
          question:          m.question,
          resolution_source: m.resolutionSource,
          closes_at:         closesAt,
          resolved,
          outcome:           outcomeStr,
        })
      } else if (src.type === 'hourly_markets') {
        const closeRaw  = src.closeTime ? new Date(src.closeTime) : new Date(expiresAt * 1000)
        const closeTime = isNaN(closeRaw.getTime()) ? closesAt : closeRaw.toISOString()
        // open_time = close_time minus 1 hour, sliced to "YYYY-MM-DDTHH"
        const openDate  = new Date(new Date(closeTime).getTime() - 3600000)
        const openTime  = openDate.toISOString().slice(0, 13)
        hourlyInserts.push({
          asset:             src.assetId,
          symbol:            ASSET_SYMBOLS[src.assetId] || src.assetId.toUpperCase(),
          open_price:        src.openPrice,
          open_time:         openTime,
          close_time:        closeTime,
          presaga_market_id: id,
          question:          m.question,
          resolved,
          outcome:           outcomeStr || undefined,
        })
      }
    })

    const done = Math.min(i + BATCH_SIZE, toFetch.length)
    process.stdout.write(`\r  Fetched ${done}/${toFetch.length} | sync:${syncInserts.length} hourly:${hourlyInserts.length} skip:${skipped} fail:${failed}`)
    await sleep(DELAY_MS)
  }

  console.log('\n\nInserting into Supabase...')

  // Upsert in chunks of 500
  const UPSERT_CHUNK = 500

  for (let i = 0; i < syncInserts.length; i += UPSERT_CHUNK) {
    const chunk = syncInserts.slice(i, i + UPSERT_CHUNK)
    const { error } = await supabase.from('markets_sync').insert(chunk)
    if (error) console.error(`  markets_sync insert error (chunk ${i}):`, error.message)
    else process.stdout.write(`\r  markets_sync: ${Math.min(i + UPSERT_CHUNK, syncInserts.length)}/${syncInserts.length}`)
  }

  console.log()

  for (let i = 0; i < hourlyInserts.length; i += UPSERT_CHUNK) {
    const chunk = hourlyInserts.slice(i, i + UPSERT_CHUNK)
    const { error } = await supabase.from('hourly_markets').insert(chunk)
    if (error) console.error(`  hourly_markets insert error (chunk ${i}):`, error.message)
    else process.stdout.write(`\r  hourly_markets: ${Math.min(i + UPSERT_CHUNK, hourlyInserts.length)}/${hourlyInserts.length}`)
  }

  console.log('\n\nDone.')
  console.log(`  markets_sync rows:   ${syncInserts.length}`)
  console.log(`  hourly_markets rows: ${hourlyInserts.length}`)
  console.log(`  skipped (unknown):   ${skipped}`)
  console.log(`  failed (RPC error):  ${failed}`)
}

main().catch(console.error)
