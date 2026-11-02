// NiceHash REST client: request signing (HMAC-SHA256 over NUL-joined fields,
// as in nicehash/rest-clients-demo) plus the few calls the engine needs.
//
//   const nh = new NiceHash({ key, secret, orgId, host });
//   await nh.depositAddress('USDT', 'SOL')     → { address, network }
//   await nh.balance('USDT')                   → { available, pending, total }
//   await nh.ensurePool({...})                 → { id }
//   await nh.createOrder({...}) / nh.refill(id, amount) / nh.order(id)
import { createHmac, randomBytes } from 'node:crypto';

export const HOSTS = { prod: 'https://api2.nicehash.com', test: 'https://api-test.nicehash.com' };

export class NiceHash {
  constructor({ key, secret, orgId, host = HOSTS.prod, log = console }) {
    this.key = key; this.secret = secret; this.orgId = orgId; this.host = host.replace(/\/$/, '');
    this.log = log;
    this.timeDiff = null;
  }

  get configured() { return !!(this.key && this.secret && this.orgId); }

  async syncTime() {
    const r = await fetch(`${this.host}/api/v2/time`);
    const { serverTime } = await r.json();
    this.timeDiff = serverTime - Date.now();
  }

  // Signed request. `query` is an object; `body` an object or undefined.
  async call(method, path, { query, body } = {}) {
    if (this.timeDiff == null) await this.syncTime();
    const time = String(Date.now() + this.timeDiff);
    const nonce = randomBytes(18).toString('hex').slice(0, 32);
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)).toString() : '';
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const parts = [this.key, time, nonce, '', this.orgId, '', method.toUpperCase(), path, qs];
    if (raw !== undefined) parts.push(raw);
    const digest = createHmac('sha256', this.secret).update(parts.join('\0')).digest('hex');
    const headers = {
      'X-Time': time, 'X-Nonce': nonce, 'X-Request-Id': nonce, 'X-User-Agent': 'satmine', 'X-User-Lang': 'en',
      'X-Organization-Id': this.orgId, 'X-Auth': `${this.key}:${digest}`,
    };
    if (raw !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${this.host}${path}${qs ? `?${qs}` : ''}`, { method, headers, body: raw, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = data?.errors?.map(e => e.message).join('; ') || data?.error_id || text.slice(0, 200);
      const err = new Error(`nicehash ${method} ${path} → ${res.status}: ${msg}`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  // ---------- public ----------
  static async buyInfo(algoName = 'SHA256AsicBoost_USDT', host = HOSTS.prod) {
    const r = await fetch(`${host}/main/api/v2/public/buy/info`);
    const { miningAlgorithms } = await r.json();
    return miningAlgorithms.find(a => a.name.toLowerCase() === algoName.toLowerCase());
  }
  static async algorithm(name = 'SHA256ASICBOOST_USDT', host = HOSTS.prod) {
    const r = await fetch(`${host}/main/api/v2/mining/algorithms`);
    const { miningAlgorithms } = await r.json();
    return miningAlgorithms.find(a => a.algorithm === name);
  }
  // Current market: lowest price that is actually getting hashrate, among alive STANDARD/FIXED orders.
  static async marketPrice(algorithm = 'SHA256ASICBOOST_USDT', market = 'USDT', host = HOSTS.prod) {
    const r = await fetch(`${host}/main/api/v2/hashpower/orderBook?algorithm=${algorithm}&page=0&size=100`);
    const { stats } = await r.json();
    // The public book is quoted in BTC/EH/day; the USDT market has no public book,
    // so its price is the BTC one converted at the current BTC/USD rate.
    const book = stats?.[market] ?? stats?.BTC ?? Object.values(stats ?? {})[0];
    const quoted = book?.orders?.[0]?.currencyMarket ?? 'BTC';
    let fx = 1;
    if (market === 'USDT' && quoted === 'BTC') {
      const px = await fetch('https://mempool.space/api/v1/prices', { signal: AbortSignal.timeout(10_000) }).then(x => x.json());
      fx = Number(px.USD);
    }
    const paying = (book?.orders ?? []).filter(o => o.alive && Number(o.acceptedSpeed) > 0).map(o => Number(o.price) * fx).sort((a, b) => a - b);
    const round = v => (v == null ? null : +v.toFixed(4));
    return { price: round(paying.length ? paying[Math.floor(paying.length * 0.25)] : null), lowest: round(paying[0] ?? null), orders: paying.length, totalSpeed: Number(book?.totalSpeed ?? 0), unit: book?.displayPriceFactor, quoted, fx, currency: market };
  }

  // ---------- account ----------
  async depositAddress(currency = 'USDT', network = 'SOL') {
    const d = await this.call('GET', '/main/api/v2/accounting/depositAddresses', { query: { currency, walletType: 'FIREBLOCKS_AG', network } });
    const a = d.list?.find(x => !network || x.network === network) ?? d.list?.[0];
    if (!a) throw new Error(`no ${currency}/${network} deposit address`);
    return { address: a.address, network: a.network, type: a.type?.code };
  }
  async balance(currency = 'USDT') {
    const d = await this.call('GET', `/main/api/v2/accounting/account2/${currency}`);
    return { available: Number(d.available), pending: Number(d.pending), total: Number(d.totalBalance), status: d.status };
  }
  async deposits(currency = 'USDT', size = 20) {
    const d = await this.call('GET', `/main/api/v2/accounting/deposits/${currency}`, { query: { size } });
    return d.list ?? [];
  }

  // ---------- pools ----------
  async pools() { return (await this.call('GET', '/main/api/v2/pools', { query: { size: 100 } })).list ?? []; }
  async ensurePool({ name, algorithm, stratumHostname, stratumPort, username, password = 'x' }) {
    const same = (await this.pools()).find(p => p.algorithm === algorithm && p.stratumHostname === stratumHostname && Number(p.stratumPort) === Number(stratumPort) && p.username === username);
    if (same) return same;
    return this.call('POST', '/main/api/v2/pool', { body: { name, algorithm, stratumHostname, stratumPort: Number(stratumPort), username, password } });
  }

  // ---------- orders ----------
  async myOrders({ algorithm, status } = {}) {
    const d = await this.call('GET', '/main/api/v2/hashpower/myOrders', { query: { algorithm, status, limit: 50, op: 'LT', ts: Date.now() + 60_000 } });
    return d.list ?? [];
  }
  async order(id) { return this.call('GET', `/main/api/v2/hashpower/order/${id}`); }
  async createOrder({ algorithm, market = 'USDT', poolId, amount, price, limit, algo }) {
    const body = {
      algorithm, market, currencyMarket: market, type: 'STANDARD', poolId,
      amount: String(amount), price: String(price), limit: String(limit),
      displayMarketFactor: algo.displayMarketFactor, marketFactor: algo.marketFactor,
      displayPriceFactor: algo.displayPriceFactor, priceFactor: algo.priceFactor,
    };
    return this.call('POST', '/main/api/v2/hashpower/order', { body });
  }
  async refill(id, amount) { return this.call('POST', `/main/api/v2/hashpower/order/${id}/refill`, { body: { amount: String(amount) } }); }
  async updatePriceAndLimit(id, { price, limit, algo }) {
    return this.call('POST', `/main/api/v2/hashpower/order/${id}/updatePriceAndLimit`, { body: { price: String(price), limit: String(limit), displayMarketFactor: algo.displayMarketFactor, marketFactor: algo.marketFactor } });
  }
  async cancel(id) { return this.call('DELETE', `/main/api/v2/hashpower/order/${id}`); }
}
