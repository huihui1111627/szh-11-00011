/* 事件流：严重告警展示完整因果链，链上挂接“可恢复节点/修复动作”按钮 */
(function (root) {
  var MLSS = globalThis.MLSS, U = MLSS.U, UI = (MLSS.UI = MLSS.UI || {});
  var esc = UI.escapeHtml;
  var filter = 'all';

  function state() { return UI.app.manager().active().state; }

  function levelClass(ev) {
    if (ev.level === 'critical') return 'critical';
    if (ev.type === 'ACTION' || ev.type === 'TRANSFER') return 'action';
    if (ev.level === 'warn') return 'warn';
    if (ev.level === 'failed') return 'failed';
    return 'info';
  }

  function matches(ev) {
    if (filter === 'critical') return ev.level === 'critical';
    if (filter === 'action') return ev.type === 'ACTION' || ev.level === 'failed';
    return true;
  }

  function render() {
    var list = document.getElementById('event-list');
    var events = state().events.filter(matches).slice(0, 120);
    if (!events.length) {
      list.innerHTML = '<div class="empty">暂无事件。<br>推进推演或下发操作后，告警与因果链会在此累积。</div>';
      return;
    }
    list.innerHTML = events.map(function (ev) {
      var hasChain = ev.chain && ev.chain.steps && ev.chain.steps.length;
      return '<div class="event-item ' + levelClass(ev) + '" data-id="' + ev.id + '">' +
        '<div class="event-head"><span>' + typeLabel(ev.type) + '</span>' +
          '<span class="event-time">T+' + U.fmtTime(ev.t) + '</span></div>' +
        '<div class="event-msg">' + esc(ev.msg) + '</div>' +
        (hasChain ? '<button class="chain-toggle">▸ 因果链 / 可恢复节点</button><div class="chain">' +
          ev.chain.steps.map(function (s) { return '<div class="chain-step">' + esc(s) + '</div>'; }).join('') +
          (ev.chain.recover && ev.chain.recover.length
            ? '<div class="chain-recover"><span class="rc-label">可恢复节点 / 建议动作</span><div>' +
              ev.chain.recover.map(function (r, i) {
                return '<button class="btn small" data-r="' + i + '">' + esc(r.label) + '</button>';
              }).join('') + '</div></div>'
            : '') +
        '</div>' : '') +
      '</div>';
    }).join('');

    list.querySelectorAll('.event-item').forEach(function (item) {
      var ev = events.filter(function (e) { return e.id === item.getAttribute('data-id'); })[0];
      var tg = item.querySelector('.chain-toggle'), ch = item.querySelector('.chain');
      if (tg) tg.onclick = function () {
        var open = ch.classList.toggle('open');
        tg.textContent = open ? '▾ 收起因果链' : '▸ 因果链 / 可恢复节点';
      };
      item.querySelectorAll('[data-r]').forEach(function (b) {
        b.onclick = function () {
          var rec = ev.chain.recover[+b.getAttribute('data-r')];
          UI.app.runRecovery(rec);
        };
      });
    });
  }

  function typeLabel(t) {
    return ({
      LEAK: '舱体泄漏', REPAIRED: '修复完成', REPAIR_START: '维修派出',
      SEALED: '封闭隔离', UNSEALED: '重新开舱', EDGE_CLOSED: '舱口关闭', EDGE_OPENED: '舱口开启',
      CRIT_ENV: '致命环境', WARN_ENV: '环境告警', CASUALTY: '乘员罹难',
      LOAD_SHED: '负载卸载', POWER_COLLAPSE: '电力危机',
      WATER_LOW: '水储位低', WATER_OUT: '断水',
      O2_SHARE: '氧气分配', PRIORITY: '优先级变更',
      EQ_START: '冷备启动', EQ_READY: '设备并网', EQ_ABORT: '启动中止',
      EQ_ON: '设备开启', EQ_OFF: '设备关闭', EQ_FAILED: '设备故障', EQ_REPAIRED: '设备修复',
      TRANSFER: '乘员转移', TRANSFER_DONE: '转移到达', TRANSFER_BLOCKED: '转移受阻',
      SUIT_O2_OUT: '舱外服耗尽', REACTOR: '反应堆', ACTION: '操作',
      ROLLBACK: '状态回滚', VALVE_EDGE: '舱口阀位'
    })[t] || t;
  }

  UI.events = {
    render: render,
    setFilter: function (f) { filter = f; },
    levelClass: levelClass
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
