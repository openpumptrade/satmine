// MiningRigRentals REST client (API v2): HMAC-SHA1 of key+nonce+endpoint,
// plus the calls the engine needs: deposit address, balance, a sha256 pool
// profile pointed at our pool, rig search and rentals.
import { createHmac } from 'node:crypto';

export const BASE = 'https://www.miningrigrentals.com/api/v2';

export class MRR {
  constructor({ key, secret, log = console }) {
    this.key = key; this.secret = secret; this.log = log;
    this.nonce = Date.now() * 1000;
  }
  get configured() { return !!(this.key && this.secret); }

  async call(method, endpoint, { query, body } = {}) {
    const nonce = String(++this.nonce);
    const sign = createHmac('sha1', this.secret).update(this.key + nonce + endpoint).digest('hex');
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString() : '';
    const res = await fetch(`${BASE}${endpoint}${qs}`, {
      method, headers: { 'x-api-key': this.key, 'x-api-sign': sign, 'x-api-nonce': nonce, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let d; try { d = JSON.parse(text); } catch { d = { success: false, data: { message: text.slice(0, 200) } }; }
    if (!res.ok || d.success === false) {
      const err = new Error(`mrr ${method} ${endpoint} → ${res.status}: ${d?.data?.message ?? text.slice(0, 200)}`);
      err.status = res.status; err.data = d; throw err;
    }
    return d.data;
  }

  // ---------- public ----------
  static async algo(name = 'sha256') {
    const r = await fetch(`${BASE}/info/algos/${name}`, { signal: AbortSignal.timeout(10_000) });
    const { data } = await r.json();
    return { unit: data.suggested_price?.unit, suggested: Number(data.suggested_price?.amount), lowest: Number(data.stats?.prices?.lowest?.amount), last10: Number(data.stats?.prices?.last_10?.amount), available_rigs: Number(data.stats?.available?.rigs), available_hash: data.stats?.available?.hash?.nice, rented_rigs: Number(data.stats?.rented?.rigs) };
  }
  // Cheapest online rigs for `type`. `hashMinTh` filters tiny rigs; prices come back normalised to BTC per PH per day.
  static async rigs({ type = 'sha256', hashMinTh = 10, count = 50, rpiMin = 80 } = {}) {
    const q = new URLSearchParams({ type, count, orderby: 'price', orderdir: 'asc', 'hash.min': hashMinTh, 'hash.type': 'th', 'rpi.min': rpiMin, currency: 'BTC' });
    const r = await fetch(`${BASE}/rig?${q}`, { signal: AbortSignal.timeout(15_000) });
    const { data } = await r.json();
    return (data?.records ?? []).filter(x => x.online && x.status?.status === 'available' && x.price?.BTC?.enabled).map(MRR.rig);
  }
  static rig(x) {
    const unit = { hash: 1e-15, kh: 1e-12, mh: 1e-9, gh: 1e-6, th: 1e-3, ph: 1, eh: 1e3 };
    const ph = Number(x.hashrate?.advertised?.hash ?? 0) * (unit[x.hashrate?.advertised?.type] ?? 1);
    const p = x.price?.BTC ?? {};
    return {
      id: Number(x.id), name: x.name, region: x.region, rpi: Number(x.rpi), ph, nice: x.hashrate?.advertised?.nice,
      price_ph_day: Number(p.price) * (x.price?.type === 'th' ? 1000 : x.price?.type === 'eh' ? 0.001 : 1),
      btc_hour: Number(p.hour), minhours: Number(p.min_rental_length || x.minhours), maxhours: Number(x.maxhours),
      online: !!x.online, available: x.status?.status === 'available', url: x.shorturl,
    };
  }

  // ---------- account ----------
  async whoami() { return this.call('GET', '/whoami'); }
  async account() { return this.call('GET', '/account'); }
  async depositAddress(currency = 'BTC') {
    const a = await this.account();
    const addr = a?.deposit?.[currency]?.address;
    if (!addr) throw new Error(`no ${currency} deposit address on the MRR account`);
    return addr;
  }
  async balance(currency = 'BTC') {
    const b = await this.call('GET', '/account/balance');
    const c = b?.[currency] ?? {};
    return { confirmed: Number(c.confirmed ?? 0), unconfirmed: Number(c.unconfirmed ?? 0) };
  }
  async transactions({ type, limit = 50 } = {}) { return (await this.call('GET', '/account/transactions', { query: { type, limit } }))?.transactions ?? []; }

  // ---------- pool profile ----------
  // A profile (algo + saved pool) is what a rental mines against. Idempotent.
  async ensureProfile({ name, algo, host, port, user, pass = 'x' }) {
    const profiles = await this.call('GET', '/account/profile', { query: { algo } });
    const found = (profiles ?? []).find(p => p.name === name && (p.pools ?? []).some(x => x.host === host && Number(x.port) === Number(port) && x.user === user));
    if (found) return Number(found.id);
    const pools = await this.call('GET', '/account/pool');
    let pool = (pools ?? []).find(x => x.type === algo && x.host === host && Number(x.port) === Number(port) && x.user === user);
    if (!pool) pool = await this.call('PUT', '/account/pool', { body: { type: algo, name, host, port: Number(port), user, pass } });
    const prof = await this.call('PUT', '/account/profile', { body: { name, algo } });
    const pid = Number(prof.pid ?? prof.id);
    await this.call('PUT', `/account/profile/${pid}`, { body: { priority: 0, poolid: Number(pool.id) } });
    return pid;
  }

  // ---------- rentals ----------
  async rent({ rig, hours, profile, currency = 'BTC' }) {
    const r = await this.call('PUT', '/rental', { body: { rig: Number(rig), length: Number(hours), profile: Number(profile), currency } });
    return MRR.rental(Array.isArray(r) ? r[0] : r);
  }
  async rental(id) { const r = await this.call('GET', `/rental/${id}`); return MRR.rental(Array.isArray(r) ? r[0] : r); }
  async rentals({ limit = 20 } = {}) { const r = await this.call('GET', '/rental', { query: { limit, type: 'renter' } }); return (r?.rentals ?? (Array.isArray(r) ? r : [])).map(MRR.rental); }
  static rental(x = {}) {
    const t = v => (v ? Date.parse(String(v).replace(' UTC', 'Z').replace(' ', 'T')) || null : null);
    const h = x.hashrate ?? x.rig?.hashrate ?? {};
    return {
      id: Number(x.id), rig: Number(x.rig?.id ?? x.rig), rig_name: x.rig?.name ?? null, hours: Number(x.length), extended: Number(x.extended ?? 0),
      paid_btc: Number(x.price?.paid ?? 0), advertised_btc: Number(x.price?.advertised ?? 0), currency: x.price?.currency ?? 'BTC',
      start: t(x.start), end: t(x.end), ended: !!x.ended, refunded: !!x.refunded,
      hash_advertised: h.advertised?.nice ?? null, hash_average: h.average?.nice ?? h.last_30min?.nice ?? null,
    };
  }
}
