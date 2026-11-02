<p align="center">
  <img src="public/icon.svg" width="72" alt="Satmine">
</p>

<h1 align="center">Satmine</h1>

<p align="center"><b>Fees become hashrate.</b><br>
A pump.fun coin whose creator rewards are claimed, swapped to native Bitcoin and spent on real SHA-256 rigs, automatically, every cycle, for as long as the coin trades.<br>
No exchange account. No identity check. A public receipt at every hop.</p>

<p align="center">
  <a href="https://satmine.vercel.app">satmine.vercel.app</a> ·
  <a href="https://satmine.vercel.app/bitcoin">live receipts</a> ·
  <a href="https://x.com/Satmine_Sol">@Satmine_Sol</a>
</p>

<p align="center">
  <img src="docs/home.png" width="100%" alt="Satmine home: the flywheel, the loop and the receipts over the pixel-art mine">
</p>

---

## What it is

Most "revenue share" coins route fees back to holders or to a buyback. Satmine routes them into **Bitcoin mining**.

Every pump.fun coin pays its creator a share of trading fees. Satmine's engine wallet owns that creator position. On a timer it:

1. **claims** the creator rewards (SOL),
2. **swaps** them to native BTC on [Chainflip](https://chainflip.io) (a decentralised cross-chain swap, no account),
3. **rents** SHA-256 hashrate on [MiningRigRentals](https://www.miningrigrentals.com) with that BTC, pointed at a pool,
4. **mines** to a public Bitcoin address that the pool pays straight from the coinbase.

As long as people trade the coin, fees keep arriving and the loop keeps buying hashrate. While a rented rig is still running, new fees extend it rather than renting a second one, so the hashrate is continuous instead of bursty.

The site shows all of it live: hashrate rented right now, how many hours of rig time are paid for, Bitcoin landed on the payout address, and every transaction, swap channel and rental with a link to where you can check it yourself.

<p align="center">
  <img src="docs/pipeline.svg" width="100%" alt="Pipeline: claim on Solana, swap on Chainflip, rent on MiningRigRentals, mine on Ocean, repeat">
</p>

## Why this route

| Hop | Alternative we rejected | What we use | Why |
|---|---|---|---|
| SOL → BTC | Centralised exchange (KYC, custody, withdrawal delays) | **Chainflip** deposit channel: native SOL in, native BTC out, refund to our wallet if the price moves past the tolerance | No account, no identity, the channel id and both chain transactions are public |
| Buying hashrate | NiceHash (requires KYC; first USDT order is 300 USDT minimum) | **MiningRigRentals**: rent a specific rig by the hour, paid in BTC, API-driven | No blanket KYC, rentals from a few dollars, so every claim can buy hashrate instead of waiting for a minimum |
| Pool | Pools that pay from a pool wallet | **Ocean** (`mine.ocean.xyz:3334`), username = the public BTC address | Pays from the block's coinbase, so a payout is provably a mining reward, not a transfer |

The NiceHash path is kept behind `HASH_PROVIDER=nicehash` for anyone who already has a verified account.

## Receipts: how to verify it yourself

Nothing on the site needs to be trusted. Every step produces something a third party can open:

| Step | Receipt | Where |
|---|---|---|
| Claim | Solana transaction from the pump.fun creator vault to the engine wallet | [solscan.io](https://solscan.io) |
| Swap | Solana transaction into the Chainflip deposit channel; the channel itself (state, amounts, swap id); the Bitcoin transaction Chainflip sends out | [scan.chainflip.io](https://scan.chainflip.io), [mempool.space](https://mempool.space) |
| Rent | Rental id and the rig's public page (hashrate, price per PH/day, reliability score) | [rig.rent](https://www.miningrigrentals.com) |
| Mine | The payout address's hashrate at the pool; every coinbase payout to it on chain | [ocean.xyz/stats/\<address\>](https://ocean.xyz), [mempool.space/address/\<address\>](https://mempool.space) |

The engine wallet, the marketplace deposit address and the payout address are all printed on the `/bitcoin` page.

<p align="center">
  <img src="docs/bitcoin.png" width="100%" alt="The /bitcoin page: hashpower rented, pool hashrate, Bitcoin received, and every receipt with its link">
</p>

## The side quest: mine in your browser

`/mine` is a browser proof-of-work pool, the original Satmine game. Your tab hashes `SHA-256(seed ‖ nonce)` on CPU (Web Workers) and GPU (WebGPU compute), looking for digests with `difficulty` leading zero bits. The server verifies each proof with a single hash, credits 2^difficulty hashes of work, and splits each round's SOL pot by share of verified work. Payouts are plain SOL transfers once a balance passes the threshold.

It is real work and real SOL, but it is not Bitcoin mining: a browser at a few MH/s is ~10 orders of magnitude short of a Bitcoin block. The Bitcoin hashrate is the engine's.

<p align="center">
  <img src="docs/mine.png" width="100%" alt="The /mine page: your rig, the network, earnings and the pixel-art miner">
</p>

Pages: **Engine** (home), **Mine**, Stats, Leaderboard, Rounds (with per-round split), Ledger, Benchmark, Bitcoin (full receipts), How it works.

## How the engine decides

Runs every `BTC_EVERY_MS` (10 min by default). Each cycle, in order:

| Step | Rule |
|---|---|
| Claim | If the creator vault holds ≥ `BTC_MIN_CLAIM_SOL`, claim it (both pump.fun programs). |
| Swap | SOL above `BTC_KEEP_SOL` (gas reserve) is swapped once it reaches `CF_MIN_SOL`. Chainflip needs at least 40 000 sats out per swap (≈ 0.36 SOL at current prices), so the default floor is 0.4 SOL. The quote's recommended retry window and a `CF_SLIPPAGE_PCT` fill-or-kill tolerance protect the trade; an unfilled swap refunds SOL to the engine wallet. Only one swap is in flight at a time. The destination of the swap is the marketplace's BTC deposit address, so the BTC never sits in a wallet we control. |
| Rent | Once the marketplace balance is ≥ `MRR_MIN_RENT_BTC`: if a rig is still running for us, **extend it** with everything the balance covers. Otherwise rent the cheapest rig that is online, has reliability `rpi ≥ MRR_RPI_MIN`, is at or below `MRR_MAX_PRICE_X ×` the market's lowest BTC/PH/day, and whose minimum rental fits the budget, for as many hours as the balance covers (capped at `MRR_MAX_HOURS`). The rig mines against a saved pool profile: our pool, username `BTC_ADDRESS.worker`. |
| Watch | Open swaps are polled until the BTC egress transaction is known. Live rentals, pool hashrate, on-chain payouts, the market and the vault are refreshed every minute and served at `GET /api/btc`. |

`BTC_DRY=1` runs the whole loop but only logs what it would do (`would claim …`, `would swap …`, `would rent rig …`). That is how you arm it safely the first time.

## Run it

```bash
git clone https://github.com/openpumptrade/satmine && cd satmine
npm install
cp .env.example .env
npm start
```

Open http://localhost:8787. Out of the box:

- the browser pool runs **simulated** (every round pays a fixed pot into the ledger, no SOL moves);
- the engine is **off** (`BTC_ENGINE=0`) and the home page shows the public side only: market prices, pool, chain.

Set `CREATOR_WALLET` (public key, no secret) and the home page already shows how much SOL is waiting in the creator vault.

### Arming the engine

1. Create a [MiningRigRentals](https://www.miningrigrentals.com) account and an API key with the **rent** permission.
2. Pick a fresh Bitcoin address for payouts (`BTC_ADDRESS`). This is public; it goes in the pool username.
3. Fill `MRR_API_KEY`, `MRR_API_SECRET`, `PRIVATE_KEY` (the coin's creator wallet), `BTC_ADDRESS`.
4. Start with `BTC_ENGINE=1 BTC_DRY=1` and read the logs for one cycle.
5. Set `BTC_DRY=0`.

### Going live with the browser pool

- `TOKEN_MINT`: the coin's CA, shown on the page with a pump.fun link.
- `TREASURY_SECRET` + `RPC_URL`: the server pays balances over `PAYOUT_THRESHOLD_SOL` with SOL transfers at each round close.

## Configuration

Everything is an environment variable; `.env.example` lists them all with comments.

| Group | Variables |
|---|---|
| Pool | `PORT`, `ROUND_MS`, `REWARD_SOL`, `PAYOUT_THRESHOLD_SOL`, `MIN_DIFFICULTY`, `TOKEN_MINT`, `TREASURY_SECRET`, `RPC_URL`, `DATA_FILE` |
| Engine | `BTC_ENGINE`, `BTC_DRY`, `BTC_EVERY_MS`, `HASH_PROVIDER` (`mrr` \| `nicehash`), `CREATOR_WALLET`, `PRIVATE_KEY`, `BTC_KEEP_SOL`, `BTC_MIN_CLAIM_SOL`, `BTC_DATA_FILE` |
| Chainflip | `CF_SLIPPAGE_PCT`, `CF_MIN_SOL` |
| MiningRigRentals | `MRR_API_KEY`, `MRR_API_SECRET`, `MRR_ALGO`, `MRR_MIN_RENT_BTC`, `MRR_RPI_MIN`, `MRR_HASH_MIN_TH`, `MRR_MAX_HOURS`, `MRR_MAX_PRICE_X`, `MRR_EXTEND_WINDOW_MIN` |
| Pool target | `BTC_ADDRESS`, `POOL_HOST`, `POOL_PORT`, `POOL_WORKER`, `POOL_NAME` |
| NiceHash (legacy) | `NH_API_KEY`, `NH_API_SECRET`, `NH_ORG_ID`, `NH_TEST`, `NH_ALGORITHM`, `NH_LIMIT_EH`, `NH_PRICE_MARGIN`, `NH_ORDER_MIN_USDT`, `NH_REFILL_MIN_USDT`, `BTC_MIN_DEPOSIT_USDT` |

## API

| Endpoint | What |
|---|---|
| `GET /api/btc` | The engine: `config`, `flow` (TH/s now, rigs, paid-for time, next cycle), `totals`, `live` (pool, chain, market, rentals, balance, vault), `ledger` (claims, swaps, rentals, errors) |
| `GET /api/stream` | Server-sent events: pool state every 2 s, `settled` and `payout` events |
| `GET /api/state`, `/api/stats`, `/api/rounds`, `/api/rounds/:id`, `/api/wallet/:addr`, `/api/bench` | Browser pool reads |
| `POST /api/challenge`, `POST /api/proof` | Browser pool: get a ticket, submit a nonce |

## Layout

```
server.js            the pool server + static hosting (zero-dependency node http)
engine/btc.js        the loop: claim → swap → rent → watch; dry-run; ledger; /api/btc view
engine/chainflip.js  Chainflip SDK wrapper: quote, deposit channel, status
engine/mrr.js        MiningRigRentals API v2 client: HMAC-SHA1 auth, balance, deposit address, pool profiles, rigs, rentals, extend
engine/nicehash.js   legacy NiceHash client (HASH_PROVIDER=nicehash)
public/              static frontend, no build step: app.js (routing + views), pit.js (pixel-art mine), miner.js + worker.js + gpu.js + sha.js (browser mining), charts.js, fx.js
vendor/pumpkit       Solana/pump.fun toolkit (creator vault claims, Jupiter swaps, transfers)
docs/                screenshots and the pipeline diagram
```

State persists to JSON files (`DATA_FILE`, `BTC_DATA_FILE`); on Railway they live on a mounted volume.

## Deploy

- **API**: Railway, one service running `node server.js`, a volume mounted at `/data` with `DATA_FILE=/data/state.json` and `BTC_DATA_FILE=/data/btc.json`.
- **Frontend**: Vercel from `public/` (its own `vercel.json` rewrites every non-API path to `index.html`). `public/config.js` reads `<meta name="satmine-api">` for the API origin.

## Security notes

- The engine wallet's secret and the marketplace keys live only in the host's environment. Nothing is committed.
- The engine never holds BTC: Chainflip delivers straight to the marketplace deposit address, and the pool pays the public address, which can be a wallet nobody at the project can spend from.
- The marketplace balance is the one custodial hop. Rentals are bought as soon as the balance allows, so it stays small.
- `/api/challenge` and `/api/proof` are rate-limited per wallet and per IP; proofs are bound to a ticket, a seed and a difficulty, and each nonce is accepted once.

## License

MIT
