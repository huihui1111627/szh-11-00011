/* 前向推演：在状态克隆上连续 tick，得到阈值穿越事件链与“剩余保障时间”。
 * 不产生持久事件、不修改原状态。 */
(function (root) {
  var MLSS = root.MLSS, C = MLSS.CONFIG, U = MLSS.U, sim = MLSS.sim;
  var fc = MLSS.forecast = {};

  function fork(s) {
    var c = U.clone(s);
    c.checkpoints = s.checkpoints;   // 快照不参与推演，免拷贝
    c.events = [];
    return c;
  }

  fc.derive = function (s) {
    var T = C.thresholds;
    var mods = s.mods.map(function (m) {
      var p = sim.pressure(m);
      var lvl = 'ok';
      if (m.crew || m.leak) {
        if (p < T.pressureLowCrit || m.gas.o2 < T.o2LowCrit || m.gas.co2 > T.co2Crit) lvl = 'crit';
        else if (p < T.pressureLowWarn || m.gas.o2 < T.o2LowWarn || m.gas.co2 > T.co2Warn) lvl = 'warn';
      }
      return { id: m.id, p: p, o2: m.gas.o2, co2: m.gas.co2, crew: m.crew, lvl: lvl,
        leak: m.leak ? m.leak.rate : null, sealed: m.sealed };
    });
    return {
      t: s.t, water: s.water.potable, waste: s.water.waste,
      battery: s.power.battery, reactor: s.power.reactorOut,
      demand: s.power.demand, supplied: s.power.supplied,
      crew: sim.crewCount(s), casualties: s.totalCasualties,
      mods: mods,
      shed: s.equipment.filter(function (q) { return q.shed; }).map(function (q) { return q.name; })
    };
  };

  /* horizon 分钟前向推演：返回 horizon 时刻指标、期间出现的严重/警告事件 */
  fc.run = function (s, horizon) {
    horizon = horizon || C.forecastMin;
    var c = fork(s), events = [];
    for (var i = 1; i <= horizon; i++) {
      var emitted = sim.tick(c, { silent: true });
      emitted.forEach(function (ev) {
        if (ev.level === 'critical' || ev.level === 'warn') {
          events.push({ at: i, level: ev.level, type: ev.type, msg: ev.msg, chain: ev.chain });
        }
      });
      if (events.length >= 12) { /* 保留前 12 条穿越事件 */ }
    }
    return { horizon: horizon, end: fc.derive(c), events: events.slice(0, 12), state: c };
  };

  /* 剩余保障时间（分钟）：逐项扫描，最多看 cap 分钟；超过则返回 null（视为安全） */
  fc.supportTimes = function (s, cap) {
    cap = cap || 480;
    var c = fork(s);
    var res = { o2: null, pressure: null, co2: null, water: null, power: null, casualty: null };
    var T = C.thresholds;
    var initialCrew = sim.crewCount(c);

    for (var i = 1; i <= cap; i++) {
      sim.tick(c, { silent: true });
      if (res.casualty === null && sim.crewCount(c) < initialCrew) res.casualty = i;
      if (res.water === null && c.water.potable <= 0.05) res.water = i;
      if (res.power === null && c.power.battery <= 0.02 && c.power.demand > c.power.supplied + 0.1)
        res.power = i;
      var badO2 = false, badP = false, badCO2 = false;
      c.mods.forEach(function (m) {
        if (!m.crew) return;
        if (m.gas.o2 < T.o2LowCrit) badO2 = true;
        if (sim.pressure(m) < T.pressureLowCrit) badP = true;
        if (m.gas.co2 > T.co2Crit) badCO2 = true;
      });
      if (res.o2 === null && badO2) res.o2 = i;
      if (res.pressure === null && badP) res.pressure = i;
      if (res.co2 === null && badCO2) res.co2 = i;
    }
    res.overall = U.min(res.o2, res.pressure, res.co2, res.water, res.power, res.casualty);
    return res;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
