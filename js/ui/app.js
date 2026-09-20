/* 应用入口：主循环 + 全局 UI 绑定 */
(function () {
  const MLS = window.MLS;
  const store = MLS.store;

  let lastTs = 0;

  function boot() {
    store.init();
    MLS.ui.schematic.build();
    bindGlobal();
    store.subscribe(onStoreChange);
    renderAll();
    requestAnimationFrame(loop);
    showResumeNotice();
  }

  function showResumeNotice() {
    const saved = MLS.persistence.load();
    if (saved && saved.savedAt) {
      const ago = Math.round((Date.now() - saved.savedAt) / 1000);
      setTimeout(() => {
        if (ago > 30) {
          const st = store.active.state;
          MLS.ui.toast({
            reason: `已从本地存档恢复：${store.strategies.length} 套策略，当前推演时刻 T+${MLS.clockStr(st.t)}`,
            recover: "点击速度按钮即可继续未完成的生存推演",
          });
        }
      }, 600);
    }
  }

  /* ---------- 主循环：真实帧 × 倍率 → 同步推进所有策略 ---------- */
  function loop(ts) {
    const dt = Math.min(0.25, (ts - lastTs) / 1000 || 0);
    lastTs = ts;
    if (store.running && store.speed > 0) {
      let simSec = dt * store.speed;
      simSec = Math.min(simSec, 600); // 单帧上限，防切后台后爆炸
      const whole = Math.floor(simSec);
      if (whole > 0) {
        const changed = store.advance(whole);
        if (changed) renderDynamic();
        if (store.active.state.ended) store.setSpeed(0);
      }
    }
    requestAnimationFrame(loop);
  }

  /* ---------- store 变化 → 重绘 ---------- */
  let dynRaf = 0;
  function onStoreChange(reason) {
    if (reason === "speed") return updateSpeedUI();
    renderAll();
    if (reason && reason.startsWith("save")) {
      const el = document.getElementById("save-status");
      el.textContent = reason === "save:ok" ? "自动存档已开启 · 已保存" : "自动存档失败（空间不足？）";
    }
  }

  function renderAll() {
    renderDynamic();
    renderTabs();
    MLS.ui.inspector.render();
    MLS.ui.events.render();
    updateClock();
    updateAlarmBanner();
    updateSpeedUI();
  }

  function renderDynamic() {
    const s = store.active.state;
    MLS.ui.schematic.refresh(s);
    // 检查器仅在选中节点/总览时刷新数值（滑杆交互不被打断：拖动中不整体重绘）
    if (!document.querySelector("#quota-slider:active")) {
      // 轻量：事件/标签/时钟每帧更新，检查器每秒更新即可
    }
    MLS.ui.events.render();
    renderTabs();
    updateClock();
    updateAlarmBanner();
    if (!document.getElementById("compare-drawer").classList.contains("hidden"))
      MLS.ui.compare.render();
  }

  /* ---------- 时钟 / 状态栏 ---------- */
  function updateClock() {
    const s = store.active.state;
    document.getElementById("mission-clock").textContent = "T+" + MLS.clockStr(s.t);
    const left = MLS.CONFIG.SCENE.rescueAt - s.t;
    const rc = document.getElementById("rescue-clock");
    if (s.ended && s.ended.win) rc.textContent = "✔ 救援已抵达";
    else if (s.ended) rc.textContent = "✖ 任务失败";
    else rc.textContent = "救援抵达倒计时 " + MLS.clockStr(left);

    const { eta, where } = MLS.engine.baseEta(s);
    const el = document.getElementById("survival-status");
    const name = where ? MLS.CONFIG.NODES.find((n) => n.id === where)?.name : "";
    if (eta === Infinity) el.innerHTML = "基地剩余保障时间：充足";
    else {
      const cls = eta < 1800 ? "crit" : eta < 3600 ? "warn" : "ok";
      el.innerHTML = `基地剩余保障时间：<span class="${cls}">${MLS.durStr(eta)}</span>（瓶颈：${name}）`;
    }

    const rs = document.getElementById("run-status");
    rs.textContent = store.running ? `推演中 ${store.speed}×` : "已暂停";
    rs.className = "run-status" + (store.running ? " running" : "");
  }

  /* ---------- 策略标签 ---------- */
  function renderTabs() {
    const wrap = document.getElementById("strategy-tabs");
    wrap.innerHTML = "";
    store.strategies.forEach((s) => {
      const { eta } = MLS.engine.baseEta(s.state);
      const tab = document.createElement("div");
      tab.className = "strategy-tab" + (s.id === store.activeId ? " active" : "");
      tab.innerHTML = `
        <span class="tab-dot" style="background:${s.color}"></span>
        <span>${MLS.esc(s.name)}</span>
        <span class="tab-eta">${eta === Infinity ? "稳定" : MLS.durStr(eta)}</span>
        ${s.state.ended ? `<span>${s.state.ended.win ? "✔" : "✖"}</span>` : ""}
        ${store.strategies.length > 1 ? `<span class="tab-close" title="删除该策略">✕</span>` : ""}`;
      tab.onclick = (ev) => {
        if (ev.target.classList.contains("tab-close")) {
          if (confirm(`删除策略「${s.name}」？`)) store.removeStrategy(s.id);
          return;
        }
        store.activate(s.id);
      };
      wrap.appendChild(tab);
    });
  }

  /* ---------- 告警横幅 ---------- */
  let lastAlarmCount = -1;
  function updateAlarmBanner() {
    const s = store.active.state;
    const recent = s.events.filter((e) => e.level === "alarm" && s.t - e.t < 300 &&
      !e.msg.includes("失去生命体征") || (e.level === "alarm" && e.kind === "end-lose" && s.t - e.t < 600));
    const last = s.events.slice().reverse().find((e) => e.level === "alarm");
    const banner = document.getElementById("alarm-banner");
    const openLeaks = Object.values(s.nodes).some((n) => n.leak);
    if (s.power.blackout || openLeaks || (last && s.t - last.t < 200)) {
      const show = s.power.blackout
        ? "⚠ 全电网断电！生命保障设备停止 — 立即启动备用燃料电池"
        : openLeaks ? "⚠ 实验舱外壳破损持续泄漏 — 转移乘员 → 封闭舱段 → 修补" : last.msg;
      banner.textContent = show;
      banner.className = "alarm-banner";
    } else {
      const warn = s.events.slice().reverse().find((e) => e.level === "warn" && s.t - e.t < 120);
      if (warn) { banner.textContent = "注意：" + warn.msg; banner.className = "alarm-banner warn"; }
      else banner.className = "alarm-banner hidden";
    }
  }

  /* ---------- 速度按钮 ---------- */
  function updateSpeedUI() {
    document.querySelectorAll(".speed-btn").forEach((b) => {
      b.classList.toggle("active", Number(b.getAttribute("data-speed")) === store.speed);
    });
  }

  /* ---------- 全局绑定 ---------- */
  function bindGlobal() {
    document.querySelectorAll(".speed-btn").forEach((b) =>
      b.addEventListener("click", () => store.setSpeed(Number(b.getAttribute("data-speed")))));

    document.getElementById("btn-compare").onclick = () => MLS.ui.compare.open();
    document.getElementById("btn-close-compare").onclick = () => MLS.ui.compare.close();
    document.querySelector("#compare-drawer .drawer-mask").onclick = () => MLS.ui.compare.close();

    document.getElementById("btn-new-strategy").onclick = () => {
      const name = prompt("新策略名称：", `策略 ${String.fromCharCode(65 + store.strategies.length)} · 备选救援路线`);
      if (name === null) return;
      store.newStrategy(name || undefined);
    };

    document.getElementById("btn-rollback").onclick = () => {
      const cp = store.active.state.checkpoints.slice().pop();
      if (!cp) return MLS.ui.toast({ reason: "当前策略还没有可恢复的稳定点" });
      if (confirm(`恢复到上一稳定点？\n\nT+${MLS.clockStr(cp.t)} · ${cp.label}\n\n其后的操作与演化将全部作废（可对照其他策略后再决定）。`)) {
        const r = store.rollback();
        if (!r.ok) MLS.ui.toast(r);
      }
    };

    document.getElementById("filter-alarm").addEventListener("change", () => MLS.ui.events.render());

    document.getElementById("btn-export").onclick = () => {
      const blob = new Blob([MLS.persistence.exportJSON(store)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `mars-lss-save-T${store.active.state.t}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    };

    document.getElementById("file-import").addEventListener("change", (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = MLS.persistence.importJSON(reader.result);
          if (confirm(`导入存档：${data.strategies.length} 套策略，将覆盖当前推演。继续？`)) {
            store.loadImport(data);
          }
        } catch (e) {
          MLS.ui.toast({ reason: "导入失败：" + e.message });
        }
      };
      reader.readAsText(f);
      ev.target.value = "";
    });

    document.getElementById("btn-reset").onclick = () => {
      if (confirm("放弃全部策略与存档，回到事故发生时刻重新推演？")) store.resetAll();
    };

    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
      if (e.code === "Space") { e.preventDefault(); store.setSpeed(store.speed > 0 ? 0 : 100); }
      if (e.key === "1") store.setSpeed(1);
      if (e.key === "2") store.setSpeed(30);
      if (e.key === "3") store.setSpeed(100);
      if (e.key === "4") store.setSpeed(300);
      if (e.key.toLowerCase() === "c") MLS.ui.compare.open();
      if (e.key === "Escape") MLS.ui.compare.close();
    });

    window.addEventListener("beforeunload", () => store.saveNow());
  }

  boot();
})();
