/* 通用工具与常量（全局 MLS 命名空间，脚本直连，无需构建） */
(function () {
  const MLS = (window.MLS = window.MLS || {});

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round = (v, n = 2) => {
    const f = Math.pow(10, n);
    return Math.round(v * f) / f;
  };

  let _uid = 0;
  const uid = (p) => `${p}_${Date.now().toString(36)}_${(_uid++).toString(36)}`;

  const clone = (o) => JSON.parse(JSON.stringify(o));

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  /* 秒 → "HH:MM:SS"（可超过 24 小时） */
  function clockStr(s) {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  /* 秒 → 可读时长 "2天03小时 / 3小时12分 / 4分05秒" */
  function durStr(s) {
    if (s === Infinity || s == null) return "∞";
    s = Math.max(0, Math.floor(s));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0) return `${d}天${h}小时`;
    if (h > 0) return `${h}小时${m}分`;
    if (m > 0) return `${m}分${String(sec).padStart(2, "0")}秒`;
    return `${sec}秒`;
  }

  /* 物理常数 */
  const PHYS = {
    R: 8.314, // J/(mol·K)
    T: 293, // 舱内 20°C
    M_O2: 32, // g/mol
    M_N2: 28,
    M_CO2: 44,
    M_H2O: 18,
  };

  /* 临界阈值（用于告警与健康损伤） */
  const LIM = {
    O2_LO: 17.5, // kPa，低氧
    O2_CRIT: 14.0,
    O2_HI: 25.0, // 高氧/火险
    CO2_HI: 0.5,
    CO2_CRIT: 1.0,
    PRESS_LO: 75,
    PRESS_CRIT: 55,
    PRESS_HI: 115,
    WATER_LO: 200, // g/人 饮用水告急（约 8 小时量）
    HEALTH_REGEN: 0.7, // %/s? 用 0.002/秒（环境正常）
    HEALTH_DMG: 0.01, // 每秒基础损伤（临界时）
    ALIVE_HEALTH: 0,
  };

  Object.assign(MLS, {
    clamp, round, uid, clone, esc,
    clockStr, durStr, PHYS, LIM,
  });
})();
