/* 舱室资源流向图：SVG 静态结构 + 动态数值/流动动画 */
(function () {
  const MLS = window.MLS;
  const C = MLS.CONFIG;

  const NODE = {};
  C.NODES.forEach((n) => (NODE[n.id] = n));

  /* 固定连接端口（让三类管道不重叠） */
  const PORTS = {
    E_G_HAB_COR: ["HAB", "right", "COR", "left"],
    E_G_MED_COR: ["MED", "right", "COR", "left"],
    E_G_COR_AGR: ["COR", "top", "AGR", "bottom"],
    E_G_COR_LAB: ["COR", "bottom", "LAB", "top"],
    E_G_COR_PWR: ["COR", "right", "PWR", "left"],
    E_W_HAB_COR: ["HAB", "right", "COR", "left"],
    E_W_MED_COR: ["MED", "right", "COR", "left"],
    E_W_COR_AGR: ["COR", "right", "AGR", "bottom"],
    E_W_COR_LAB: ["COR", "right", "LAB", "top"],
    E_W_COR_PWR: ["COR", "right", "PWR", "bottom"],
    E_P_COR_PWR: ["COR", "top", "PWR", "top"],
    E_P_HAB_COR: ["HAB", "top", "COR", "left"],
    E_P_MED_COR: ["MED", "top", "COR", "left"],
    E_P_COR_AGR: ["AGR", "right", "COR", "top"],
    E_P_COR_LAB: ["LAB", "right", "COR", "bottom"],
  };
  const OFFSET = { gas: -13, water: 0, power: 13 };
  const BEND = { gas: -20, water: 0, power: 20 };

  function portXY(nid, side, type) {
    const n = NODE[nid], off = OFFSET[type] || 0;
    if (side === "left") return { x: n.x, y: n.y + n.h / 2 + off };
    if (side === "right") return { x: n.x + n.w, y: n.y + n.h / 2 + off };
    if (side === "top") return { x: n.x + n.w / 2 + off, y: n.y };
    return { x: n.x + n.w / 2 + off, y: n.y + n.h };
  }

  /* 二次贝塞尔：中点沿法向偏移，保证气/水/电三类管全程平行不重叠 */
  function edgePath(e) {
    const p = PORTS[e.id] || [e.a, "right", e.b, "left"];
    const p1 = portXY(p[0], p[1], e.type);
    const p2 = portXY(p[2], p[3], e.type);
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len; // 法向量
    const bend = BEND[e.type] || 0;
    const cx = mx + nx * bend, cy = my + ny * bend;
    return { d: `M ${p1.x} ${p1.y} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${p2.x} ${p2.y}`, p1, p2 };
  }

  function build() {
    const root = document.getElementById("schematic");
    let svg = `<svg viewBox="0 0 900 540" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<defs>
      <marker id="arrow-pow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="#ffd24a"/>
      </marker>
    </defs>`;

    // 边（先电力，再水，再气，气体在最上层方便点击）
    const order = ["power", "water", "gas"];
    for (const type of order) {
      for (const e of C.EDGES.filter((x) => x.type === type)) {
        const { d } = edgePath(e);
        svg += `<g class="edge-group">
          <path class="edge-hit" data-edge="${e.id}" d="${d}"/>
          <path class="edge ${type}" data-edge="${e.id}" data-edge-line="${e.id}" d="${d}"/>
        </g>`;
      }
    }

    // 泄漏可视化：LAB 底部 → EVA
    const lab = NODE.LAB, eva = NODE.EVA;
    svg += `<path id="leak-line" class="edge leak-edge" d="M ${lab.x + lab.w * 0.72} ${lab.y + lab.h}
            C ${lab.x + lab.w * 0.72 + 60} ${lab.y + lab.h + 40}, ${eva.x + 20} ${eva.y - 40}, ${eva.x + 20} ${eva.y}"/>`;

    // 流动点容器（每边 2 个）
    svg += `<g id="flow-layer"></g>`;

    // 节点
    for (const n of C.NODES) {
      svg += `<g class="node-group" data-node="${n.id}">
        <rect class="node-rect ${n.outside ? "outside" : ""}" data-node-rect="${n.id}"
          x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10"/>
        <text class="node-label" x="${n.x + 12}" y="${n.y + 22}">${n.name}</text>
        <text class="node-sub" data-nsub="${n.id}" x="${n.x + 12}" y="${n.y + 38}"></text>
        <text class="node-eta" data-neta="${n.id}" x="${n.x + 12}" y="${n.y + n.h - 12}"></text>
        <text class="node-crew" data-ncrew="${n.id}" x="${n.x + n.w - 12}" y="${n.y + 22}" text-anchor="end"></text>
        <g data-nbar="${n.id}" transform="translate(${n.x + 12},${n.y + n.h - 26})"></g>
      </g>`;
    }

    svg += `</svg>`;
    root.innerHTML = svg;

    // 事件绑定
    root.querySelectorAll("[data-node]").forEach((g) => {
      g.addEventListener("click", () => {
        const id = g.getAttribute("data-node");
        MLS.store.select("node", id);
      });
    });
    root.querySelectorAll(".edge-group [data-edge]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        MLS.store.select("edge", el.getAttribute("data-edge"));
      });
    });
  }

  /* ---- 动态刷新（由主循环节流调用） ---- */
  function refresh(state) {
    for (const nDef of C.NODES) {
      const n = state.nodes[nDef.id];
      if (!n) continue;
      const rect = document.querySelector(`[data-node-rect="${nDef.id}"]`);
      if (rect) {
        const alarm = nDef.outside ? "" :
          (Object.values(n.alarms).some(Boolean) ? "alarm" : "");
        const sel = MLS.store.selected.kind === "node" && MLS.store.selected.id === nDef.id ? "selected" : "";
        rect.setAttribute("class", `node-rect ${nDef.outside ? "outside" : ""} ${alarm} ${sel}`);
      }
      const sub = document.querySelector(`[data-nsub="${nDef.id}"]`);
      if (sub && !nDef.outside) {
        sub.textContent = `${MLS.engine.press(n).toFixed(0)} kPa · O₂ ${MLS.engine.pO2(n).toFixed(1)} · CO₂ ${MLS.engine.pCO2(n).toFixed(2)}`;
      }
      const crewEl = document.querySelector(`[data-ncrew="${nDef.id}"]`);
      if (crewEl) {
        const crew = MLS.engine.crewIn(state, nDef.id);
        const moving = state.transfers.filter((t) => t._at === nDef.id && t.path[t.path.length - 1] !== nDef.id).length;
        crewEl.textContent = crew.length ? `👤 ${crew.length}${moving ? " ⇄" : ""}` : "";
        crewEl.setAttribute("fill", crew.some((c) => c.incapacitated) ? "#ff5c6c" : "#4aa3ff");
      }
      // ETA
      const etaEl = document.querySelector(`[data-neta="${nDef.id}"]`);
      if (etaEl && !nDef.outside) {
        const crew = MLS.engine.crewIn(state, nDef.id);
        if (crew.length) {
          const e = MLS.engine.nodeEta(state, nDef.id);
          etaEl.textContent = e.min < 359999 ? `保障余量 ${MLS.durStr(e.min)}` : "状态稳定";
          etaEl.setAttribute("fill", e.min < 600 ? "#ff5c6c" : e.min < 3600 ? "#ffb547" : "#7f92a6");
        } else {
          etaEl.textContent = n.leak ? "⚠ 破损舱段" : "无人";
          etaEl.setAttribute("fill", n.leak ? "#ff5c6c" : "#7f92a6");
        }
      }
      // 迷你条
      const barG = document.querySelector(`[data-nbar="${nDef.id}"]`);
      if (barG && !nDef.outside) {
        const o2p = MLS.clamp(MLS.engine.pO2(n) / 21.5, 0, 1);
        const wp = MLS.clamp(n.water / n.waterCap, 0, 1);
        barG.innerHTML = `
          <rect width="34" height="3" y="0" rx="1.5" fill="#0c1219"><rect width="${(34 * o2p).toFixed(1)}" height="3" rx="1.5" fill="#5ec8f0"/></rect>
          <rect width="34" height="3" y="6" rx="1.5" fill="#0c1219"><rect width="${(34 * wp).toFixed(1)}" height="3" rx="1.5" fill="#4a9eff"/></rect>`;
      }
    }

    // 边状态
    for (const e of Object.values(state.edges)) {
      const line = document.querySelector(`[data-edge-line="${e.id}"]`);
      if (!line) continue;
      const cls = `edge ${e.type} ${e.closed ? "closed" : ""}`;
      line.setAttribute("class", cls);
      line.setAttribute("stroke-width", e.type === "power" ? 2 : 2.5);
      if (e.type === "power") line.setAttribute("opacity", state.power.blackout ? 0.2 : 0.85);
    }

    // 泄漏线
    const leakLine = document.getElementById("leak-line");
    if (leakLine) leakLine.style.opacity = state.nodes.LAB.leak ? 1 : 0;

    // 流动点
    const layer = document.getElementById("flow-layer");
    if (layer) layer.innerHTML = flowDots(state);
  }

  let dotPhase = 0;
  function flowDots(state) {
    dotPhase += 0.04;
    let out = "";
    const colorMap = { gas: "#9be4ff", water: "#9cc7ff", power: "#ffe9a3" };
    for (const e of Object.values(state.edges)) {
      if (e.type === "power") continue;
      if (e.closed) continue;
      const f = e.flow || 0;
      if (Math.abs(f) < (e.type === "gas" ? 0.02 : 0.5)) continue;
      const { p1, p2 } = edgePath(e);
      const speed = MLS.clamp(Math.abs(f) / (e.type === "gas" ? 0.8 : 120), 0.02, 0.25);
      for (let k = 0; k < 2; k++) {
        let t = (dotPhase * speed + k * 0.5) % 1;
        if (f < 0) t = 1 - t;
        const x = p1.x + (p2.x - p1.x) * t;
        const y = p1.y + (p2.y - p1.y) * t;
        out += `<circle class="flow-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2" fill="${colorMap[e.type]}"/>`;
      }
    }
    return out;
  }

  MLS.ui = MLS.ui || {};
  MLS.ui.schematic = { build, refresh };
})();
