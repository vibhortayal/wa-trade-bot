const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = iso => {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
};
const pill = (ok, t) => `<span class="${ok ? "ok" : "bad"}">●</span> ${t}`;

async function refresh() {
  const s = await fetch("api/status").then(r => r.json());
  const rows = [
    ["WhatsApp", s.wa_paired ? pill(true, "linked") :
      s.pairing === "waiting" ? `<span class="warn">●</span> waiting for code` :
      s.pairing === "failed" ? pill(false, "failed — " + esc(s.pairing_error || "")) :
      pill(false, "not linked")],
    ["Last pull", ago(s.last_pull)],
    ["Messages parsed", `${s.parsed_messages} <span class="k">(${s.parsed_actions} actions, ${ago(s.last_parse)})</span>`],
    ["Gemini key", s.gemini_configured ? pill(true, "set") : pill(false, "missing")],
    ["Supabase", s.supabase_configured ? pill(true, "set") : pill(false, "missing")],
  ];
  $("status").innerHTML = rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("");
  if (s.wa_paired) {
    $("pairBox").querySelector("button").disabled = true;
    $("pairOut").innerHTML = `<p class="hint">✓ This machine is linked. No need to pair again.</p>`;
  }
}

$("pairBtn").onclick = async () => {
  const phone = $("phone").value.replace(/\D/g, "");
  $("pairBtn").disabled = true;
  $("pairOut").innerHTML = `<p class="hint">Contacting WhatsApp…</p>`;
  try {
    const r = await fetch("api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }) }).then(r => r.json());
    if (r.already) { $("pairOut").innerHTML = `<p class="hint">Already linked.</p>`; }
    else if (r.code) {
      $("pairOut").innerHTML = `<div class="code">${esc(r.code)}</div>
        <p class="hint">Type this code into WhatsApp on your phone now. This page will show “linked” once pairing completes (refresh status in ~30s).</p>`;
    } else throw new Error(r.error || "unknown error");
  } catch (e) { $("pairOut").innerHTML = `<p class="hint" style="color:var(--red)">Failed: ${esc(e.message)}</p>`; }
  $("pairBtn").disabled = false;
  setTimeout(refresh, 5000);
};

$("saveKeys").onclick = async () => {
  const body = { gemini_key: $("geminiKey").value, supabase_url: $("sbUrl").value, supabase_service_key: $("sbKey").value };
  const r = await fetch("api/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
  $("keysMsg").innerHTML = r.saved && r.saved.length
    ? `<span class="ok">Saved: ${r.saved.join(", ")}. Fields cleared.</span>`
    : `<span class="warn">Nothing to save — fill in at least one field.</span>`;
  $("geminiKey").value = $("sbUrl").value = $("sbKey").value = "";
  refresh();
};

$("runBtn").onclick = async () => {
  $("runBtn").disabled = true;
  await fetch("api/run", { method: "POST" });
  $("runMsg").innerHTML = `<span class="warn">Cycle started — watch the log below.</span>`;
  setTimeout(() => { loadLog(); $("runBtn").disabled = false; refresh(); }, 15000);
};

async function loadLog() {
  const r = await fetch("api/logs").then(r => r.json());
  $("log").textContent = r.log || "(empty)";
  $("log").scrollTop = $("log").scrollHeight;
}
$("refreshLog").onclick = loadLog;

refresh();
loadLog();
setInterval(refresh, 30000);
