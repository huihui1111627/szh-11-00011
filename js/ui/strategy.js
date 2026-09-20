/* 底部策略栏：多套救援方案卡片 + 同步对照表 */
(function (root) {
  var MLSS = globalThis.MLSS, U = MLSS.U, UI = (MLSS.UI = MLSS.UI || {});
  var esc = UI.escapeHtml;

  function mgr() { return UI.app.manager(); }

  function render() {
    var host = document.getElementById('strategy-strip');
    var rows = mgr().compare();
    host.innerHTML = '';
    rows.forEach(function (r) {
      var card = document.createElement('div');
      card.className = 'strat-card' + (r.id === mgr().activeId ? ' active' : '');
      var supportCls = r.support === null ? 'good' : (r.support < 30 ? 'bad' : r.support < 90 ? 'warn' : '');
      card.innerHTML =
        '<h5><input value="' + esc(r.name) + '" maxlength="24" spellcheck="false">' +
          '<span class="strat-tag ' + (r.critical ? '' : 'live') + '">T+' + U.fmtTime(r.t) + '</span></h5>' +
        '<div class="strat-stat"><span>综合保障</span><b class="' + supportCls + '">' +
          U.fmtTime(r.support) + '</b></div>' +
        '<div class="strat-stat"><span>乘员 / 减员</span><b>' + r.crew + ' / ' + r.casualties + '</b></div>' +
        '<div class="strat-stat"><span>水 / 电池</span><b>' + r.water + 'L · ' + r.battery + 'kWh</b></div>' +
        '<div class="strat-stat"><span>负载/出力 · 泄漏</span><b class="' +
          (r.demand > r.supplied ? 'warn' : '') + '">' + r.demand + '/' + r.supplied + 'kW · ' +
          (r.leaks ? '<span style="color:var(--red)">' + r.leaks + '</span>' : '0') + '</b></div>' +
        '<div class="strat-actions">' +
          '<button class="btn ghost" data-a="clone">克隆</button>' +
          '<button class="btn ghost" data-a="rename">改名</button>' +
          '<button class="btn ghost danger" data-a="del">删除</button>' +
        '</div>';
      card.onclick = function (ev) {
        if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'BUTTON') return;
        mgr().activeId = r.id; UI.app.refreshAll(true);
      };
      var input = card.querySelector('input');
      input.onchange = function () { mgr().rename(r.id, input.value.trim() || r.name); UI.app.save(); };
      card.querySelectorAll('button').forEach(function (b) {
        b.onclick = function (ev) {
          ev.stopPropagation();
          var a = b.getAttribute('data-a');
          if (a === 'clone') {
            var st = mgr().addStrategy(r.name + '（副本）', r.id);
            mgr().activeId = st.id; UI.app.refreshAll(true);
            UI.toast({ level: 'ok', title: '已克隆方案', msg: st.name + ' 与原方案在同一时刻分叉，可分别推进。' });
          } else if (a === 'del') {
            var res = mgr().removeStrategy(r.id);
            if (!res.ok) UI.toast({ level: 'fail', title: '无法删除', msg: res.error });
            else UI.app.refreshAll(true);
          } else if (a === 'rename') { input.focus(); input.select(); }
        };
      });
      host.appendChild(card);
    });

    var add = document.createElement('button');
    add.className = 'strat-add';
    add.textContent = '＋ 新建并行方案';
    add.onclick = function () {
      var st = mgr().addStrategy();
      mgr().activeId = st.id;
      UI.app.refreshAll(true);
      UI.toast({ level: 'ok', title: '新增救援方案', msg: st.name + ' 已加入，所有方案将同步推进。' });
    };
    host.appendChild(add);

    var cmp = document.createElement('button');
    cmp.className = 'strat-add';
    cmp.style.minWidth = '110px';
    cmp.textContent = '▤ 方案对照';
    cmp.onclick = openCompare;
    host.appendChild(cmp);
  }

  function bestWorst(key, rows, biggerBetter) {
    var vals = rows.map(function (r) { return r[key] === null ? Infinity : r[key]; });
    var best = biggerBetter ? Math.max.apply(null, vals) : Math.min.apply(null, vals);
    var worst = biggerBetter ? Math.min.apply(null, vals) : Math.max.apply(null, vals);
    return { best: best, worst: worst };
  }

  function openCompare() {
    var rows = mgr().compare();
    var wrap = document.createElement('div');
    var supportBW = bestWorst('support', rows, true);
    var casualtyBW = bestWorst('casualties', rows, false);
    var leakBW = bestWorst('leaks', rows, false);
    var crewBW = bestWorst('crew', rows, true);
    wrap.innerHTML =
      '<h2>救援方案同步对照（T+' + U.fmtTime(rows[0].t) + '）</h2>' +
      '<p class="cmp-note">绿色为该指标当前最优，红色为最差；“综合保障”为 O₂/舱压/CO₂/水/电/减员 中最早到达的致命时刻（∞ 表示 8 小时窗口内安全）。</p>' +
      '<table><thead><tr><th>指标</th>' + rows.map(function (r) {
        return '<th>' + esc(r.name) + (r.id === mgr().activeId ? ' ★' : '') + '</th>';
      }).join('') + '</tr></thead><tbody>' +
      row('综合剩余保障', rows, function (r, bw) {
        return cls(r.support === null || r.support >= bw.best, r.support !== null && r.support <= bw.worst && bw.worst < 999,
          U.fmtTime(r.support));
      }, supportBW) +
      row('存活乘员', rows, function (r, bw) {
        return cls(r.crew >= bw.best, r.crew <= bw.worst, r.crew + ' 人');
      }, crewBW) +
      row('累计减员', rows, function (r, bw) {
        return cls(r.casualties <= bw.best, r.casualties >= bw.worst && bw.worst > 0, r.casualties + ' 人');
      }, casualtyBW) +
      row('饮用水', rows, function (r) { return r.water + ' L'; }) +
      row('电池', rows, function (r) { return r.battery + ' kWh'; }) +
      row('负载 / 出力', rows, function (r) {
        return (r.demand > r.supplied ? '<span style="color:var(--amber)">' : '') +
          r.demand + ' / ' + r.supplied + ' kW' + (r.demand > r.supplied ? '</span>' : '');
      }) +
      row('最低舱压', rows, function (r) {
        return '<span style="color:' + (r.worstP < 60 ? 'var(--red)' : r.worstP < 80 ? 'var(--amber)' : 'inherit') + '">' +
          r.worstP + ' kPa</span>';
      }) +
      row('泄漏舱段', rows, function (r, bw) {
        return cls(r.leaks <= bw.best, r.leaks >= bw.worst && bw.worst > 0, r.leaks + ' 个');
      }, leakBW) +
      row('致命告警舱', rows, function (r) {
        return (r.critical ? '<span style="color:var(--red)">' : '') + r.critical + ' 个' +
          (r.critical ? '</span>' : '');
      }) +
      '</tbody></table>' +
      '<div class="modal-foot"><button class="btn primary" id="cmp-close">关闭</button></div>';
    var modal = UI.modal(wrap);
    wrap.querySelector('#cmp-close').onclick = modal.close;

    function row(name, rows, fn, bw) {
      return '<tr><td>' + name + '</td>' + rows.map(function (r) {
        return '<td>' + fn(r, bw) + '</td>';
      }).join('') + '</tr>';
    }
    function cls(isBest, isWorst, text) {
      return '<span class="' + (isWorst ? 'worst' : isBest ? 'best' : '') + '">' + text + '</span>';
    }
  }

  UI.strategy = { render: render, openCompare: openCompare };
})(typeof globalThis !== 'undefined' ? globalThis : this);
