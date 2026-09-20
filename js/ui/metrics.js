/* 顶部指标条：各资源剩余保障时间（每 1.5 秒重算一次，避免逐 tick 全量前向推演） */
(function (root) {
  var MLSS = globalThis.MLSS, U = MLSS.U, sim = MLSS.sim, fc = MLSS.forecast, UI = (MLSS.UI = MLSS.UI || {});
  var cache = null, cacheT = -1, cacheAt = 0;

  function lvl(min) {
    if (min === null) return 'ok';
    if (min < 30) return 'crit';
    if (min < 90) return 'warn';
    return 'ok';
  }

  function setMetric(id, text, min, ratio) {
    var node = document.getElementById(id);
    node.className = 'metric ' + (id === 'm-overall' ? 'overall ' : '') + lvl(min);
    node.querySelector('.mvalue').textContent = text;
    node.querySelector('i').style.width = Math.round((ratio == null ? 1 : ratio) * 100) + '%';
  }

  function renderClock(s) {
    document.getElementById('sim-clock').textContent = 'T+' + U.fmtTime(s.t);
    document.getElementById('sim-date').textContent = U.solLabel(s.t);
  }

  function render(force) {
    var st = UI.app.manager().active(), s = st.state;
    renderClock(s);
    var now = Date.now();
    if (!force && cacheT === s.t && now - cacheAt < 1500) return;
    cacheT = s.t; cacheAt = now;

    var sup = fc.supportTimes(s), d = fc.derive(s);
    cache = sup;
    setMetric('m-oxygen', U.fmtTime(sup.o2), sup.o2, sup.o2 === null ? 1 : Math.min(1, sup.o2 / 240));
    setMetric('m-water', U.fmtTime(sup.water) + ' · ' + d.water.toFixed(0) + 'L',
      sup.water, d.water / 300);
    setMetric('m-pressure', U.fmtTime(sup.pressure), sup.pressure,
      sup.pressure === null ? 1 : Math.min(1, sup.pressure / 240));
    setMetric('m-power', U.fmtTime(sup.power) + ' · ' + d.battery.toFixed(0) + 'kWh',
      sup.power, d.battery / 24);
    var crewText = d.crew + ' 人' + (d.casualties ? ' · 减员' + d.casualties : '');
    setMetric('m-crew', crewText, sup.casualty, d.crew / 8);
    setMetric('m-overall', U.fmtTime(sup.overall), sup.overall,
      sup.overall === null ? 1 : Math.min(1, sup.overall / 240));
  }

  UI.metrics = { render: render };
})(typeof globalThis !== 'undefined' ? globalThis : this);
