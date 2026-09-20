/* 右侧检查器：舱室/管道/基地总览的详情与操作 */
(function () {
  const MLS = window.MLS;
  MLS.ui = MLS.ui || {};
  const C = MLS.CONFIG;

  const body = () => document.getElementById("inspector-body");

  function clsVal(v, lo, hi) { return v < lo ? "bad" : v < hi ? "warn" : "ok"; }

  function render() {
    const sel = MLS.store.selected;
    if (sel.kind === "edge") return edgePanel(sel.id);
    if (sel.kind === "node") return nodePanel(sel.id);
    return basePanel();
  }

  /* ---------- 基地总览 ---------- */
  function basePanel() {
    const state = MLS.store.active.state;
    const alive = Object.values(state.crew).filter((c) => !c.incapacitated).length;
    const { eta, where } = MLS.engine.baseEta(state);
    body().innerHTML = `
      <div class="insp-title">基地综合态势</div>
      <div class="insp-sub">点击左侧舱室或管道查看与操作</div>

      <div class="section">
        <div class="section-h">电力母线</div>
        ${metric("发电", state.power.supply.toFixed(2) + " kW")}
        ${metric("负载", state.power.load.toFixed(2) + " kW")}
        ${metric("已切除", state.power.shed.toFixed(2) + " kW", state.power.shed > 0 ? "warn" : "")}
        <div class="ctl-label"><span>电池 ${state.power.battery.toFixed(1)} / ${C.SCENE.batteryKWh} kWh</span></div>
        ${bar("bat", state.power.battery / C.SCENE.batteryKWh)}
        <div class="ctl-label"><span>太阳能出力 ${Math.round(state.power.solarFactor * 100)}%</span>
          <span>${state.t < C.SCENE.stormEndsAt ? "尘暴中" : "正常"}</span></div>
        ${state.power.blackout ? `<div class="insp-note">⚠ 全电网断电！立即启动备用燃料电池 FC1</div>` : ""}
      </div>

      <div class="section">
        <div class="section-h">生命保障</div>
        ${metric("存活乘员", alive + " / " + Object.keys(state.crew).length, alive < Object.keys(state.crew).length ? "warn" : "ok")}
        ${metric("最紧迫保障余量", eta === Infinity ? "充足" : MLS.durStr(eta) + (where ? "（" + C.NODES.find((n) => n.id === where)?.name + "）" : ""),
                 eta !== Infinity && eta < 1800 ? "bad" : eta !== Infinity && eta < 3600 ? "warn" : "ok")}
        ${metric("转移途中", state.transfers.length + " 人", state.transfers.length ? "warn" : "")}
      </div>

      <div class="section">
        <div class="section-h">启动母线</div>
        ${state.starter.busy > 0
          ? `<div class="insp-note">备用启动母线占用中，剩余 ${state.starter.busy} 秒（${state.starter.by}）。备用设备不能同时启动。</div>`
          : metric("母线状态", "空闲，可冷启动备用设备", "ok")}
      </div>

      <div class="section">
        <div class="section-h">快速操作</div>
        <div class="ctl-row">
          <button class="btn" data-act="toggleDevice" data-arg="FC1">${state.devices.FC1.on ? "关闭燃料电池" : "启动备用燃料电池"}</button>
        </div>
      </div>`;
    bindButtons();
  }

  /* ---------- 舱室面板 ---------- */
  function nodePanel(nid) {
    const def = C.NODES.find((n) => n.id === nid);
    const state = MLS.store.active.state;
    const n = state.nodes[nid];
    if (def.outside) {
      body().innerHTML = `<div class="insp-title">${def.name}</div>
        <div class="insp-sub">${def.en}</div>
        <div class="insp-note">舱外为火星稀薄大气（≈0.6 kPa），无活动服不可到达。</div>`;
      return;
    }
    const p = MLS.engine.press(n), o2 = MLS.engine.pO2(n), co2 = MLS.engine.pCO2(n);
    const people = MLS.engine.crewIn(state, nid);
    const eta = MLS.engine.nodeEta(state, nid);
    const devs = Object.values(state.devices).filter((d) => d.node === nid);

    body().innerHTML = `
      <div class="insp-title">${def.name}</div>
      <div class="insp-sub">${def.en} · 容积 ${def.vol} m³ · ${people.length} 人</div>

      ${n.leak ? `<div class="insp-note">⚠ 舱体破洞，泄漏速率 ${n._leakFlow ? n._leakFlow.toFixed(2) : "—"} mol/s
        ${n.repairing > 0 ? "，修补中（剩余 " + MLS.durStr(n.repairing) + "）" : ""}</div>` : ""}

      <div class="section">
        <div class="section-h">大气环境</div>
        ${metric("总压", p.toFixed(1) + " kPa", clsVal(p, LIM_PRESS.LO, LIM_PRESS.LO + 10))}
        ${bar(null, MLS.clamp(p / 101.3, 0, 1), "o2")}
        ${metric("O₂ 分压", o2.toFixed(2) + " kPa", o2 < MLS.LIM.O2_LO ? "bad" : o2 > MLS.LIM.O2_HI ? "warn" : "ok")}
        ${metric("CO₂ 分压", co2.toFixed(3) + " kPa", co2 > MLS.LIM.CO2_HI ? (co2 > MLS.LIM.CO2_CRIT ? "bad" : "warn") : "ok")}
        ${metric("N₂ 余量", n.gas.n2.toFixed(0) + " mol")}
      </div>

      <div class="section">
        <div class="section-h">水储备</div>
        ${metric("饮用水", (n.water / 1000).toFixed(1) + " kg")}
        ${bar("h2o", n.water / n.waterCap)}
        ${metric("废水", (n.waste / 1000).toFixed(1) + " kg")}
        ${people.length ? metric("人均保障",
          n.water / people.length < MLS.LIM.WATER_LO ? "< 8 小时" :
          MLS.durStr(n.water / people.length / (C.SCENE.crewWaterGS)),
          n.water / people.length < MLS.LIM.WATER_LO ? "bad" : "ok") : ""}
      </div>

      <div class="section">
        <div class="section-h">保障余量（当前净速率推算）</div>
        ${eta.o2 != null ? metric("氧气", MLS.durStr(eta.o2), eta.o2 < 1800 ? "bad" : "ok") : metric("氧气", "收支平衡", "ok")}
        ${eta.co2 != null ? metric("CO₂ 临界", MLS.durStr(eta.co2), eta.co2 < 1800 ? "warn" : "ok") : metric("CO₂", "安全", "ok")}
        ${eta.press != null ? metric("失压", MLS.durStr(eta.press), eta.press < 1800 ? "bad" : "ok") : metric("压力", "稳定", "ok")}
        ${eta.water != null ? metric("饮水", MLS.durStr(eta.water), eta.water < 14400 ? "warn" : "ok") : metric("饮水", "充足", "ok")}
      </div>

      <div class="section">
        <div class="section-h">氧气分配配额</div>
        <div class="ctl">
          <div class="ctl-label"><span>O₂ 分配比例（影响制氧机送向本舱的份额）</span>
            <span class="ctl-val" id="quota-val">${Math.round(n.o2Quota * 100)}%</span></div>
          <input type="range" id="quota-slider" min="0" max="200" step="10" value="${n.o2Quota * 100}">
        </div>
      </div>

      <div class="section">
        <div class="section-h">舱室设备（${devs.length}）</div>
        ${devs.map(deviceCard).join("")}
      </div>

      <div class="section">
        <div class="section-h">乘员（${people.length}）</div>
        ${people.map(crewRow).join("") || '<div class="insp-sub">舱内无人</div>'}
      </div>

      <div class="section">
        <div class="section-h">转移与舱段控制</div>
        ${people.map((c) => `
          <div class="ctl">
            <div class="ctl-label"><span>${c.name} 转移至</span></div>
            <select data-transfer="${c.id}">
              <option value="">— 选择目的地 —</option>
              ${C.NODES.filter((x) => !x.outside && x.id !== nid).map((x) =>
                `<option value="${x.id}">${x.name}</option>`).join("")}
            </select>
          </div>`).join("")}
        ${people.map((c) => `
          <div class="ctl">
            <div class="ctl-label"><span>${c.name} 活动强度</span></div>
            <div class="prio-pick">
              ${["rest", "normal", "work"].map((a) =>
                `<button data-activity="${c.id}" data-val="${a}" class="${c.activity === a ? "sel" : ""}">
                  ${a === "rest" ? "休息" : a === "normal" ? "正常" : "作业"}</button>`).join("")}
          </div></div>`).join("")}
        <div class="ctl-row">
          ${n.leak && !n.repairing
            ? `<button class="btn danger" data-act="repair" data-arg="${nid}">开始修补破洞（10分钟·需无人已隔离）</button>` : ""}
          ${n.leak && n.repairing > 0 ? `<button class="btn" disabled>修补中 ${MLS.durStr(n.repairing)}</button>` : ""}
        </div>
      </div>`;

    bindButtons();
    bindLiveControls(state, nid);
  }

  const LIM_PRESS = { LO: 75 };

  function deviceCard(d) {
    const t = C.DEVICE_TYPES[d.type];
    const stateMap = { running: ["on", "运行中"], starting: ["starting", `启动中 ${d.startLeft}s`],
      shed: ["fault", "已被电网切除"], off: ["", "已关闭"], fault: ["fault", "故障"] };
    const [sCls, sText] = stateMap[d.state] || ["", d.state];
    return `<div class="dev-card ${d.state === "off" ? "off" : ""} ${d.state === "shed" ? "fault" : ""}">
      <div class="dev-head">
        <span class="dev-name">${d.fixedLoadName || t.name}</span>
        <span class="dev-state ${sCls}">${sText}</span>
      </div>
      <div class="dev-meta">
        ${t.run ? `运行 ${t.run} kW` : ""}${t.supply ? ` 发电 ${t.supply} kW` : ""}
        ${t.surge ? ` · 冲击 ${t.surge + t.run} kW` : ""}
        ${d.fuel != null ? ` · 氢 ${MLS.durStr(d.fuel)}` : ""}
      </div>
      <div class="dev-meta">${t.desc || ""}</div>
      <div class="ctl-row">
        <button class="btn small" data-act="toggleDevice" data-arg="${d.id}">${d.on || d.state === "starting" ? "关闭" : "启动"}</button>
      </div>
      ${d.type !== "solar" && d.type !== "rtg" ? `
      <div class="prio-pick" title="供电紧张时数字越大越先被切除">
        ${[1, 2, 3, 4].map((p) =>
          `<button data-prio="${d.id}" data-val="${p}" class="${d.prio === p ? "sel" : ""}">P${p}</button>`).join("")}
      </div>` : ""}
    </div>`;
  }

  function crewRow(c) {
    return `<div class="crew-row ${c.incapacitated ? "incap" : ""}">
      <div class="avatar">${c.name[0]}</div>
      <div class="cname">${c.name} · ${c.role}${c.injured ? " 🩹" : ""}</div>
      <div class="chealth">${c.incapacitated ? "遇难" : "HP " + c.health.toFixed(0)}</div>
    </div>`;
  }

  /* ---------- 管道面板 ---------- */
  function edgePanel(eid) {
    const def = C.EDGES.find((e) => e.id === eid);
    const state = MLS.store.active.state;
    const e = state.edges[eid];
    if (!def) return basePanel();
    const typeName = { gas: "气体管道 / 气闸", water: "水管阀门", power: "电力母线" }[e.type];
    const flowText = e.type === "power" ? "—" :
      Math.abs(e.flow) < 0.01 ? "无流动" :
      `${(Math.abs(e.flow)).toFixed(2)} ${e.type === "gas" ? "mol/s" : "g/s"} ${e.flow > 0 ? def.a + "→" + def.b : def.b + "→" + def.a}`;

    body().innerHTML = `
      <div class="insp-title">${C.NODES.find((n) => n.id === e.a).name} ↔ ${C.NODES.find((n) => n.id === e.b).name}</div>
      <div class="insp-sub">${typeName}${e.type !== "power" ? ` · 传输延迟 ${e.delay} 秒` : ""}</div>

      <div class="section">
        ${metric("状态", e.closed ? "已封闭" : "畅通", e.closed ? "bad" : "ok")}
        ${metric("实时流量", flowText, "")}
        ${e.type !== "power" ? metric("传导系数", e.c, "") : ""}
        ${e.queue && e.queue.length ? metric("在途资源包", e.queue.length + " 个", "warn") : ""}
      </div>

      <div class="section">
        <div class="section-h">操作</div>
        ${e.type === "power"
          ? `<div class="insp-note">电力为全局母线，由能源站统一调度，区域断电会自动切除低优先级设备，无实体阀门。</div>`
          : `<div class="ctl-row">
              <button class="btn ${e.closed ? "" : "danger"}" data-act="toggleEdge" data-arg="${e.id}">
                ${e.closed ? "重新开启" : "封闭阀门/气闸"}</button>
            </div>
            <div class="insp-note">封闭会延迟资源抵达；若会把有人舱室隔成孤岛，系统将拒绝执行并给出因果链。</div>`}
      </div>
      <div class="ctl-row"><button class="btn ghost small" id="insp-back">← 返回基地总览</button></div>`;

    bindButtons();
    const back = document.getElementById("insp-back");
    if (back) back.onclick = () => MLS.store.select(null, null);
  }

  /* ---------- 控件绑定 ---------- */
  function bindButtons() {
    body().querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const act = btn.getAttribute("data-act");
        const arg = btn.getAttribute("data-arg");
        dispatch(act, arg);
      });
    });
    body().querySelectorAll("[data-prio]").forEach((btn) => {
      btn.addEventListener("click", () =>
        dispatch("setPriority", btn.getAttribute("data-prio"), Number(btn.getAttribute("data-val"))));
    });
    body().querySelectorAll("[data-activity]").forEach((btn) => {
      btn.addEventListener("click", () =>
        dispatch("setActivity", btn.getAttribute("data-activity"), btn.getAttribute("data-val")));
    });
    body().querySelectorAll("[data-transfer]").forEach((sel) => {
      sel.addEventListener("change", () => {
        if (sel.value) dispatch("transfer", sel.getAttribute("data-transfer"), sel.value);
      });
    });
  }

  function bindLiveControls(state, nid) {
    const slider = document.getElementById("quota-slider");
    const label = document.getElementById("quota-val");
    if (slider) {
      slider.addEventListener("input", () => (label.textContent = slider.value + "%"));
      slider.addEventListener("change", () => dispatch("setO2Quota", nid, Number(slider.value) / 100));
    }
  }

  function dispatch(act, arg, val) {
    const args = val != null ? [arg, val] : (arg != null ? [arg] : []);
    const r = MLS.store.act(act, ...args);
    if (!r.ok) MLS.ui.toast(r, act);
  }

  function metric(k, v, cls) {
    return `<div class="metric-row"><span class="k">${k}</span><span class="v ${cls || ""}">${v}</span></div>`;
  }
  function bar(cls, pct, extra) {
    return `<div class="bar ${cls || extra || ""}"><div style="width:${(MLS.clamp(pct, 0, 1) * 100).toFixed(0)}%"></div></div>`;
  }

  MLS.ui.inspector = { render };
})();
