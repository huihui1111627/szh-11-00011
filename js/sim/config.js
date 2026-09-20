/* 静态配置：舱室布局 / 管道 / 设备目录 / 乘员定义 */
(function () {
  const MLS = window.MLS;

  /* ---- 舱室（x/y/w/h 为 SVG 坐标，viewBox 980×560） ---- */
  const NODES = [
    { id: "HAB", name: "居住区", en: "HABITAT", vol: 70, x: 36,  y: 150, w: 172, h: 118 },
    { id: "MED", name: "医疗舱", en: "MEDICAL", vol: 35, x: 36,  y: 322, w: 172, h: 104 },
    { id: "COR", name: "中央走廊", en: "CORRIDOR", vol: 25, x: 252, y: 246, w: 148, h: 96 },
    { id: "AGR", name: "农业舱", en: "AGRI-DOME", vol: 60, x: 446, y: 78,  w: 164, h: 112 },
    { id: "LAB", name: "实验舱", en: "LAB", vol: 50, x: 446, y: 348, w: 164, h: 112 },
    { id: "PWR", name: "能源生保站", en: "POWER/LSS", vol: 45, x: 668, y: 158, w: 176, h: 132 },
    { id: "EVA", name: "火星表面", en: "SURFACE", vol: Infinity, x: 700, y: 386, w: 140, h: 86, outside: true },
  ];

  /* ---- 管道：c 传导系数（mol·s⁻¹·kPa⁻¹ / g·s⁻¹），delay 传输延迟(秒) ---- */
  const EDGES = [
    // 气体（压力平衡 + O2/CO2 混合气）
    { id: "E_G_HAB_COR", a: "HAB", b: "COR", type: "gas",   c: 0.27, delay: 12 },
    { id: "E_G_MED_COR", a: "MED", b: "COR", type: "gas",   c: 0.24, delay: 18 },
    { id: "E_G_COR_AGR", a: "COR", b: "AGR", type: "gas",   c: 0.27, delay: 14 },
    { id: "E_G_COR_LAB", a: "COR", b: "LAB", type: "gas",   c: 0.27, delay: 14 },
    { id: "E_G_COR_PWR", a: "COR", b: "PWR", type: "gas",   c: 0.27, delay: 12 },
    // 水（可饮用/废水共用管网，流向由液位梯度决定）
    { id: "E_W_HAB_COR", a: "HAB", b: "COR", type: "water", c: 50, delay: 20 },
    { id: "E_W_MED_COR", a: "MED", b: "COR", type: "water", c: 35, delay: 30 },
    { id: "E_W_COR_AGR", a: "COR", b: "AGR", type: "water", c: 50, delay: 25 },
    { id: "E_W_COR_LAB", a: "COR", b: "LAB", type: "water", c: 35, delay: 30 },
    { id: "E_W_COR_PWR", a: "COR", b: "PWR", type: "water", c: 60, delay: 25 },
    // 电力（全局母线，仅用于态势展示与断电区域标识）
    { id: "E_P_COR_PWR", a: "PWR", b: "COR", type: "power" },
    { id: "E_P_HAB_COR", a: "HAB", b: "COR", type: "power" },
    { id: "E_P_MED_COR", a: "MED", b: "COR", type: "power" },
    { id: "E_P_COR_AGR", a: "COR", b: "AGR", type: "power" },
    { id: "E_P_COR_LAB", a: "COR", b: "LAB", type: "power" },
  ];

  /* ---- 设备类型目录 ----
     run 运行功率 kW；surge 启动峰值增量 kW；startT 启动耗时 s；prio 默认优先级
     supply 发电 kW；rate 处理量（含义随 kind） */
  const DEVICE_TYPES = {
    oxy:       { name: "制氧机（电解水）", run: 2.5, surge: 0,    startT: 0,  prio: 1,
                 o2Rate: 0.075, waterPerMolO2: 36, desc: "电解水产生 O₂，同时消耗饮用水" },
    oxy2:      { name: "备用制氧机",       run: 2.2, surge: 4.0,  startT: 40, prio: 1,
                 o2Rate: 0.065, waterPerMolO2: 36, starter: true,
                 desc: "冷启动需占用备用启动母线 40 秒，峰值冲击 4.0 kW" },
    recycler:  { name: "水回收净化器",     run: 0.7, surge: 0,    startT: 0,  prio: 2,
                 wasteRate: 1.5, eff: 0.93, desc: "将废水净化为饮用水，闭合度 93%" },
    scrubber:  { name: "CO₂ 净化装置",     run: 0.8, surge: 0,    startT: 0,  prio: 2,
                 co2Rate: 0.020, desc: "锂羟基吸收 CO₂" },
    fan:       { name: "通风风机",         run: 0.35,surge: 0.2,  startT: 3,  prio: 2,
                 desc: "保障舱室间气体交换；停机后管道仅剩微渗漏" },
    solar:     { name: "太阳能阵列",       run: 0,   surge: 0,    startT: 0,  prio: 1,
                 supply: 12, desc: "尘暴期间出力降至 25%" },
    rtg:       { name: "核温差电池 RTG",   run: 0,   surge: 0,    startT: 0,  prio: 1,
                 supply: 1.2, desc: "恒定 1.2 kW，不可关闭" },
    fuelCell:  { name: "备用燃料电池",     run: 0,   surge: 1.0,  startT: 90, prio: 1,
                 supply: 2.0, starter: true, fuel: 21600,
                 desc: "2 kW，氢燃料可运行 6 小时；冷启动占用母线 90 秒" },
    load:      { name: "固定负载",         run: 0.5, surge: 0,    startT: 0,  prio: 4,
                 desc: "照明/仪器/种植灯等，可被电网分级切除" },
  };

  const DEVICES = [
    { id: "SOLAR1",  type: "solar",     node: "PWR", on: true,  fixedLoadName: "太阳能阵列" },
    { id: "RTG1",    type: "rtg",       node: "PWR", on: true },
    { id: "OXY1",    type: "oxy",       node: "PWR", on: true },
    { id: "OXY2",    type: "oxy2",      node: "PWR", on: false },
    { id: "FC1",     type: "fuelCell",  node: "PWR", on: false },
    { id: "REC_HAB", type: "recycler",  node: "HAB", on: true },
    { id: "REC_AGR", type: "recycler",  node: "AGR", on: true },
    { id: "SCR_HAB", type: "scrubber",  node: "HAB", on: true, cap: 0.032 },
    { id: "SCR_MED", type: "scrubber",  node: "MED", on: true },
    { id: "SCR_AGR", type: "scrubber",  node: "AGR", on: true },
    { id: "SCR_LAB", type: "scrubber",  node: "LAB", on: true },
    { id: "FAN_HAB", type: "fan",       node: "HAB", on: true },
    { id: "FAN_AGR", type: "fan",       node: "AGR", on: true },
    { id: "FAN_PWR", type: "fan",       node: "PWR", on: true },
    { id: "FAN_COR", type: "fan",       node: "COR", on: true },
    { id: "LD_HAB",  type: "load",      node: "HAB", on: true,  prio: 4, run: 0.5,  fixedLoadName: "生活照明/加热" },
    { id: "LD_MED",  type: "load",      node: "MED", on: true,  prio: 2, run: 0.25, fixedLoadName: "医疗监护仪" },
    { id: "LD_AGR",  type: "load",      node: "AGR", on: true,  prio: 4, run: 0.45, fixedLoadName: "种植灯" },
    { id: "LD_LAB",  type: "load",      node: "LAB", on: true,  prio: 3, run: 0.6,  fixedLoadName: "实验仪器" },
  ];

  /* ---- 乘员 ---- */
  const CREW = [
    { id: "C1", name: "李远征", role: "指令长",   node: "HAB", health: 100 },
    { id: "C2", name: "林岚",   role: "机电工程师", node: "HAB", health: 100 },
    { id: "C7", name: "马克",   role: "飞行员",   node: "HAB", health: 100 },
    { id: "C8", name: "伊万",   role: "地质学家", node: "HAB", health: 100 },
    { id: "C3", name: "苏晴",   role: "医官",     node: "MED", health: 100 },
    { id: "C4", name: "田野",   role: "植物学家", node: "AGR", health: 100 },
    { id: "C5", name: "赵磊",   role: "化学家",   node: "LAB", health: 60, injured: true },
    { id: "C6", name: "阿依努尔", role: "材料学家", node: "LAB", health: 100 },
  ];

  /* ---- 场景常量 ---- */
  const SCENE = {
    rescueAt: 28800,        // 救援穿梭机抵达（8 小时）
    stormEndsAt: 21600,     // 尘暴 6 小时后减弱
    stormFactor: 0.25,
    batteryKWh: 30,
    batteryMaxIO: 8,        // kW
    leakConductance: 0.06,  // LAB 破洞（mol/s/kPa）
    crewO2molS: 0.0064,     // 每人 O2 消耗
    crewCO2molS: 0.0056,    // 每人 CO2 呼出
    crewWaterGS: 0.417,     // 每人饮水 g/s（25 g/分）
    crewWasteGS: 0.40,      // 每人废水 g/s
    edgeHatchTime: 45,      // 乘员每跨越一道气闸耗时
    repairTime: 600,        // 破洞修补耗时（隔离后）
    passiveFanFactor: 0.12, // 无风机舱室的被动导通
  };

  /* 初始大气：101.3 kPa，O2 21% / N2 78.7% / CO2 0.04% */
  function initGas(vol) {
    const P = 101.3;
    const n = (P * 1000 * vol) / (MLS.PHYS.R * MLS.PHYS.T);
    return { o2: n * 0.2095, n2: n * 0.7861, co2: n * 0.0004 };
  }

  MLS.CONFIG = { NODES, EDGES, DEVICE_TYPES, DEVICES, CREW, SCENE, initGas };
})();
