/* 初始状态构建。状态为纯 JSON，可直接序列化存档。 */
(function (root) {
  var MLSS = root.MLSS, C = MLSS.CONFIG, U = MLSS.U;

  MLSS.createInitialState = function () {
    var mix = C.initialMix;
    var mods = C.modules.map(function (m) {
      return {
        id: m.id, name: m.name, short: m.short, type: m.type,
        volume: m.volume, crewCap: m.crewCap,
        x: m.x, y: m.y, w: m.w, h: m.h,
        gas: { o2: mix.o2, co2: mix.co2, n2: mix.n2 },
        sealed: false,
        leak: null,                 // null | { rate, repairReadyAt }
        crew: C.crewInit[m.id] || 0,
        casualties: 0,
        dangerMin: 0,              // 累计危险暴露分钟
        share: 1,                  // O₂ 分配权重（阀门）
        inflow: []                 // 管道延迟队列 [{ at, amount }]
      };
    });

    var edges = C.edges.map(function (e) {
      return { id: e.id, a: e.a, b: e.b, dist: e.dist, open: true, valve: 1 };
    });

    var equipment = C.equipment.map(function (q) {
      return {
        id: q.id, mod: q.mod, kind: q.kind, name: q.name,
        pwr: q.pwr, prio: q.prio,
        on: !!q.on, fixed: !!q.fixed,
        backup: !!q.backup, cold: !!q.cold, startMin: q.startMin || 0,
        inrush: q.inrush || 0, rate: q.rate || 0, out: q.out || 0,
        o2rate: q.o2rate || 0, water: q.water || 0,
        status: q.on ? 'on' : (q.backup ? 'standby' : 'off'),
        readyAt: null, shed: false
      };
    });

    return {
      version: C.version,
      t: 0,
      water: { potable: C.water.potableInit, waste: C.water.wasteInit },
      power: {
        battery: C.power.batteryInit,
        reactorOut: C.power.reactorKw,
        demand: 0, supplied: 0, shed: [],
        starting: null            // 当前占用“启动窗口”的设备 id
      },
      mods: mods,
      edges: edges,
      equipment: equipment,
      transits: [],
      schedule: [],
      events: [],
      checkpoints: [],
      alerts: {},
      totalCrew: 8,
      totalCasualties: 0,
      // 临时运算字段在每次 tick 重建
      tmp: null
    };
  };

  /* 生成一条事件（持久）。chain: {steps:[...], recover:[{label,action,payload}]} */
  MLSS.addEvent = function (s, ev) {
    s.events.unshift({
      id: U.shortId(), t: s.t,
      level: ev.level || 'info',       // critical | warn | info | action | failed
      type: ev.type,
      msg: ev.msg,
      chain: ev.chain || null,
      source: ev.source || null
    });
    if (s.events.length > 400) s.events.length = 400;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
