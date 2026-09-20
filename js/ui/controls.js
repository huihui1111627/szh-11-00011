/* 调度面板：选中对象的详情与操作入口；所有动作经 app.dispatch 走事务命令 */
(function (root) {
  var MLSS = globalThis.MLSS, U = MLSS.U, C = MLSS.CONFIG, sim = MLSS.sim, UI = (MLSS.UI = MLSS.UI || {});
  var esc = UI.escapeHtml;

  function state() { return UI.app.manager().active().state; }
  function dispatch(cmd) { return UI.app.dispatch(cmd); }

  function render(sel) {
    var empty = document.getElementById('selection-empty');
    var detail = document.getElementById('selection-detail');
    if (!sel) { empty.hidden = false; detail.hidden = true; return; }
    empty.hidden = true; detail.hidden = false;
    detail.innerHTML = '';
    if (sel.kind === 'mod') detail.appendChild(modCard(sel.id));
    if (sel.kind === 'edge') detail.appendChild(edgeCard(sel.id));
  }

  function kv(k, v, cls) {
    return '<div class="kv"><span>' + esc(k) + '</span><b class="' + (cls || '') + '">' + esc(v) + '</b></div>';
  }

  function modCard(id) {
    var s = state(), m = sim.mod(s, id), p = sim.pressure(m);
    var card = document.createElement('div');
    var T = C.thresholds;
    var cls = function (v, w, c, hi) { return hi ? (v < c ? 'bad' : v < w ? 'warn' : 'good') :
      (v > c ? 'bad' : v > w ? 'warn' : 'good'); };
    var o2Cls = cls(m.gas.o2, T.o2LowWarn, T.o2LowCrit, true);
    var co2Cls = cls(m.gas.co2, T.co2Warn, T.co2Crit, false);
    var pCls = cls(p, T.pressureLowWarn, T.pressureLowCrit, true);
    var eqs = s.equipment.filter(function (q) { return q.mod === id; });
    var connected = s.edges.filter(function (e) { return e.a === id || e.b === id; });

    card.innerHTML =
      '<div class="detail-card"><h4>' + esc(m.name) +
        '<span class="cp-tag">' + ({command:'指挥',lifesup:'生命保障',habitat:'居住',farm:'农业',
          medical:'医疗',airlock:'气闸',storage:'储藏',power:'电力'})[m.type] + '</span></h4>' +
        kv('舱压', p.toFixed(1) + ' kPa', pCls) +
        kv('O₂ 分压', m.gas.o2.toFixed(2) + ' kPa', o2Cls) +
        kv('CO₂ 分压', m.gas.co2.toFixed(2) + ' kPa', co2Cls) +
        kv('乘员 / 容量', m.crew + ' / ' + m.crewCap) +
        kv('舱内容积', m.volume + ' m³') +
        kv('隔离状态', m.sealed ? '已封闭' : '并入回路', m.sealed ? 'warn' : 'good') +
        kv('泄漏', m.leak ? ({minor:'轻微',major:'严重',catastrophic:'灾难性'})[m.leak.rate] +
          (m.leak.repairReadyAt !== null ? '（维修中 ' + U.fmtTime(m.leak.repairReadyAt - s.t) + '）' : '')
          : '无', m.leak ? 'bad' : 'good') +
        (m.dangerMin > 0 ? kv('危险暴露', m.dangerMin + ' / ' + T.dangerMinsToCasualty + ' 分钟', 'bad') : '') +
      '</div>' +
      '<div class="detail-card"><h4>氧气分配阀</h4>' +
        '<div class="slider-row">权重<input type="range" id="share-range" min="0" max="3" step="0.5" value="' +
          m.share + '"><b id="share-val">×' + m.share + '</b></div>' +
        '<div class="op-row">' +
          '<button class="btn small" id="op-seal">' + (m.sealed ? '🔓 重新开启舱段' : '🔒 封闭舱段（隔离泄漏）') + '</button>' +
          '<button class="btn small" id="op-transfer">🚶 安排乘员转移…</button>' +
        '</div>' +
        '<div class="op-row">' +
          (m.sealed
            ? '<button class="btn small ghost" id="op-preview-unseal">🔭 预演：开启舱段的影响</button>'
            : '<button class="btn small ghost" id="op-preview-seal">🔭 预演：封闭舱段的影响</button>') +
        '</div>' +
        '<div class="op-row">' +
          (m.leak
            ? '<button class="btn small" id="op-repair" ' +
                (m.leak.repairReadyAt !== null ? 'disabled' : '') + '>🛠 派出破损维修（' +
                C.leakRepairMins + ' 分钟）</button>'
            : '<button class="btn small ghost" id="op-leak">注入破损（演练）</button>') +
        '</div>' +
      '</div>' +
      (eqs.length ? '<div class="detail-card"><h4>本舱设备 · 优先级/启停</h4>' +
        eqs.map(equipRowHtml).join('') + '</div>' : '') +
      (connected.length ? '<div class="detail-card"><h4>连接舱口</h4>' +
        connected.map(function (e) {
          var otherId = e.a === id ? e.b : e.a;
          var other = sim.mod(s, otherId);
          return '<div class="kv"><span>↔ ' + esc(other.name) + '</span><b class="' +
            (e.open ? 'good' : 'bad') + '">' + (e.open ? Math.round(e.valve * 100) + '%' : '已关闭') + '</b></div>';
        }).join('') + '</div>' : '');

    var range = card.querySelector('#share-range');
    var val = card.querySelector('#share-val');
    range.oninput = function () { val.textContent = '×' + range.value; };
    range.onchange = function () { dispatch({ type: 'valve', payload: { mod: id, share: +range.value } }); };

    card.querySelector('#op-seal').onclick = function () {
      dispatch({ type: m.sealed ? 'unseal' : 'seal', payload: { mod: id } });
    };
    card.querySelector('#op-transfer').onclick = function () { openTransferDialog(id); };
    var pvSeal = card.querySelector('#op-preview-seal');
    if (pvSeal) pvSeal.onclick = function () {
      UI.forecast.previewCommand({ type: 'seal', payload: { mod: id } }, '封闭 ' + m.name);
    };
    var pvUnseal = card.querySelector('#op-preview-unseal');
    if (pvUnseal) pvUnseal.onclick = function () {
      UI.forecast.previewCommand({ type: 'unseal', payload: { mod: id } }, '开启 ' + m.name);
    };
    var rep = card.querySelector('#op-repair');
    if (rep) rep.onclick = function () { dispatch({ type: 'repairLeak', payload: { mod: id } }); };
    var lk = card.querySelector('#op-leak');
    if (lk) lk.onclick = function () { dispatch({ type: 'injectLeak', payload: { mod: id, rate: 'major' } }); };

    card.querySelectorAll('[data-equip]').forEach(function (btn) {
      btn.onclick = function () {
        var qid = btn.getAttribute('data-equip'), act = btn.getAttribute('data-act');
        if (act === 'toggle') dispatch({ type: 'toggleEquip', payload: { equip: qid, on: btn.getAttribute('data-on') === '1' } });
        if (act === 'prio-up' || act === 'prio-down') {
          var q = sim.eq(s, qid);
          dispatch({ type: 'priority', payload: { equip: qid, prio: q.prio + (act === 'prio-up' ? 5 : -5) } });
        }
        if (act === 'repair') dispatch({ type: 'repairEquip', payload: { equip: qid } });
      };
    });
    return card;
  }

  function equipRowHtml(q) {
    var stCn = { on: '运行中', standby: '冷备待机', off: '已关闭', starting: '启动中…', failed: '故障' };
    var cls = { on: 'on', standby: 'off', off: 'off', starting: 'starting', failed: 'failed' }[q.status];
    var wantOn = q.status === 'off' || q.status === 'standby';
    return '<div class="equip-row ' + cls + '">' +
      '<div><div class="ename">' + esc(q.name) + '</div>' +
        '<div class="estate">' + stCn[q.status] +
          (q.status === 'starting' && q.readyAt !== null ? '（余 ' + U.fmtTime(q.readyAt - state().t) + '）' : '') +
          (q.shed ? ' · 已卸载' : '') + (q.fixed ? ' · 固定' : '') + '</div></div>' +
      '<div class="equip-actions">' +
        '<button class="mini-btn" data-equip="' + q.id + '" data-act="prio-down" title="降低卸载优先级数值（更晚被卸载）">P−</button>' +
        '<span class="mini-btn" style="cursor:default">P' + q.prio + '</span>' +
        '<button class="mini-btn" data-equip="' + q.id + '" data-act="prio-up">P+</button>' +
        (q.status === 'failed'
          ? '<button class="mini-btn" data-equip="' + q.id + '" data-act="repair">维修</button>'
          : '<button class="mini-btn" data-equip="' + q.id + '" data-act="toggle" data-on="' +
              (wantOn ? '1' : '0') + '">' + (wantOn ? '启动' : '停止') + '</button>') +
      '</div></div>';
  }

  function edgeCard(eid) {
    var s = state(), e = sim.edge(s, eid), A = sim.mod(s, e.a), B = sim.mod(s, e.b);
    var card = document.createElement('div');
    card.innerHTML =
      '<div class="detail-card"><h4>' + esc(A.name) + ' ↔ ' + esc(B.name) + '</h4>' +
        kv('舱口状态', e.open ? '开启' : '已关闭', e.open ? 'good' : 'bad') +
        kv('距离', e.dist + ' 舱段（转移耗时）') +
        kv('A 舱压', sim.pressure(A).toFixed(1) + ' kPa') +
        kv('B 舱压', sim.pressure(B).toFixed(1) + ' kPa') +
        kv('压差 Δ', (sim.pressure(A) - sim.pressure(B)).toFixed(1) + ' kPa',
          Math.abs(sim.pressure(A) - sim.pressure(B)) > 15 ? 'warn' : 'good') +
      '</div>' +
      '<div class="detail-card"><h4>阀位（气体交换速率）</h4>' +
        '<div class="slider-row"><input type="range" id="edge-range" min="0" max="1" step="0.1" value="' +
          e.valve + '"><b id="edge-val">' + Math.round(e.valve * 100) + '%</b></div>' +
        '<div class="op-row"><button class="btn small" id="edge-toggle">' +
          (e.open ? '🚫 关闭舱口阀' : '✅ 打开舱口阀') + '</button></div>' +
      '</div>';
    var range = card.querySelector('#edge-range'), val = card.querySelector('#edge-val');
    range.oninput = function () { val.textContent = Math.round(range.value * 100) + '%'; };
    range.onchange = function () { dispatch({ type: 'edge', payload: { edge: eid, valve: +range.value } }); };
    card.querySelector('#edge-toggle').onclick = function () {
      dispatch({ type: 'edge', payload: { edge: eid, open: !e.open } });
    };
    return card;
  }

  function openTransferDialog(fromId) {
    var s = state(), m = sim.mod(s, fromId);
    var wrap = document.createElement('div');
    wrap.innerHTML = '<h2>安排乘员转移</h2>' +
      '<p class="cmp-note">从 <b style="color:var(--cyan)">' + esc(m.name) + '</b>（当前 ' + m.crew +
        ' 人）出发；系统校验通道连通性、目标容量与预计耗时。</p>' +
      '<div class="detail-card">' +
        '<div class="slider-row">转移人数 <input type="range" id="tr-count" min="1" max="' +
          Math.max(1, m.crew) + '" step="1" value="' + Math.max(1, m.crew) +
          '"><b id="tr-count-val"></b></div>' +
      '</div>' +
      '<div id="tr-targets"></div>' +
      '<div class="modal-foot"><button class="btn ghost" id="tr-cancel">取消</button></div>';
    var modal = UI.modal(wrap);
    var range = wrap.querySelector('#tr-count'), countVal = wrap.querySelector('#tr-count-val');
    function count() { return Math.min(+range.value, m.crew); }
    function refresh() {
      countVal.textContent = count() + ' 人';
      var list = wrap.querySelector('#tr-targets');
      list.innerHTML = '';
      s.mods.filter(function (x) { return x.id !== fromId; }).forEach(function (t) {
        var path = sim.findPath(s, fromId, t.id);
        var delay = path ? path.slice(1).reduce(function (d, mid, i) {
          var e = s.edges.filter(function (x) {
            return (x.a === path[i] && x.b === mid) || (x.b === path[i] && x.a === mid);
          })[0];
          return d + (e ? e.dist : 2);
        }, 0) : null;
        var full = !t.sealed && t.crew + count() > t.crewCap;
        var row = document.createElement('div');
        row.className = 'cp-item';
        row.innerHTML = '<div class="cp-head"><b>' + esc(t.name) + '</b>' +
          '<span class="event-time">' + (path ? '⏱ ' + delay + ' 分钟 · ' + path.map(function (i) {
            return sim.mod(s, i).short; }).join('→') : '⛔ 无连通路径') + '</span></div>' +
          '<div class="cp-reason">乘员 ' + t.crew + '/' + t.crewCap +
            (t.sealed ? ' · 目标舱封闭（到达后将等待开舱）' : '') +
            (full ? ' · 容量不足' : '') + '</div>' +
          (path && !full ? '<button class="btn small">转移 ' + count() + ' 人到此舱</button>' : '');
        var btn = row.querySelector('button');
        if (btn) btn.onclick = function () {
          var res = dispatch({ type: 'transfer', payload: { from: fromId, to: t.id, count: count() } });
          if (res.ok) modal.close();
        };
        list.appendChild(row);
      });
    }
    range.oninput = refresh;
    wrap.querySelector('#tr-cancel').onclick = modal.close;
    refresh();
  }

  UI.controls = { render: render, openTransferDialog: openTransferDialog };
})(typeof globalThis !== 'undefined' ? globalThis : this);
