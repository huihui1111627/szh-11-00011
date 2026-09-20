/* 多策略同步对照：指标表 + 历史火花线 */
(function () {
  const MLS = window.MLS;
  MLS.ui = MLS.ui || {};

  function open() {
    document.getElementById("compare-drawer").classList.remove("hidden");
    render();
  }
  function close() {
    document.getElementById("compare-drawer").classList.add("hidden");
  }

  function metrics(st) {
    const s = st.state;
    const alive = Object.values(s.crew).filter((c) => !c.incapacitated).length;
    const { eta } = MLS.engine.baseEta(s);
    const h = s.history[s.history.length - 1] || {};
    return {
      name: st.name, color: st.color, t: s.t, ended: s.ended,
      alive, total: Object.keys(s.crew).length,
      eta,
      battery: s.power.battery,
      o2: h.o2Min ?? 0, co2: h.co2Max ?? 0, p: h.pMin ?? 0,
      water: (h.water || 0) / 1000,
      events: s.events.filter((e) => e.level === "alarm").length,
    };
  }

  function bestKey(rows, key, higherBetter) {
    const valid = rows.filter((r) => r.ended ? r.ended.win : true);
    if (!valid.length) return null;
    let best = valid[0][key];
    for (const r of valid) if (higherBetter ? r[key] > best : r[key] < best) best = r[key];
    return best;
  }

  function render() {
    const rows = MLS.store.strategies.map(metrics);
    const etaBest = Math.max(...rows.map((r) => r.eta));
    const aliveBest = Math.max(...rows.map((r) => r.alive));
    const battBest = Math.max(...rows.map((r) => r.battery));

    const winRow = (r) => r.ended
      ? `<span class="cmp-outcome ${r.ended.win ? "win" : "lose"}">${r.ended.win ? "✔ 救援成功" : "✖ 推演失败"}</span>`
      : '<span style="color:#7f92a6">推演中…</span>';

    let html = `
      <table class="cmp-table">
        <tr><th>策略</th><th>状态</th><th>推演时刻</th><th>生还</th><th>保障余量</th><th>电池 kWh</th><th>最低 O₂ kPa</th><th>最高 CO₂ kPa</th><th>最低舱压 kPa</th><th>水量 kg</th><th>告警</th><th></th></tr>`;

    rows.forEach((r) => {
      html += `<tr${MLS.store.activeId === MLS.store.strategies.find((s) => s.name === r.name)?.id ? ' class="cmp-sep"' : ""}>
        <td><span style="color:${r.color}">●</span> ${MLS.esc(r.name)}</td>
        <td>${winRow(r)}</td>
        <td>T+${MLS.clockStr(r.t)}</td>
        <td class="${r.alive === aliveBest ? "col-best" : ""}">${r.alive}/${r.total}</td>
        <td class="${r.eta === etaBest ? "col-best" : ""}">${r.eta === Infinity ? "充足" : MLS.durStr(r.eta)}</td>
        <td class="${r.battery === battBest ? "col-best" : ""}">${r.battery.toFixed(1)}</td>
        <td>${r.o2.toFixed(1)}</td>
        <td>${r.co2.toFixed(2)}</td>
        <td>${r.p.toFixed(0)}</td>
        <td>${r.water.toFixed(0)}</td>
        <td>${r.events}</td>
        <td><button class="btn small ghost cmp-go" data-name="${MLS.esc(r.name)}">查看</button></td>
      </tr>`;
    });
    html += `</table>`;

    html += sparkBlock("基地剩余保障时间（秒，越高越好）", "eta", 3600 * 8, MLS.durStr);
    html += sparkBlock("存活人数", "alive", Object.keys(MLS.store.active.state.crew).length, (v) => v.toFixed(0));
    html += sparkBlock("最低舱压 kPa", "pMin", 110, (v) => v.toFixed(0));
    html += sparkBlock("电池储量 kWh", "battery", C_battery(), (v) => v.toFixed(1));
    html += `<div class="cmp-legend">
      ${MLS.store.strategies.map((s) => `<span><i style="background:${s.color}"></i>${MLS.esc(s.name)}</span>`).join("")}
    </div>`;

    document.getElementById("compare-body").innerHTML = html;
    document.querySelectorAll(".cmp-go").forEach((b) => {
      b.addEventListener("click", () => {
        const name = b.getAttribute("data-name");
        const st = MLS.store.strategies.find((x) => x.name === name);
        if (st) { MLS.store.activate(st.id); close(); }
      });
    });
  }

  function C_battery() { return MLS.CONFIG.SCENE.batteryKWh; }

  function sparkBlock(title, key, max, fmt) {
    const W = 720, H = 80, PAD = 30;
    const all = MLS.store.strategies.map((s) => s.state.history);
    const tMax = Math.max(1, ...all.map((h) => h.length ? h[h.length - 1].t : 0));
    let paths = "";
    MLS.store.strategies.forEach((s, si) => {
      const h = s.state.history;
      if (h.length < 2) return;
      const pts = h.map((row) => {
        const x = PAD + (row.t / tMax) * (W - PAD - 8);
        const v = key === "eta" ? (row.eta >= 359999 ? max : Math.min(row.eta, max)) : row[key];
        const y = H - 8 - (MLS.clamp(v / max, 0, 1)) * (H - 18);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      paths += `<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="1.8"/>`;
    });
    const endVal = (s) => {
      const h = s.state.history;
      if (!h.length) return "—";
      const row = h[h.length - 1];
      const v = key === "eta" ? (row.eta >= 359999 ? Infinity : row.eta) : row[key];
      return v === Infinity ? "充足" : fmt(v);
    };
    const legend = MLS.store.strategies.map((s) =>
      `<span><i style="background:${s.color}"></i>${endVal(s)}</span>`).join("");
    return `<div class="cmp-spark"><h4>${title}</h4>
      <svg viewBox="0 0 ${W} ${H}">
        <line x1="${PAD}" y1="${H - 8}" x2="${W - 8}" y2="${H - 8}" stroke="#243243"/>
        <line x1="${PAD}" y1="10" x2="${PAD}" y2="${H - 8}" stroke="#243243"/>
        ${paths}
      </svg>
      <div class="cmp-legend">${legend}<span style="margin-left:auto">0 ──────── T+${MLS.clockStr(tMax)} ─→</span></div>
    </div>`;
  }

  MLS.ui.compare = { open, close, render };
})();
