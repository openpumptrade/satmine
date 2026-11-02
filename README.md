# Goldvein

Strike gold in your browser. Your tab solves SHA-256 puzzles; every verified proof is a share of the round pot, paid in SOL.

Pixel-art mine (pickaxe, cart, lantern, bats), odometer digits, hex-scramble labels, segmented round ruler, toasts and a blurred-cave backdrop on the sub-pages. Pages: Mine, Stats, Leaderboard, Rounds (+ round detail), Ledger, Benchmark, How it works.

## Run

```bash
npm install
cp .env.example .env
npm start
```

Open http://localhost:8787. Out of the box it runs **simulated**: every round pays a fixed pot into the ledger and nothing moves on chain.

## Layout

- `public/` static frontend (no build step). `config.js` reads `<meta name="goldvein-api">` for the API origin when hosted apart from the server (Vercel + Railway).
- `server.js` the pool: tickets (`POST /api/challenge`), proof verification (`POST /api/proof`), per-wallet vardiff, rounds, payouts, stats, SSE stream (`/api/stream`), bench table, static hosting with SPA fallback. State persists to `data/state.json`.

## Going live

1. Set `TOKEN_MINT` to the pump.fun CA so the mine page shows it.
2. Set `TREASURY_SECRET` (base58 or JSON array) and `RPC_URL`. The server then pays balances over `PAYOUT_THRESHOLD_SOL` at every round close with a plain SOL transfer, capped by what the wallet holds minus a 0.01 SOL fee reserve. Fund that wallet from the creator-fee claims.
3. Deploy `server.js` on Railway and `public/` on Vercel; put the Railway URL in the `goldvein-api` meta tag of `public/index.html`.

## Puzzle

`SHA-256(seed ‖ nonce)` with a 32-byte seed and an 8-byte big-endian nonce, must start with `difficulty` zero bits. A proof at difficulty *d* credits 2^d hashes. Difficulty per address targets about one proof every 4 s.

## Bitcoin engine (creator rewards → hashrate, no KYC)

`engine/btc.js` turns the coin's pump.fun creator rewards into real SHA-256 hashpower without an exchange account or identity check, with a public receipt at every hop:

1. **Claim** creator rewards (pumpkit `claimCreatorFees`) → Solana tx.
2. **Swap** SOL above `BTC_KEEP_SOL` to native BTC on [Chainflip](https://chainflip.io) (`engine/chainflip.js`, official SDK): a deposit channel whose destination is the rig marketplace's BTC deposit address. Receipts: the Solana tx into the channel, the channel id on scan.chainflip.io, the BTC egress tx on mempool.space. If the price moves past `CF_SLIPPAGE_PCT` the SOL is refunded to the engine wallet. Chainflip needs at least 40 000 sats out per swap (≈ 0.36 SOL), so rewards accumulate to `CF_MIN_SOL` first.
3. **Rent**: the BTC balance on [MiningRigRentals](https://www.miningrigrentals.com) (`engine/mrr.js`) rents the cheapest reliable `sha256` rig (rpi ≥ `MRR_RPI_MIN`, price ≤ `MRR_MAX_PRICE_X` × market low) against a pool profile pointed at our pool, for as many hours as the balance covers (up to `MRR_MAX_HOURS`). Receipt: rental id + rig page.
4. **Mine**: pool username is the public `BTC_ADDRESS` (Ocean by default, which pays from the coinbase). The page reads hashrate from `api.ocean.xyz` and payouts from `mempool.space`.

The `/bitcoin` page (`GET /api/btc`) shows live rentals, pool hashrate, BTC received and every receipt with its link. Without `PRIVATE_KEY` + marketplace keys it still shows the public side.

Set up: create a MiningRigRentals API key with the *rent* permission, fill `MRR_API_KEY`/`MRR_API_SECRET`, `PRIVATE_KEY` and `BTC_ADDRESS`, run once with `BTC_ENGINE=1 BTC_DRY=1` to see the plan in the logs (`would swap … would rent rig …`), then `BTC_DRY=0`.

`HASH_PROVIDER=nicehash` keeps the older path (Jupiter SOL→USDT → NiceHash USDT order, `engine/nicehash.js`), which needs a KYC'd NiceHash account and 300 USDT for the first order.
