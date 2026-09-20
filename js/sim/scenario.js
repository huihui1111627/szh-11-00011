/* 初始想定：微陨石击穿 LAB + 尘暴削弱太阳能 */
(function () {
  const MLS = window.MLS;
  const { NODES, EDGES, DEVICES, CREW, SCENE, initGas } = MLS.CONFIG;

  function makeState() {
    const nodes = {};
    NODES.forEach((def) => {
      const isOutside = !!def.outside;
      nodes[def.id] = {
        id: def.id,
        gas: isOutside
          ? { o2: 0, n2: 0, co2: 0 }
          : initGas(def.vol),
        water: 0,
        waste: 0,
        waterCap: 120000,
        wasteCap: 120000,
        o2Quota: 1,
        leak: def.id === "LAB" ? SCENE.leakConductance : 0, // mol/s/kPa
        repairing: 0,
        rates: {}, // 上一 tick 净速率快照（供 UI/ETA）
        alarms: {},
      };
    });

    // 初始饮用水（g）
    Object.assign({} , {});
    nodes.HAB.water = 120000;
    nodes.MED.water = 30000;
    nodes.COR.water = 60000;
    nodes.AGR.water = 90000;
    nodes.LAB.water = 40000;
    nodes.PWR.water = 160000;

    const edges = {};
    EDGES.forEach((e) => {
      edges[e.id] = {
        id: e.id, a: e.a, b: e.b, type: e.type,
        c: e.c ?? 1, delay: e.delay ?? 0,
        closed: false,
        flow: 0, // 上一 tick 流量（带方向，正 a→b）
        queue: [], // 延迟到达的资源包
      };
    });

    const devices = {};
    DEVICES.forEach((d) => {
      devices[d.id] = {
        id: d.id, type: d.type, node: d.node,
        on: d.on,
        state: d.on ? "running" : "off", // off | starting | running | shed | fault
        prio: d.prio ?? MLS.CONFIG.DEVICE_TYPES[d.type].prio,
        startLeft: 0,
        cooldown: 0,
        fuel: MLS.CONFIG.DEVICE_TYPES[d.type].fuel ?? null,
        cap: d.cap ?? null,
      };
    });

    const crew = {};
    CREW.forEach((c) => {
      crew[c.id] = { id: c.id, name: c.name, role: c.role, node: c.node,
        health: c.health, injured: !!c.injured,
        activity: "normal", incapacitated: c.health <= 0, dehydration: 0 };
    });

    const state = {
      t: 0,
      nodes, edges, devices, crew,
      power: { battery: SCENE.batteryKWh, solarFactor: SCENE.stormFactor, supply: 0, load: 0, shed: 0, blackout: false },
      starter: { busy: 0, by: null }, // 备用设备启动母线占用剩余秒数
      transfers: [],   // {crewId, path:[nodeId...], segLeft, segTotal, total}
      pendingO2: [],   // {node, mol, path, segLeft}
      events: [],
      idIndex: {},
      checkpoints: [], // [{eventId, t, label}]
      history: [],     // 采样 {t, eta, alive, o2Min, co2Max, pMin, battery, water}
      ended: null,     // null | {win, reason, t}
      _e: 0,
    };

    seedEvents(state);
    MLS.engine.prime(state);
    MLS.engine.sampleHistory(state);
    return state;
  }

  function addEvent(state, ev) {
    const id = "EV" + String(++state._e).padStart(4, "0");
    const full = Object.assign({ id, t: state.t, kind: "info", level: "info" }, ev);
    state.events.push(full);
    if (state.events.length > 600) state.events.splice(0, state.events.length - 600);
    return full;
  }

  function seedEvents(state) {
    state.idIndex["SOLAR1:storm"] = addEvent(state, { kind: "storm", level: "warn", subject: "SOLAR1",
      msg: "火星尘暴抵达，太阳能阵列出力 25%，预计 6 小时后减弱",
      cause: null }).id;
    state.idIndex["LAB:breach"] = addEvent(state, { kind: "breach", level: "alarm", subject: "LAB",
      msg: "微陨石击穿实验舱外壳！实验舱正在失压，舱内 2 名乘员生命受威胁",
      cause: null, recover: "先转移乘员，再封闭实验舱气闸，隔离后可派人修补破洞（约 10 分钟）" }).id;
    addEvent(state, { kind: "mission", level: "info", subject: "MISSION",
      msg: "救援穿梭机将于 T+8:00:00 抵达。目标：让尽可能多的乘员存活至救援",
      cause: null });
    const cp = addEvent(state, { kind: "checkpoint", level: "ok", subject: "MISSION",
      msg: "稳定点 #0：事故初始状态", cause: null, checkpoint: true });
    state.checkpoints.push({ eventId: cp.id, t: 0, label: "事故初始状态" });
  }

  MLS.scenario = { makeState, addEvent };
})();
