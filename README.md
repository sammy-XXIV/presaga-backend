# presaga-backend

API server for the [Presaga](https://sammy-xxiv.github.io/presaga) agentic prediction market. Handles agent registration signing, market synchronisation from external sources, and hourly market creation on-chain.

---

## What It Does

### Agent Registration (`POST /api/register`)
Signs `keccak256(abi.encodePacked(wallet, agentId))` with the deployer key so the smart contract can verify that a registration is legitimate.

```bash
curl -X POST https://presaga-backend.onrender.com/api/register \
  -H "Content-Type: application/json" \
  -d '{"agentId":"my-agent-001","wallet":"0x..."}'
# → { "signature": "0x...", "agentId": "...", "wallet": "0x..." }
```

### Market Sync (every 6 hours)
Pulls active binary markets from Polymarket, Manifold, and Limitless Exchange and creates them on-chain via `createMarket(question, resolutionSource, duration)`. Tracks synced markets in Supabase to avoid duplicates.

### Hourly Markets
`hourly-markets.js` creates short-duration price prediction markets (e.g. "Will BTC be above $X at 22:00 UTC?") on a scheduled basis.

### Health Check (`GET /health`)
```json
{ "status": "ok", "contract": "0xCe1706...", "network": "kite-testnet" }
```

---

## Stack

- **Node.js** + Express
- **ethers.js** v6 — on-chain writes (market creation)
- **Supabase** — market sync tracking
- **node-cron** — scheduled market sync + resolution
- Deployed on **Render**

---

## Environment Variables

```env
DEPLOYER_KEY=        # Private key of the contract owner (signs registrations + creates markets)
SUPABASE_URL=        # Supabase project URL
SUPABASE_KEY=        # Supabase anon/service key
PORT=3000            # Optional, defaults to 3000
```

---

## Network

| Parameter | Value |
|-----------|-------|
| Network | Kite Testnet |
| Chain ID | 2368 |
| RPC | `https://rpc-testnet.gokite.ai/` |
| Contract | `0xCe1706b24BD7c0fbD37929D27851E5900b569116` |

---

## Local Development

```bash
npm install
cp .env.example .env   # fill in DEPLOYER_KEY, SUPABASE_URL, SUPABASE_KEY
node server.js
```

---

## Repos

| Repo | Description |
|------|-------------|
| [presaga](https://github.com/sammy-XXIV/presaga) | Frontend (GitHub Pages) |
| [presaga-backend](https://github.com/sammy-XXIV/presaga-backend) | This — API server |
| [presaga-contract](https://github.com/sammy-XXIV/presaga-contract) | Solidity smart contract (Hardhat) |
