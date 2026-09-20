/* =====================================================================
 * Store：多策略并行推演 + 稳定点保护 + 失败动作隔离 + 自动存档
 * ===================================================================== */
(function () {
  const MLS = window.MLS;

  const store = {
    strategies: [],
    activeId: null,
    speed: 100,
    running: false,
    selected: { kind: null, id: null }, // 检查器选中
    filterAlarmOnly: true,
    listeners: new Set(),

    /* ---------- 初始化 ---------- */
    init() {
      const saved = MLS.persistence.load();
      if (saved && saved.strategies && saved.strategies.length) {
        this.strategies = saved.strategies;
        this.activeId = saved.activeId && this.strategies.some((s) => s.id === saved.activeId)
          ? saved.activeId : this.strategies[0].id;
        this.speed = saved.speed || 0;
      } else {
        const s0 = this.makeStrategy("策略 A · 稳健保守", MLS.scenario.makeState());
        this.strategies = [s0];
        this.activeId = s0.id;
        this.speed = 0; // 初始暂停，留给指挥长决策时间
      }
      this.running = this.speed > 0;
    },

    makeStrategy(name, state) {
      return { id: MLS.uid("st"), name, color: pickColor(this.strategies.length), state, createdAt: Date.now() };
    },

    get active() { return this.strategies.find((s) => s.id === this.activeId); },

    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    emit(reason) { this.listeners.forEach((fn) => fn(reason)); this.autosave(); },

    _saveTimer: null,
    autosave() {
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => {
        const r = MLS.persistence.save(this);
        this.listeners.forEach((fn) => fn("save:" + (r.ok ? "ok" : "fail")));
      }, 400);
    },

    saveNow() { return MLS.persistence.save(this); },

    select(kind, id) {
      this.selected = { kind, id };
      this.emit("select");
    },

    setSpeed(v) {
      this.speed = v;
      this.running = v > 0;
      this.emit("speed");
    },

    /* ---------- 动作分发：失败不覆盖稳定状态 ---------- */
    act(actionName, ...args) {
      const strat = this.active;
      const state = strat.state;
      const fn = MLS.engine.actions[actionName];
      if (!fn) return { ok: false, reason: "未知操作" };
      if (state.ended) {
        const r = { ok: false, reason: "该策略推演已结束",
          recover: "从最近稳定点回退，切换到其他策略，或分叉新策略重开" };
        this.emit("rejected");
        return r;
      }

      const snapshot = MLS.clone(state);   // 防御性快照
      let result;
      try {
        result = fn(state, ...args);
      } catch (e) {
        result = { ok: false, reason: "系统异常：" + e.message, recover: "状态已回滚，可重试或恢复上一稳定点" };
      }
      if (!result || result.ok === false) {
        // 恢复快照：任何失败/异常都不能污染当前稳定状态
        this._restoreInto(strat, snapshot);
        this.emit("rejected");
        return result || { ok: false, reason: "操作失败" };
      }
      if (result.silent) { this.emit("silent"); return result; }

      // 成功的用户操作 → 写入新的稳定点
      this.checkpoint(`${actionLabel(actionName, args)}`);
      this.emit("action");
      return result;
    },

    _restoreInto(strat, snap) {
      // 保持对象引用一致：逐键恢复
      const cur = strat.state;
      for (const k of Object.keys(cur)) delete cur[k];
      Object.assign(cur, snap);
    },

    /* ---------- 稳定点 ---------- */
    checkpoint(label) {
      const state = this.active.state;
      const ev = MLS.scenario.addEvent(state, {
        kind: "checkpoint", level: "ok", subject: "MISSION",
        msg: `稳定点 #${state.checkpoints.length}：${label}`, cause: null, checkpoint: true,
      });
      state.checkpoints.push({ eventId: ev.id, t: state.t, label, snap: MLS.clone(state) });
      // 仅保留最近 6 个带快照的稳定点（更早的只保留记录，控制存档体积）
      while (state.checkpoints.length > 5) {
        const old = state.checkpoints.shift();
        old.snap = null;
        const idx = state.events.findIndex((e) => e.id === old.eventId);
        if (idx >= 0) state.events[idx].snapDropped = true;
      }
    },

    rollback() {
      const state = this.active.state;
      const cp = state.checkpoints.filter((c) => c.snap).slice(-1)[0];
      if (!cp) return { ok: false, reason: "没有可恢复的稳定点" };
      const snap = MLS.clone(cp.snap);
      this._restoreInto(this.active, snap);
      MLS.scenario.addEvent(state, { kind: "rollback", level: "warn", subject: "MISSION",
        msg: `已回退到「${cp.label}」(T+${MLS.clockStr(cp.t)})，其后操作全部作废`, cause: null });
      this.emit("rollback");
      return { ok: true, label: cp.label };
    },

    /* ---------- 策略管理 ----------
     * 新策略从父策略「当前状态」分叉（保留其最近的可恢复稳定点作为分支根） */
    newStrategy(name) {
      const parent = this.active;
      const seed = MLS.clone(parent.state);
      // 仅保留父策略最近一个有快照的稳定点，作为新分支的根节点
      const lastSnap = parent.state.checkpoints.filter((c) => c.snap).slice(-1)[0];
      seed.checkpoints = lastSnap ? [{ eventId: lastSnap.eventId, t: lastSnap.t,
        label: "分支根：" + lastSnap.label, snap: MLS.clone(lastSnap.snap) }] : [];
      const letter = String.fromCharCode(65 + this.strategies.length);
      const st = this.makeStrategy(name || `策略 ${letter} · 新救援路线`, seed);
      MLS.scenario.addEvent(st.state, { kind: "fork", level: "info", subject: "MISSION",
        msg: `从「${parent.name}」T+${MLS.clockStr(seed.t)} 分叉出对照策略「${st.name}」`, cause: null });
      this.strategies.push(st);
      this.activeId = st.id;
      this.selected = { kind: null, id: null };
      this.emit("new-strategy");
      return st;
    },

    activate(id) {
      if (id === this.activeId) return;
      this.activeId = id;
      this.selected = { kind: null, id: null };
      this.emit("activate");
    },

    removeStrategy(id) {
      if (this.strategies.length <= 1) return { ok: false, reason: "至少保留一套策略" };
      const idx = this.strategies.findIndex((s) => s.id === id);
      this.strategies.splice(idx, 1);
      if (this.activeId === id) this.activeId = this.strategies[0].id;
      this.selected = { kind: null, id: null };
      this.emit("remove-strategy");
      return { ok: true };
    },

    resetAll() {
      MLS.persistence.clear();
      this.strategies = [];
      this.init();
      this.selected = { kind: null, id: null };
      this.emit("reset");
    },

    loadImport(data) {
      this.strategies = data.strategies;
      this.activeId = data.activeId && this.strategies.some((s) => s.id === data.activeId)
        ? data.activeId : this.strategies[0].id;
      this.speed = data.speed || 0;
      this.running = this.speed > 0;
      this.selected = { kind: null, id: null };
      this.autosave();
      this.emit("import");
    },

    /* ---------- 仿真推进：所有策略同步前进 ---------- */
    advance(seconds) {
      let anyChanged = false;
      for (const strat of this.strategies) {
        if (strat.state.ended) continue;
        for (let i = 0; i < seconds; i++) MLS.engine.step(strat.state);
        anyChanged = true;
      }
      return anyChanged;
    },
  };

  function actionLabel(name, args) {
    const map = {
      toggleDevice: "设备启停", setPriority: "调整供电优先级", setO2Quota: "调整氧气分配",
      setActivity: "调整乘员活动", toggleEdge: "启闭阀门气闸", transfer: "安排乘员转移",
      repair: "开始修补破洞",
    };
    return map[name] || name;
  }

  const PALETTE = ["#36d6c3", "#4aa3ff", "#ffb547", "#ff8f6b", "#b58cff", "#4ade80", "#f472b6"];
  function pickColor(i) { return PALETTE[i % PALETTE.length]; }

  MLS.store = store;
})();
