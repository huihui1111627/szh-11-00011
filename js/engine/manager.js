/* 多策略管理器：
 * - 多套救援策略并行推进、共享同一时钟 tick
 * - 命令“克隆体试算 → 成功才提交”，失败绝不修改当前稳定状态
 * - 每次成功操作前自动打点（上一稳定节点），另支持手动打点与回滚
 * - 汇总多策略指标用于对照 */
(function (root) {
  var MLSS = root.MLSS, U = MLSS.U, sim = MLSS.sim, fc = MLSS.forecast, commands = MLSS.commands;

  var AUTO_KEEP = 20, CP_KEEP = 30;

  function Manager(data) {
    if (data && data.strategies) {
      this.strategies = data.strategies;
      this.activeId = data.activeId || this.strategies[0].id;
    } else {
      var base = MLSS.createInitialState();
      this.strategies = [
        { id: U.shortId(), name: '方案 A · 保守封闭', state: base, createdAt: U.nowISO(), lastTouched: U.nowISO() }
      ];
      this.activeId = this.strategies[0].id;
      this.snapshot(this.strategies[0], '初始稳定基线', 'manual');
    }
  }

  Manager.prototype.active = function () {
    return U.byId(this.strategies, this.activeId) || this.strategies[0];
  };

  /* 打点：保存轻量状态副本（checkpoints/events 之外的全部推演状态） */
  Manager.prototype.snapshot = function (st, reason, kind) {
    var copy = stripForSnapshot(st.state);
    st.state.checkpoints.unshift({
      id: U.shortId(), t: st.state.t, reason: reason || '', kind: kind || 'manual',
      at: U.nowISO(), state: copy
    });
    var autos = st.state.checkpoints.filter(function (c) { return c.kind === 'auto'; });
    var manuals = st.state.checkpoints.filter(function (c) { return c.kind !== 'auto'; });
    if (autos.length > AUTO_KEEP) {
      var cut = autos.slice(AUTO_KEEP).map(function (c) { return c.id; });
      st.state.checkpoints = st.state.checkpoints.filter(function (c) { return cut.indexOf(c.id) < 0; });
    }
    if (st.state.checkpoints.length > CP_KEEP) st.state.checkpoints.length = CP_KEEP;
  };

  Manager.prototype.rollback = function (st, cpId) {
    var cp = U.byId(st.state.checkpoints, cpId);
    if (!cp) return { ok: false, error: '找不到该恢复节点。' };
    st.state = U.clone(cp.state);
    MLSS.addEvent(st.state, {
      level: 'info', type: 'ROLLBACK',
      msg: '已回滚到恢复节点「' + (cp.reason || 'T+' + U.fmtTime(cp.t)) + '」，其后的推演与操作全部作废。'
    });
    st.lastTouched = U.nowISO();
    return { ok: true };
  };

  /* 事务式命令：在克隆体上试算；只有 ok 才替换 live 状态 */
  Manager.prototype.command = function (c, strategyId) {
    var st = strategyId ? U.byId(this.strategies, strategyId) : this.active();
    var trial = U.clone(st.state);
    var result = commands.apply(trial, c);
    if (!result.ok) return result;

    /* 成功路径：先把“操作前”状态留作自动恢复节点，再提交 */
    this.snapshot(st, (c.label || commands.LABELS[c.type]) + ' 前（T+' + U.fmtTime(st.state.t) + '）', 'auto');
    st.state = trial;
    MLSS.addEvent(st.state, {
      level: result.event.level || 'info', type: 'ACTION',
      msg: '[' + (c.label || commands.LABELS[c.type]) + '] ' + (result.event.msg || ''),
      chain: result.event.chain || null, source: result.event.source || null
    });
    st.lastTouched = U.nowISO();
    return { ok: true, event: result.event, strategyId: st.id };
  };

  /* 情景注入同样走事务通道 */
  Manager.prototype.scenario = function (key, strategyId) {
    var st = strategyId ? U.byId(this.strategies, strategyId) : this.active();
    var trial = U.clone(st.state);
    var result = commands.scenario(trial, key);
    if (!result.ok) return result;
    this.snapshot(st, '情景注入前（T+' + U.fmtTime(st.state.t) + '）', 'auto');
    st.state = trial;
    MLSS.addEvent(st.state, result.event);
    st.lastTouched = U.nowISO();
    return { ok: true, event: result.event };
  };

  /* 同步推进：所有策略走相同分钟数；某策略提前结束只暂停它 */
  Manager.prototype.advance = function (ticks) {
    var results = [];
    this.strategies.forEach(function (st) {
      if (st.ended) return;
      var emittedAll = [];
      for (var i = 0; i < ticks; i++) emittedAll = emittedAll.concat(sim.tick(st.state));
      var crit = emittedAll.filter(function (e) { return e.level === 'critical'; });
      if (crit.length && hasCrewLoss(emittedAll)) {
        /* 减员时自动保留“减员前 1 tick”附近的最后节点（auto 链已覆盖） */
      }
      results.push({ id: st.id, events: emittedAll });
    });
    return results;
  };

  Manager.prototype.addStrategy = function (name, cloneFrom) {
    var src = cloneFrom ? U.byId(this.strategies, cloneFrom) : this.active();
    var copy = U.clone(src.state);
    copy.checkpoints = copy.checkpoints.slice(0, 8);
    var st = { id: U.shortId(), name: name || ('方案 ' + String.fromCharCode(65 + this.strategies.length)),
      state: copy, createdAt: U.nowISO(), lastTouched: U.nowISO() };
    this.strategies.push(st);
    return st;
  };

  Manager.prototype.removeStrategy = function (id) {
    if (this.strategies.length <= 1) return { ok: false, error: '至少保留一套方案。' };
    var idx = this.strategies.findIndex(function (x) { return x.id === id; });
    if (idx < 0) return { ok: false, error: '方案不存在。' };
    this.strategies.splice(idx, 1);
    if (this.activeId === id) this.activeId = this.strategies[0].id;
    return { ok: true };
  };

  Manager.prototype.rename = function (id, name) {
    var st = U.byId(this.strategies, id);
    if (st && name) st.name = name;
  };

  /* 对照表：所有策略同一时刻的关键指标 */
  Manager.prototype.compare = function () {
    return this.strategies.map(function (st) {
      var d = fc.derive(st.state), sup = fc.supportTimes(st.state);
      return {
        id: st.id, name: st.name, t: st.state.t,
        crew: d.crew, casualties: d.casualties,
        water: Math.round(d.water), battery: d.battery.toFixed(1),
        demand: Math.round(d.demand), supplied: Math.round(d.supplied),
        worstP: Math.round(Math.min.apply(null, d.mods.map(function (m) { return m.p; }))),
        support: sup.overall === null ? null : sup.overall,
        supportDetail: sup,
        leaks: d.mods.filter(function (m) { return m.leak; }).length,
        critical: d.mods.filter(function (m) { return m.lvl === 'crit'; }).length,
        ended: !!st.ended
      };
    });
  };

  Manager.prototype.serialize = function () {
    return JSON.stringify({ version: 1, activeId: this.activeId, strategies: this.strategies });
  };

  function hasCrewLoss(events) {
    return events.some(function (e) { return e.type === 'CASUALTY' || e.type === 'SUIT_O2_OUT'; });
  }

  function stripForSnapshot(s) {
    var c = U.clone(s);
    c.events = [];
    c.checkpoints = [];
    return c;
  }

  MLSS.Manager = Manager;
  MLSS.loadManager = function (json) {
    var data = typeof json === 'string' ? JSON.parse(json) : json;
    if (!data || !Array.isArray(data.strategies) || !data.strategies.length)
      throw new Error('存档格式无效');
    return new Manager(data);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
