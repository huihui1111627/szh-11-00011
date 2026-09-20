/* 延迟影响预测：基线 120 分钟前向推演 + 操作预演（试算不提交），逐项给出延迟与差异 */
(function (root) {
  var MLSS = globalThis.MLSS, U = MLSS.U, sim = MLSS.sim, fc = MLSS.forecast, C = MLSS.CONFIG, UI = (MLSS.UI = MLSS.UI || {});
  var esc = UI.escapeHtml;

  function state() { return UI.app.manager().active().state; }

  function metricGrid(d, sup) {
    var worstP = Math.min.apply(null, d.mods.map(function (m) { return m.p; }));
    var worstO2 = Math.min.apply(null, d.mods.filter(function (m) { return m.crew; })
      .map(function (m) { return m.o2; }));
    return '<div class="fc-grid">' +
      cell('综合保障时间', U.fmtTime(sup.overall), sup.overall === null ? 'good' :
        (sup.overall < 30 ? 'bad' : sup.overall < 90 ? 'warn' : 'good')) +
      cell('O₂ 致命时刻', U.fmtTime(sup.o2)) +
      cell('舱压致命时刻', U.fmtTime(sup.pressure)) +
      cell('CO₂ 致命时刻', U.fmtTime(sup.co2)) +
      cell('饮用水耗尽', U.fmtTime(sup.water)) +
      cell('电力告罄', U.fmtTime(sup.power)) +
      cell('最低舱压', worstP.toFixed(0) + ' kPa') +
      cell('乘员舱最低 O₂', (worstO2 || 0).toFixed(1) + ' kPa') +
      cell('饮用水储位', d.water.toFixed(0) + ' L') +
      cell('电池电量', d.battery.toFixed(1) + ' kWh') +
      cell('当前负载/出力', d.demand.toFixed(0) + ' / ' + d.supplied.toFixed(0) + ' kW') +
      cell('乘员（含伤亡）', d.crew + ' 人' + (d.casualties ? '（累计减员 ' + d.casualties + '）' : '')) +
      '</div>';
  }
  function cell(k, v, cls) {
    return '<span class="k">' + esc(k) + '</span><span class="v ' + (cls || '') + '">' + esc(v) + '</span>';
  }
  function eventsHtml(f) {
    if (!f.events.length) return '<div class="fc-events"><div class="fc-event">未来 ' + f.horizon +
      ' 分钟内无阈值穿越事件。</div></div>';
    return '<div class="fc-events">' + f.events.map(function (e) {
      return '<div class="fc-event ' + (e.level === 'critical' ? 'crit' : '') +
        '"><span class="t">+' + String(e.at).padStart(3, ' ') + ' min</span><span>' + esc(e.msg) + '</span></div>';
    }).join('') + '</div>';
  }

  function renderBaseline() {
    var s = state();
    var f = fc.run(s, C.forecastMin);
    var sup = fc.supportTimes(s);
    document.getElementById('forecast-baseline').innerHTML =
      '<h4>基线（不采取新操作）</h4>' + metricGrid(f.end, sup) + eventsHtml(f);
  }

  /* 操作预演：克隆当前状态 -> 试应用命令（不提交）-> 再推演，展示差异与新出现的延迟事件 */
  function previewCommand(cmd, label) {
    var s = state();
    var trial = U.clone(s);
    var res = MLSS.commands.apply(trial, cmd);
    var pane = document.getElementById('forecast-proposal');
    pane.hidden = false;
    if (!res.ok) {
      pane.innerHTML = '<h4>操作预演失败：' + esc(label || cmd.type) + '</h4>' +
        '<div class="fc-event crit"><span class="t">即时</span><span>' + esc(res.error) + '</span></div>' +
        '<div class="chain open" id="preview-chain"></div>';
      var ch = pane.querySelector('#preview-chain');
      (res.chain.steps || []).forEach(function (st) {
        var d = document.createElement('div'); d.className = 'chain-step'; d.textContent = st; ch.appendChild(d);
      });
      switchTab('forecast');
      return res;
    }
    var base = fc.run(s, C.forecastMin), prop = fc.run(trial, C.forecastMin);
    var bSup = fc.supportTimes(s), pSup = fc.supportTimes(trial);
    var delta = function (name, b, p, lowerBetter) {
      if (b === null && p === null) return '';
      var bv = b === null ? 9999 : b, pv = p === null ? 9999 : p;
      var cls = pv === bv ? 'delta-flat' : ((pv < bv) !== lowerBetter ? 'delta-good' : 'delta-bad');
      var arrow = pv === bv ? '＝' : (pv > bv ? '▲ 延后 ' : '▼ 提前 ');
      var diff = Math.abs(pv - bv);
      return '<span class="k">' + name + '差异</span><span class="v ' + cls + '">' +
        arrow + (pv === 9999 || bv === 9999 ? U.fmtTime(Math.min(pv, bv)) : U.fmtTime(diff)) + '</span>';
    };
    var baseKeys = {};
    base.events.forEach(function (e) { baseKeys[e.type + e.at] = 1; });
    var newEvents = prop.events.filter(function (e) { return !baseKeys[e.type + e.at]; });
    pane.innerHTML = '<h4>操作预演：' + esc(label || cmd.type) + '（未提交，可对比后执行）</h4>' +
      '<div class="fc-grid">' +
        cell('综合保障', U.fmtTime(pSup.overall), pSup.overall === null ? 'good' :
          (pSup.overall < 30 ? 'bad' : pSup.overall < 90 ? 'warn' : '')) +
        delta('综合保障', bSup.overall, pSup.overall) +
        cell('最低舱压(末)', prop.end.mods.reduce(function (a, m) { return Math.min(a, m.p); }, 999).toFixed(0) + ' kPa') +
        cell('基线最低舱压(末)', base.end.mods.reduce(function (a, m) { return Math.min(a, m.p); }, 999).toFixed(0) + ' kPa') +
      '</div>' +
      (newEvents.length ? '<div class="fc-events"><div class="fc-event">该操作在窗口内新引发/提前的事件：</div>' +
        newEvents.map(function (e) {
          return '<div class="fc-event ' + (e.level === 'critical' ? 'crit' : '') +
            '"><span class="t">+' + String(e.at).padStart(3, ' ') + ' min</span><span>' +
            esc(e.msg) + '</span></div>';
        }).join('') + '</div>' :
        '<div class="fc-events"><div class="fc-event">未在 120 分钟窗口内引入新的阈值穿越。</div></div>') +
      '<div class="op-row"><button class="btn small primary" id="preview-commit">确认并真正执行</button>' +
      '<button class="btn small ghost" id="preview-discard">放弃预演</button></div>';
    pane.querySelector('#preview-commit').onclick = function () {
      UI.app.dispatch(cmd); pane.hidden = true; pane.innerHTML = '';
    };
    pane.querySelector('#preview-discard').onclick = function () { pane.hidden = true; pane.innerHTML = ''; };
    switchTab('forecast');
    return res;
  }

  function switchTab(name) {
    document.querySelectorAll('#side-tabs nav button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    document.querySelectorAll('.tabpane').forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-pane') === name);
    });
  }

  UI.forecast = { renderBaseline: renderBaseline, previewCommand: previewCommand, switchTab: switchTab };
})(typeof globalThis !== 'undefined' ? globalThis : this);
