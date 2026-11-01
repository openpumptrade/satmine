// The Bitcoin engine: pump.fun creator rewards → USDT → NiceHash → SHA-256
// hashpower pointed at a pool that pays a public BTC address.
//
// Every hop leaves a receipt somebody else can check:
//   1. claim      Solana tx (creator vault → engine wallet)            solscan
//   2. swap       Solana tx (SOL → USDT on Jupiter)                     solscan
//   3. deposit    Solana tx (USDT → NiceHash deposit address)           solscan
//   4. hashpower  NiceHash order id, accepted speed, spent              nicehash (order id + API stats)
//   5. mining     pool stats for the BTC address, payouts to it         ocean.xyz + mempool.space
//
// Runs on a timer inside server.js. Without PRIVATE_KEY + NiceHash keys it
// only reads the public side (pool + mempool) so the page still works.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NiceHash, HOSTS } from './nicehash.js';

const env = (k, d) => (process.env[k] ?? d);
const SOL = 1e9;
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNUS';
const USDT_DEC = 6;

export const CFG = {
  enabled: env('BTC_ENGINE', '0') === '1',
  dry: env('BTC_DRY', '0') === '1',
  every_ms: Number(env('BTC_EVERY_MS', 600_000)),
  // Solana side
  rpc: env('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  secret: env('PRIVATE_KEY', ''),
  keep_sol: Number(env('BTC_KEEP_SOL', 0.02)),           // gas reserve left in the engine wallet
  min_claim_sol: Number(env('BTC_MIN_CLAIM_SOL', 0.01)),
  min_deposit_usdt: Number(env('BTC_MIN_DEPOSIT_USDT', 10)),  // NiceHash charges 0.5 USDT under 10
  // NiceHash side
  nh_key: env('NH_API_KEY', ''), nh_secret: env('NH_API_SECRET', ''), nh_org: env('NH_ORG_ID', ''),
  nh_host: env('NH_HOST', '') || (env('NH_TEST', '0') === '1' ? HOSTS.test : HOSTS.prod),
  algorithm: env('NH_ALGORITHM', 'SHA256ASICBOOST_USDT'),
  market: 'USDT',
  limit: Number(env('NH_LIMIT_EH', 0.001)),                // EH/s; 0.001 EH = 1 PH/s
  price_margin: Number(env('NH_PRICE_MARGIN', 1.03)),      // pay 3% over the lowest paying price so rigs pick us
  order_min_usdt: Number(env('NH_ORDER_MIN_USDT', 300)),   // NiceHash minimum for a new USDT order
  refill_min_usdt: Number(env('NH_REFILL_MIN_USDT', 20)),
  // Pool + payout
  btc_address: env('BTC_ADDRESS', ''),
  pool_host: env('POOL_HOST', 'mine.ocean.xyz'),
  pool_port: Number(env('POOL_PORT', 3334)),
  pool_worker: env('POOL_WORKER', 'goldvein'),
  pool_name: env('POOL_NAME', 'OCEAN'),
  data_file: env('BTC_DATA_FILE', new URL('../data/btc.json', import.meta.url).pathname),
};

const log = (...a) => console.log(new Date().toISOString(), '[btc]', ...a);

export class BtcEngine {
  constructor() {
    this.state = { claims: [], swaps: [], deposits: [], orders: [], refills: [], errors: [], wallet: null, nhDeposit: null, poolId: null, orderId: null, lastRun: null };
    this.live = { order: null, pool: null, chain: null, market: null, nhBalance: null, at: 0 };
    this.nh = new NiceHash({ key: CFG.nh_key, secret: CFG.nh_secret, orgId: CFG.nh_org, host: CFG.nh_host });
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

  get writes() { return CFG.enabled && !!CFG.secret && this.nh.configured && !!CFG.btc_address; }

  // What the page shows.
  view() {
    const sum = (l, k) => this.state[l].reduce((a, x) => a + (x[k] ?? 0), 0);
    return {
      config: {
        enabled: CFG.enabled, dry: CFG.dry, writes: this.writes, every_ms: CFG.every_ms,
        wallet: this.state.wallet, nh_deposit: this.state.nhDeposit, btc_address: CFG.btc_address || null,
        pool: `${CFG.pool_host}:${CFG.pool_port}`, pool_name: CFG.pool_name, algorithm: CFG.algorithm, limit_eh: CFG.limit,
        order_min_usdt: CFG.order_min_usdt, order_id: this.state.orderId, nh_host: CFG.nh_host, usdt_mint: USDT_MINT,
      },
      totals: { claimed_lamports: sum('claims', 'lamports'), swapped_usdt: sum('swaps', 'usdt'), deposited_usdt: sum('deposits', 'usdt'), ordered_usdt: sum('orders', 'usdt') + sum('refills', 'usdt') },
      live: this.live,
      ledger: { claims: this.state.claims.slice(0, 50), swaps: this.state.swaps.slice(0, 50), deposits: this.state.deposits.slice(0, 50), orders: this.state.orders.slice(0, 20), refills: this.state.refills.slice(0, 50), errors: this.state.errors.slice(0, 10) },
      last_run: this.state.lastRun,
    };
  }

  start() {
    this.poll().catch(e => log(`poll: ${e.message}`));
    setInterval(() => this.poll().catch(e => log(`poll: ${e.message}`)), 60_000);
    if (!CFG.enabled) { log('engine off (BTC_ENGINE=0) · public stats only'); return; }
    if (!this.writes) log(`engine on but not armed: needs PRIVATE_KEY, NH_API_KEY/SECRET/ORG_ID, BTC_ADDRESS${CFG.dry ? ' (dry run)' : ''}`);
    const tick = () => this.round().catch(e => this.fail('round', e));
    setTimeout(tick, 5000);
    setInterval(tick, CFG.every_ms);
  }

  // ---------- public reads: pool, chain, market ----------
  async poll() {
    const [pool, chain, market, order, nhBalance] = await Promise.all([
      this.poolStats().catch(() => null),
      this.chainStats().catch(() => null),
      NiceHash.marketPrice(CFG.algorithm, CFG.market, CFG.nh_host).catch(() => null),
      this.state.orderId && this.nh.configured ? this.nh.order(this.state.orderId).then(o => ({ id: o.id, status: o.status?.code, alive: o.alive, price: Number(o.price), limit: Number(o.limit), amount: Number(o.amount), available: Number(o.availableAmount), spent: Number(o.payedAmount), speed_eh: Number(o.acceptedCurrentSpeed ?? 0), rigs: o.rigsCount, end: o.endTs })).catch(() => this.live.order) : null,
      this.nh.configured ? this.nh.balance(CFG.market).catch(() => this.live.nhBalance) : null,
    ]);
    this.live = { pool, chain, market, order, nhBalance, at: Date.now() };
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
  async kitLoad() {
    if (this.kit) return;
    const [kit, fees, jup, transfer, token, wallet] = await Promise.all([import('pumpkit'), import('pumpkit/pumpfun/fees'), import('pumpkit/jupiter'), import('pumpkit/transfer'), import('pumpkit/token'), import('pumpkit/wallet')]);
    this.kit = { ...kit, ...fees, ...jup, ...transfer, ...token, ...wallet };
    this.ctx = this.kit.createContext({ rpcUrl: CFG.rpc, slippagePct: 1, log: { log, warn: log, error: log } });
    this.walletKp = this.kit.keypairFromSecret(CFG.secret);
    this.state.wallet = this.walletKp.publicKey.toBase58();
    this.save();
  }

  async round() {
    if (!this.writes) return;
    await this.kitLoad();
    const { kit, ctx, walletKp: w } = this;
    const me = w.publicKey;
    this.state.lastRun = Date.now();
    log(`round · wallet ${this.state.wallet}${CFG.dry ? ' · DRY' : ''}`);

    // 1. claim creator rewards (both programs, SOL quote)
    try {
      const claimable = await kit.creatorVaultBalances(ctx, { creator: me });
      if (claimable.sol >= CFG.min_claim_sol) {
        if (CFG.dry) log(`would claim ${claimable.sol} SOL`);
        else {
          const r = await kit.claimCreatorFees(ctx, { wallet: w });
          if (r.sig) { this.push('claims', { sig: r.sig, lamports: Number(r.claimedRaw) }); log(`claimed ${Number(r.claimedRaw) / SOL} SOL · ${r.sig}`); }
        }
      }
    } catch (e) { this.fail('claim', e); }

    // 2. swap everything above the gas reserve to USDT
    try {
      const bal = await ctx.connection.getBalance(me);
      const spend = bal - Math.round(CFG.keep_sol * SOL);
      if (spend > 0.005 * SOL) {
        if (CFG.dry) log(`would swap ${spend / SOL} SOL → USDT`);
        else {
          const r = await kit.swapSolFor(ctx, { wallet: w, mint: USDT_MINT, lamports: BigInt(spend), slippageBps: 100 });
          this.push('swaps', { sig: r.sig, lamports: spend, usdt: Number(r.outAmount) / 10 ** USDT_DEC });
          log(`swapped ${spend / SOL} SOL → ${Number(r.outAmount) / 1e6} USDT · ${r.sig}`);
        }
      }
    } catch (e) { this.fail('swap', e); }

    // 3. send the USDT to NiceHash (Solana network deposit)
    try {
      if (!this.state.nhDeposit) { this.state.nhDeposit = (await this.nh.depositAddress('USDT', 'SOL')).address; this.save(); log(`nicehash USDT deposit address ${this.state.nhDeposit}`); }
      const raw = await kit.tokenBalanceRaw(ctx, { owner: me, mint: USDT_MINT });
      const usdt = Number(raw) / 10 ** USDT_DEC;
      if (usdt >= CFG.min_deposit_usdt) {
        if (CFG.dry) log(`would deposit ${usdt} USDT to ${this.state.nhDeposit}`);
        else {
          const r = await kit.transferTokens(ctx, { wallet: w, mint: USDT_MINT, to: this.state.nhDeposit, amountRaw: raw, decimals: USDT_DEC });
          this.push('deposits', { sig: r.sig, usdt, to: this.state.nhDeposit });
          log(`deposited ${usdt} USDT · ${r.sig}`);
        }
      }
    } catch (e) { this.fail('deposit', e); }

    // 4. turn the NiceHash balance into hashpower: a new order, or a refill of the live one
    try {
      const { available } = await this.nh.balance(CFG.market);
      this.live.nhBalance = await this.nh.balance(CFG.market);
      let order = this.state.orderId ? await this.nh.order(this.state.orderId).catch(() => null) : null;
      if (order && !order.alive && !['PENDING', 'ACTIVE'].includes(order.status?.code)) { log(`order ${order.id} is ${order.status?.code}; a new one will be placed`); order = null; this.state.orderId = null; }
      const [algo, market] = await Promise.all([NiceHash.algorithm(CFG.algorithm, CFG.nh_host), NiceHash.marketPrice(CFG.algorithm, CFG.market, CFG.nh_host)]);
      if (!order && available >= CFG.order_min_usdt) {
        const price = +(Math.max(market.price ?? 0, market.lowest ?? 0) * CFG.price_margin).toFixed(4);
        if (!price) throw new Error('no market price for the order');
        if (!this.state.poolId) {
          const pool = await this.nh.ensurePool({ name: `${CFG.pool_name} ${CFG.btc_address.slice(0, 8)}`, algorithm: CFG.algorithm, stratumHostname: CFG.pool_host, stratumPort: CFG.pool_port, username: `${CFG.btc_address}.${CFG.pool_worker}`, password: 'x' });
          this.state.poolId = pool.id; this.save();
        }
        const amount = Math.floor(available * 100) / 100;
        if (CFG.dry) log(`would create order · ${amount} USDT · price ${price} · limit ${CFG.limit} EH/s`);
        else {
          const o = await this.nh.createOrder({ algorithm: CFG.algorithm, market: CFG.market, poolId: this.state.poolId, amount, price, limit: CFG.limit, algo });
          this.state.orderId = o.id;
          this.push('orders', { id: o.id, usdt: amount, price, limit_eh: CFG.limit, pool: `${CFG.pool_host}:${CFG.pool_port}` });
          log(`order ${o.id} · ${amount} USDT at ${price} USDT/EH/day`);
        }
      } else if (order && available >= CFG.refill_min_usdt) {
        const amount = Math.floor(available * 100) / 100;
        if (CFG.dry) log(`would refill ${order.id} with ${amount} USDT`);
        else { await this.nh.refill(order.id, amount); this.push('refills', { id: order.id, usdt: amount }); log(`refilled ${order.id} · ${amount} USDT`); }
      } else if (!order) {
        log(`waiting: ${available.toFixed(2)} / ${CFG.order_min_usdt} USDT for the first order`);
      }
    } catch (e) { this.fail('hashpower', e); }

    await this.poll().catch(() => {});
  }
}
