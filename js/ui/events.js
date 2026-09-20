/* 事件链：因果链回溯 + 可恢复节点 + 失败操作 toast */
(function () {
  const MLS = window.MLS;

  MLS.ui = MLS.ui || {};

  function buildChain(state, ev) {
    const chain = [];
    let cur = ev, guard = 0;
    while (cur && cur.cause && guard++ < 12) {
      let prev = cur.cause.eventId ? state.events.find((e) => e.id === cur.cause.eventId) : null;
      const label = cur.cause.label || (prev ? prev.msg : null);
      if (label) chain.push(label);
      cur = prev;
    }
    return chain;
  }

  function chainHTML(state, ev) {
    const chain = buildChain(state, ev);
    if (!chain.length) return "";
    return `<span class="chain">因果：${chain.reverse().map((s, i) =>
      `<b>${MLS.esc(s)}</b>`).join(" ⟶ ")} ⟶ <b>${MLS.esc(ev.msg)}</b></span>`;
  }

  function render() {
    const state = MLS.store.active.state;
    const feed = document.getElementById("event-feed");
    const onlyAlarm = document.getElementById("filter-alarm").checked;

    let list = state.events.slice().reverse();
    if (onlyAlarm) list = list.filter((e) => e.level === "alarm" || e.level === "warn" || e.checkpoint);

    feed.innerHTML = list.map((e) => {
      const tag = e.checkpoint ? `<span class="event-tag checkpoint">稳定点</span>` : "";
      return `<div class="event-item ${e.level}" data-eid="${e.id}">
        <span class="event-time">T+${MLS.clockStr(e.t)}</span>
        <span class="event-msg">${MLS.esc(e.msg)}
          ${chainHTML(state, e)}
          ${e.recover ? `<span class="recover">↳ 可恢复：${MLS.esc(e.recover)}</span>` : ""}
        </span>${tag}
      </div>`;
    }).join("") || `<div class="event-item info"><span class="event-msg">暂无告警事件</span></div>`;

    // 最新稳定点信息
    const cp = state.checkpoints[state.checkpoints.length - 1];
    document.getElementById("checkpoint-info").textContent =
      cp ? `最近稳定点 T+${MLS.clockStr(cp.t)}：${cp.label}` : "无稳定点";

    // 点击稳定点 → 询问回退
    feed.querySelectorAll("[data-eid]").forEach((el) => {
      el.addEventListener("click", () => {
        const ev = state.events.find((x) => x.id === el.getAttribute("data-eid"));
        if (ev && ev.checkpoint) {
          if (confirm(`回退到该稳定点？\n\n${ev.msg}\n\n该点之后的所有操作与演化都将作废。`)) {
            rollbackTo(ev.id);
          }
        }
      });
    });
  }

  function rollbackTo(eventId) {
    const state = MLS.store.active.state;
    const target = state.checkpoints.find((c) => c.eventId === eventId);
    if (!target || !target.snap) { MLS.ui.toast({ reason: '该稳定点快照已被清理，无法回退' }); return; }
    const idx = state.checkpoints.indexOf(target);
    if (idx < 0) return;
    // 截断到目标点
    state.checkpoints.splice(idx + 1);
    const r = MLS.store.rollback();
    if (!r.ok) toast({ reason: r.reason });
  }

  /* ---------- 失败操作 Toast（含因果链与恢复按钮） ---------- */
  function toast(result, actName) {
    const stack = document.getElementById("toast-stack");
    const el = document.createElement("div");
    el.className = "toast";
    const chain = result.chain && result.chain.length
      ? `<div class="toast-chain">因果：${result.chain.map((s) => `<b>${MLS.esc(s)}</b>`).join(" ⟶ ")}</div>` : "";
    el.innerHTML = `
      <div class="toast-h"><span>✖ 操作被拒绝</span><span style="margin-left:auto;cursor:pointer;color:#7f92a6" class="t-close">✕</span></div>
      <div>${MLS.esc(result.reason || "操作失败")}</div>
      ${chain}
      ${result.recover ? `<div class="toast-recover">↳ 建议：${MLS.esc(result.recover)}</div>` : ""}
      <div class="toast-actions">
        ${canRollback() ? `<button class="btn small danger t-rollback">恢复上一稳定点</button>` : ""}
        <button class="btn small t-ok">知道了</button>
      </div>`;
    while (stack.children.length >= 3) stack.firstChild.remove();
    stack.appendChild(el);
    const rm = () => el.remove();
    el.querySelector(".t-close").onclick = rm;
    el.querySelector(".t-ok").onclick = rm;
    const rb = el.querySelector(".t-rollback");
    if (rb) rb.onclick = () => { const r = MLS.store.rollback(); if (!r.ok) toast(r); rm(); };
    setTimeout(rm, 12000);
  }

  function canRollback() {
    return MLS.store.active.state.checkpoints.length > 0;
  }

  MLS.ui.events = { render, toast, buildChain };
  MLS.ui.toast = toast; // 便捷全局方法，供 app/inspector 直接调用
})();
