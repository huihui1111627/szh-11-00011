/* =====================================================================
 * 仿真引擎：资源流动（延迟管道）、泄漏、电网争用、乘员、因果事件
 * 每 tick = 1 仿真秒，采用显式欧拉 + 管道延迟队列；dt 内做子步进
 * ===================================================================== */
(function () {
  const MLS = window.MLS;
  const { clamp, PHYS, LIM } = MLS;
  const C = MLS.CONFIG;
  const S = C.SCENE;

  const addEvent = (state, ev) => MLS.scenario.addEvent(state, ev);

  /* ---------- 基础查询 ---------- */
  const nodeDef = (id) => C.NODES.find((n) => n.id === id);
  const devType = (id) => C.DEVICE_TYPES[id];
  const gasTot = (g) => g.o2 + g.n2 + g.co2;
  function press(node) {
    if (nodeDef(node.id).outside) return 0.6; // 火星表面 kPa
    return (gasTot(node.gas) * PHYS.R * PHYS.T) / (nodeDef(node.id).vol * 1000);
  }
  function pO2(node) { return press(node) * (gasTot(node.gas) > 0 ? node.gas.o2 / gasTot(node.gas) : 0); }
  function pCO2(node) { return press(node) * (gasTot(node.gas) > 0 ? node.gas.co2 / gasTot(node.gas) : 0); }

  const running = (state, id) => state.devices[id].state === "running";
  const crewIn = (state, nid) => Object.values(state.crew).filter((c) => c.node === nid);

  function edgesOf(state, nid, type) {
    return Object.values(state.edges).filter((e) => e.type === type && !e.closed && (e.a === nid || e.b === nid));
  }

  /* 舱室风机系数：本舱或对端有运行风机则全导通，否则被动微渗 */
  function fanFactor(state, e) {
    const hasFan = (nid) => Object.values(state.devices).some(
      (d) => d.node === nid && d.type === "fan" && d.state === "running");
    return hasFan(e.a) || hasFan(e.b) ? 1 : S.passiveFanFactor;
  }

  /* ---------- 气体路径（最短开阀气路） ---------- */
  function gasPath(state, from, to) {
    if (from === to) return [from];
    const prev = { [from]: null }, q = [from];
    while (q.length) {
      const cur = q.shift();
      for (const e of edgesOf(state, cur, "gas")) {
        const nx = e.a === cur ? e.b : e.a;
        if (!(nx in prev)) { prev[nx] = { node: cur, edge: e.id }; q.push(nx); }
      }
    }
    if (!(to in prev)) return null;
    const path = [to];
    let cur = to;
    while (prev[cur]) { const st = prev[cur]; path.unshift(st.node); cur = st.node; }
    return path;
  }
  function reachableGasNodes(state, from) {
    const seen = new Set([from]), q = [from];
    while (q.length) {
      const cur = q.shift();
      for (const e of edgesOf(state, cur, "gas")) {
        const nx = e.a === cur ? e.b : e.a;
        if (!seen.has(nx)) { seen.add(nx); q.push(nx); }
      }
    }
    return seen;
  }

  /* ---------- 单步（1 秒） ---------- */
  function step(state) {
    state.t += 1;

    starterTick(state);
    deviceTick(state);
    powerTick(state);          // 供电/切除（决定本秒哪些设备真正在运行）
    crewTransferTick(state);   // 乘员移动

    produceO2(state);          // 制氧机产 O2 → 分配（延迟路径）
    crewMetabolism(state);     // 呼吸/饮水/废水
    runScrubbers(state);       // CO2 吸收（在气体流动前，本地生效）
    runRecyclers(state);       // 废水 → 饮用水

    gasFlowTick(state);        // 压力平衡 + 组分混合（边缘延迟队列）
    deliverPendingO2(state);   // O2 分配包沿路径推进
    waterFlowTick(state);      // 水网
    consumeOxyWater(state);    // 制氧用水：本地→水网

    leakTick(state);           // 破洞向火星排气
    crewHealthTick(state);

    checkEnds(state);
    alarmsTick(state);

    if (state.t % 60 === 0) sampleHistory(state);
  }

  /* ---------- 备用启动母线 ---------- */
  function starterTick(state) {
    if (state.starter.busy > 0) state.starter.busy -= 1;
    if (state.starter.busy <= 0) state.starter.by = null;
  }

  /* ---------- 设备状态机 ---------- */
  function deviceTick(state) {
    for (const d of Object.values(state.devices)) {
      if (d.cooldown > 0) d.cooldown -= 1;
      if (d.state === "starting") {
        d.startLeft -= 1;
        if (d.startLeft <= 0) {
          d.state = "running";
          const ev = addEvent(state, { kind: "dev-on", level: "ok", subject: d.id,
            msg: `${devType(d.type).name}（${d.node}）启动完成，已并网`,
            cause: { eventId: state.idIndex[d.id + ":start"] || null, label: "人工启动指令" } });
          if (d.type === "fuelCell" && state.starter.by === d.id) state.starter.by = null;
        }
      }
      // 被切除设备尝试自动恢复
      if (d.state === "shed" && d.on && d.cooldown <= 0 && !state.power.blackout) {
        const battFrac = state.power.battery / S.batteryKWh;
        const supply = supplyNow(state);
        const load = runningLoad(state);
        const battAvail = state.power.battery > 0.01 ? S.batteryMaxIO : 0;
        // 电池管理阈值仍在生效时，不自动恢复被策略切除的高优先级编号设备
        let policyBlock = false;
        if (load > supply + 0.05) {
          if (battFrac < 0.15 && d.prio >= 3) policyBlock = true;
          else if (battFrac < 0.4 && d.prio >= 4) policyBlock = true;
        }
        if (!policyBlock && hasPowerHeadroom(state, d)) {
          d.state = "running"; d.startLeft = 0;
          addEvent(state, { kind: "dev-restore", level: "info", subject: d.id,
            msg: `${devType(d.type).name}（${d.node}）供电恢复，自动重启`, cause: null });
        } else {
          d.cooldown = 180; // 条件不满足，3 分钟后再评估
        }
      }
    }
    if (state.starter.busy <= 0 && state.starter.by) {
      // 启动被中断（如断电）的清理
    }
  }

  /* 启动能力校验：母线互斥 + 峰值电力 */
  function canStart(state, d, silent) {
    const t = devType(d.type);
    if (d.state !== "off" && d.state !== "shed") return { ok: false, reason: "设备当前不处于可启动状态" };
    if (state.power.blackout)
      return { ok: false, reason: "基地全电网断电，仅 RTG 母线带电，无法启动该设备",
        recover: "先恢复电力：启动备用燃料电池（占用启动母线 90 秒），或等待尘暴减弱" };
    if (t.starter && state.starter.busy > 0 && state.starter.by !== d.id) {
      const other = Object.values(state.devices).find((x) => x.id === state.starter.by);
      return { ok: false, reason: `备用启动母线被「${other ? devType(other.type).name : "其他设备"}」占用（剩余 ${state.starter.busy} 秒），两台备用设备不能同时启动`,
        recover: `等待母线释放后再启动；可在事件链中查看当前占用进度` };
    }
    const surge = (t.surge || 0) + t.run;
    const avail = state.power.supply + S.batteryMaxIO;
    if (surge > avail)
      return { ok: false, reason: `启动峰值需 ${surge.toFixed(1)} kW，但当前可用电力（发电 ${state.power.supply.toFixed(1)} + 电池极限 ${S.batteryMaxIO} kW）不足`,
        recover: "先启动备用燃料电池，或降低其他设备优先级让电网腾出容量" };
    return { ok: true };
  }

  /* 电网是否还有带起某台运行设备的净裕度（考虑电池放电上限） */
  function hasPowerHeadroom(state, d) {
    const t = devType(d.type);
    let supply = 0, load = 0;
    for (const x of Object.values(state.devices)) {
      const xt = devType(x.type);
      if (xt.supply) {
        if (x.type === "solar") supply += xt.supply * state.power.solarFactor;
        else if (x.state === "running") supply += xt.supply;
      } else if (x.state === "running") load += xt.run;
    }
    const battAvail = state.power.battery > 0.01 ? S.batteryMaxIO : 0;
    return supply + battAvail >= load + t.run + 0.05;
  }

  /* 供电能力（kW）：太阳能（受尘暴）+ 运行中的发电设备 */
  function supplyNow(state) {
    let kw = 0;
    for (const x of Object.values(state.devices)) {
      const xt = devType(x.type);
      if (!xt.supply) continue;
      if (x.type === "solar") kw += xt.supply * state.power.solarFactor;
      else if (x.state === "running") kw += xt.supply;
    }
    return kw;
  }
  function runningLoad(state) {
    let kw = 0;
    for (const x of Object.values(state.devices)) {
      const xt = devType(x.type);
      if (!xt.supply && x.state === "running") kw += xt.run;
    }
    return kw;
  }
  /* 断电后能否解除：至少能带起当前运行负载 + 一台 P1 生保设备（制氧/净化） */
  function canExitBlackout(state) {
    const supply = supplyNow(state);
    const load = runningLoad(state);
    const battAvail = state.power.battery > 0.01 ? S.batteryMaxIO : 0;
    const critical = Object.values(state.devices)
      .filter((d) => d.state === "shed" && d.on && d.prio <= 2)
      .sort((a, b) => a.prio - b.prio)[0];
    const need = critical ? devType(critical.type).run : 0.8;
    return supply + battAvail >= load + need + 0.1;
  }

  /* ---------- 电网 ---------- */
  function powerTick(state) {
    // 供电
    const storm = state.t < S.stormEndsAt ? S.stormFactor : 1;
    state.power.solarFactor = storm;
    let supply = 0;
    const sources = [];
    for (const d of Object.values(state.devices)) {
      const t = devType(d.type);
      if (!t.supply) continue;
      let kw = 0;
      if (d.type === "solar") kw = t.supply * storm;
      else if (d.state === "running") kw = t.supply;
      else if (d.state === "starting") kw = 0;
      if (kw > 0) { supply += kw; sources.push(`${t.name} ${kw.toFixed(1)}kW`); }
    }

    // 负载（运行中设备 + 启动中设备的冲击功率）
    let load = 0;
    const drawList = [];
    for (const d of Object.values(state.devices)) {
      const t = devType(d.type);
      if (t.supply) continue;
      if (d.state === "running") { load += t.run; drawList.push(d); }
      else if (d.state === "starting") { load += t.run + (t.surge || 0); drawList.push(d); }
    }

    // 电池水位：低水位时主动分级卸载，为关键设备保留电量
    const battFrac = state.power.battery / S.batteryKWh;
    let proactiveFloor = 0; // 低于此优先级的设备将被主动切除
    const deficitNow = load > supply + 0.05; // 供电不足即处于净消耗（电池管理启动）
    if (deficitNow) {
      if (battFrac < 0.15) proactiveFloor = 3;   // 仅剩 P1/P2
      else if (battFrac < 0.4) proactiveFloor = 4; // 切除 P4
    }

    // 先确定当前可用于带载的电力：发电 + 电池放电上限（且电池有电）
    const battAvail = state.power.battery > 0.01 ? S.batteryMaxIO : 0;
    const capacity = supply + battAvail;
    let shed = 0;
    let uncovered = Math.max(0, load - capacity);

    // 主动卸载（电池管理策略：每台设备只在越线时产生一次事件）
    if (proactiveFloor > 0) {
      const cands0 = drawList
        .filter((d) => d.state === "running" && d.type !== "solar" && d.type !== "rtg"
          && (d.prio || 0) >= proactiveFloor);
      for (const d of cands0) {
        const kw = devType(d.type).run;
        shed += kw; uncovered = Math.max(0, uncovered - kw);
        d.state = "shed"; d.on = true; d.cooldown = 300;
        addEvent(state, { kind: "load-shed", level: "warn", subject: d.id,
          msg: `电池电量 ${Math.round(battFrac * 100)}%，按供电策略预切除「${devType(d.type).name}（${d.node}）」为关键设备保留 ${kw.toFixed(2)} kW`,
          cause: { eventId: state.idIndex["SOLAR1:storm"] || null,
                   label: "尘暴致发电不足，执行分级负载管理" },
          recover: "启动备用燃料电池可恢复供电；或手动降低其他设备优先级" });
      }
    }

    // 超出能力 → 按优先级切除（数字越大越先被切；供电设备不可切）
    if (uncovered > 0.01) {
      const cands = drawList
        .filter((d) => d.state === "running" && d.type !== "solar" && d.type !== "rtg")
        .sort((a, b) => (b.prio || 0) - (a.prio || 0) || a.id.localeCompare(b.id));
      for (const d of cands) {
        if (uncovered <= 0.01) break;
        const kw = devType(d.type).run;
        uncovered -= kw; shed += kw;
        d.state = "shed"; d.on = true; d.cooldown = 60;
        addEvent(state, { kind: "load-shed", level: "warn", subject: d.id,
          msg: `电力不足，自动切除「${devType(d.type).name}（${d.node}）」释放 ${kw.toFixed(2)} kW`,
          cause: { eventId: state.idIndex["SOLAR1:storm"] || null,
                   label: state.power.battery > 0.01
                     ? "尘暴致发电不足，放电达 8 kW 极限后仍有缺口"
                     : "尘暴致发电不足，电池已耗尽" },
          recover: "启动备用燃料电池，或调低该舱室固定负载/其他设备的优先级" });
      }
    }

    // 结算电池：切除后的实际负载（从设备实际状态统计，避免超额切除重复扣减）
    let servedLoad = 0;
    for (const d of drawList) {
      if (d.state === "running") servedLoad += devType(d.type).run;
      else if (d.state === "starting") servedLoad += devType(d.type).run + (devType(d.type).surge || 0);
    }
    shed = Math.max(0, load - servedLoad);
    if (servedLoad > supply + 0.01) {
      const battKw = Math.min(servedLoad - supply, battAvail);
      state.power.battery = Math.max(0, state.power.battery - battKw / 3600);
    } else if (servedLoad < supply - 0.01) {
      const chargeKw = Math.min(supply - servedLoad, 3);
      state.power.battery = Math.min(S.batteryKWh, state.power.battery + chargeKw / 3600);
    }

    state.power.supply = supply;
    state.power.load = servedLoad;
    state.power.shed = shed;

    // 全黑：电池耗尽，且发电无法维持剩余在役负载
    const stillShort = servedLoad - supply > 0.05 && state.power.battery <= 0.01;
    if (stillShort) {
      if (!state.power.blackout) {
        state.power.blackout = true;
        addEvent(state, { kind: "blackout", level: "alarm", subject: "PWR",
          msg: "电池耗尽，剩余发电无法维持电网，基地进入分级断电",
          cause: { eventId: state.idIndex["SOLAR1:storm"] || null, label: "尘暴期间长期入不敷出" },
          recover: "立即启动备用燃料电池 FC1（RTG 维持启动母线）；启动需 90 秒" });
      }
      // 继续切除超出供电的运行设备（保留 RTG、燃料电池与太阳能）
      const runners = drawList
        .filter((d) => d.state === "running" && d.type !== "rtg" && d.type !== "fuelCell" && d.type !== "solar")
        .sort((a, b) => (b.prio || 0) - (a.prio || 0));
      let need = servedLoad - supply;
      for (const d of runners) {
        if (need <= 0.01) break;
        const kw = devType(d.type).run;
        need -= kw;
        d.state = "shed"; d.on = true; d.cooldown = 120;
      }
      let actual = 0;
      for (const d of drawList) if (d.state === "running") actual += devType(d.type).run;
      state.power.load = actual;
    } else if (state.power.blackout && canExitBlackout(state)) {
      state.power.blackout = false;
      addEvent(state, { kind: "power-restore", level: "ok", subject: "PWR",
        msg: "电网能力回升，设备将按冷却时序自动重启", cause: null });
    }

    // 燃料电池耗氢
    for (const d of Object.values(state.devices)) {
      if (d.type === "fuelCell" && d.state === "running") {
        d.fuel -= 1;
        if (d.fuel <= 0) {
          d.state = "off"; d.on = false;
          addEvent(state, { kind: "fuel-out", level: "alarm", subject: d.id,
            msg: "备用燃料电池氢燃料耗尽停机", cause: null,
            recover: "氢储备已空，只能等待尘暴结束太阳能恢复" });
        }
      }
    }

    // 低电量提醒（每 30 分钟一次）
    if (state.power.battery < S.batteryKWh * 0.2 && state.t % 1800 === 0) {
      addEvent(state, { kind: "batt-low", level: "warn", subject: "PWR",
        msg: `电池电量低于 20%（剩余 ${state.power.battery.toFixed(1)} kWh）`,
        cause: { eventId: state.idIndex["SOLAR1:storm"] || null, label: "尘暴期间发电不足" },
        recover: "启动备用燃料电池，或继续切除低优先级负载" });
    }
  }

  /* ---------- 乘员转移 ---------- */
  function crewTransferTick(state) {
    for (let i = state.transfers.length - 1; i >= 0; i--) {
      const tr = state.transfers[i];
      tr.segLeft -= 1;
      if (tr.segLeft > 0) continue;

      const idx = tr.path.indexOf(tr._at);
      const nx = tr.path[idx + 1];
      const c = state.crew[tr.crewId];

      // 抵达终点
      if (nx === tr.path[tr.path.length - 1]) {
        c.node = nx;
        addEvent(state, { kind: "transfer-done", level: "info", subject: c.id,
          msg: `${c.name} 已抵达${nodeDef(nx).name}`, cause: { eventId: tr._causeId, label: "乘员转移安排" } });
        state.transfers.splice(i, 1);
        continue;
      }
      // 下一段气闸被封闭 → 滞留当前舱
      const edgeOpen = Object.values(state.edges).some(
        (e) => e.type === "gas" && !e.closed &&
          ((e.a === tr._at && e.b === nx) || (e.b === tr._at && e.a === nx)));
      if (!edgeOpen) {
        c.node = tr._at;
        addEvent(state, { kind: "transfer-blocked", level: "warn", subject: c.id,
          msg: `${c.name} 的转移路径中断（气闸已封闭），滞留于${nodeDef(tr._at).name}`,
          cause: { eventId: null, label: "转移途中有人封闭了舱段气闸" },
          recover: "重新打开气闸，或重新安排转移路线" });
        state.transfers.splice(i, 1);
        continue;
      }
      // 正常进入下一舱段（乘员在途时视为在当前舱，节点随段推进）
      tr._at = nx;
      c.node = nx;
      tr.segLeft = S.edgeHatchTime;
    }
  }

  /* ---------- 制氧 ---------- */
  function produceO2(state) {
    const gens = Object.values(state.devices).filter(
      (d) => (d.type === "oxy" || d.type === "oxy2") && d.state === "running");
    for (const g of gens) {
      const t = devType(g.type);
      let o2 = t.o2Rate;
      const gnode = state.nodes[g.node];
      // 无水则减产
      if (gnode.water < 40) {
        const factor = clamp(gnode.water / 40, 0, 1);
        if (factor < 1) {
          o2 *= factor;
          if (state.t % 60 === 0)
            addEvent(state, { kind: "oxy-starve", level: "warn", subject: g.id,
              msg: `${t.name}供水不足，制氧出力降至 ${Math.round(factor * 100)}%`,
              cause: { eventId: gnode.id === "PWR" ? null : null, label: "水网液位过低" },
              recover: "检查水回收净化器或调整用水优先级" });
        }
      }
      g._o2Produced = o2;
      g._waterUsed = o2 * t.waterPerMolO2;
      // 按「配额权重 × 在册人数」分配给气路可达舱室；O2 即产即达（沿管延迟由压力平衡近似）
      const reach = reachableGasNodes(state, g.node);
      const targets = [...reach].filter((nid) => nid !== "EVA");
      const weight = (nid) => state.nodes[nid].o2Quota * Math.max(1, crewIn(state, nid).length);
      const wsum = targets.reduce((a, nid) => a + weight(nid), 0) || 1;
      for (const nid of targets) {
        const share = (o2 * weight(nid)) / wsum;
        if (share <= 0) continue;
        state.nodes[nid].gas.o2 += share;
      }
    }
  }

  function edgeDelay(state, a, b) {
    const e = Object.values(state.edges).find(
      (x) => x.type === "gas" && ((x.a === a && x.b === b) || (x.a === b && x.b === a)));
    return e ? e.delay : 10;
  }

  function deliverPendingO2(state) {
    // O₂ 即产即达（见 produceO2）；此函数保留用于清理陈旧在途包
    if (state.pendingO2 && state.pendingO2.length) state.pendingO2.length = 0;
  }

  /* ---------- 乘员代谢 ---------- */
  function crewMetabolism(state) {
    for (const c of Object.values(state.crew)) {
      if (c.incapacitated) continue;
      const node = state.nodes[c.node];
      if (!node || nodeDef(c.node).outside) {
        // 无舱外活动服概念：到 EVA 视为致命
        c.health = 0; c.incapacitated = true;
        continue;
      }
      const mult = c.activity === "rest" ? 0.75 : c.activity === "work" ? 1.25 : 1;
      const o2use = S.crewO2molS * mult;
      const co2ex = S.crewCO2molS * mult;
      node.gas.o2 = Math.max(0, node.gas.o2 - o2use);
      node.gas.co2 += co2ex;

      const drink = S.crewWaterGS;
      if (node.water >= drink) {
        node.water -= drink;
        node.waste = Math.min(node.wasteCap, node.waste + S.crewWasteGS);
        c.dehydration = Math.max(0, c.dehydration - 2);
      } else {
        node.water = 0;
        c.dehydration += 1;
      }
    }
  }

  /* ---------- CO2 净化 / 水回收 ---------- */
  function runScrubbers(state) {
    for (const d of Object.values(state.devices)) {
      if (d.type !== "scrubber" || d.state !== "running") continue;
      const n = state.nodes[d.node];
      const cap = d.cap || devType("scrubber").co2Rate;
      const removed = Math.min(cap, n.gas.co2);
      n.gas.co2 -= removed;
    }
  }

  function runRecyclers(state) {
    for (const d of Object.values(state.devices)) {
      if (d.type !== "recycler" || d.state !== "running") continue;
      const t = devType("recycler");
      const n = state.nodes[d.node];
      const intake = Math.min(t.wasteRate, n.waste);
      n.waste -= intake;
      n.water = Math.min(n.waterCap, n.water + intake * t.eff);
    }
  }

  /* ---------- 气体压力平衡（组分混合，边缘延迟） ----------
   * 两遍法：先基于同一时刻的压力快照算全部边流量，再统一扣气，
   * 避免同一舱室多条边顺序扣减造成的数值质量损失。 */
  function gasFlowTick(state) {
    const plans = [];
    for (const e of Object.values(state.edges)) {
      if (e.type !== "gas" || e.closed) { e.flow = 0; continue; }
      const na = state.nodes[e.a], nb = state.nodes[e.b];
      const pa = press(na), pb = press(nb);
      const dp = pa - pb;
      if (Math.abs(dp) < 0.05) { e.flow = 0; continue; }
      const c = e.c * fanFactor(state, e);
      const dir = dp > 0 ? 1 : -1;
      const src = dir > 0 ? na : nb;
      const tot = gasTot(src.gas);
      if (tot <= 0) { e.flow = 0; continue; }
      let nFlow = Math.min(c * Math.abs(dp), tot * 0.1);
      plans.push({ e, srcId: dir > 0 ? e.a : e.b, dir, nFlow });
      e.flow = nFlow * dir;
    }
    // 同一节点可能是多条边的源：按比例缩放，保证本秒抽气不超过其存量
    const bySrc = {};
    for (const p of plans) (bySrc[p.srcId] = bySrc[p.srcId] || []).push(p);
    for (const srcId in bySrc) {
      const src = state.nodes[srcId];
      const tot = gasTot(src.gas);
      const sum = bySrc[srcId].reduce((a, p) => a + p.nFlow, 0);
      const scale = sum > tot * 0.1 ? (tot * 0.1) / sum : 1;
      for (const p of bySrc[srcId]) p.nFlow *= scale;
    }
    // 统一扣气并入延迟队列
    for (const p of plans) {
      const src = state.nodes[p.srcId];
      const tot = gasTot(src.gas);
      if (tot <= 0 || p.nFlow <= 0) continue;
      const pack = { o2: p.nFlow * (src.gas.o2 / tot), n2: p.nFlow * (src.gas.n2 / tot),
                     co2: p.nFlow * (src.gas.co2 / tot) };
      src.gas.o2 -= pack.o2; src.gas.n2 -= pack.n2; src.gas.co2 -= pack.co2;
      p.e.queue.push({ left: p.e.delay, pack, dir: p.dir });
    }
    // 延迟队列交付
    for (const e of Object.values(state.edges)) {
      if (e.type !== "gas") continue;
      for (let i = e.queue.length - 1; i >= 0; i--) {
        const q = e.queue[i];
        q.left -= 1;
        if (q.left <= 0) {
          const dst = q.dir > 0 ? state.nodes[e.b] : state.nodes[e.a];
          dst.gas.o2 += q.pack.o2; dst.gas.n2 += q.pack.n2; dst.gas.co2 += q.pack.co2;
          e.queue.splice(i, 1);
        }
      }
    }
  }

  /* ---------- 水网：压力（液位）梯度流动 + 制氧取水 ---------- */
  function waterFlowTick(state) {
    for (const e of Object.values(state.edges)) {
      if (e.type !== "water" || e.closed) { e.flow = 0; continue; }
      const na = state.nodes[e.a], nb = state.nodes[e.b];
      const la = na.water / na.waterCap, lb = nb.water / nb.waterCap;
      const dl = la - lb;
      if (Math.abs(dl) < 0.005) { e.flow = 0; continue; }
      let gFlow = e.c * dl * (dl > 0 ? 100 : 100); // g/s，液位差驱动
      gFlow = Math.min(Math.abs(gFlow), Math.abs(dl) * 1000);
      if (gFlow < 0.01) { e.flow = 0; continue; }
      const dir = dl > 0 ? 1 : -1;
      const src = dir > 0 ? na : nb, dst = dir > 0 ? nb : na;
      gFlow = Math.min(gFlow, src.water, dst.waterCap - dst.water);
      src.water -= gFlow; dst.water += gFlow;
      e.flow = gFlow * dir;
    }
  }

  function consumeOxyWater(state) {
    for (const d of Object.values(state.devices)) {
      if ((d.type !== "oxy" && d.type !== "oxy2") || d.state !== "running") continue;
      const need = d._waterUsed || 0;
      const n = state.nodes[d.node];
      const got = Math.min(need, n.water);
      n.water -= got;
      if (got < need - 0.1) d._o2Produced *= got / need; // 供水不足减产（兜底）
    }
  }

  /* ---------- 泄漏：破洞向火星排气 ---------- */
  function leakTick(state) {
    for (const n of Object.values(state.nodes)) {
      if (!n.leak) continue;
      const p = press(n);
      if (p <= 0.6) continue;
      const tot = gasTot(n.gas);
      if (tot <= 0) continue;
      let out = n.leak * (p - 0.6);
      out = Math.min(out, tot * 0.05);
      const f = out / tot;
      n.gas.o2 -= n.gas.o2 * f;
      n.gas.n2 -= n.gas.n2 * f;
      n.gas.co2 -= n.gas.co2 * f;
      n._leakFlow = out;
    }
  }

  /* ---------- 乘员健康 ---------- */
  function crewHealthTick(state) {
    for (const c of Object.values(state.crew)) {
      if (c.incapacitated) continue;
      const n = state.nodes[c.node];
      if (!n) continue;
      const o2 = pO2(n), co2 = pCO2(n), p = press(n);
      let dmg = 0;
      if (o2 < LIM.O2_CRIT) dmg += LIM.HEALTH_DMG * 3;
      else if (o2 < LIM.O2_LO) dmg += LIM.HEALTH_DMG * 0.5;
      if (co2 > LIM.CO2_CRIT) dmg += LIM.HEALTH_DMG * 2;
      else if (co2 > LIM.CO2_HI) dmg += LIM.HEALTH_DMG * 0.5;
      if (p < LIM.PRESS_CRIT) dmg += LIM.HEALTH_DMG * 3;
      else if (p < LIM.PRESS_LO) dmg += LIM.HEALTH_DMG * 0.4;
      if (c.dehydration > 1800) dmg += LIM.HEALTH_DMG * 1.5;
      if (c.injured) dmg += 0.0008;

      if (dmg === 0 && o2 > LIM.O2_LO && co2 < LIM.CO2_HI && p > LIM.PRESS_LO) {
        c.health = Math.min(100, c.health + 0.002);
      } else {
        c.health = Math.max(0, c.health - dmg);
      }
      if (c.health <= 0) {
        c.incapacitated = true;
        addEvent(state, { kind: "crew-death", level: "alarm", subject: c.id,
          msg: `${c.name}（${c.role}）于${nodeDef(c.node).name}失去生命体征`,
          cause: { eventId: state.idIndex["LAB:breach"] || null,
                   label: describeCause(n) || "舱内环境持续恶化" },
          recover: "回退到上一稳定点重新安排救援，或继续保护其余乘员" });
      }
    }
  }

  function describeCause(n) {
    const o2 = pO2(n), co2 = pCO2(n), p = press(n);
    if (p < LIM.PRESS_LO) return "低压/缺氧环境";
    if (co2 > LIM.CO2_HI) return "CO₂ 浓度过高";
    if (o2 < LIM.O2_LO) return "氧气分压过低";
    return null;
  }

  /* ---------- 速率快照（每秒初/末差分，供 UI 与 ETA 使用） ---------- */
  function snapRatesStart(state) {
    for (const n of Object.values(state.nodes)) {
      n._snap = { o2: n.gas.o2, n2: n.gas.n2, co2: n.gas.co2, tot: gasTot(n.gas), water: n.water };
    }
  }
  function snapRatesEnd(state) {
    for (const n of Object.values(state.nodes)) {
      if (!n._snap) continue;
      const r = n.rates || (n.rates = {});
      r.o2 = n.gas.o2 - n._snap.o2;          // mol/s 净
      r.co2 = n.gas.co2 - n._snap.co2;
      r.tot = gasTot(n.gas) - n._snap.tot;
      r.water = n.water - n._snap.water;     // g/s 净
      // 转 kPa/s
      const V = nodeDef(n.id).vol;
      if (V !== Infinity) {
        const k = (PHYS.R * PHYS.T) / (V * 1000);
        const tot = gasTot(n.gas);
        r.pO2 = r.o2 * k;
        r.pCO2 = r.co2 * k;
        r.p = r.tot * k;
      } else r.pO2 = r.pCO2 = r.p = 0;
    }
  }

  /* ---------- 剩余保障时间（秒） ---------- */
  const CAP_T = 359999;
  function nodeEta(state, nid) {
    const n = state.nodes[nid], r = n.rates || {};
    const etas = {};
    if (r.pO2 < 0) etas.o2 = clamp((pO2(n) - LIM.O2_CRIT) / -r.pO2, 0, CAP_T);
    if (r.pCO2 > 0) etas.co2 = clamp((LIM.CO2_CRIT - pCO2(n)) / r.pCO2, 0, CAP_T);
    if (r.p < 0) etas.press = clamp((press(n) - LIM.PRESS_CRIT) / -r.p, 0, CAP_T);
    const people = crewIn(state, nid).length;
    if (people > 0 && r.water < -0.01)
      etas.water = clamp((n.water / people - LIM.WATER_LO) / (-r.water / people), 0, CAP_T);
    etas.min = Math.min(CAP_T, ...Object.values(etas).filter((v) => v != null && v > 0), CAP_T);
    return etas;
  }

  function baseEta(state) {
    let worst = CAP_T, where = null;
    for (const def of C.NODES) {
      if (def.outside) continue;
      if (crewIn(state, def.id).length === 0) continue;
      const e = nodeEta(state, def.id);
      if (e.min < worst) { worst = e.min; where = def.id; }
    }
    // 电力
    const deficit = state.power.load - state.power.supply;
    if (deficit > 0.05 && state.power.battery > 0) {
      const bt = (state.power.battery / deficit) * 3600;
      if (bt < worst) { worst = clamp(bt, 0, CAP_T); where = "PWR"; }
    }
    return { eta: worst >= CAP_T ? Infinity : worst, where };
  }

  /* ---------- 修补计时 ---------- */
  function repairTick(state) {
    for (const n of Object.values(state.nodes)) {
      if (n.repairing > 0) {
        n.repairing -= 1;
        if (n.repairing <= 0) {
          n.leak = 0;
          addEvent(state, { kind: "repaired", level: "ok", subject: n.id,
            msg: `${nodeDef(n.id).name}破洞修补完成，舱体恢复密封（可重新开启气闸复压）`, cause: null });
        }
      }
    }
  }

  /* ---------- 告警状态机 ---------- */
  function alarmsTick(state) {
    for (const def of C.NODES) {
      if (def.outside) continue;
      const n = state.nodes[def.id];
      const a = n.alarms || (n.alarms = {});
      const o2 = pO2(n), co2 = pCO2(n), p = press(n);
      const people = crewIn(state, def.id).length;

      const fire = (key, level, on, msg, recover, cause) => {
        if (on && !a[key]) {
          a[key] = true;
          addEvent(state, { kind: "alarm-" + key, level, subject: def.id, msg, recover, cause });
        } else if (!on && a[key]) {
          a[key] = false;
        }
      };

      fire("pressLo", people ? "alarm" : "warn", p < LIM.PRESS_LO,
        `${def.name}压力 ${p.toFixed(1)} kPa 低于安全线（${LIM.PRESS_LO}）`,
        n.leak ? "封闭该舱气闸并安排修补；转移舱内乘员" : "检查相邻气闸与风机状态",
        n.leak ? { eventId: state.idIndex["LAB:breach"] || null, label: "舱体破洞持续排气" } : null);
      fire("o2Lo", people ? "alarm" : "warn", o2 < LIM.O2_LO,
        `${def.name}氧分压 ${o2.toFixed(1)} kPa 过低（安全线 ${LIM.O2_LO}）`,
        "提高该舱氧气分配配额，确认制氧机供水与运行状态",
        causeForO2(state, def.id));
      fire("o2Hi", "warn", o2 > LIM.O2_HI,
        `${def.name}氧分压 ${o2.toFixed(1)} kPa 过高，存在燃烧风险`,
        "降低该舱氧气分配配额或开启相邻气闸均压");
      fire("co2Hi", people ? "alarm" : "warn", co2 > LIM.CO2_HI,
        `${def.name}CO₂ 分压 ${co2.toFixed(2)} kPa 超标（安全线 ${LIM.CO2_HI}）`,
        "检查该舱 CO₂ 净化装置是否因断电被切除，必要时转移乘员");
      fire("waterLo", people ? "alarm" : "warn", people > 0 && n.water / people < LIM.WATER_LO,
        `${def.name}人均饮用水低于 8 小时储备`, "检查水回收净化器与水管阀门");
    }
    // 尘暴结束
    if (state.t === S.stormEndsAt) {
      state.idIndex["SOLAR1:restore"] = addEvent(state, { kind: "storm-end", level: "ok", subject: "SOLAR1",
        msg: "尘暴减弱，太阳能阵列恢复全功率出力", cause: null }).id;
    }
  }

  function causeForO2(state, nid) {
    const n = state.nodes[nid];
    const scrubOff = Object.values(state.devices).some(
      (d) => d.node === nid && d.type === "scrubber" && d.state !== "running");
    if (n.leak) return { eventId: state.idIndex["LAB:breach"] || null, label: "破洞泄漏带走 O₂" };
    if (scrubOff) return { eventId: null, label: "通风/净化设备被电网切除" };
    return { eventId: null, label: `氧气配额 ${Math.round(n.o2Quota * 100)}%，制氧分配不足` };
  }

  /* ---------- 胜负 ---------- */
  function checkEnds(state) {
    if (state.ended) return;
    const alive = Object.values(state.crew).filter((c) => !c.incapacitated).length;
    if (alive === 0) {
      state.ended = { win: false, reason: "全体乘员遇难，推演失败", t: state.t };
      addEvent(state, { kind: "end-lose", level: "alarm", subject: "MISSION",
        msg: "✖ 全体乘员失去生命体征，救援失败", cause: null });
    } else if (state.t >= S.rescueAt) {
      state.ended = { win: true, reason: `救援抵达，${alive} 名乘员生还`, t: state.t };
      addEvent(state, { kind: "end-win", level: "ok", subject: "MISSION",
        msg: `✔ 救援穿梭机抵达！${alive} 名乘员成功生还`, cause: null });
    }
  }

  function sampleHistory(state) {
    const { eta, where } = baseEta(state);
    const o2s = [], co2s = [], ps = [];
    for (const def of C.NODES) {
      if (def.outside) continue;
      const n = state.nodes[def.id];
      o2s.push(pO2(n)); co2s.push(pCO2(n)); ps.push(press(n));
    }
    let water = 0;
    for (const def of C.NODES) if (!def.outside) water += state.nodes[def.id].water;
    state.history.push({
      t: state.t, eta: eta == null || eta === Infinity ? CAP_T : eta,
      alive: Object.values(state.crew).filter((c) => !c.incapacitated).length,
      o2Min: Math.min(...o2s), co2Max: Math.max(...co2s), pMin: Math.min(...ps),
      battery: state.power.battery, water,
    });
    if (state.history.length > 500) state.history.splice(0, state.history.length - 500);
  }

  /* 包裹每秒：差分快照 + 修补 */
  /* 首屏预热：只做只读的电力/速率估算，不产生事件、不改设备 */
  function prime(state) {
    const storm = state.t < S.stormEndsAt ? S.stormFactor : 1;
    let supply = 0, load = 0;
    for (const d of Object.values(state.devices)) {
      const t = devType(d.type);
      if (t.supply) {
        if (d.type === "solar") supply += t.supply * storm;
        else if (d.on) supply += t.supply;
      } else if (d.on) load += t.run;
    }
    state.power.supply = supply;
    state.power.load = load;
    state.power.solarFactor = storm;
    state.power.shed = 0;
    for (const n of Object.values(state.nodes)) {
      const people = crewIn(state, n.id).length;
      n.rates = { o2: 0, co2: 0, tot: 0, water: people * -S.crewWaterGS, pO2: 0, pCO2: 0, p: 0 };
    }
  }

  function stepWrapped(state) {
    snapRatesStart(state);
    repairTick(state);
    step(state);
    snapRatesEnd(state);
  }

  /* ================== 用户操作（动作层） ==================
   * 所有动作返回 { ok:true } 或 { ok:false, reason, recover, chain? }
   * 失败动作绝不修改 state —— store 据此保证不覆盖稳定状态。
   */
  const actions = {
    /* 设备启停 */
    toggleDevice(state, id) {
      const d = state.devices[id];
      if (!d) return fail("设备不存在");
      const t = devType(d.type);
      if (d.type === "rtg" || d.type === "solar")
        return fail("该设备不可手动关闭", "RTG 持续运行；太阳能受尘暴影响自动调节");
      if (state.ended) return fail("推演已结束", "可从最近稳定点回退，或分叉新策略重开");

      if (!d.on || d.state === "off" || d.state === "shed") {
        // 启动
        if (d.type === "fuelCell" && (d.fuel == null || d.fuel <= 0))
          return fail("燃料电池氢燃料已耗尽", "等待尘暴结束太阳能恢复");
        const check = canStart(state, d);
        if (!check.ok) return fail(check.reason, check.recover, starterChain(state));
        d.on = true;
        if ((t.startT || 0) > 0) {
          d.state = "starting";
          d.startLeft = t.startT;
          if (t.starter) { state.starter.busy = t.startT; state.starter.by = d.id; }
          state.idIndex[d.id + ":start"] =
            addEvent(state, { kind: "dev-start", level: "info", subject: d.id,
              msg: `开始冷启动「${t.name}（${d.node}）」，需 ${t.startT} 秒` +
                   (t.starter ? "，已占用备用启动母线" : ""), cause: null }).id;
        } else {
          d.state = "running";
          addEvent(state, { kind: "dev-on", level: "info", subject: d.id,
            msg: `开启「${t.name}（${d.node}）」`, cause: null });
        }
      } else {
        d.on = false;
        if (d.state === "starting" && t.starter && state.starter.by === d.id)
          { state.starter.busy = 0; state.starter.by = null; }
        d.state = "off"; d.startLeft = 0;
        addEvent(state, { kind: "dev-off", level: "info", subject: d.id,
          msg: `关闭「${t.name}（${d.node}）」`, cause: null });
      }
      return { ok: true };
    },

    /* 设备优先级（1 关键 … 4 可优先切除） */
    setPriority(state, id, prio) {
      const d = state.devices[id];
      if (!d) return fail("设备不存在");
      prio = clamp(Number(prio) || 1, 1, 4);
      d.prio = prio;
      addEvent(state, { kind: "prio", level: "info", subject: d.id,
        msg: `「${devType(d.type).name}（${d.node}）」供电优先级调整为 ${prio}（数字越大越先被切除）`, cause: null });
      return { ok: true };
    },

    /* 氧气分配配额 */
    setO2Quota(state, nid, q) {
      const n = state.nodes[nid];
      if (!n) return fail("舱室不存在");
      q = clamp(Math.round((Number(q) || 0) * 10) / 10, 0, 2);
      n.o2Quota = q;
      addEvent(state, { kind: "quota", level: "info", subject: nid,
        msg: `${nodeDef(nid).name}氧气分配配额设为 ${Math.round(q * 100)}%`, cause: null });
      return { ok: true };
    },

    /* 乘员活动强度 */
    setActivity(state, crewId, activity) {
      const c = state.crew[crewId];
      if (!c) return fail("乘员不存在");
      if (c.incapacitated) return fail("该乘员已失去行动能力");
      c.activity = activity;
      const label = { rest: "休息（耗氧 -25%）", normal: "正常活动", work: "高强度作业（耗氧 +25%）" }[activity];
      addEvent(state, { kind: "activity", level: "info", subject: crewId,
        msg: `${c.name} 活动强度：${label}`, cause: null });
      return { ok: true };
    },

    /* 开关阀门/气闸 */
    toggleEdge(state, edgeId, closed) {
      const e = state.edges[edgeId];
      if (!e) return fail("管道不存在");
      if (e.type === "power") return fail("电力母线无实体阀门", "区域断电由电网自动分配");
      const want = closed == null ? !e.closed : !!closed;
      if (want === e.closed) return { ok: true, silent: true };
      if (want) {
        // 安全校验：不能把有人的舱室完全孤立
        for (const nid of [e.a, e.b]) {
          const people = crewIn(state, nid);
          if (people.length === 0) continue;
          const reach = reachableGasNodes(state, nid);
          const others = [...reach].filter((x) => x !== nid && !nodeDef(x).outside);
          // 模拟关闭后
          e.closed = true;
          const reach2 = reachableGasNodes(state, nid);
          e.closed = false;
          const others2 = [...reach2].filter((x) => x !== nid && !nodeDef(x).outside);
          if (others2.length < others.length && others2.length === 0)
            return fail(`不能封闭${nodeDef(nid).name}的气闸：舱内有 ${people.length} 名乘员，封闭后该舱将成为孤岛`,
              "先将乘员转移到其他舱室，再执行封闭");
        }
      }
      e.closed = want;
      // 关阀瞬间：把已在管道内、本应继续流动的在途资源退回来源（隔离即截断）
      if (want && e.queue && e.queue.length) {
        for (const q of e.queue) {
          const srcNode = q.dir > 0 ? state.nodes[e.a] : state.nodes[e.b];
          srcNode.gas.o2 += q.pack.o2;
          srcNode.gas.n2 += q.pack.n2;
          srcNode.gas.co2 += q.pack.co2;
        }
        e.queue.length = 0;
      }
      const name = `${nodeDef(e.a).name} ↔ ${nodeDef(e.b).name}`;
      addEvent(state, { kind: "valve", level: want ? "warn" : "info", subject: edgeId,
        msg: `${e.type === "gas" ? "气闸" : "水管阀"}「${name}」已${want ? "封闭" : "重新开启"}`,
        cause: want ? { eventId: state.idIndex["LAB:breach"] || null, label: "隔离泄漏舱段" } : null });
      return { ok: true };
    },

    /* 乘员转移安排（仅气路；不能去舱外） */
    transfer(state, crewId, to) {
      const c = state.crew[crewId];
      if (!c) return fail("乘员不存在");
      if (c.incapacitated) return fail(`${c.name} 已失去行动能力，无法自行转移`, "需由其他乘员转运（暂不可用）");
      if (state.transfers.some((tr) => tr.crewId === crewId))
        return fail("该乘员正在转移途中", "等待抵达或路径中断后再安排");
      if (to === c.node) return fail("乘员已在该舱");
      if (nodeDef(to).outside) return fail("无舱外活动服，不能转移到火星表面");
      const path = gasPath(state, c.node, to);
      if (!path)
        return fail(`无法从${nodeDef(c.node).name}抵达${nodeDef(to).name}：气闸封闭导致无通路`,
          "在舱室详情中开启沿途气闸，或选择其他目的地");
      const cause = addEvent(state, { kind: "transfer-start", level: "info", subject: crewId,
        msg: `${c.name} 从${nodeDef(c.node).name}转移至${nodeDef(to).name}，途经 ${path.length - 1} 道气闸`, cause: null });
      state.transfers.push({ crewId, path, segLeft: S.edgeHatchTime, segTotal: S.edgeHatchTime,
        _at: path[0], _causeId: cause.id });
      return { ok: true };
    },

    /* 修补破洞（仅已隔离且无泄漏对外通路的舱室，需无人） */
    repair(state, nid) {
      const n = state.nodes[nid];
      if (!n) return fail("舱室不存在");
      if (!n.leak) return fail("该舱没有破损需要修补");
      if (n.repairing > 0) return { ok: true, silent: true };
      if (crewIn(state, nid).length > 0)
        return fail("修补前必须清空舱内乘员", "先安排乘员转移，再开始修补");
      // 必须先隔离：关闭所有相邻气闸
      const openGas = edgesOf(state, nid, "gas");
      if (openGas.length > 0)
        return fail("必须先封闭该舱所有相邻气闸才能安全修补", "在舱室详情中点击「封闭舱段」");
      n.repairing = S.repairTime;
      addEvent(state, { kind: "repair-start", level: "info", subject: nid,
        msg: `修补组开始处理${nodeDef(nid).name}破洞，预计 ${MLS.durStr(S.repairTime)}（按规程舱内无人作业）`,
        cause: { eventId: state.idIndex["LAB:breach"] || null, label: "舱体破洞" } });
      return { ok: true };
    },
  };

  function fail(reason, recover, chain) {
    return { ok: false, reason, recover, chain: chain || null };
  }
  function starterChain(state) {
    if (state.starter.busy > 0) {
      const other = Object.values(state.devices).find((x) => x.id === state.starter.by);
      return [
        "尘暴 → 太阳能出力 25% → 电池供电",
        other ? `另一台备用设备「${devType(other.type).name}」已占用启动母线（剩余 ${state.starter.busy}s）` : "启动母线被占用",
        "备用设备无法同时启动",
      ];
    }
    return null;
  }

  Object.assign(MLS, {
    engine: {
      step: stepWrapped, press, pO2, pCO2, gasTot, crewIn,
      nodeEta, baseEta, fanFactor, gasPath, reachableGasNodes,
      actions, canStart, sampleHistory, prime,
    },
  });
})();
