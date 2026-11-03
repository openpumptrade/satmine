// UI: routing, controls, live pool stream, wallet polling, and the 3D field.
import { deviceLabel, runBench } from './bench.js';
import { barChart, lineChart } from './charts.js';
import { API } from './config.js';
import { MineScene } from './pit.js';
import { floatUp, pulse, ripples, roll, scramble, toast } from './fx.js';
import { Miner, short } from './miner.js';

const $ = id => document.getElementById(id);
const miner = new Miner();
const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PAGES = ['/', '/mine', '/stats', '/leaderboard', '/rounds', '/ledger', '/benchmark', '/bitcoin', '/rules'];

let pool = null;       // latest /api/state
let you = null;        // latest /api/wallet/:addr
let board = 'round';
let shownHash = null;
let seen = { accepted: 0, rejected: 0 };
let lastStatus = 'idle';
let earned = null;     // balance + pending + paid at the last poll, to spot new earnings
const R = (id, v) => roll($(id), v);

ripples('.go, .icon-btn, .tabs button');

const scene = new MineScene($('pit'));

// ---------- formatting ----------
const sol = lamports => (lamports / 1e9).toLocaleString(undefined, { maximumFractionDigits: 6 });
function rate(hps) {
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s'];
  let i = 0;
  while (hps >= 1000 && i < units.length - 1) { hps /= 1000; i++; }
  return [hps.toFixed(hps < 10 ? 2 : hps < 100 ? 1 : 0), units[i]];
}
const work = n => (Number(n) === 0 ? '0' : `2^${Math.log2(Number(n)).toFixed(1)}`);
const time = t => new Date(t).toLocaleTimeString([], { hour12: false });
const pct = x => `${(x * 100).toFixed(x < 0.1 ? 2 : 1)}%`;
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
function store(key, value) { try { localStorage.setItem(key, value); } catch {} }
function load(key) { try { return localStorage.getItem(key); } catch { return null; } }
function setText(id, v) { const el = $(id); if (el && el.textContent !== String(v)) el.textContent = v; }

// Segmented progress bar, lit up to `fraction`; the leading segment pulses.
function segments(el, fraction, n = 24) {
  if (el.children.length !== n) el.innerHTML = '<span></span>'.repeat(n);
  const f = Math.max(0, Math.min(1, fraction));
  const at = Math.min(n - 1, Math.floor(f * n));
  [...el.children].forEach((s, i) => { s.className = i < at ? 'on' : i === at && f > 0 ? 'at' : ''; });
}

// ---------- routing ----------
// On the mine view the field is the stage; on other pages it sits blurred behind them.
function route() {
  const roundId = location.pathname.match(/^\/rounds\/(\d+)$/)?.[1];
  const path = roundId ? '/rounds' : PAGES.includes(location.pathname) ? location.pathname : '/';
  const stage = path === '/' || path === '/mine';   // the pit is the stage on both
  document.querySelector('[data-view="/"]').hidden = path !== '/';
  document.querySelector('[data-view="/mine"]').hidden = path !== '/mine';
  document.querySelector('[data-view="page"]').hidden = stage;
  document.body.classList.toggle('backdrop', !stage);
  scene.setBackdrop(!stage);
  for (const a of document.querySelectorAll('.rail nav a')) a.classList.toggle('on', a.getAttribute('href') === path);
  if (!stage) {
    for (const s of document.querySelectorAll('[data-page]')) s.hidden = s.dataset.page !== path;
    renderPool();
  }
  if (path === '/') loadHome();
  if (path === '/stats') loadStats();
  if (path === '/rounds') roundId ? loadRound(Number(roundId)) : loadRounds();
  if (path === '/benchmark') loadBench();
  if (path === '/bitcoin') loadBtc();
  closeSettings();
  enter(document.querySelector(path === '/' ? '[data-view="/"]' : path === '/mine' ? '[data-view="/mine"]' : '[data-view="page"]'));
}

// Staggered entrance for the visible view, and hex-scramble its static labels.
function enter(view) {
  pulse(view, 'enter');
  for (const el of view.querySelectorAll('.card-head .label, .sheet article:not([hidden]) h1')) {
    if (el.closest('[hidden]')) continue;
    scramble(el, el.dataset.text ?? el.textContent, el.tagName === 'H1' ? 700 : 480);
  }
}
function go(path) {
  history.pushState(null, '', path);
  route();
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-nav]');
  if (!e.target.closest('.control')) closeSettings();
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
addEventListener('popstate', route);
const getJson = async path => (await fetch(API + path)).json();
const ago = t => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const dur = ms => `${Math.floor(ms / 60000)}m ${String(Math.round(ms / 1000) % 60).padStart(2, '0')}s`;
const hhmm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

// ---------- stats ----------
let statsTimer = null;
async function loadStats() {
  clearTimeout(statsTimer);
  if (location.pathname !== '/stats') return;
  let st;
  try { st = await getJson('/api/stats'); } catch { return; }
  R('stPaid', sol(st.totals.paid));
  R('stRounds', st.totals.rounds);
  R('stWallets', st.totals.wallets);
  setText('stWork', work(st.totals.work));
  const rateFmt = v => rate(v).join(' ');
  const shortRate = v => { const [n, u] = rate(v); return `${+Number(n).toFixed(1)}${u[0] === 'H' ? '' : u[0]}`; };
  lineChart($('chHash'), st.samples.map(p => ({ x: p.at, y: p.hashrate })), { fmt: rateFmt, axis: shortRate, xfmt: hhmm, label: 'pool hashrate' });
  lineChart($('chMiners'), st.samples.map(p => ({ x: p.at, y: p.miners })), { fmt: v => String(Math.round(v)), xfmt: hhmm, label: 'active miners', integer: true });
  barChart($('chPot'), st.rounds.map(r => ({ label: `#${r.id}`, value: r.reward / 1e9, sub: `${r.miners} miners` })), { fmt: v => `${+v.toFixed(4)}`, label: 'SOL', every: Math.ceil(st.rounds.length / 6) || 1 });
  barChart($('chDays'), st.days.map(d => ({ label: d.day.slice(5), value: d.paid / 1e9, sub: `${d.rounds} rounds` })), { fmt: v => `${+v.toFixed(4)}`, label: 'SOL paid', every: Math.ceil(st.days.length / 7) || 1 });
  $('daysTable').innerHTML = '<tr><th>Day</th><th class="num">Rounds</th><th class="num">Proofs</th><th class="num">Pot, SOL</th><th class="num">Paid, SOL</th></tr>' +
    ([...st.days].reverse().map(d => `<tr><td>${d.day}</td><td class="num">${d.rounds}</td><td class="num">${d.proofs}</td><td class="num">${sol(d.pot)}</td><td class="num">${sol(d.paid)}</td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">No days recorded yet.</td></tr>');
  statsTimer = setTimeout(loadStats, 30_000);
}
addEventListener('resize', () => { if (location.pathname === '/stats') loadStats(); });

// ---------- rounds ----------
let roundsBefore = Infinity;
async function loadRounds(more = false) {
  $('roundsList').hidden = false;
  $('roundDetail').hidden = true;
  if (!more) roundsBefore = Infinity;
  let data;
  const all = $('roundsAll').checked ? '&all=1' : '';
  try { data = await getJson(`/api/rounds?limit=30${all}${roundsBefore < Infinity ? `&before=${roundsBefore}` : ''}`); } catch { return; }
  const rows = data.rounds.map((r, i) =>
    `<tr data-round="${r.id}" style="animation-delay:${i * 15}ms"><td>#${r.id}</td><td>${ago(r.closed_at)}</td><td class="num">${dur(r.closed_at - r.started_at)}</td>` +
    `<td class="num">${r.miners}</td><td class="num">${work(r.work)}</td><td class="num">${r.reward ? sol(r.reward) : '–'}</td><td class="num">${r.payouts}</td></tr>`).join('');
  const head = '<tr><th>Round</th><th>Closed</th><th class="num">Length</th><th class="num">Miners</th><th class="num">Work</th><th class="num">Pot, SOL</th><th class="num">Payouts</th></tr>';
  $('roundsTable').innerHTML = more ? $('roundsTable').innerHTML + rows : head + (rows || `<tr><td colspan="7" class="empty">${$('roundsAll').checked ? 'No rounds have closed yet.' : 'No mined rounds yet. Rounds with no miners are hidden.'}</td></tr>`);
  roundsBefore = data.rounds.at(-1)?.id ?? roundsBefore;
  $('roundsMore').hidden = !data.more;
}
$('roundsTable').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-round]');
  if (tr) go(`/rounds/${tr.dataset.round}`);
});
$('roundsMore').addEventListener('click', () => loadRounds(true));
$('roundsAll').addEventListener('change', () => loadRounds());

async function loadRound(id) {
  $('roundsList').hidden = true;
  $('roundDetail').hidden = false;
  const res = await fetch(`${API}/api/rounds/${id}`);
  if (!res.ok) {
    setText('rdTitle', `Round #${id}`);
    setText('rdWhen', 'This round is not in the pool history.');
    return;
  }
  const r = await res.json();
  scramble($('rdTitle'), `Round #${r.id}`, 500);
  setText('rdWhen', `${new Date(r.started_at).toLocaleString()} – ${hhmm(r.closed_at)} · ${dur(r.closed_at - r.started_at)}`);
  R('rdPot', sol(r.reward));
  R('rdMiners', r.miners);
  setText('rdWork', work(r.work));
  R('rdPayouts', r.payouts.length);
  for (const [el, to] of [['rdPrev', r.prev], ['rdNext', r.next]]) {
    $(el).hidden = to == null;
    if (to != null) $(el).setAttribute('href', `/rounds/${to}`);
  }
  const me = walletInput.value.trim();
  $('rdShares').innerHTML = '<tr><th>#</th><th>Wallet</th><th class="num">Work</th><th class="num">Share</th><th class="num">Reward, SOL</th></tr>' +
    (r.shares.map((x, i) => `<tr class="${x.wallet === me ? 'me' : ''}" style="animation-delay:${i * 20}ms"><td>${i + 1}</td><td>${short(x.wallet)}</td><td class="num">${work(x.work)}</td>` +
      `<td class="num">${pct(x.share)}<div class="share-bar" style="width:${Math.max(2, x.share * 100)}%"></div></td><td class="num">${sol(x.lamports)}</td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">No work was credited in this round, so its pot stayed in the reward wallet.</td></tr>');
  $('rdPayoutTable').innerHTML = '<tr><th>Wallet</th><th class="num">Amount</th><th>Status</th><th>Signature</th></tr>' +
    (r.payouts.map(p => `<tr><td>${short(p.wallet)}</td><td class="num">${sol(p.lamports)} SOL</td><td><span class="st st-${p.status ?? 'sim'}">${STATUS[p.status] ?? 'simulated'}</span></td><td>${sigLink(p)}</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">No balance crossed the payout threshold at this round\'s close.</td></tr>');
}

// ---------- benchmark ----------
let benchResult = null;
let benching = false;
async function loadBench() {
  setText('bnDevice', `${deviceLabel()} · ${navigator.hardwareConcurrency || '?'} threads`);
  segments($('bnProgress'), 0);
  renderBenchButton();
  let data;
  try { data = await getJson('/api/bench'); } catch { return; }
  const mine = benchResult && `${deviceLabel()}|${benchResult.gpu}`;
  $('benchTable').innerHTML = '<tr><th>#</th><th>Device</th><th>GPU</th><th class="num">CPU</th><th class="num">GPU</th><th class="num">Total</th></tr>' +
    (data.results.map((b, i) => `<tr class="${mine === `${b.device}|${b.gpu}` ? 'me' : ''}" style="animation-delay:${i * 20}ms"><td>${i + 1}</td><td>${esc(b.device)} · ${b.threads}t</td><td>${esc(b.gpu ?? '–')}</td>` +
      `<td class="num">${rate(b.cpu).join(' ')}</td><td class="num">${b.gpu_rate ? rate(b.gpu_rate).join(' ') : '–'}</td><td class="num"><b>${rate(b.cpu + (b.gpu_rate ?? 0)).join(' ')}</b></td></tr>`).join('')
      || '<tr><td colspan="6" class="empty">No devices yet. Run the test and add yours.</td></tr>');
}
function renderBenchButton() {
  const busy = miner.status === 'mining' || miner.status === 'starting';
  $('bnGo').disabled = benching || busy;
  $('bnGo').textContent = benching ? 'Running…' : benchResult ? 'Run again' : 'Run benchmark';
  setText('bnNote', busy ? 'Stop mining first; the test needs the whole device.' : navigator.gpu ? '' : 'WebGPU is not available here, so only the CPU will be tested.');
}
$('bnGo').addEventListener('click', async () => {
  if (benching) return;
  benching = true;
  benchResult = null;
  renderBenchButton();
  // Show the calculator from the start and feed it live numbers as each phase runs.
  const threads = navigator.hardwareConcurrency || 4;
  let cpuRate = 0;
  setText('bnCpu', 'measuring'); setText('bnCpuSub', `${threads} threads`);
  setText('bnGpu', navigator.gpu ? 'waiting' : '–'); setText('bnGpuSub', navigator.gpu ? 'after the CPU' : 'not available');
  $('bnSave').hidden = true;
  $('bnResult').hidden = false;
  const res = await runBench({
    threads,
    gpu: !!navigator.gpu,
    onTick: ({ phase, rate: r, progress }) => {
      const [v, u] = rate(r);
      R('bnRate', v);
      setText('bnUnit', u);
      setText('bnPhase', phase === 'cpu' ? `Measuring CPU · ${threads} threads` : 'Measuring GPU · WebGPU');
      segments($('bnProgress'), phase === 'cpu' ? progress / 2 : 0.5 + progress / 2);
      scene.setActivity({ mining: true, hashrate: r });
      if (phase === 'cpu') { cpuRate = r; setText('bnCpu', rate(r).join(' ')); }
      else { setText('bnGpu', rate(r).join(' ')); setText('bnGpuSub', 'measuring'); }
      calc(phase === 'cpu' ? r : cpuRate + r, true);
    },
  });
  scene.setActivity({ mining: false, hashrate: 0 });
  benching = false;
  benchResult = res;
  setText('bnPhase', 'Done');
  segments($('bnProgress'), 1);
  const total = res.cpu + (res.gpu_rate ?? 0);
  const [tv, tu] = rate(total);
  R('bnRate', tv); setText('bnUnit', tu);
  setText('bnCpu', rate(res.cpu).join(' ')); setText('bnCpuSub', `${threads} threads`);
  setText('bnGpu', res.gpu_rate ? rate(res.gpu_rate).join(' ') : '–'); setText('bnGpuSub', res.gpu ?? res.gpuError ?? 'not available');
  calc();
  $('bnSave').hidden = false;
  $('bnSave').disabled = false;
  $('bnSave').textContent = 'Add to the device table';
  renderBenchButton();
  toast('Benchmark finished', `${rate(total).join(' ')} total`, 'good');
});
// Earnings calculator: your measured speed against a pool you describe.
// share = you / (others + you); earnings = share × pot.
// While the test runs it is called with the live speed; afterwards it uses the result.
function calc(liveRate = null, measuring = false) {
  if (liveRate == null && !benchResult) return;
  const you = liveRate ?? benchResult.cpu + (benchResult.gpu_rate ?? 0);
  $('cSteps').classList.toggle('live', measuring);
  const pot = Math.max(0, Number($('cPot').value) || 0);
  const n = Math.max(0, Math.floor(Number($('cMiners').value) || 0));
  const each = Math.max(0, Number($('cRate').value) || 0) * 1e9;
  const others = n * each;
  const share = you / (others + you);
  const earn = share * pot;
  const r = v => rate(v).join(' ');
  $('cSteps').innerHTML = [
    `Your speed <b>${r(you)}</b>`,
    `Everyone else <b>${n} × ${r(each)} = ${r(others)}</b>`,
    `Your share <b>${r(you)} ÷ (${r(others)} + ${r(you)}) = ${pct(share)}</b>`,
    `You earn <b>${pct(share)} × ${pot} SOL = ${+earn.toFixed(4)} SOL</b>`,
  ].map(x => `<li>${x}</li>`).join('');
  setText('bnEarn', +earn.toFixed(4));
  setText('bnEarnSub', `SOL for you · ${pct(share)} share`);
}
for (const id of ['cPot', 'cMiners', 'cRate']) $(id).addEventListener('input', () => calc());

$('bnSave').addEventListener('click', async () => {
  if (!benchResult) return;
  $('bnSave').disabled = true;
  const r = await fetch(`${API}/api/bench`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device: deviceLabel(), gpu: benchResult.gpu, threads: benchResult.threads, cpu: benchResult.cpu, gpu_rate: benchResult.gpu_rate }),
  }).then(x => x.json()).catch(() => ({ error: 'network' }));
  if (r.error) toast('Not saved', r.error === 'rate_limited' ? 'Try again in a few seconds.' : r.error, 'bad');
  else toast(r.saved ? `Saved · rank #${r.rank}` : 'Already in the table', r.saved ? 'Your device is in the table.' : 'A faster result for this device is already listed.', 'good');
  $('bnSave').textContent = r.error ? 'Add to the device table' : 'Saved';
  $('bnSave').disabled = !r.error;
  loadBench();
});


// ---------- bitcoin ----------
let btcTimer = null;
const btcFmt = (v, d = 8) => (+Number(v).toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d });
const usdt = v => `${btcFmt(v, 2)} USDT`;
const ehRate = eh => { const [n, u] = rate(eh * 1e18); return `${n} ${u}`; };
const solLink = sig => `<a href="https://solscan.io/tx/${esc(sig)}" target="_blank" rel="noopener">${esc(sig.slice(0, 10))}…</a>`;
async function loadBtc() {
  clearTimeout(btcTimer);
  if (location.pathname !== '/bitcoin') return;
  let d;
  try { d = await getJson('/api/btc'); } catch { return; }
  const { config: c, live: l, totals: t, ledger: L } = d;
  const mrr = c.provider === 'mrr';
  const btc = v => `${btcFmt(v, 8)} BTC`;
  const ext = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
  const row = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  const acct = a => ext(`https://solscan.io/account/${a}`, esc(a));
  const now = Date.now();
  const liveRentals = (l.rentals ?? []).filter(r => r.end && r.end > now && !r.ended);
  if (mrr) {
    const hs = liveRentals.reduce((a, r) => a + parseNice(r.hash_average ?? r.hash_advertised), 0);
    const [sv, su] = rate(hs);
    R('btSpeed', sv); setText('btSpeedSub', `${su} · ${liveRentals.length} live rental${liveRentals.length === 1 ? '' : 's'}`);
  } else {
    const speed = l.order?.speed_eh ?? 0; const [sv, su] = rate(speed * 1e18);
    R('btSpeed', sv); setText('btSpeedSub', `${su} accepted · ${l.order?.rigs ?? 0} rigs`);
  }
  const [pv, pu] = rate(l.pool?.hashrate_300s ?? 0);
  R('btPool', pv); setText('btPoolSub', `${pu} · 5 min average${l.pool?.unpaid_btc ? ` · ${btcFmt(l.pool.unpaid_btc)} BTC unpaid` : ''}`);
  R('btRecv', btcFmt((l.chain?.received_sats ?? 0) / 1e8));
  setText('btRecvSub', `BTC on the payout address · ${l.chain?.payouts?.length ?? 0} payouts`);
  if (mrr) { R('btUsdt', btcFmt(t.rented_btc, 8)); setText('btUsdtSub', `BTC into rentals · ${t.rented_hours} rig-hours · ${sol(t.claimed_lamports)} SOL claimed`); }
  else { R('btUsdt', btcFmt(t.ordered_usdt, 2)); setText('btUsdtSub', `USDT into hashpower · ${sol(t.claimed_lamports)} SOL claimed`); }
  setText('btEvery', mrr
    ? `Every ${Math.round(c.every_ms / 60000)} minutes. Swaps start at ${c.min_swap_sol} SOL, rentals at ${c.min_rent_btc} BTC; nothing waits for a minimum order.`
    : `Every ${Math.round(c.every_ms / 60000)} minutes. First order needs ${c.order_min_usdt} USDT; after that every claim tops the order up.`);
  const m = l.market;
  $('btLinks').innerHTML =
    row('Engine wallet', c.wallet ? acct(c.wallet) : '<span class="muted">not armed yet</span>') +
    (mrr
      ? row('Rig marketplace deposit (BTC)', c.mrr_deposit ? ext(`https://mempool.space/address/${c.mrr_deposit}`, esc(c.mrr_deposit)) : '<span class="muted">read from the account at the first round</span>')
      : row('NiceHash deposit (USDT on Solana)', c.nh_deposit ? acct(c.nh_deposit) : '<span class="muted">assigned at the first round</span>')) +
    row('Payout address', c.btc_address ? ext(`https://mempool.space/address/${c.btc_address}`, esc(c.btc_address)) : '<span class="muted">not set</span>') +
    row('Pool', `${esc(c.pool_name)} · ${esc(c.pool)}${c.btc_address && /ocean/.test(c.pool) ? ` · ${ext(`https://ocean.xyz/stats/${c.btc_address}`, 'pool stats ↗')}` : ''}`) +
    (mrr
      ? row('Market', m ? `${esc(c.algorithm)} on MiningRigRentals · lowest ${btcFmt(m.lowest, 6)} BTC per PH/day · ${m.available_rigs} rigs (${esc(m.available_hash)}) available` : esc(c.algorithm))
      : row('Market', m?.price ? `${esc(c.algorithm)} · ${btcFmt(m.price, 2)} USDT per EH/day · ${m.orders} paying orders` : esc(c.algorithm))) +
    (l.balance ? row(mrr ? 'Marketplace balance' : 'NiceHash balance', mrr ? `${btc(l.balance.confirmed)} confirmed${l.balance.unconfirmed ? ` · ${btc(l.balance.unconfirmed)} unconfirmed` : ''}` : `${usdt(l.balance.confirmed ?? l.balance.available)} available`) : '');
  if (mrr) {
    const rows = (L.rentals ?? []).slice(0, 20).map(r => {
      const lv = (l.rentals ?? []).find(x => x.id === r.id) ?? r;
      const live = lv.end && lv.end > now && !lv.ended;
      return `<tr><td class="mono">${r.url ? ext(r.url, esc(String(r.id))) : esc(String(r.id))}</td><td>${esc(r.rig_name ?? String(r.rig))}<span class="muted"> · rpi ${r.rpi ?? '–'}</span></td><td><span class="st ${live ? 'st-sent' : 'st-sim'}">${live ? 'mining' : lv.ended || (lv.end && lv.end <= now) ? 'ended' : 'starting'}</span></td><td class="num">${esc(lv.hash_average ?? r.nice ?? '–')}H/s</td><td class="num">${r.hours} h</td><td class="num">${btcFmt(r.price_ph_day ?? 0, 6)} BTC/PH/day</td><td class="num">${btc(r.paid_btc)}</td><td>${lv.end ? time(lv.end) : '–'}</td></tr>`;
    }).join('');
    $('btOrder').innerHTML = '<tr><th>Rental</th><th>Rig</th><th>Status</th><th class="num">Hashrate</th><th class="num">Length</th><th class="num">Price</th><th class="num">Paid</th><th>Ends</th></tr>' +
      (rows || `<tr><td colspan="8" class="empty">${c.writes ? `No rental yet. The first one is placed once ${c.min_rent_btc} BTC of rewards have landed on the marketplace.` : 'The engine is not armed: no rental to show.'}</td></tr>`);
  } else {
    const o = l.order;
    $('btOrder').innerHTML = '<tr><th>Order</th><th>Status</th><th class="num">Speed</th><th class="num">Limit</th><th class="num">Price</th><th class="num">Spent</th><th class="num">Left</th></tr>' +
      (o ? `<tr><td class="mono">${esc(o.id)}</td><td><span class="st ${o.alive ? 'st-sent' : 'st-sim'}">${esc(o.status ?? '–')}</span></td><td class="num">${ehRate(o.speed_eh)}</td><td class="num">${ehRate(o.limit)}</td><td class="num">${btcFmt(o.price, 2)} USDT/EH/day</td><td class="num">${usdt(o.spent)}</td><td class="num">${usdt(o.available)}</td></tr>`
        : `<tr><td colspan="7" class="empty">${c.writes ? `No live order yet. The first one is placed once ${c.order_min_usdt} USDT of rewards have reached NiceHash.` : 'The engine is not armed: no order to show.'}</td></tr>`);
  }
  $('btPayouts').innerHTML = '<tr><th>Time</th><th>Transaction</th><th class="num">Amount</th><th>Block</th><th>From</th></tr>' +
    ((l.chain?.payouts ?? []).map((p, i) => `<tr style="animation-delay:${i * 20}ms"><td>${time(p.at)}</td><td>${ext(`https://mempool.space/tx/${p.txid}`, esc(p.txid.slice(0, 12)) + '…')}</td><td class="num">${btcFmt(p.sats / 1e8)} BTC</td><td>${p.height ?? '<span class="muted">mempool</span>'}</td><td>${p.coinbase ? '<span class="st st-sent">coinbase</span>' : 'pool wallet'}</td></tr>`).join('')
      || `<tr><td colspan="5" class="empty">${c.btc_address ? 'Nothing has landed on the address yet.' : 'No payout address set.'}</td></tr>`);
  const swapRow = x => {
    if (!x.channel) return { at: x.at, step: 'swap', what: `${sol(x.lamports)} SOL → ${usdt(x.usdt)}`, link: solLink(x.sig) };
    const links = [solLink(x.sig), ext(`https://scan.chainflip.io/channels/${x.channel}`, 'channel')];
    if (x.egress_tx) links.push(ext(`https://mempool.space/tx/${x.egress_tx}`, 'btc tx'));
    const got = x.egress_sats ? `${btcFmt(x.egress_sats / 1e8)} BTC` : `~${btcFmt((x.quoted_sats ?? 0) / 1e8)} BTC`;
    return { at: x.at, step: 'swap', what: `${sol(x.lamports)} SOL → ${got} <span class="st ${x.state === 'COMPLETED' ? 'st-sent' : x.state === 'FAILED' ? 'st-queued' : 'st-sim'}">${esc((x.state ?? 'waiting').toLowerCase())}</span>`, link: links.join(' · '), bad: x.state === 'FAILED' };
  };
  const items = [
    ...L.claims.map(x => ({ at: x.at, step: 'claim', what: `${sol(x.lamports)} SOL from the creator vault`, link: solLink(x.sig) })),
    ...L.swaps.map(swapRow),
    ...(L.rentals ?? []).map(x => ({ at: x.at, step: 'rent', what: `${esc(x.nice ?? '')} for ${x.hours} h on ${esc(x.rig_name ?? String(x.rig))} · ${btc(x.paid_btc)}`, link: x.url ? ext(x.url, `rental ${esc(String(x.id))}`) : `<span class="mono">${esc(String(x.id))}</span>` })),
    ...L.deposits.map(x => ({ at: x.at, step: 'deposit', what: `${usdt(x.usdt)} → NiceHash`, link: solLink(x.sig) })),
    ...L.orders.map(x => ({ at: x.at, step: 'order', what: `${usdt(x.usdt)} · ${ehRate(x.limit_eh)} at ${btcFmt(x.price, 2)} USDT/EH/day`, link: `<span class="mono">${esc(x.id)}</span>` })),
    ...L.refills.map(x => ({ at: x.at, step: 'refill', what: `${usdt(x.usdt)} added to the order`, link: `<span class="mono">${esc(x.id)}</span>` })),
    ...L.errors.map(x => ({ at: x.at, step: 'error', what: `${esc(x.step)}: ${esc(x.error)}`, link: '–', bad: true })),
  ].sort((a, b) => b.at - a.at).slice(0, 60);
  $('btLedger').innerHTML = '<tr><th>Time</th><th>Step</th><th>What</th><th>Receipt</th></tr>' +
    (items.map((x, i) => `<tr style="animation-delay:${i * 15}ms"><td>${time(x.at)}</td><td><span class="st ${x.bad ? 'st-queued' : 'st-sent'}">${x.step}</span></td><td>${x.what}</td><td>${x.link}</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">No receipts yet.</td></tr>');
  setText('btNote', c.writes
    ? `Armed${c.dry ? ' · dry run (logs only, nothing moves)' : ''}. ${mrr ? 'SOL becomes BTC on Chainflip and rents rigs on MiningRigRentals' : 'Hashpower is bought on NiceHash'}; the pool pays the address above, never a marketplace wallet.`
    : `Not armed: the server has no engine wallet or ${mrr ? 'MiningRigRentals' : 'NiceHash'} keys, so only the public side (pool, chain, market) is live.`);
  btcTimer = setTimeout(loadBtc, 15_000);
}

// ---------- engine home ----------
let homeTimer = null, homeData = null, homeCoinAt = 0;
const parseNice = n => { const m = /([\d.]+)\s*([KMGTPE]?)/i.exec(String(n ?? '')); return m ? Number(m[1]) * ({ '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 }[m[2].toUpperCase()] ?? 1) : 0; };
const until = t => { const s = Math.max(0, Math.round((t - Date.now()) / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
async function loadHome() {
  clearTimeout(homeTimer);
  if (location.pathname !== '/') return;
  try { homeData = await getJson('/api/btc'); } catch { homeTimer = setTimeout(loadHome, 15_000); return; }
  renderHome();
  homeTimer = setTimeout(loadHome, 15_000);
}
function renderHome() {
  const d = homeData; if (!d || location.pathname !== '/') return;
  const { config: c, live: l, totals: t, ledger: L, flow: f } = d;
  const now = Date.now();
  const ext = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
  // flywheel card
  R('fwTh', (f.th_now ?? 0).toFixed(f.th_now >= 100 ? 0 : 1));
  setText('fwThSub', `TH/s on ${f.rigs} rig${f.rigs === 1 ? '' : 's'}${l.pool?.hashrate_300s ? ` · pool sees ${rate(l.pool.hashrate_300s).join(' ')}` : ''}`);
  R('fwUntil', f.until ? until(f.until) : '–');
  setText('fwUntilSub', f.until ? (c.provider === 'nicehash' ? 'the order budget lasts at current speed' : `of rig time left · ends ${time(f.until)}`) : f.armed ? (c.provider === 'nicehash' ? 'no order running yet' : 'no rig running yet') : 'engine not armed');
  document.querySelectorAll('.home .chips li').forEach((li, i) => { if (i === 1) li.innerHTML = `<b>2</b>${c.provider === 'nicehash' ? 'Swap to USDT' : 'Swap to BTC'}`; if (i === 2) li.innerHTML = `<b>3</b>${c.provider === 'nicehash' ? 'Buy hashpower' : 'Rent rigs'}`; });
  R('fwBtc', ((l.chain?.received_sats ?? 0) / 1e8).toFixed(8));
  setText('fwBtcSub', `BTC on the payout address · ${l.chain?.payouts?.length ?? 0} payouts`);
  R('fwSol', sol(t.claimed_lamports));
  setText('fwSolSub', c.provider === 'nicehash' ? `SOL claimed · ${(t.swapped_usdt ?? 0).toFixed(2)} USDT swapped · ${(t.ordered_usdt ?? 0).toFixed(2)} USDT of hashpower` : `SOL claimed · ${(t.swapped_sats / 1e8).toFixed(6)} BTC bought · ${t.rented_hours} rig-hours`);
  $('fwState').textContent = f.armed ? (c.dry ? 'dry run' : 'live') : 'standby';
  $('fwState').style.color = f.armed && !c.dry ? '' : 'var(--accent)';
  if (f.next_run) { setText('fwLeft', until(f.next_run)); segments($('fwRuler'), 1 - Math.max(0, f.next_run - now) / f.cycle_ms); }
  else { setText('fwLeft', `every ${Math.round(f.cycle_ms / 60000)} min`); segments($('fwRuler'), 0); }
  const vault = l.vault;
  setText('fwVault', vault ? `vault: ${vault.claimable_sol.toFixed(4)} SOL claimable${c.provider === 'nicehash' ? '' : ` · next swap at ${c.min_swap_sol} SOL`}` : c.creator ? 'vault: reading…' : 'vault: creator wallet not set');
  // the loop
  const swaps = L.swaps ?? [], rentals = L.rentals ?? [], claims = L.claims ?? [];
  const pendingSwap = swaps.find(s => s.channel && !['COMPLETED', 'FAILED'].includes(s.state));
  const lastSwap = swaps[0], lastClaim = claims[0], lastRent = rentals[0];
  const liveRig = f.rigs > 0 || (f.provider === 'nicehash' && f.th_now > 0);
  const nh = c.provider === 'nicehash';
  const deposits = L.deposits ?? [], orders = L.orders ?? [], refills = L.refills ?? [];
  const lastDep = deposits[0], lastOrder = orders[0], o = l.order;
  const step = (n, name, what, state, cls) => `<li class="${cls}"><b>${n}</b><span>${name}<small>${what}</small></span><em>${state}</em></li>`;
  const stepClaim = step('01', 'Claim creator rewards', lastClaim ? `${sol(lastClaim.lamports)} SOL · ${ago(lastClaim.at)}` : vault ? `${vault.claimable_sol.toFixed(4)} SOL waiting in the vault` : 'pump.fun creator vault → engine wallet', vault && vault.claimable_sol >= 0.01 ? 'ready' : lastClaim ? 'done' : 'waiting', vault && vault.claimable_sol >= 0.01 ? 'wait' : lastClaim ? 'on' : '');
  const stepMine = step(nh ? '05' : '04', 'Mine to the public address', l.pool ? `${rate(l.pool.hashrate_300s ?? 0).join(' ')} at the pool · ${(l.pool.unpaid_btc ?? 0).toFixed(8)} BTC unpaid` : c.btc_address ? `${esc(c.pool_name)} · ${esc(c.pool)}` : 'payout address not set', l.pool?.hashrate_300s ? 'hashing' : 'idle', l.pool?.hashrate_300s ? 'on' : '');
  if (nh) $('fwLoop').innerHTML =
    stepClaim +
    step('02', 'Swap SOL → USDT', lastSwap ? `${sol(lastSwap.lamports)} SOL → ${(lastSwap.usdt ?? 0).toFixed(2)} USDT · ${ago(lastSwap.at)}` : 'Jupiter, on Solana, everything above the gas reserve', lastSwap ? 'done' : 'waiting', lastSwap ? 'on' : '') +
    step('03', 'Deposit to NiceHash', lastDep ? `${(lastDep.usdt ?? 0).toFixed(2)} USDT · ${ago(lastDep.at)}` : l.balance ? `${(l.balance.confirmed ?? l.balance.available ?? 0).toFixed(2)} / ${c.order_min_usdt} USDT for the first order` : 'USDT on Solana straight to the hashpower wallet', lastDep ? 'done' : 'waiting', lastDep ? 'on' : '') +
    step('04', 'Buy SHA-256 hashpower', o && liveRig ? `${(o.speed_eh * 1e6).toFixed(0)} TH/s on ${o.rigs ?? 0} rigs · ${(o.available ?? 0).toFixed(2)} USDT left` : lastOrder ? `order ${esc(String(lastOrder.id)).slice(0, 8)}… · ${(lastOrder.usdt ?? 0).toFixed(2)} USDT · ${ago(lastOrder.at)}` : l.market?.price ? `market ${Number(l.market.price).toFixed(2)} USDT per EH/day` : 'NiceHash standing order, refilled every cycle', liveRig ? 'running' : lastOrder ? 'idle' : 'waiting', liveRig ? 'on' : '') +
    stepMine;
  else $('fwLoop').innerHTML =
    stepClaim +
    step('02', 'Swap SOL → BTC', pendingSwap ? `${sol(pendingSwap.lamports)} SOL in flight · ${esc((pendingSwap.state ?? 'waiting').toLowerCase())}` : lastSwap ? `${sol(lastSwap.lamports)} SOL → ${((lastSwap.egress_sats ?? lastSwap.quoted_sats ?? 0) / 1e8).toFixed(6)} BTC · ${ago(lastSwap.at)}` : `Chainflip, native BTC, from ${c.min_swap_sol} SOL`, pendingSwap ? 'swapping' : lastSwap ? 'done' : 'waiting', pendingSwap ? 'wait' : lastSwap ? 'on' : '') +
    step('03', 'Rent SHA-256 rigs', lastRent ? `${esc(lastRent.nice ?? '')} · ${lastRent.hours} h · ${(lastRent.paid_btc ?? 0).toFixed(8)} BTC · ${ago(lastRent.at)}` : l.market ? `market low ${(l.market.lowest ?? 0).toFixed(6)} BTC per PH/day · ${l.market.available_rigs} rigs free` : 'MiningRigRentals, cheapest reliable rig', liveRig ? 'running' : lastRent ? 'ended' : 'waiting', liveRig ? 'on' : '') +
    stepMine;
  $('fwLoopState').className = `state ${liveRig ? 'mining' : ''}`;
  $('fwLoopState').querySelector('b').textContent = liveRig ? 'running' : f.armed ? 'armed' : 'standby';
  // receipts
  const solLink = sig => ext(`https://solscan.io/tx/${sig}`, 'solscan ↗');
  const items = [
    ...claims.map(x => ({ at: x.at, k: 'claim', what: `${sol(x.lamports)} SOL`, link: solLink(x.sig) })),
    ...swaps.map(x => ({ at: x.at, k: 'swap', what: `${sol(x.lamports)} SOL → ${x.usdt != null ? `${x.usdt.toFixed(2)} USDT` : 'BTC'}`, link: x.channel ? ext(`https://scan.chainflip.io/channels/${x.channel}`, 'chainflip ↗') : solLink(x.sig) })),
    ...deposits.map(x => ({ at: x.at, k: 'deposit', what: `${(x.usdt ?? 0).toFixed(2)} USDT → NiceHash`, link: solLink(x.sig) })),
    ...orders.map(x => ({ at: x.at, k: 'order', what: `${(x.usdt ?? 0).toFixed(2)} USDT · ${Math.round(x.limit_eh * 1e6)} TH/s cap`, link: `<span class="mono">${esc(String(x.id)).slice(0, 8)}…</span>` })),
    ...refills.map(x => ({ at: x.at, k: 'refill', what: `${(x.usdt ?? 0).toFixed(2)} USDT`, link: `<span class="mono">${esc(String(x.id)).slice(0, 8)}…</span>` })),
    ...rentals.map(x => ({ at: x.at, k: x.extended ? 'extend' : 'rent', what: `${esc(x.nice ?? '')} · ${x.hours} h`, link: x.url ? ext(x.url, 'rig ↗') : `#${esc(String(x.id))}` })),
    ...(l.chain?.payouts ?? []).map(p => ({ at: p.at, k: 'payout', what: `${(p.sats / 1e8).toFixed(8)} BTC${p.coinbase ? ' · coinbase' : ''}`, link: ext(`https://mempool.space/tx/${p.txid}`, 'mempool ↗') })),
  ].sort((a, b) => b.at - a.at).slice(0, 6);
  $('fwReceipts').innerHTML = items.map(x => `<li><span>${esc(x.k)}</span><em>${x.what}</em><b>${x.link}</b></li>`).join('') || '<li class="empty">No receipts yet. The first claim starts the loop.</li>';
  $('fwPoolName').textContent = c.pool_name;
  $('fwPool').innerHTML = c.btc_address ? `${ext(`https://mempool.space/address/${c.btc_address}`, esc(c.btc_address))} · ${/ocean/.test(c.pool) ? ext(`https://ocean.xyz/stats/${c.btc_address}`, 'pool stats ↗') : esc(c.pool)}` : `${esc(c.pool)} · payout address not set yet`;
  // the pit works as hard as the rented rigs do
  scene.setActivity({ mining: liveRig, hashrate: liveRig ? Math.min(1, f.th_now / 500) * 50e6 : 0 });
  if (liveRig && now - homeCoinAt > 7000) { homeCoinAt = now; scene.proof({ difficulty: 24, accepted: true }); }
}
setInterval(() => { if (location.pathname === '/' && homeData) renderHome(); }, 1000);

// ---------- caption under the pit: live Bitcoin tip ----------
async function loadTip() {
  try {
    const h = Number(await (await fetch('https://mempool.space/api/blocks/tip/height')).text());
    if (!h) return;
    const next = Math.ceil(h / 210000) * 210000;
    setText('figBlock', `Block ${h.toLocaleString()}`);
    setText('figHalving', `${(next - h).toLocaleString()} blocks to halving`);
  } catch {}
}
loadTip(); setInterval(loadTip, 120_000);

// ---------- controls ----------
const walletInput = $('wallet');
walletInput.value = load('wallet') ?? '';
walletInput.addEventListener('input', () => {
  const v = walletInput.value.trim();
  walletInput.classList.toggle('invalid', v !== '' && !WALLET.test(v));
  earned = null;
  if (WALLET.test(v)) { store('wallet', v); pollWallet(); }
});

function slider(id, value, onInput) {
  const el = $(id);
  const paint = () => el.style.setProperty('--p', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
  el.value = value;
  paint();
  el.addEventListener('input', () => { paint(); onInput(Number(el.value)); });
}
$('threads').max = miner.maxThreads;
slider('threads', miner.threads, v => miner.setThreads(v));
slider('cpuDuty', miner.cpuDuty * 100, v => miner.setCpuDuty(v / 100));
slider('gpuDuty', miner.gpuDuty * 100, v => miner.setGpuDuty(v / 100));
$('gpu').addEventListener('change', e => miner.setGpu(e.target.checked));
setText('cores', `${navigator.hardwareConcurrency || '?'} cores`);
if (!navigator.gpu) {
  $('gpu').disabled = true;
  setText('gpuInfo', 'WebGPU is not available in this browser. Try a recent Chrome, Edge or Safari.');
}

function toggleMining() {
  if (miner.status === 'mining' || miner.status === 'starting') return miner.stop();
  const v = walletInput.value.trim();
  if (!WALLET.test(v)) {
    walletInput.classList.remove('invalid');
    void walletInput.offsetWidth;
    walletInput.classList.add('invalid');
    walletInput.focus();
    return;
  }
  miner.start(v);
}
$('go').addEventListener('click', toggleMining);
walletInput.addEventListener('keydown', e => { if (e.key === 'Enter') toggleMining(); });
function closeSettings() {
  $('settings').hidden = true;
  $('settingsBtn').setAttribute('aria-expanded', 'false');
}
$('settingsBtn').addEventListener('click', () => {
  const open = $('settings').hidden;
  $('settings').hidden = !open;
  $('settingsBtn').setAttribute('aria-expanded', String(open));
});
addEventListener('keydown', e => { if (e.key === 'Escape') closeSettings(); });

document.querySelectorAll('[data-board]').forEach(b => b.addEventListener('click', () => {
  board = b.dataset.board;
  document.querySelectorAll('[data-board]').forEach(x => x.classList.toggle('on', x === b));
  renderBoard();
}));

// ---------- miner ----------
miner.onChange(renderMiner);

function renderMiner() {
  const running = miner.status === 'mining' || miner.status === 'starting';
  if (miner.status !== lastStatus) {
    if (miner.status === 'mining') toast('Mining started', `${miner.threads} CPU thread${miner.threads > 1 ? 's' : ''}${miner.gpuEnabled ? ' + GPU' : ''} · ${short(miner.wallet)}`);
    if (miner.status === 'idle' && lastStatus === 'mining') toast('Mining stopped', `${miner.accepted} proofs accepted this session`);
    if (miner.status === 'error') toast('Could not start', miner.error ?? '', 'bad');
    lastStatus = miner.status;
  }
  document.body.classList.toggle('is-mining', miner.status === 'mining');
  $('go').textContent = running ? 'Stop mining' : 'Start mining';
  $('go').classList.toggle('stop', running);
  walletInput.disabled = running;
  if (location.pathname === '/benchmark') renderBenchButton();
  const st = $('status');
  st.className = `state ${miner.status === 'mining' ? 'on' : miner.status === 'error' ? 'err' : ''}`;
  st.querySelector('b').textContent = miner.status === 'mining' ? 'mining' : miner.status;

  setText('threadsVal', miner.threads);
  setText('cpuDutyVal', `${Math.round(miner.cpuDuty * 100)}%`);
  setText('gpuDutyVal', `${Math.round(miner.gpuDuty * 100)}%`);
  $('gpu').checked = miner.gpuEnabled;
  setText('gpuState', miner.gpuEnabled ? 'on' : 'off');
  if (miner.gpuName && $('gpuInfo').textContent.indexOf(miner.gpuName) < 0) toast('GPU ready', `${miner.gpuName} · self-test passed`);
  if (miner.gpuName) setText('gpuInfo', `GPU: ${miner.gpuName} · self-test passed`);
  if (miner.gpuError) setText('gpuInfo', miner.gpuError);

  const [r, u] = rate(miner.hashrate);
  R('rate', r);
  setText('rateUnit', u);
  R('diff', miner.ticket?.difficulty ?? '–');
  R('proofs', miner.accepted);
  setText('rej', `${miner.rejected} rejected`);

  $('log').innerHTML = miner.log.slice(0, 4)
    .map(l => `<li class="${l.tone}">${time(l.at)}  ${esc(l.text)}</li>`).join('');

  // 3D: activity follows hashrate; every new proof flies out of the core.
  if (location.pathname !== '/') scene.setActivity({ mining: miner.status === 'mining', hashrate: miner.hashrate });
  for (; seen.accepted < miner.accepted; seen.accepted++) {
    scene.proof({ difficulty: miner.lastProof?.difficulty ?? 0, accepted: true });
    floatUp($('proofs').parentElement, `+2^${miner.lastProof?.difficulty ?? '?'}`);
    pulse($('proofs').parentElement);
  }
  for (; seen.rejected < miner.rejected; seen.rejected++) scene.proof({ difficulty: miner.ticket?.difficulty ?? 0, accepted: false });

  if (miner.lastProof && miner.lastProof.hash !== shownHash) {
    shownHash = miner.lastProof.hash;
    const hex = miner.lastProof.hash;
    let i = 0;
    while (i < hex.length && hex[i] === '0') i++;
    const el = $('digest');
    scramble(el, hex, 420);
    setTimeout(() => {
      if (shownHash !== hex) return;
      el.innerHTML = `<span class="z">${hex.slice(0, i + 1)}</span>${hex.slice(i + 1)}`;
      pulse(el, 'flash');
    }, 450);
  }
  drawSpark();
}

function drawSpark() {
  const c = $('spark');
  const dpr = devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const s = miner.samples;
  if (s.length < 2) return;
  const max = Math.max(...s.map(x => x.cpu + x.gpu), 1);
  const x = i => w - ((s.length - 1 - i) / 89) * w;
  const y = v => h - 2 - (v / max) * (h - 6);
  ctx.beginPath();
  s.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.cpu + p.gpu)) : ctx.moveTo(x(i), y(p.cpu + p.gpu))));
  ctx.strokeStyle = '#ffc83a';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.lineTo(x(s.length - 1), h);
  ctx.lineTo(x(0), h);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#ffc83a33');
  g.addColorStop(1, '#ffc83a00');
  ctx.fillStyle = g;
  ctx.fill();
}

// ---------- pool stream ----------
function connect() {
  const es = new EventSource(`${API}/api/stream`);
  const conn = $('conn');
  es.addEventListener('open', () => { conn.className = 'conn live'; conn.title = 'live'; });
  es.addEventListener('error', () => { conn.className = 'conn down'; conn.title = 'reconnecting'; });
  es.addEventListener('state', e => { pool = JSON.parse(e.data); renderPool(); });
  es.addEventListener('settled', e => {
    const { round, reward } = JSON.parse(e.data);
    scene.wave();
    pulse(document.querySelector('.view:not([hidden])'), 'sweep');
    if (reward) toast(`Round #${round} settled`, `${sol(reward)} SOL split by verified work`);
    pollWallet();
  });
  es.addEventListener('payout', e => {
    const p = JSON.parse(e.data);
    if (p.wallet === walletInput.value.trim()) toast('Payout confirmed', `${sol(p.lamports)} SOL sent to ${short(p.wallet)}`, 'good');
  });
}

function renderPool() {
  if (!pool) return;
  const [r, u] = rate(pool.live.hashrate);
  R('poolRate', r); setText('poolRateUnit', u);
  R('lbRate', r); setText('lbRateUnit', u);
  R('miners', pool.live.active_miners); R('lbMiners', pool.live.active_miners);
  R('ppm', pool.live.proofs_per_min); R('lbProofs', pool.live.proofs_per_min);
  R('reward', sol(pool.config.reward_per_round));
  setText('roundLabel', `round #${pool.round.id}`);
  setText('lbRound', `#${pool.round.id}`);
  setText('roundMiners', `${pool.round.miners} miner${pool.round.miners === 1 ? '' : 's'} · ${work(pool.round.work)} hashes`);
  for (const el of document.querySelectorAll('.threshold')) el.textContent = sol(pool.config.payout_threshold);
  renderCA(pool.config.token_mint);

  const funding = pool.simulated
    ? 'Simulated: each round pays a fixed pot into the ledger. No SOL moves.'
    : 'Creator fees reach the reward wallet. Each round, the new fees are split by verified work.';
  setText('fundingText', funding);
  setText('fundingRule', `${funding} Balances over the threshold are paid out and logged in the ledger.`);
  setText('rulesConfig',
    `Current settings: ${pool.config.round_ms / 1000}s rounds · pot ${sol(pool.config.reward_per_round)} SOL · ` +
    `payout threshold ${sol(pool.config.payout_threshold)} SOL · minimum difficulty ${pool.config.min_difficulty} bits.`);

  $('rounds').innerHTML = (pool.rounds ?? []).map(r =>
    `<li><span>#${r.id}</span><em>${r.miners} miner${r.miners === 1 ? '' : 's'}</em><b>${r.reward ? sol(r.reward) : '–'}</b></li>`).join('')
    || '<li class="empty">No rounds settled yet.</li>';
  renderBoard();
  renderLedger();
}

// Contract address: a placeholder until TOKEN_MINT is set on the server.
let shownMint;
function renderCA(mint) {
  if (mint === shownMint) return;
  shownMint = mint;
  $('ca').classList.toggle('set', !!mint);
  $('caCopy').hidden = $('caLink').hidden = !mint;
  if (mint) {
    scramble($('caValue'), mint, 600);
    $('caLink').href = `https://pump.fun/coin/${mint}`;
  } else {
    $('caValue').textContent = 'dropping at launch';
  }
}
$('caCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shownMint);
    $('caCopy').textContent = 'Copied';
    toast('CA copied', `${shownMint.slice(0, 6)}…${shownMint.slice(-6)}`, 'good');
  } catch {
    toast('Copy failed', 'Select the address and copy it manually.', 'bad');
  }
  setTimeout(() => { $('caCopy').textContent = 'Copy'; }, 1600);
});

function tickRound() {
  if (!pool) return;
  const { started_at, closes_at } = pool.round;
  const left = Math.max(0, closes_at - Date.now());
  const m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
  const label = left ? `${m}:${String(s).padStart(2, '0')} left` : 'settling';
  setText('roundLeft', label);
  $('roundLeft').classList.toggle('urgent', left > 0 && left < 10_000);
  setText('lbLeft', label);
  segments($('roundRuler'), 1 - left / (closes_at - started_at));
}

function renderBoard() {
  if (!pool) return;
  const me = walletInput.value.trim();
  let rows, head;
  if (board === 'all') {
    head = '<tr><th>#</th><th>Wallet</th><th class="num">Work, hashes</th><th class="num">Paid</th></tr>';
    rows = pool.leaderboard.all.map((r, i) =>
      `<tr class="${r.wallet === me ? 'me' : ''}" style="animation-delay:${i * 25}ms"><td>${i + 1}</td><td>${short(r.wallet)}</td><td class="num">${work(r.work)}</td><td class="num">${sol(r.paid)} SOL</td></tr>`);
  } else {
    const list = board === 'round' ? pool.leaderboard.round : pool.leaderboard.last?.shares ?? [];
    head = `<tr><th>#</th><th>Wallet</th><th class="num">Work, hashes</th><th class="num">Share</th>${board === 'last' ? '<th class="num">Reward</th>' : ''}</tr>`;
    rows = list.map((r, i) =>
      `<tr class="${r.wallet === me ? 'me' : ''}" style="animation-delay:${i * 25}ms"><td>${i + 1}</td><td>${short(r.wallet)}</td><td class="num">${work(r.work)}</td>` +
      `<td class="num">${pct(r.share)}<div class="share-bar" style="width:${Math.max(2, r.share * 100)}%"></div></td>` +
      `${board === 'last' ? `<td class="num">${sol(r.lamports)} SOL</td>` : ''}</tr>`);
  }
  const html = head + (rows.join('') || '<tr><td colspan="5" class="empty">No work in this period yet.</td></tr>');
  if ($('board').dataset.html !== html) { $('board').innerHTML = html; $('board').dataset.html = html; }
}

function explorer(kind, id) {
  const c = pool?.treasury?.cluster;
  const q = !c || c === 'mainnet-beta' ? '' : c === 'localnet' ? '?cluster=custom' : `?cluster=${c}`;
  return `https://solscan.io/${kind}/${id}${q}`;
}

const STATUS = { sim: 'simulated', queued: 'queued', submitted: 'sending', sent: 'confirmed' };
function claimText(c) {
  const when = `${ago(c.at)} · `;
  if (c.signature) return `${when}${sol(c.amount)} SOL ${c.mode === 'distribute' ? 'distributed' : 'collected'} · <a href="${explorer('tx', c.signature)}" target="_blank" rel="noopener">${c.signature.slice(0, 10)}…</a>`;
  if (c.error) return `${when}failed, retrying next round`;
  return `${when}nothing to claim`;
}
function sigLink(p) {
  if (!p.signature) return '–';
  if (p.status === 'sim' || !p.status) return `<span class="muted">${p.signature.slice(0, 12)}…</span>`;
  return `<a href="${explorer('tx', p.signature)}" target="_blank" rel="noopener">${p.signature.slice(0, 12)}…</a>`;
}

function renderLedger() {
  const t = pool.treasury;
  $('treasury').innerHTML = t
    ? `<div><span>Reward wallet</span><b><a href="${explorer('account', t.address)}" target="_blank" rel="noopener">${esc(t.address)}</a></b></div>` +
      `<div><span>Balance</span><b>${sol(t.balance)} SOL</b></div><div><span>Cluster</span><b>${esc(t.cluster)}</b></div>` +
      (t.claim ? `<div><span>Last fee claim</span><b>${claimText(t.claim)}</b></div>` : '')
    : '';
  const rows = pool.payouts.map((p, i) => {
    const sig = !p.signature ? '–'
      : p.status === 'sim' || !p.status ? `<span class="dim">${p.signature.slice(0, 12)}…</span>`
      : `<a href="${explorer('tx', p.signature)}" target="_blank" rel="noopener">${p.signature.slice(0, 12)}…</a>`;
    return `<tr style="animation-delay:${i * 20}ms"><td>${time(p.at)}</td><td>${short(p.wallet)}</td><td>#${p.round}</td>` +
      `<td class="num">${sol(p.lamports)} SOL</td><td><span class="st st-${p.status ?? 'sim'}">${STATUS[p.status] ?? 'simulated'}</span></td><td>${sig}</td></tr>`;
  });
  const html = '<tr><th>Time</th><th>Wallet</th><th>Round</th><th class="num">Amount</th><th>Status</th><th>Signature</th></tr>' +
    (rows.join('') || '<tr><td colspan="6" class="empty">No payouts yet.</td></tr>');
  if ($('ledger').dataset.html !== html) { $('ledger').innerHTML = html; $('ledger').dataset.html = html; }
}

// ---------- wallet ----------
async function pollWallet() {
  const v = walletInput.value.trim();
  if (!WALLET.test(v)) return;
  try {
    you = await (await fetch(`${API}/api/wallet/${v}`)).json();
  } catch { return; }
  setText('youAddr', short(v));
  R('share', pct(you.round_share));
  setText('est', `≈ ${sol(you.round_estimate)} SOL`);
  R('balance', sol(you.balance));
  setText('pendingNote', you.pending ? `SOL · ${sol(you.pending)} sending` : 'SOL · not sent');
  R('paid', sol(you.paid));
  const total = you.balance + (you.pending ?? 0) + you.paid;
  if (earned !== null && total > earned) {
    toast('You earned', `+${sol(total - earned)} SOL from the last round`, 'good');
    floatUp($('balance').parentElement, `+${sol(total - earned)}`);
  }
  earned = total;
  if (pool) {
    const t = pool.config.payout_threshold;
    segments($('thresholdRuler'), you.balance / t);
    setText('thresholdText', `${pct(Math.min(1, you.balance / t))} of ${sol(t)} SOL, sent on its own`);
  }
}

route();
renderMiner();
connect();
segments($('roundRuler'), 0);
segments($('thresholdRuler'), 0);
setInterval(tickRound, 1000);
setInterval(pollWallet, 4000);
pollWallet();
addEventListener('resize', drawSpark);
