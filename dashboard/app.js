/* Trade Flow dashboard — vanilla JS, hand-rolled SVG */
const state = { mode: "day", end: null, symbol: null, trader: null, instrument: null, action: null, obucket: null, ofav: null, preview: null, tab: "market", traderSort: "active" };
let DATA = null;

const ACTION_COLORS = {
  BUY: "#26a69a", ADD: "#26a69a", SELL: "#ef5350", TRIM: "#ef5350",
  EXIT: "#ab47bc", PLAN: "#4f7cff", HOLD: "#8a94a6", WATCH: "#8a94a6"
};
const INST_COLORS = {
  stock: "#4f7cff", call: "#26a69a", put: "#ef5350",
  spread: "#ab47bc", crypto: "#ffb300", other: "#8a94a6"
};
const OPEN = new Set(["BUY", "ADD"]), CLOSE = new Set(["SELL", "TRIM", "EXIT"]);
const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Los_Angeles" });

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function windowDays() {
  const n = state.mode === "day" ? 1 : state.mode === "week" ? 7 : 30;
  const days = [], d = new Date(state.end + "T12:00:00");
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(d); t.setDate(t.getDate() - i);
    days.push(t.toISOString().slice(0, 10));
  }
  return days;
}
function inRange(t) {
  return windowDays().includes(t.day)
    && (!state.symbol || t.symbol === state.symbol)
    && (!state.trader || t.trader === state.trader)
    && (!state.instrument || (t.instrument || "other") === state.instrument)
    && (!state.action || t.action === state.action)
    && (!state.obucket || (expiryBucket(t) || "unstated") === state.obucket)
    && (!state.ofav || outcomeClass(t) === state.ofav);
}
function clearFilters() { state.symbol = state.trader = state.instrument = state.action = state.obucket = state.ofav = state.preview = null; }
/* tap-to-inspect: tapping a card shows its numbers in the summary bar, never filters */
function isPreview(kind, value) { const p = state.preview; return !!p && p.kind === kind && p.value === value; }
function setPreview(kind, value) {
  const was = isPreview(kind, value);
  state.preview = was ? null : { kind, value };
  render();
  if (!was) {
    const el = $("sliceSummary");
    if (el && !el.classList.contains("hidden")) {
      el.scrollIntoView({ block: "nearest" });
      el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse");
    }
  }
}
function previewTrades() {
  const p = state.preview;
  if (!p) return null;
  const base = DATA.trades.filter(t => windowDays().includes(t.day));
  if (p.kind === "symbol") return base.filter(t => t.symbol === p.value);
  if (p.kind === "instrument") return base.filter(t => (t.instrument || "other") === p.value);
  if (p.kind === "action") return base.filter(t => t.action === p.value);
  if (p.kind === "obucket") return base.filter(t => (expiryBucket(t) || "unstated") === p.value);
  return [];
}
function outcomeClass(t) {
  const o = t.outcome;
  if (!o || !o.scored) return null;
  if (o.roundtrip && o.roundtrip.ret != null)
    return o.roundtrip.ret > 0.01 ? "fav" : o.roundtrip.ret < -0.01 ? "unf" : "flat";
  if (o.kind === "plan" && o.target != null) return o.tgt_hit ? "fav" : null;
  if (o.favorable === true) return "fav";
  if (o.favorable === false) return "unf";
  return "flat";
}
function rangeTrades() { return DATA.trades.filter(inRange); }
function fmtDay(d) {
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/* ---------- digest ---------- */
function renderDigest(trades) {
  const traders = new Set(trades.map(t => t.trader));
  const symCount = {};
  trades.forEach(t => { if (t.symbol) symCount[t.symbol] = (symCount[t.symbol] || 0) + 1; });
  const top = Object.entries(symCount).sort((a, b) => b[1] - a[1])[0];
  const calls = trades.filter(t => t.instrument === "call").length;
  const puts = trades.filter(t => t.instrument === "put").length;
  const pc = calls ? (puts / calls).toFixed(2) : puts ? "∞" : "–";
  const lean = trades.filter(t => OPEN.has(t.action)).length - trades.filter(t => CLOSE.has(t.action)).length;
  const leanLabel = lean > 0 ? `+${lean} accumulating` : lean < 0 ? `${lean} de-risking` : "balanced";
  const leanColor = lean > 0 ? "var(--green)" : lean < 0 ? "var(--red)" : "var(--muted)";
  const scored = trades.filter(t => t.outcome && t.outcome.scored);
  const fav = scored.filter(t => t.outcome.favorable === true).length;
  const unf = scored.filter(t => t.outcome.favorable === false).length;
  const flatN = scored.length - fav - unf;
  const ocTip = "How trades did over the next 5 trading days. Green = moved 1%+ in the trade's favor, red = 1%+ against, gray = stayed flat. Options are scored on the stock's direction, not the contract's profit. A plan's target counts as hit if the price touches it within 14 days.";
  $("digest").innerHTML = `
    <div class="stat"><div class="k">Trade actions <span class="tip" data-tip="Individual buy / sell / plan mentions the bot extracted from chat messages.">i</span></div><div class="v">${trades.length}</div><div class="s">${state.mode} · ${fmtRange()}</div></div>
    <div class="stat"><div class="k">Active traders <span class="tip" data-tip="How many anonymous members posted trades in this period.">i</span></div><div class="v">${traders.size}</div><div class="s">anonymous members</div></div>
    <div class="stat"><div class="k">Top symbol <span class="tip" data-tip="The most-mentioned symbol in this period.">i</span></div><div class="v">${top ? esc(top[0]) : "–"}</div><div class="s">${top ? top[1] + " actions" : ""}</div></div>
    <div class="stat"><div class="k">Put / call <span class="tip" data-tip="Bearish option bets divided by bullish ones. Above 1 means more downside bets than upside.">i</span></div><div class="v">${pc}</div><div class="s">${puts} puts · ${calls} calls</div></div>
    <div class="stat"><div class="k">Net lean <span class="tip" data-tip="Opening trades (buy, add) minus closing trades (sell, trim, exit). Positive means the group is putting money in; negative means taking it out.">i</span></div><div class="v" style="color:${leanColor}">${esc(leanLabel)}</div><div class="s">opens minus closes</div></div>
    <div class="stat"><div class="k">Outcomes <span class="tip" data-tip="${ocTip}">i</span></div><div class="v"><span style="color:var(--green)">${fav} ✓</span> · <span style="color:var(--red)">${unf} ✗</span></div><div class="s">${flatN} flat · ${scored.length} scored</div></div>`;
}
function fmtRange() {
  const w = windowDays();
  return w.length === 1 ? fmtDay(w[0]) : `${fmtDay(w[0])} → ${fmtDay(w[w.length - 1])}`;
}

/* ---------- charts ---------- */
function donut(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  let a0 = 0;
  const segs = Object.entries(counts).map(([k, v]) => {
    const frac = v / total, a1 = a0 + frac * 360;
    const large = frac > 0.5 ? 1 : 0;
    const p = a => [50 + 38 * Math.cos((a - 90) * Math.PI / 180), 50 + 38 * Math.sin((a - 90) * Math.PI / 180)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    const s = `<path d="M50,50 L${x0.toFixed(1)},${y0.toFixed(1)} A38,38 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${INST_COLORS[k] || INST_COLORS.other}"/>`;
    a0 = a1;
    return s;
  }).join("");
  return `<svg viewBox="0 0 100 100" width="150" height="150">${segs}<circle cx="50" cy="50" r="22" fill="var(--panel)"/><text x="50" y="55" text-anchor="middle" fill="var(--text)" font-size="13" font-weight="700">${total}</text></svg>`;
}
function hbars(rows, colorFor) {
  const max = Math.max(...rows.map(r => r[1]), 1);
  return rows.map(([lbl, n]) => `
    <div class="hbar-row tap" data-lbl="${esc(lbl)}"><span class="lbl">${esc(lbl)}</span>
      <div class="hbar-track"><div class="hbar-fill" style="width:${(n / max * 100).toFixed(1)}%;background:${colorFor(lbl)}"></div></div>
      <span class="num">${n}</span></div>`).join("");
}

/* ---------- tape ---------- */
function instLabel(t) {
  const parts = [];
  if (t.instrument && t.instrument !== "stock") parts.push(t.instrument);
  else if (t.instrument === "stock") parts.push("shares");
  if (t.strike) parts.push("$" + t.strike);
  if (t.expiry) parts.push(t.expiry);
  if (t.price) parts.push("@" + t.price);
  if (t.quantity) parts.push("× " + t.quantity);
  return parts.join(" ");
}
function pctStr(x) { return (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%"; }
/* Outcome badge — reads t.outcome identically from static JSON or Supabase.
   Same field shape both ways, so switching the data source changes nothing. */
function outcomeBadge(t) {
  const o = t.outcome;
  if (!o || !o.scored) return "";
  if (o.kind === "plan" && o.target != null) {
    if (o.tgt_hit)
      return `<span class="tipx oc oc-hit" data-tip="The price hit the $${o.target} target on ${o.target_hit_day}.">✓ target hit</span>`;
    return `<span class="tipx oc oc-pend" data-tip="Announced target: $${o.target}. Counts as hit if the price touches it within 14 days.">target $${o.target}</span>`;
  }
  const rt = o.roundtrip ? ` · closed ${pctStr(o.roundtrip.ret)}` : "";
  const what = o.kind === "exit"
    ? `In the 5 trading days after the exit the price moved ${pctStr(o.ret)}${rt}.`
    : `Over the next 5 trading days the underlying moved ${pctStr(o.ret)}${rt}. Options are scored on the stock's direction, not the contract's profit.`;
  if (o.favorable === true)
    return `<span class="tipx oc oc-good" data-tip="${esc(what)} ✓ = moved 1%+ in the trade's favor.">✓ ${pctStr(o.ret)}</span>`;
  if (o.favorable === false)
    return `<span class="tipx oc oc-bad" data-tip="${esc(what)} ✗ = moved 1%+ against the trade.">✗ ${pctStr(o.ret)}</span>`;
  return `<span class="tipx oc oc-flat" data-tip="${esc(what)} – = stayed within 1% (flat).">${pctStr(o.ret)}</span>`;
}
function renderTape(trades) {
  const el = $("tape");
  if (!trades.length) { el.innerHTML = `<div class="empty">No trade actions in this range.</div>`; return; }
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);
  let html = "", lastDay = "";
  for (const t of sorted) {
    if (t.day !== lastDay) { html += `<div class="day-head">${fmtDay(t.day)}</div>`; lastDay = t.day; }
    html += `<div class="trow">
      <div class="ttime">${timeFmt.format(new Date(t.ts * 1000))}</div>
      <div class="tmain">
        <div class="tline1">
          <span class="badge b-${t.action}">${t.action}</span>
          <span class="tsym">${esc(t.symbol || "—")}</span>
          <span class="tinst">${esc(instLabel(t))}</span>
          <span class="conf ${t.confidence}" title="${t.confidence} confidence"></span>
          ${outcomeBadge(t)}
          <span class="ttrader">${esc(t.trader)}</span>
        </div>
        ${t.note ? `<div class="tnote">${esc(t.note)}</div>` : ""}
      </div></div>`;
  }
  el.innerHTML = html;
  const chip = $("tapeFilter");
  const bits = [];
  if (state.trader) bits.push(`<b>${esc(state.trader)}</b>`);
  if (state.symbol) bits.push(`<b>${esc(state.symbol)}</b>`);
  if (state.instrument) bits.push(`<b>${esc(state.instrument)}</b>`);
  if (state.action) bits.push(`<b>${esc(state.action)}</b>`);
  if (state.obucket) bits.push(`<b>${esc(state.obucket)}</b>`);
  if (state.ofav) bits.push(`<b>${state.ofav === "fav" ? "✓ favorable" : state.ofav === "unf" ? "✗ unfavorable" : "– flat"}</b>`);
  if (bits.length) {
    chip.classList.remove("hidden");
    chip.innerHTML = `Filtered: ${bits.join(" · ")} ✕`;
    chip.onclick = () => { clearFilters(); render(); };
  } else chip.classList.add("hidden");
  renderTapeFilters();
  renderSliceSummary(trades);
}

/* filter dropdowns on the tape — always visible on the Market tab */
function renderTapeFilters() {
  const wrap = $("tapeFilters");
  wrap.classList.remove("hidden");
  const traders = [...new Set(DATA.trades.map(t => t.trader))]
    .sort((a, b) => a === "You" ? -1 : b === "You" ? 1 : a.localeCompare(b, undefined, { numeric: true }));
  const syms = [...new Set(DATA.trades.filter(t => t.symbol).map(t => t.symbol))].sort();
  const sel = (id, label, opts, cur) => `
    <label class="tfilter"><span>${label}</span>
      <select id="${id}">${opts.map(o => `<option value="${o.v}"${o.v === cur ? " selected" : ""}>${o.t}</option>`).join("")}</select>
    </label>`;
  wrap.innerHTML =
    sel("fTrader", "Trader",
      [{ v: "", t: "All" }].concat(traders.map(x => ({ v: x, t: x }))),
      state.trader || "") +
    sel("fSym", "Symbol",
      [{ v: "", t: "All" }].concat(syms.map(s => ({ v: s, t: s }))),
      state.symbol || "") +
    sel("fInst", "Instrument",
      [{ v: "", t: "All" }].concat(["stock", "call", "put", "spread", "crypto", "other"].map(i => ({ v: i, t: i }))),
      state.instrument || "") +
    sel("fAct", "Action",
      [{ v: "", t: "All" }].concat(["BUY", "ADD", "SELL", "TRIM", "EXIT", "PLAN", "HOLD", "WATCH"].map(a => ({ v: a, t: a }))),
      state.action || "") +
    sel("fOc", "Outcome",
      [{ v: "", t: "All" }, { v: "fav", t: "✓ favorable" }, { v: "unf", t: "✗ unfavorable" }, { v: "flat", t: "– flat" }],
      state.ofav || "");
  $("fTrader").onchange = e => { state.trader = e.target.value || null; render(); };
  $("fSym").onchange = e => { state.symbol = e.target.value || null; render(); };
  $("fInst").onchange = e => { state.instrument = e.target.value || null; render(); };
  $("fAct").onchange = e => { state.action = e.target.value || null; render(); };
  $("fOc").onchange = e => { state.ofav = e.target.value || null; render(); };
}

/* summary of a slice — either the active filters or the tapped card's preview */
function sliceStatsBits(list) {
  const traders = new Set();
  let fav = 0, unf = 0, flat = 0, rt = 0, tgtHit = 0, tgt = 0;
  const rets = [];
  list.forEach(t => {
    traders.add(t.trader);
    const c = outcomeClass(t);
    if (!c) return;
    if (c === "fav") fav++; else if (c === "unf") unf++; else flat++;
    const o = t.outcome;
    const r = (o.roundtrip && o.roundtrip.ret != null) ? o.roundtrip.ret : o.ret;
    if (r != null) rets.push(r);
    if (o.roundtrip && o.roundtrip.ret != null) rt++;
    if (o.kind === "plan" && o.target != null) { tgt++; if (o.tgt_hit) tgtHit++; }
  });
  const scored = fav + unf + flat;
  const avg = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null;
  const bits = [`<b>${list.length}</b> action${list.length === 1 ? "" : "s"}`];
  bits.push(`<b>${traders.size}</b> trader${traders.size === 1 ? "" : "s"}`);
  if (scored) bits.push(`${fav} ✓ · ${unf} ✗ · ${flat} – <span class="tc-sub">of ${scored} scored</span>`);
  if (fav + unf) bits.push(`hit rate <b>${Math.round(fav / (fav + unf) * 100)}%</b>`);
  if (avg != null) bits.push(`avg move <b style="color:${avg >= 0 ? "var(--green)" : "var(--red)"}">${pctStr(avg)}</b>`);
  if (rt) bits.push(`<b>${rt}</b> round trip${rt === 1 ? "" : "s"} closed`);
  if (tgt) bits.push(`<b>${tgtHit}/${tgt}</b> targets hit`);
  return bits;
}
function renderSliceSummary(trades) {
  const wrap = $("sliceSummary");
  const p = state.preview;
  let list = null, label = "", isPrev = false;
  if (p) {
    list = previewTrades(); label = p.value; isPrev = true;
  } else {
    const anyFilter = state.symbol || state.trader || state.instrument || state.action || state.obucket || state.ofav;
    if (!anyFilter) { wrap.classList.add("hidden"); wrap.innerHTML = ""; return; }
    list = trades;
    label = [state.trader, state.symbol, state.instrument, state.action, state.obucket,
      state.ofav === "fav" ? "✓ favorable" : state.ofav === "unf" ? "✗ unfavorable" : state.ofav === "flat" ? "– flat" : null
    ].filter(Boolean).join(" · ");
  }
  wrap.classList.remove("hidden");
  const bits = sliceStatsBits(list);
  wrap.innerHTML = `<div class="ss-label">${esc(label)}${isPrev ? ` <button id="ssX" class="ss-x" aria-label="dismiss">✕</button>` : ""}</div>` +
    `<div class="ss-stats">${bits.join("<span class='ss-dot'>·</span>")}</div>`;
  if (isPrev) $("ssX").onclick = e => { e.stopPropagation(); state.preview = null; render(); };
}

/* ---------- side panels ---------- */
function renderSide(trades) {
  const inst = {};
  trades.forEach(t => { const k = t.instrument || "other"; inst[k] = (inst[k] || 0) + 1; });
  $("donut").innerHTML = donut(inst);
  $("donutLegend").innerHTML = Object.entries(inst).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="tap ${isPreview("instrument", k) ? "factive" : ""}" data-inst="${esc(k)}"><span class="dot" style="background:${INST_COLORS[k] || INST_COLORS.other}"></span>${k} · ${v}</span>`).join("");
  document.querySelectorAll("#donutLegend .tap").forEach(el => {
    el.onclick = () => setPreview("instrument", el.dataset.inst);
  });

  const acts = {};
  trades.forEach(t => { acts[t.action] = (acts[t.action] || 0) + 1; });
  $("actionBars").innerHTML = hbars(
    Object.entries(acts).sort((a, b) => b[1] - a[1]),
    lbl => ACTION_COLORS[lbl] || "#8a94a6");
  document.querySelectorAll("#actionBars .hbar-row").forEach(el => {
    el.classList.toggle("factive", isPreview("action", el.dataset.lbl));
    el.onclick = () => setPreview("action", el.dataset.lbl);
  });

  const sym = {};
  trades.forEach(t => {
    if (!t.symbol) return;
    sym[t.symbol] = sym[t.symbol] || { n: 0, net: 0 };
    sym[t.symbol].n++;
    if (OPEN.has(t.action)) sym[t.symbol].net++;
    if (CLOSE.has(t.action)) sym[t.symbol].net--;
  });
  const rows = Object.entries(sym).sort((a, b) => b[1].n - a[1].n).slice(0, 12);
  $("leaderboard").innerHTML = rows.length ? rows.map(([s, d]) => `
    <div class="sym-row ${isPreview("symbol", s) ? "active" : ""}" data-sym="${esc(s)}">
      <div class="sym-top"><span class="s">${esc(s)}</span>
        <span class="net ${d.net > 0 ? "pos" : d.net < 0 ? "neg" : "flat"}">${d.net > 0 ? "+" : ""}${d.net}</span></div>
      <div class="hbar-track" style="margin-top:4px"><div class="hbar-fill" style="width:${(d.n / rows[0][1].n * 100).toFixed(0)}%;background:var(--blue)"></div></div>
      <div style="font-size:11px;color:var(--muted);margin-top:2px">${d.n} actions</div>
    </div>`).join("")
    : `<div class="empty">No symbols in range.</div>`;
  document.querySelectorAll(".sym-row").forEach(el => {
    el.onclick = () => setPreview("symbol", el.dataset.sym);
  });
}

/* ---------- clusters ---------- */
function renderClusters(trades) {
  const by = {};
  trades.forEach(t => {
    if (!t.symbol) return;
    by[t.symbol] = by[t.symbol] || { traders: new Set(), n: 0, net: 0 };
    by[t.symbol].traders.add(t.trader); by[t.symbol].n++;
    if (OPEN.has(t.action)) by[t.symbol].net++;
    if (CLOSE.has(t.action)) by[t.symbol].net--;
  });
  const clusters = Object.entries(by).filter(([, d]) => d.traders.size >= 3)
    .sort((a, b) => b[1].traders.size - a[1].traders.size);
  $("clusters").innerHTML = clusters.length ? clusters.map(([s, d]) => `
    <div class="cluster tap ${isPreview("symbol", s) ? "factive" : ""}" data-sym="${esc(s)}"><div class="cs">${esc(s)}</div>
      <div class="cm">${d.traders.size} traders · ${d.n} actions</div>
      <div class="ca net ${d.net > 0 ? "pos" : d.net < 0 ? "neg" : "flat"}">net ${d.net > 0 ? "+" : ""}${d.net}</div>
    </div>`).join("")
    : `<div class="empty">No symbol was traded by 3+ members in this range.</div>`;
  document.querySelectorAll(".cluster").forEach(el => {
    el.onclick = () => setPreview("symbol", el.dataset.sym);
  });
}

/* ---------- options lens & plans ---------- */
function expiryBucket(t) {
  if (!t.expiry || !/^\d{4}-\d{2}$/.test(t.expiry)) return null;
  const [ey, em] = t.expiry.split("-").map(Number);
  const [dy, dm] = t.day.split("-").map(Number);
  const months = (ey - dy) * 12 + (em - dm);
  if (months <= 1) return "≤ 1 month";
  if (months <= 6) return "1–6 months";
  return "LEAPS (> 6 mo)";
}
function renderOptions(trades) {
  const opts = trades.filter(t => ["call", "put", "spread"].includes(t.instrument));
  const buckets = { "≤ 1 month": [], "1–6 months": [], "LEAPS (> 6 mo)": [], "unstated": [] };
  opts.forEach(t => (buckets[expiryBucket(t) || "unstated"]).push(t));
  const max = Math.max(...Object.values(buckets).map(b => b.length), 1);
  $("optionsLens").innerHTML = Object.entries(buckets).map(([k, arr]) => `
    <div class="opt-bucket tap ${isPreview("obucket", k) ? "factive" : ""}" data-obucket="${esc(k)}">
      <div class="ob-head"><b>${k}</b><span>${arr.length}</span></div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${(arr.length / max * 100).toFixed(0)}%;background:var(--amber)"></div></div>
      ${arr.slice(0, 4).map(t => `<div class="opt-ex">${esc(t.symbol || "?")} ${esc(t.instrument)}${t.strike ? " $" + t.strike : ""}${t.expiry ? " " + t.expiry : ""} · ${t.action}</div>`).join("")}
    </div>`).join("") || `<div class="empty">No options in range.</div>`;
  document.querySelectorAll(".opt-bucket").forEach(el => {
    el.onclick = () => setPreview("obucket", el.dataset.obucket);
  });
}
function renderPlans() {
  const endD = new Date(state.end + "T12:00:00");
  const cutoff = new Date(endD); cutoff.setDate(cutoff.getDate() - 14);
  const plans = DATA.trades
    .filter(t => t.action === "PLAN" && t.day <= state.end && t.day >= cutoff.toISOString().slice(0, 10))
    .sort((a, b) => b.ts - a.ts).slice(0, 8);
  $("plans").innerHTML = plans.length ? plans.map(t => `
    <div class="plan-row tap ${isPreview("symbol", t.symbol) ? "factive" : ""}" data-sym="${esc(t.symbol || "")}"><b>${esc(t.symbol || "—")}</b> <span class="tinst">${esc(instLabel(t))}</span>
      <div class="tnote">${esc(t.note)}</div>
      <div class="pd">${fmtDay(t.day)} · ${esc(t.trader)}</div></div>`).join("")
    : `<div class="empty">No planned/conditional orders in the last 14 days.</div>`;
  document.querySelectorAll(".plan-row").forEach(el => {
    el.onclick = () => {
      if (!el.dataset.sym) return;
      setPreview("symbol", el.dataset.sym);
    };
  });
}

/* ---------- heatmap ---------- */
function renderHeatmap() {
  const counts = {};
  DATA.trades.forEach(t => { counts[t.day] = (counts[t.day] || 0) + 1; });
  const endD = new Date(state.end + "T12:00:00");
  const cells = [];
  for (let i = 59; i >= 0; i--) {
    const d = new Date(endD); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10), n = counts[key] || 0;
    const a = n === 0 ? 0 : Math.min(0.25 + n / 12, 1);
    cells.push(`<div class="hm-cell tap" data-day="${key}" data-tip="${fmtDay(key)} · ${n}" style="background:rgba(38,166,154,${a.toFixed(2)})"></div>`);
  }
  $("heatmap").innerHTML = cells.join("");
  document.querySelectorAll(".hm-cell").forEach(el => {
    el.onclick = () => {
      state.mode = "day"; state.end = el.dataset.day; clearFilters(); render();
      window.scrollTo(0, 0);
    };
  });
}

/* ---------- traders tab ---------- */
function renderTraders() {
  const inWin = new Set(windowDays());
  $("tradersRange").textContent = `${fmtRange()} · anonymous`;
  const by = {};
  DATA.trades.filter(t => inWin.has(t.day)).forEach(t => {
    const d = by[t.trader] = by[t.trader] || {
      n: 0, days: new Set(), sym: {}, inst: {},
      fav: 0, unf: 0, flat: 0, rt: [], tgtHit: 0, tgt: 0,
    };
    d.n++; d.days.add(t.day);
    if (t.symbol) d.sym[t.symbol] = (d.sym[t.symbol] || 0) + 1;
    const k = t.instrument || "other"; d.inst[k] = (d.inst[k] || 0) + 1;
    const o = t.outcome;
    if (o && o.scored) {
      if (o.kind === "plan" && o.target != null) { d.tgt++; if (o.tgt_hit) d.tgtHit++; }
      else if (o.favorable === true) d.fav++;
      else if (o.favorable === false) d.unf++;
      else d.flat++;
      if (o.roundtrip && o.roundtrip.ret != null) d.rt.push(o.roundtrip.ret);
    }
  });
  let rows = Object.entries(by).map(([name, d]) => ({ name, ...d, scored: d.fav + d.unf + d.flat }));
  const rate = r => r.scored ? r.fav / r.scored : -1;
  rows.sort(state.traderSort === "record"
    ? (a, b) => rate(b) - rate(a) || b.scored - a.scored
    : (a, b) => b.n - a.n);
  if (!rows.length) {
    $("traderCards").innerHTML = `<div class="empty">No trade actions in this range.</div>`;
    return;
  }
  $("traderCards").innerHTML = rows.map(r => {
    const topSym = Object.entries(r.sym).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const instMix = Object.entries(r.inst).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const avgRt = r.rt.length ? r.rt.reduce((a, b) => a + b, 0) / r.rt.length : null;
    const small = r.scored > 0 && r.scored < 5;
    return `<div class="tcard" data-trader="${esc(r.name)}">
      <div class="tc-head"><b>${esc(r.name)}</b>
        <span class="tc-meta">${r.n} actions · ${r.days.size} days</span></div>
      <div class="tc-record">
        <span style="color:var(--green)">${r.fav} ✓</span> ·
        <span style="color:var(--red)">${r.unf} ✗</span> ·
        <span style="color:var(--muted)">${r.flat} –</span>
        <span class="tc-sub">${r.scored} scored</span>
        ${small ? `<span class="tipx oc oc-pend" data-tip="Only ${r.scored} scored trades — too few to judge a track record.">small sample</span>` : ""}
      </div>
      ${topSym.length ? `<div class="tc-row"><span class="tc-k">Favorites</span> ${topSym.map(([s, n]) => `${esc(s)} ×${n}`).join(" · ")}</div>` : ""}
      ${instMix.length ? `<div class="tc-row"><span class="tc-k">Mix</span> ${instMix.map(([k, n]) => `${k} ×${n}`).join(" · ")}</div>` : ""}
      ${r.rt.length ? `<div class="tc-row"><span class="tc-k">Round trips</span> ${r.rt.length} closed · avg <b style="color:${avgRt >= 0 ? "var(--green)" : "var(--red)"}">${pctStr(avgRt)}</b></div>` : ""}
      ${r.tgt ? `<div class="tc-row"><span class="tc-k">Targets</span> ${r.tgtHit}/${r.tgt} hit</div>` : ""}
    </div>`;
  }).join("");
  document.querySelectorAll(".tcard").forEach(el => {
    el.onclick = () => {
      state.trader = el.dataset.trader;
      state.tab = "market";
      render();
      window.scrollTo(0, 0);
    };
  });
}

/* ---------- shell ---------- */
function render() {
  document.querySelectorAll("#tabSeg button").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === state.tab));
  $("marketView").classList.toggle("hidden", state.tab !== "market");
  $("tradersView").classList.toggle("hidden", state.tab !== "traders");
  $("dateLabel").textContent = fmtRange();
  const days = DATA.day_range;
  $("prevBtn").disabled = windowDays()[0] <= days[0];
  $("nextBtn").disabled = state.end >= days[1];
  document.querySelectorAll("#rangeSeg button").forEach(b =>
    b.classList.toggle("active", b.dataset.mode === state.mode));
  if (state.tab === "traders") { renderTraders(); return; }
  const trades = rangeTrades();
  renderDigest(trades);
  renderTape(trades);
  renderSide(trades);
  renderClusters(trades);
  renderOptions(trades);
  renderPlans();
  renderHeatmap();
}
function shift(dir) {
  const step = state.mode === "day" ? 1 : state.mode === "week" ? 7 : 30;
  const d = new Date(state.end + "T12:00:00");
  d.setDate(d.getDate() + dir * step);
  state.end = d.toISOString().slice(0, 10);
  const [lo, hi] = DATA.day_range;
  if (state.end < lo) state.end = lo;
  if (state.end > hi) state.end = hi;
  state.preview = null;
  render();
}

async function loadData() {
  // Prefer live Supabase data when configured; fall back to the baked-in
  // static JSON (used before migration, or if Supabase is unreachable/empty).
  const cfg = window.TRADE_FLOW || {};
  if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) {
    try {
      const base = cfg.SUPABASE_URL.replace(/\/$/, "");
      const headers = { apikey: cfg.SUPABASE_ANON_KEY, Authorization: "Bearer " + cfg.SUPABASE_ANON_KEY };
      const [tr, me] = await Promise.all([
        fetch(base + "/rest/v1/wa_trades?select=*&order=ts.asc", { headers })
          .then(r => { if (!r.ok) throw new Error("trades " + r.status); return r.json(); }),
        fetch(base + "/rest/v1/wa_meta?select=*", { headers })
          .then(r => (r.ok ? r.json() : [])).catch(() => []),
      ]);
      if (Array.isArray(tr) && tr.length) {
        const trades = tr.map(row => ({
          day: row.day, ts: Number(row.ts), trader: row.trader, action: row.action,
          symbol: row.symbol, instrument: row.instrument, strike: row.strike,
          expiry: row.expiry, price: row.price, quantity: row.quantity,
          confidence: row.confidence, note: row.note,
          target: row.target, outcome: row.outcome || null,
        }));
        const days = [...new Set(trades.map(t => t.day))].sort();
        const meta = Object.fromEntries((me || []).map(m => [m.key, m.value]));
        return {
          generated: meta.last_push || "",
          day_range: [days[0], days[days.length - 1]],
          n_traders: new Set(trades.map(t => t.trader)).size,
          trades, live: true,
        };
      }
    } catch (e) { console.warn("supabase unavailable, using static data:", e.message); }
  }
  const res = await fetch("data/trades.json");
  return await res.json();
}

async function init() {
  DATA = await loadData();
  state.end = DATA.day_range[1];
  // Guide panel: show on first visit, remember dismissal
  try {
    if (localStorage.getItem("tradeflow_guide_seen")) $("guide").classList.add("hidden");
  } catch (e) { /* storage unavailable — leave guide visible */ }
  $("guideBtn").onclick = () => $("guide").classList.toggle("hidden");
  $("guideClose").onclick = () => {
    $("guide").classList.add("hidden");
    try { localStorage.setItem("tradeflow_guide_seen", "1"); } catch (e) {}
  };
  // Tapping an ⓘ toggles its tooltip (touch devices have no hover)
  document.addEventListener("click", e => {
    const tip = e.target.closest ? e.target.closest(".tip, .tipx") : null;
    document.querySelectorAll(".tip.show, .tipx.show").forEach(t => { if (t !== tip) t.classList.remove("show"); });
    if (tip) tip.classList.toggle("show");
  });
  $("generated").textContent = "data through " + fmtDay(DATA.day_range[1]) + (DATA.live ? " · live" : "");
  document.querySelectorAll("#rangeSeg button").forEach(b =>
    b.onclick = () => { state.mode = b.dataset.mode; clearFilters(); render(); });
  document.querySelectorAll("#tabSeg button").forEach(b =>
    b.onclick = () => { state.tab = b.dataset.tab; render(); });
  document.querySelectorAll("#traderSortSeg button").forEach(b =>
    b.onclick = () => {
      state.traderSort = b.dataset.sort;
      document.querySelectorAll("#traderSortSeg button").forEach(x =>
        x.classList.toggle("active", x === b));
      renderTraders();
    });
  $("prevBtn").onclick = () => shift(-1);
  $("nextBtn").onclick = () => shift(1);
  $("todayBtn").onclick = () => { state.end = DATA.day_range[1]; state.preview = null; render(); };
  render();
}
init();
