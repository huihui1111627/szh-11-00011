/* 基地拓扑 SVG：舱室节点、舱口/氧气/水/电力四类流向、泄漏标记。 */
(function (root) {
  var MLSS = globalThis.MLSS, U = MLSS.U, sim = MLSS.sim, C = MLSS.CONFIG, UI = (MLSS.UI = MLSS.UI || {});
  var SVGNS = 'http://www.w3.org/2000/svg';

  var refs = { nodes: {}, edges: {}, powerLinks: [], waterLinks: [] };
  var selection = null;

  function el(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  function center(m) { return { x: m.x + m.w / 2, y: m.y + m.h / 2 }; }

  function build(s) {
    var host = document.getElementById('schematic');
    host.innerHTML = '';
    var svg = el('svg', { viewBox: '0 0 960 470', preserveAspectRatio: 'xMidYMid meet' });
    var defs = el('defs');
    var style = el('style');
    style.textContent =
      '.flow-line{stroke-dasharray:8 10;animation:mlssflow 1.1s linear infinite}' +
      '.flow-slow{stroke-dasharray:6 10;animation:mlssflow 2.2s linear infinite}' +
      '@keyframes mlssflow{to{stroke-dashoffset:-18}}';
    defs.appendChild(style);
    svg.appendChild(defs);

    /* 电力虚拟母线：电力舱 -> 所有舱 */
    var pwr = C.modules.filter(function (m) { return m.type === 'power'; })[0];
    C.modules.forEach(function (m) {
      if (m.id === pwr.id) return;
      var a = center(pwr), b = center(m);
      var line = el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        class: 'edge edge-power' });
      line.style.opacity = 0.12;
      svg.appendChild(line);
      refs.powerLinks.push(line);
    });

    /* 空气舱口 */
    s.edges.forEach(function (e) {
      var A = sim.mod(s, e.a), B = sim.mod(s, e.b);
      var ca = center(A), cb = center(B);
      var g = el('g', { 'data-edge': e.id, style: 'cursor:pointer' });
      var hit = el('line', { x1: ca.x, y1: ca.y, x2: cb.x, y2: cb.y,
        stroke: 'transparent', 'stroke-width': 14 });
      var line = el('line', { x1: ca.x, y1: ca.y, x2: cb.x, y2: cb.y,
        class: 'edge edge-air flow-line' });
      var mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2;
      var label = el('text', { x: mx, y: my - 6, 'text-anchor': 'middle', class: 'edge-label' });
      g.appendChild(hit); g.appendChild(line); g.appendChild(label);
      g.addEventListener('click', function () {
        select({ kind: 'edge', id: e.id });
        UI.bus.emit('select', { kind: 'edge', id: e.id });
      });
      svg.appendChild(g);
      refs.edges[e.id] = { line: line, label: label };
    });

    /* 舱室节点 */
    s.mods.forEach(function (m) {
      var g = el('g', { 'data-mod': m.id });
      var rect = el('rect', { x: m.x, y: m.y, width: m.w, height: m.h, class: 'node-rect' });
      var title = el('text', { x: m.x + 10, y: m.y + 19, class: 'node-title' });
      title.textContent = m.name;
      var sub = el('text', { x: m.x + 10, y: m.y + 36, class: 'node-sub' });
      var stat = el('text', { x: m.x + 10, y: m.y + m.h - 12, class: 'node-stat' });
      var stat2 = el('text', { x: m.x + m.w - 10, y: m.y + m.h - 12, 'text-anchor': 'end', class: 'node-stat' });
      var badge = el('text', { x: m.x + m.w - 10, y: m.y + 19, 'text-anchor': 'end', class: 'node-badge' });
      g.appendChild(rect); g.appendChild(title); g.appendChild(sub); g.appendChild(stat);
      g.appendChild(stat2); g.appendChild(badge);
      g.addEventListener('click', function () {
        select({ kind: 'mod', id: m.id });
        UI.bus.emit('select', { kind: 'mod', id: m.id });
      });
      svg.appendChild(g);
      refs.nodes[m.id] = { rect: rect, sub: sub, stat: stat, stat2: stat2, badge: badge };
    });

    host.appendChild(svg);
    refs.svg = svg;
  }

  function select(sel) {
    selection = sel;
    Object.keys(refs.nodes).forEach(function (id) {
      refs.nodes[id].rect.classList.toggle('selected', !!sel && sel.kind === 'mod' && sel.id === id);
    });
    Object.keys(refs.edges).forEach(function (id) {
      refs.edges[id].line.classList.toggle('selected', !!sel && sel.kind === 'edge' && sel.id === id);
    });
  }

  function render(s) {
    if (!refs.svg) build(s);
    var lvlCn = { crit: '致命', warn: '警告', ok: '' };
    s.mods.forEach(function (m) {
      var r = refs.nodes[m.id];
      var p = sim.pressure(m);
      var lvl = MLSS.forecast.derive(s).mods.filter(function (x) { return x.id === m.id; })[0].lvl;
      r.rect.classList.toggle('sealed', m.sealed);
      r.rect.classList.toggle('lvl-warn', lvl === 'warn');
      r.rect.classList.toggle('lvl-crit', lvl === 'crit');
      r.sub.textContent = '压 ' + p.toFixed(0) + 'kPa  O₂ ' + m.gas.o2.toFixed(1) +
        '  CO₂ ' + m.gas.co2.toFixed(2);
      r.stat.textContent = (m.crew ? '👤×' + m.crew : '无乘员') +
        (m.dangerMin > 0 ? '  ⚠' + m.dangerMin + 'min' : '');
      r.stat2.textContent = '分配×' + m.share;
      var tags = [];
      if (m.leak) tags.push({ minor: '微漏', major: '泄漏!', catastrophic: '灾难泄漏!!' }[m.leak.rate]);
      if (m.sealed) tags.push('封闭');
      if (lvl !== 'ok') tags.push(lvlCn[lvl]);
      r.badge.textContent = tags.join(' · ');
      r.badge.setAttribute('fill',
        m.leak ? 'var(--red)' : (lvl === 'crit' ? 'var(--red)' : lvl === 'warn' ? 'var(--amber)' : 'var(--text-faint)'));
    });
    s.edges.forEach(function (e) {
      var r = refs.edges[e.id];
      r.line.classList.toggle('closed', !e.open);
      r.line.style.opacity = e.open ? String(0.25 + e.valve * 0.55) : '0.8';
      var pct = Math.round(e.valve * 100);
      r.label.textContent = e.open ? (pct < 100 ? pct + '%' : '') : '已关闭';
      r.label.setAttribute('fill', e.open ? 'var(--text-dim)' : 'var(--red)');
    });
  }

  UI.schematic = {
    build: build, render: render, select: select,
    getSelection: function () { return selection; },
    rebuild: function (s) { refs = { nodes: {}, edges: {}, powerLinks: [], waterLinks: [] }; build(s); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
