// The Bitcoin engine: pump.fun creator rewards → native BTC → rented SHA-256
// hashrate pointed at a pool that pays a public BTC address. No exchange
// account, no identity check anywhere on the path.
//
// Every hop leaves a receipt somebody else can check:
//   1. claim      Solana tx (creator vault → engine wallet)                     solscan
//   2. swap       Chainflip deposit channel + Solana tx in, BTC tx out          scan.chainflip.io + mempool.space
//                 (destination = the MiningRigRentals BTC deposit address)
//   3. hashrate   MiningRigRentals rental id (rig, hours, paid)                 rig.rent/rigs/<id>
//   4. mining     pool stats for the BTC address, coinbase payouts to it        ocean.xyz + mempool.space
//
// HASH_PROVIDER=nicehash keeps the older USDT → NiceHash path (needs KYC).
// Runs on a timer inside server.js. Without PRIVATE_KEY + marketplace keys it
// only reads the public side (pool + mempool + market) so the page still works.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NiceHash, HOSTS } from './nicehash.js';
import { MRR } from './mrr.js';
import { Chainflip } from './chainflip.js';

const env = (k, d) => (process.env[k] ?? d);
const SOL = 1e9;
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDT_DEC = 6;

export const CFG = {
  enabled: env('BTC_ENGINE', '0') === '1',
  dry: env('BTC_DRY', '0') === '1',
  every_ms: Number(env('BTC_EVERY_MS', 600_000)),
  provider: env('HASH_PROVIDER', 'nicehash'),              // nicehash | mrr
  // Solana side
  rpc: env('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  secret: env('PRIVATE_KEY', ''),
  creator: env('CREATOR_WALLET', ''),                     // public key of the coin's creator; lets the page show the vault before the engine is armed
  keep_sol: Number(env('BTC_KEEP_SOL', 0.02)),
  min_claim_sol: Number(env('BTC_MIN_CLAIM_SOL', 0.01)),
  token_mint: env('TOKEN_MINT', ''),                        // the coin; with a fee-sharing config the engine distributes its vault to the recipient wallet
  // Chainflip (SOL → BTC)
  cf_slippage: Number(env('CF_SLIPPAGE_PCT', 1)),
  cf_min_sol: Number(env('CF_MIN_SOL', 0.4)),               // protocol minimum is ~0.068 SOL in / 40 000 sats out, so ≈0.36 SOL at current prices
  // MiningRigRentals
  mrr_key: env('MRR_API_KEY', ''), mrr_secret: env('MRR_API_SECRET', ''),
  mrr_algo: env('MRR_ALGO', 'sha256'),
  mrr_min_rent_btc: Number(env('MRR_MIN_RENT_BTC', 0.0001)),  // don't rent below this balance (≈ $10)
  mrr_rpi_min: Number(env('MRR_RPI_MIN', 85)),
  mrr_hash_min_th: Number(env('MRR_HASH_MIN_TH', 10)),
  mrr_max_hours: Number(env('MRR_MAX_HOURS', 24)),
  mrr_extend_window_min: Number(env('MRR_EXTEND_WINDOW_MIN', 30)),  // extend the live rental instead of renting a second rig while it has this long left
  mrr_max_price_x: Number(env('MRR_MAX_PRICE_X', 1.5)),       // skip rigs priced above 1.5× the market's lowest
  // NiceHash (legacy)
  nh_key: env('NH_API_KEY', ''), nh_secret: env('NH_API_SECRET', ''), nh_org: env('NH_ORG_ID', ''),
  nh_host: env('NH_HOST', '') || (env('NH_TEST', '0') === '1' ? HOSTS.test : HOSTS.prod),
  algorithm: env('NH_ALGORITHM', 'SHA256ASICBOOST_USDT'), market: 'USDT',
  limit: Number(env('NH_LIMIT_EH', 0.001)), price_margin: Number(env('NH_PRICE_MARGIN', 1.03)),
  order_min_usdt: Number(env('NH_ORDER_MIN_USDT', 300)), refill_min_usdt: Number(env('NH_REFILL_MIN_USDT', 20)),
  min_deposit_usdt: Number(env('BTC_MIN_DEPOSIT_USDT', 10)),
  deposit_every_ms: Number(env('BTC_DEPOSIT_EVERY_MIN', 360)) * 60_000,   // batch deposits: NiceHash's Travel Rule flags many small deposits from a fresh account
  // Pool + payout
  btc_address: env('BTC_ADDRESS', ''),
  pool_host: env('POOL_HOST', 'mine.ocean.xyz'),
  pool_port: Number(env('POOL_PORT', 3334)),
  pool_worker: env('POOL_WORKER', 'satmine'),
  pool_name: env('POOL_NAME', 'OCEAN'),
  data_file: env('BTC_DATA_FILE', new URL('../data/btc.json', import.meta.url).pathname),
};

const log = (...a) => console.log(new Date().toISOString(), '[btc]', ...a);
const parseNice = n => { const m = /([\d.]+)\s*([KMGTPE]?)/i.exec(String(n ?? '')); return m ? Number(m[1]) * ({ '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 }[m[2].toUpperCase()] ?? 1) : 0; };
const DONE = new Set(['COMPLETED', 'FAILED']);

export class BtcEngine {
  constructor() {
    this.state = { claims: [], swaps: [], deposits: [], orders: [], refills: [], rentals: [], errors: [], wallet: null, mrrDeposit: null, profileId: null, nhDeposit: null, poolId: null, orderId: null, lastRun: null };
    this.live = { order: null, rentals: [], pool: null, chain: null, market: null, balance: null, vault: null, at: 0 };
    this.nh = new NiceHash({ key: CFG.nh_key, secret: CFG.nh_secret, orgId: CFG.nh_org, host: CFG.nh_host });
    this.mrr = new MRR({ key: CFG.mrr_key, secret: CFG.mrr_secret });
    this.cf = new Chainflip({ slippagePct: CFG.cf_slippage });
    this.kit = null; this.ctx = null; this.walletKp = null;
    this.load();
  }

  load() {
    try { if (existsSync(CFG.data_file)) this.state = { ...this.state, ...JSON.parse(readFileSync(CFG.data_file, 'utf8')) }; } catch (e) { log(`load failed: ${e.message}`); }
  }
  save() {
    try { mkdirSync(join(CFG.data_file, '..'), { recursive: true }); writeFileSync(CFG.data_file, JSON.stringify(this.state)); } catch (e) { log(`save failed: ${e.message}`); }
  }
  push(list, item) { this.state[list].unshift({ at: Date.now(), ...item }); this.state[list].length = Math.min(this.state[list].length, 500); this.save(); }
  fail(step, err) { log(`${step} failed: ${err.message}`); this.push('errors', { step, error: err.message.slice(0, 300) }); }

  get mrrMode() { return CFG.provider !== 'nicehash'; }
  get marketReady() { return this.mrrMode ? this.mrr.configured : this.nh.configured; }
  get writes() { return CFG.enabled && !!CFG.secret && this.marketReady && !!CFG.btc_address; }

  // Hashrate on the books right now and how far the paid-for rig time reaches.
  flow() {
    const now = Date.now();
    const base = { next_run: this.state.lastRun ? this.state.lastRun + CFG.every_ms : null, armed: this.writes, cycle_ms: CFG.every_ms, provider: this.mrrMode ? 'mrr' : 'nicehash' };
    if (!this.mrrMode) {
      // NiceHash: one standing order; speed in EH/s, budget drains at price × speed per day.
      const o = this.live.order;
      const alive = o && (o.alive || ['PENDING', 'ACTIVE'].includes(o.status));
      if (!alive) return { th_now: 0, rigs: 0, until: null, ...base };
      const th = (o.speed_eh ?? 0) * 1e6;
      const perDay = (o.price ?? 0) * (o.speed_eh ?? 0);
      const until = perDay > 0 ? now + (o.available / perDay) * 86400_000 : (o.end ? Date.parse(o.end) || null : null);
      return { th_now: +th.toFixed(2), rigs: o.rigs ?? 0, until, order_id: o.id, available_usdt: o.available, ...base };
    }
    const live = (this.live.rentals ?? []).filter(r => r.end && r.end > now && !r.ended);
    const th = live.reduce((a, r) => a + parseNice(r.hash_average ?? r.hash_advertised ?? '0'), 0) / 1e12;
    const until = live.reduce((a, r) => Math.max(a, r.end), 0) || null;
    return { th_now: +th.toFixed(2), rigs: live.length, until, ...base };
  }
  view() {
    const sum = (l, k) => this.state[l].reduce((a, x) => a + (x[k] ?? 0), 0);
    return {
      flow: this.flow(),
      config: {
        enabled: CFG.enabled, dry: CFG.dry, writes: this.writes, every_ms: CFG.every_ms, provider: this.mrrMode ? 'mrr' : 'nicehash',
        wallet: this.state.wallet, creator: CFG.creator || this.state.wallet || null, btc_address: CFG.btc_address || null,
        mrr_deposit: this.state.mrrDeposit, nh_deposit: this.state.nhDeposit,
        pool: `${CFG.pool_host}:${CFG.pool_port}`, pool_name: CFG.pool_name,
        algorithm: this.mrrMode ? CFG.mrr_algo : CFG.algorithm, limit_eh: CFG.limit, order_min_usdt: CFG.order_min_usdt, order_id: this.state.orderId,
        min_rent_btc: CFG.mrr_min_rent_btc, min_swap_sol: CFG.cf_min_sol, usdt_mint: USDT_MINT,
      },
      totals: {
        claimed_lamports: sum('claims', 'lamports'), swapped_lamports: sum('swaps', 'lamports'), swapped_sats: this.state.swaps.reduce((a, x) => a + (x.egress_sats ?? 0), 0),
        rented_btc: sum('rentals', 'paid_btc'), rented_hours: sum('rentals', 'hours'),
        swapped_usdt: sum('swaps', 'usdt'), deposited_usdt: sum('deposits', 'usdt'), ordered_usdt: sum('orders', 'usdt') + sum('refills', 'usdt'),
      },
      live: this.live,
      ledger: { claims: this.state.claims.slice(0, 50), swaps: this.state.swaps.slice(0, 50), rentals: this.state.rentals.slice(0, 50), deposits: this.state.deposits.slice(0, 50), orders: this.state.orders.slice(0, 20), refills: this.state.refills.slice(0, 50), errors: this.state.errors.slice(0, 10) },
      last_run: this.state.lastRun,
    };
  }

  start() {
    this.poll().catch(e => log(`poll: ${e.message}`));
    setInterval(() => this.poll().catch(e => log(`poll: ${e.message}`)), 60_000);
    if (!CFG.enabled) { log(`engine off (BTC_ENGINE=0) · public stats only · provider ${CFG.provider}`); return; }
    if (!this.writes) log(`engine on but not armed: needs PRIVATE_KEY, ${this.mrrMode ? 'MRR_API_KEY/SECRET' : 'NH_API_KEY/SECRET/ORG_ID'}, BTC_ADDRESS${CFG.dry ? ' (dry run)' : ''}`);
    const tick = () => this.round().catch(e => this.fail('round', e));
    setTimeout(tick, 5000);
    setInterval(tick, CFG.every_ms);
  }

  // ---------- public reads ----------
  async poll() {
    const now = Date.now();
    const open = this.state.rentals.filter(r => !r.end || r.end > now - 3600_000).slice(0, 5);
    const [pool, chain, market, order, rentals, balance, vault] = await Promise.all([
      this.poolStats().catch(() => null),
      this.chainStats().catch(() => null),
      this.mrrMode ? MRR.algo(CFG.mrr_algo).catch(() => null) : NiceHash.marketPrice(CFG.algorithm, CFG.market, CFG.nh_host).catch(() => null),
      !this.mrrMode && this.state.orderId && this.nh.configured ? this.nh.order(this.state.orderId).then(o => ({ id: o.id, status: o.status?.code, alive: o.alive, price: Number(o.price), limit: Number(o.limit), amount: Number(o.amount), available: Number(o.availableAmount), spent: Number(o.payedAmount), speed_eh: Number(o.acceptedCurrentSpeed ?? 0), rigs: o.rigsCount, end: o.endTs })).catch(() => this.live.order) : null,
      this.mrrMode && this.mrr.configured ? Promise.all(open.map(r => this.mrr.rental(r.id).catch(() => r))) : [],
      this.mrrMode ? (this.mrr.configured ? this.mrr.balance('BTC').catch(() => this.live.balance) : null) : (this.nh.configured ? this.nh.balance(CFG.market).catch(() => this.live.balance) : null),
      this.vaultStats().catch(() => this.live.vault),
    ]);
    this.live = { pool, chain, market, order, rentals, balance, vault, at: now };
    await this.trackSwaps().catch(e => log(`swaps: ${e.message}`));
  }
  // Follow open Chainflip swaps until the BTC egress tx is known.
  async trackSwaps() {
    const pending = this.state.swaps.filter(s => s.channel && !DONE.has(s.state)).slice(0, 10);
    for (const s of pending) {
      const st = await this.cf.status(s.channel).catch(() => null);
      if (!st) continue;
      Object.assign(s, { state: st.state, swap_id: st.swapId ?? s.swap_id, egress_sats: st.egressAmount ? Number(st.egressAmount) : s.egress_sats, egress_tx: st.egressTxRef ?? s.egress_tx, refund_tx: st.refundTxRef ?? s.refund_tx, failure: st.failure ?? null });
      if (st.expired && st.state === 'WAITING') s.state = 'FAILED';
    }
    if (pending.length) this.save();
  }
  // Creator rewards waiting in the pump.fun vault (public read; needs only the creator's address).
  async vaultStats() {
    const creator = CFG.creator || this.state.wallet;
    if (!creator) return null;
    await this.ctxLoad();
    const v = await this.kit.creatorVaultBalances(this.ctx, { creator });
    let shared = 0, sharing = null;
    if (CFG.token_mint) {
      sharing = await this.kit.readSharingConfig(this.ctx, CFG.token_mint).catch(() => null);
      if (sharing) shared = await this.kit.sharedFeesWaiting(this.ctx, CFG.token_mint).catch(() => 0);
    }
    return { creator, claimable_sol: v.sol + shared, creator_vault_sol: v.sol, shared_vault_sol: shared, sharing: sharing ? { shareholders: sharing.shareholders } : null, at: Date.now() };
  }
  async poolStats() {
    if (!CFG.btc_address || !/ocean/.test(CFG.pool_host)) return null;
    const r = await fetch(`https://api.ocean.xyz/v1/statsnap/${CFG.btc_address}`, { signal: AbortSignal.timeout(10_000) });
    const { result } = await r.json();
    return { hashrate_60s: Number(result.hashrate_60s), hashrate_300s: Number(result.hashrate_300s), shares_300s: Number(result.shares_300s), unpaid_btc: Number(result.unpaid), est_next_block_btc: Number(result.estimated_total_earn_next_block), last_share: Number(result.lastest_share_ts) * 1000 || null };
  }
  async chainStats() {
    if (!CFG.btc_address) return null;
    const base = `https://mempool.space/api/address/${CFG.btc_address}`;
    const [a, txs] = await Promise.all([fetch(base, { signal: AbortSignal.timeout(10_000) }).then(r => r.json()), fetch(`${base}/txs`, { signal: AbortSignal.timeout(10_000) }).then(r => r.json())]);
    const received = a.chain_stats.funded_txo_sum + a.mempool_stats.funded_txo_sum;
    const incoming = txs.filter(t => t.vout.some(o => o.scriptpubkey_address === CFG.btc_address)).slice(0, 25).map(t => ({
      txid: t.txid, at: (t.status.block_time ?? Date.now() / 1000) * 1000, confirmed: t.status.confirmed, height: t.status.block_height ?? null,
      sats: t.vout.filter(o => o.scriptpubkey_address === CFG.btc_address).reduce((s, o) => s + o.value, 0),
      coinbase: t.vin.some(v => v.is_coinbase),
    }));
    return { received_sats: received, tx_count: a.chain_stats.tx_count, payouts: incoming };
  }

  // ---------- the round ----------
  async ctxLoad() {
    if (this.kit) return;
    const [kit, fees, jup, transfer, token, wallet] = await Promise.all([import('pumpkit'), import('pumpkit/pumpfun/fees'), import('pumpkit/jupiter'), import('pumpkit/transfer'), import('pumpkit/token'), import('pumpkit/wallet')]);
    this.kit = { ...kit, ...fees, ...jup, ...transfer, ...token, ...wallet };
    this.ctx = this.kit.createContext({ rpcUrl: CFG.rpc, slippagePct: 1, log: { log, warn: log, error: log } });
  }
  async kitLoad() {
    await this.ctxLoad();
    if (this.walletKp) return;
    this.walletKp = this.kit.keypairFromSecret(CFG.secret);
    this.state.wallet = this.walletKp.publicKey.toBase58();
    this.save();
  }

  async round() {
    if (!this.writes) return;
    await this.kitLoad();
    this.state.lastRun = Date.now();
    log(`round · wallet ${this.state.wallet} · ${this.mrrMode ? 'chainflip → mrr' : 'jupiter → nicehash'}${CFG.dry ? ' · DRY' : ''}`);
    await this.claim();
    if (this.mrrMode) { await this.swapChainflip(); await this.trackSwaps().catch(e => log(`swaps: ${e.message}`)); await this.rentMrr(); }
    else { await this.swapUsdt(); await this.depositNicehash(); await this.orderNicehash(); }
    await this.poll().catch(() => {});
  }

  // 1. claim creator rewards (both programs, SOL quote)
  async claim() {
    const { kit, ctx, walletKp: w } = this;
    try {
      // fee-sharing coin: the shared vault is distributed to the shareholders first (we are the recipient)
      if (CFG.token_mint) {
        const cfg = await this.kit.readSharingConfig(ctx, CFG.token_mint).catch(() => null);
        if (cfg) {
          const waiting = await this.kit.sharedFeesWaiting(ctx, CFG.token_mint).catch(() => 0);
          if (waiting >= CFG.min_claim_sol) {
            if (CFG.dry) log(`would distribute ${waiting} SOL of shared fees`);
            else {
              const r = await this.kit.distributeSharedFees(ctx, { mint: CFG.token_mint, wallet: w });
              this.push('claims', { sig: r.sig, lamports: Math.round(r.gainedSol * SOL), shared: true });
              log(`distributed ${waiting} SOL of shared fees · got ${r.gainedSol} SOL · ${r.sig}`);
            }
          }
        }
      }
      const claimable = await kit.creatorVaultBalances(ctx, { creator: w.publicKey });
      if (claimable.sol < CFG.min_claim_sol) return;
      if (CFG.dry) return log(`would claim ${claimable.sol} SOL`);
      const r = await kit.claimCreatorFees(ctx, { wallet: w });
      if (r.sig) { this.push('claims', { sig: r.sig, lamports: Number(r.claimedRaw) }); log(`claimed ${Number(r.claimedRaw) / SOL} SOL · ${r.sig}`); }
    } catch (e) { this.fail('claim', e); }
  }

  // 2. SOL above the gas reserve → native BTC straight into the MRR deposit address (Chainflip)
  async swapChainflip() {
    const { kit, ctx, walletKp: w } = this;
    try {
      if (!this.state.mrrDeposit) { this.state.mrrDeposit = await this.mrr.depositAddress('BTC'); this.save(); log(`mrr BTC deposit address ${this.state.mrrDeposit}`); }
      if (this.state.swaps.some(s => s.channel && s.state === 'WAITING' && Date.now() - s.at < 30 * 60_000)) return log('a swap is still waiting for its deposit; skipping');
      const bal = await ctx.connection.getBalance(w.publicKey);
      const spend = bal - Math.round(CFG.keep_sol * SOL);
      const { minLamports, minSats } = await this.cf.limits();
      const floor = Math.max(minLamports, Math.round(CFG.cf_min_sol * SOL));
      if (spend < floor) return log(`${spend / SOL} SOL below the swap floor ${floor / SOL}; waiting`);
      const quote = await this.cf.quote(spend);
      const sats = Number(quote.egressAmount);
      if (sats < minSats) return log(`quote ${sats} sats below chainflip's ${minSats} sat minimum; waiting for more rewards`);
      if (CFG.dry) return log(`would swap ${spend / SOL} SOL → ${sats} sats via chainflip into ${this.state.mrrDeposit}`);
      const ch = await this.cf.channel({ quote, destAddress: this.state.mrrDeposit, refundAddress: this.state.wallet });
      const sig = await kit.sendSol(ctx, { wallet: w, to: ch.depositAddress, lamports: spend });
      this.push('swaps', { sig, lamports: spend, channel: ch.depositChannelId, deposit_address: ch.depositAddress, to: this.state.mrrDeposit, quoted_sats: sats, state: 'WAITING' });
      log(`swap ${spend / SOL} SOL → ~${sats} sats · channel ${ch.depositChannelId} · ${sig}`);
    } catch (e) { this.fail('swap', e); }
  }

  // 3. MRR BTC balance → the cheapest decent rig, pointed at our pool, for as long as the balance covers
  async rentMrr() {
    try {
      const { confirmed } = await this.mrr.balance('BTC');
      this.live.balance = { confirmed };
      if (confirmed < CFG.mrr_min_rent_btc) return log(`mrr balance ${confirmed.toFixed(8)} BTC < ${CFG.mrr_min_rent_btc}; waiting`);
      if (!this.state.profileId) {
        this.state.profileId = await this.mrr.ensureProfile({ name: `${CFG.pool_name} satmine`, algo: CFG.mrr_algo, host: CFG.pool_host, port: CFG.pool_port, user: `${CFG.btc_address}.${CFG.pool_worker}`, pass: 'x' });
        this.save(); log(`mrr pool profile ${this.state.profileId}`);
      }
      const budget = confirmed * 0.98;  // leave room for rounding
      // Keep the flow unbroken: while a rig is still running for us, buy more hours on it before renting a second one.
      const now = Date.now();
      const live = (this.live.rentals ?? []).filter(r => r.end && r.end > now && !r.ended).sort((a, b) => b.end - a.end)[0];
      if (live) {
        const rec = this.state.rentals.find(r => r.id === live.id);
        const perHour = rec?.paid_btc && rec?.hours ? rec.paid_btc / rec.hours : 0;
        const hours = perHour ? Math.floor((budget / perHour) * 100) / 100 : 0;
        if (hours >= 0.25) {
          if (CFG.dry) return log(`would extend rental ${live.id} by ${hours} h ≈ ${(hours * perHour).toFixed(8)} BTC (runs until ${new Date(live.end).toISOString()})`);
          try {
            const r = await this.mrr.extend(live.id, hours);
            this.push('rentals', { id: live.id, rig: live.rig, rig_name: rec?.rig_name ?? live.rig_name, nice: rec?.nice, price_ph_day: rec?.price_ph_day, rpi: rec?.rpi, url: rec?.url, hours, paid_btc: r.cost || hours * perHour, extended: true, end: live.end + hours * 3600_000, pool: `${CFG.pool_host}:${CFG.pool_port}` });
            return log(`extended rental ${live.id} by ${hours} h · ${r.cost || hours * perHour} BTC`);
          } catch (e) { log(`extend failed (${e.message}); renting a new rig instead`); }
        }
      }
      const [rigs, algo] = await Promise.all([MRR.rigs({ type: CFG.mrr_algo, hashMinTh: CFG.mrr_hash_min_th, rpiMin: CFG.mrr_rpi_min }), MRR.algo(CFG.mrr_algo)]);
      const cap = (algo?.lowest || Infinity) * CFG.mrr_max_price_x;
      const pick = rigs
        .filter(r => r.btc_hour > 0 && r.price_ph_day <= cap && r.btc_hour * r.minhours <= budget)
        .map(r => ({ ...r, hours: Math.min(CFG.mrr_max_hours, r.maxhours, Math.floor((budget / r.btc_hour) * 100) / 100) }))
        .filter(r => r.hours >= r.minhours)
        .sort((a, b) => a.price_ph_day - b.price_ph_day || b.rpi - a.rpi)[0];
      if (!pick) return log(`no rig fits ${confirmed.toFixed(8)} BTC (cap ${cap.toFixed(6)} BTC/PH/day)`);
      if (CFG.dry) return log(`would rent rig ${pick.id} (${pick.nice}, ${pick.price_ph_day.toFixed(6)} BTC/PH/day, rpi ${pick.rpi}) for ${pick.hours} h ≈ ${(pick.btc_hour * pick.hours).toFixed(8)} BTC`);
      const rental = await this.mrr.rent({ rig: pick.id, hours: pick.hours, profile: this.state.profileId });
      this.push('rentals', { ...rental, rig_name: rental.rig_name ?? pick.name, nice: pick.nice, price_ph_day: pick.price_ph_day, rpi: pick.rpi, url: pick.url, pool: `${CFG.pool_host}:${CFG.pool_port}` });
      log(`rented rig ${pick.id} (${pick.nice}) for ${pick.hours} h · ${rental.paid_btc} BTC · rental ${rental.id}`);
    } catch (e) { this.fail('rent', e); }
  }

  // ---------- legacy NiceHash path (HASH_PROVIDER=nicehash) ----------
  async swapUsdt() {
    const { kit, ctx, walletKp: w } = this;
    try {
      const bal = await ctx.connection.getBalance(w.publicKey);
      const spend = bal - Math.round(CFG.keep_sol * SOL);
      if (spend <= 0.005 * SOL) return;
      if (CFG.dry) return log(`would swap ${spend / SOL} SOL → USDT`);
      const r = await kit.swapSolFor(ctx, { wallet: w, mint: USDT_MINT, lamports: BigInt(spend), slippageBps: 100 });
      this.push('swaps', { sig: r.sig, lamports: spend, usdt: Number(r.outAmount) / 10 ** USDT_DEC, state: 'COMPLETED' });
      log(`swapped ${spend / SOL} SOL → ${Number(r.outAmount) / 1e6} USDT · ${r.sig}`);
    } catch (e) { this.fail('swap', e); }
  }
  async depositNicehash() {
    const { kit, ctx, walletKp: w } = this;
    try {
      if (!this.state.nhDeposit) { this.state.nhDeposit = (await this.nh.depositAddress('USDT', 'SOL')).address; this.save(); }
      const raw = await kit.tokenBalanceRaw(ctx, { owner: w.publicKey, mint: USDT_MINT });
      const usdt = Number(raw) / 10 ** USDT_DEC;
      if (usdt < CFG.min_deposit_usdt) return;
      if (this.state.lastDeposit && Date.now() - this.state.lastDeposit < CFG.deposit_every_ms) return;
      if (CFG.dry) return log(`would deposit ${usdt} USDT to ${this.state.nhDeposit}`);
      const r = await kit.transferTokens(ctx, { wallet: w, mint: USDT_MINT, to: this.state.nhDeposit, amountRaw: raw, decimals: USDT_DEC });
      this.state.lastDeposit = Date.now(); this.push('deposits', { sig: r.sig, usdt, to: this.state.nhDeposit }); log(`deposited ${usdt} USDT to NiceHash · ${r.sig}`);
    } catch (e) { this.fail('deposit', e); }
  }
  async orderNicehash() {
    try {
      const { available } = await this.nh.balance(CFG.market);
      this.live.balance = { confirmed: available };
      let order = this.state.orderId ? await this.nh.order(this.state.orderId).catch(() => null) : null;
      if (order && !order.alive && !['PENDING', 'ACTIVE'].includes(order.status?.code)) { order = null; this.state.orderId = null; }
      const [algo, market] = await Promise.all([NiceHash.algorithm(CFG.algorithm, CFG.nh_host), NiceHash.marketPrice(CFG.algorithm, CFG.market, CFG.nh_host)]);
      if (!order && available >= CFG.order_min_usdt) {
        const price = +(Math.max(market.price ?? 0, market.lowest ?? 0) * CFG.price_margin).toFixed(4);
        if (!price) throw new Error('no market price for the order');
        if (!this.state.poolId) {
          const pool = await this.nh.ensurePool({ name: `${CFG.pool_name} ${CFG.btc_address.slice(0, 8)}`, algorithm: CFG.algorithm, stratumHostname: CFG.pool_host, stratumPort: CFG.pool_port, username: `${CFG.btc_address}.${CFG.pool_worker}`, password: 'x' });
          this.state.poolId = pool.id; this.save();
        }
        const amount = Math.floor(available * 100) / 100;
        if (CFG.dry) return log(`would create order · ${amount} USDT · price ${price} · limit ${CFG.limit} EH/s`);
        const o = await this.nh.createOrder({ algorithm: CFG.algorithm, market: CFG.market, poolId: this.state.poolId, amount, price, limit: CFG.limit, algo });
        this.state.orderId = o.id;
        this.push('orders', { id: o.id, usdt: amount, price, limit_eh: CFG.limit, pool: `${CFG.pool_host}:${CFG.pool_port}` });
      } else if (order && available >= CFG.refill_min_usdt) {
        const amount = Math.floor(available * 100) / 100;
        if (CFG.dry) return log(`would refill ${order.id} with ${amount} USDT`);
        await this.nh.refill(order.id, amount); this.push('refills', { id: order.id, usdt: amount });
      } else if (!order) log(`waiting: ${available.toFixed(2)} / ${CFG.order_min_usdt} USDT for the first order`);
    } catch (e) { this.fail('hashpower', e); }
  }
}
