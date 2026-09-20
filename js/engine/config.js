/* 基地配置：舱室、连接管线、设备、物理常数。均为“玩法标定”值，非真实工程参数。 */
(function (root) {
  var MLSS = root.MLSS;

  MLSS.CONFIG = {
    version: 1,
    tickMin: 1,                 // 每个 tick = 1 模拟分钟
    forecastMin: 120,           // 前向推演窗口
    moduleCap: { o2: 101.3, co2: 101.3, n2: 101.3 },
    initialMix: { o2: 21.0, co2: 0.4, n2: 80.6 },   // kPa
    thresholds: {
      pressureLowWarn: 80, pressureLowCrit: 60,
      o2LowWarn: 17.5, o2LowCrit: 13.5, o2HighVent: 22.5,
      co2Warn: 1.5, co2Crit: 3.0,
      pressureHighVent: 105,
      dangerMinsToCasualty: 30
    },
    leak: { minor: 0.06, major: 0.5, catastrophic: 1.2 }, // kPa/min（严重泄漏必须尽快封闭）
    leakRepairMins: 12,
    equalConductance: 0.06,    // 舱口气体交换系数（双舱模型，每分钟约 6%）
    crew: {
      o2Rate: 4.0,             // 每人 O2 消耗量（kPa·m³ / min）
      co2Rate: 3.2,            // 每人 CO2 产生量
      waterRate: 0.08,         // 每人饮用水 L/min
      wasteRate: 0.07,         // 每人废水 L/min
      suitO2Mins: 360,         // 舱外服氧气保障
      casualtyMins: 30
    },
    water: { potableInit: 300, potableCap: 500, wasteInit: 60, wasteCap: 300 },
    power: {
      reactorKw: 70, batteryCap: 24, batteryInit: 24,
      maxChargeKw: 20, maxDischargeKw: 20
    },
    inflowDelayTicks: 1,       // O2 分配管道延迟
    maxConcurrentStarts: 1,    // 同一时刻只允许一台冷备设备启动

    modules: [
      { id: 'cmd',  name: '指令舱',   short: 'CMD', type: 'command', volume: 180, crewCap: 4, x: 400, y: 240, w: 120, h: 70 },
      { id: 'ls',   name: '生命保障舱', short: 'LS',  type: 'lifesup', volume: 220, crewCap: 1, x: 150, y: 140, w: 120, h: 70 },
      { id: 'crew', name: '乘员 quarters', short: 'CRW', type: 'habitat', volume: 160, crewCap: 4, x: 150, y: 340, w: 120, h: 70 },
      { id: 'hab',  name: '居住舱',   short: 'HAB', type: 'habitat', volume: 200, crewCap: 4, x: 400, y: 380, w: 120, h: 70 },
      { id: 'farm', name: '农业舱',   short: 'FRM', type: 'farm',    volume: 150, crewCap: 2, x: 650, y: 340, w: 110, h: 70 },
      { id: 'med',  name: '医疗舱',   short: 'MED', type: 'medical', volume: 100, crewCap: 3, x: 660, y: 140, w: 110, h: 70 },
      { id: 'air',  name: '气闸舱',   short: 'AIR', type: 'airlock', volume: 60,  crewCap: 0, x: 30,  y: 250, w: 90,  h: 56 },
      { id: 'rec',  name: '储藏回收舱', short: 'REC', type: 'storage', volume: 140, crewCap: 0, x: 820, y: 340, w: 110, h: 70 },
      { id: 'pwr',  name: '电力舱',   short: 'PWR', type: 'power',   volume: 120, crewCap: 0, x: 390, y: 50,  w: 120, h: 60 }
    ],

    // 环形-辐条拓扑：主环 + 指令舱-居住舱弦线 + 电力舱/气闸支线
    edges: [
      { id: 'e-air-ls',   a: 'air',  b: 'ls',   dist: 2 },
      { id: 'e-ls-hub',   a: 'ls',   b: 'cmd',  dist: 3 },
      { id: 'e-ls-crew',  a: 'ls',   b: 'crew', dist: 3 },
      { id: 'e-hub-crew', a: 'cmd',  b: 'crew', dist: 3 },
      { id: 'e-hub-pwr',  a: 'cmd',  b: 'pwr',  dist: 1 },
      { id: 'e-hub-med',  a: 'cmd',  b: 'med',  dist: 3 },
      { id: 'e-hub-hab',  a: 'cmd',  b: 'hab',  dist: 2 },
      { id: 'e-crew-hab', a: 'crew', b: 'hab',  dist: 3 },
      { id: 'e-hab-farm', a: 'hab',  b: 'farm', dist: 3 },
      { id: 'e-farm-med', a: 'farm', b: 'med',  dist: 3 },
      { id: 'e-farm-rec', a: 'farm', b: 'rec',  dist: 2 },
      { id: 'e-med-rec',  a: 'med',  b: 'rec',  dist: 3 }
    ],

    // 虚拟输水支路（仅可视化；水在模型中为全基地共用储箱）
    waterLinks: [
      { from: 'ls', to: 'crew' }, { from: 'ls', to: 'hab' }, { from: 'ls', to: 'med' },
      { from: 'ls', to: 'farm' }, { from: 'rec', to: 'ls' }, { from: 'ls', to: 'cmd' }
    ],

    equipment: [
      { id: 'o2gen',    mod: 'ls',   kind: 'o2gen',     name: 'O₂ 电解发生器', pwr: 12, rate: 40, prio: 30, on: true },
      { id: 'scrub',    mod: 'ls',   kind: 'scrubber',  name: 'CO₂ 洗涤器',   pwr: 10, rate: 60, prio: 20, on: true },
      { id: 'recycle',  mod: 'ls',   kind: 'recycler',  name: '水回收净化器', pwr: 8,  rate: 1.2, prio: 50, on: true },
      { id: 'reactor',  mod: 'pwr',  kind: 'source',    name: '核裂变反应堆', pwr: 0, out: 70, prio: 0, on: true, fixed: true },
      { id: 'fuelcell', mod: 'pwr',  kind: 'source',    name: '燃料电池（备用）', pwr: 0, out: 30, prio: 0, on: false,
        backup: true, cold: true, startMin: 4, inrush: 22 },
      { id: 'scrub2',   mod: 'med',  kind: 'scrubber',  name: 'CO₂ 洗涤器（备用）', pwr: 10, rate: 60, prio: 25, on: false,
        backup: true, cold: true, startMin: 3, inrush: 18 },
      { id: 'recycle2', mod: 'rec',  kind: 'recycler',  name: '水回收器（备用）', pwr: 6, rate: 0.7, prio: 55, on: false,
        backup: true, cold: true, startMin: 3, inrush: 14 },
      { id: 'farm-lt',  mod: 'farm', kind: 'growlight', name: '作物生长灯',    pwr: 9, o2rate: 7, water: 0.3, prio: 70, on: true },
      { id: 'heat-med', mod: 'med',  kind: 'heater',    name: '电加热器', pwr: 5, prio: 85, on: true },
      { id: 'heat-hab', mod: 'hab',  kind: 'heater',    name: '电加热器', pwr: 4, prio: 85, on: true },
      { id: 'heat-crw', mod: 'crew', kind: 'heater',    name: '电加热器', pwr: 4, prio: 85, on: true },
      { id: 'fridge',   mod: 'rec',  kind: 'fridge',    name: '食品冷藏柜', pwr: 4, prio: 75, on: true },
      { id: 'comms',    mod: 'cmd',  kind: 'lights',    name: '通讯与照明', pwr: 3, prio: 65, on: true },
      { id: 'pump',     mod: 'air',  kind: 'pump',      name: '气闸泵组', pwr: 4, prio: 90, on: true }
    ],

    crewInit: { cmd: 2, crew: 3, hab: 2, farm: 1 }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
