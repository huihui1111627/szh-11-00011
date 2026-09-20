/* 核心时间步仿真：每个 tick = 1 模拟分钟。
 * 资源量统一用“分压×容积”记账：m.gas 保存分压(kPa)，气体量 = kPa*volume。 */
(function (root) {
  var MLSS = root.MLSS, C = MLSS.CONFIG, U = MLSS.U;

  var sim = MLSS.sim = {};

  sim.mod = function (s, id) { return U.byId(s.mods, id); };
  sim.eq = function (s, id) { return U.byId(s.equipment, id); };
  sim.edge = function (s, id) { return U.byId(s.edges, id); };
  sim.pressure = function (m) { return m.gas.o2 + m.gas.co2 + m.gas.n2; };
  sim.o2Amount = function (m) { return m.gas.o2 * m.volume; };
  sim.gasAmount = function (m) { return sim.pressure(m) * m.volume; };
  sim.running = function (q) { return q.status === 'on' && !q.shed; };

  sim.crewCount = function (s) {
    return s.mods.reduce(function (n, m) { return n + m.crew; }, 0);
  };

  /* BFS：只走“开启且两端未封闭”的舱口 */
  sim.findPath = function (s, from, to) {
    if (from === to) return [from];
    var adj = {};
    s.mods.forEach(function (m) { adj[m.id] = []; });
    s.edges.forEach(function (e) {
      var ma = sim.mod(s, e.a), mb = sim.mod(s, e.b);
      if (!e.open || ma.sealed || mb.sealed) return;
      adj[e.a].push({ id: e.b, d: e.dist });
      adj[e.b].push({ id: e.a, d: e.dist });
    });
    var q = [{ id: from, path: [from], dist: 0 }], seen = {};
    seen[from] = true;
    while (q.length) {
      var cur = q.shift();
      var list = adj[cur.id].slice().sort(function (x, y) { return x.d - y.d; });
      for (var i = 0; i < list.length; i++) {
        var nx = list[i];
        if (seen[nx.id]) continue;
        var np = cur.path.concat(nx.id);
        if (nx.id === to) return np;
        seen[nx.id] = true;
        q.push({ id: nx.id, path: np, dist: cur.dist + nx.d });
      }
    }
    return null;
  };

  /* ===== tick ===== */
  sim.tick = function (s, opts) {
    opts = opts || {};
    var emitted = [];
    function emit(ev) { emitted.push(ev); if (!opts.silent) MLSS.addEvent(s, ev); }

    runSchedule(s, emit);
    runTransits(s, emit);
    stepPower(s, emit);
    stepGasProduction(s);
    stepCrewBreathing(s);
    stepFlow(s);
    stepLeaks(s);
    stepVenting(s);
    stepWater(s);
    stepDanger(s, emit);
    checkAlerts(s, emit);
    s.t += 1;
    return emitted;
  };

  function runSchedule(s, emit) {
    var remain = [];
    s.schedule.forEach(function (task) {
      if (task.at > s.t) { remain.push(task); return; }
      if (task.type === 'repair-done') {
        var m = sim.mod(s, task.mod);
        if (m && m.leak && m.leak.repairReadyAt <= s.t) {
          m.leak = null;
          emit({ level: 'info', type: 'REPAIRED', source: 'mod:' + m.id,
            msg: m.name + ' 破损已修复，泄漏停止。' });
        }
      } else if (task.type === 'equip-ready') {
        var q = sim.eq(s, task.equip);
        if (q && q.status === 'starting') {
          q.status = 'on'; q.on = true; q.readyAt = null;
          if (s.power.starting === q.id) s.power.starting = null;
          emit({ level: 'info', type: 'EQ_READY', source: 'eq:' + q.id,
            msg: q.name + ' 启动完成，已并入系统。' });
        }
      }
    });
    s.schedule = remain;
  }

  function runTransits(s, emit) {
    s.transits = s.transits.filter(function (tr) {
      var dest = sim.mod(s, tr.to);
      if (tr.phase === 'traveling') {
        tr.remain -= 1; tr.suitMins -= 1;
        if (tr.remain <= 0) {
          if (!dest.sealed) {
            dest.crew += tr.count;
            emit({ level: 'info', type: 'TRANSFER_DONE', source: 'mod:' + dest.id,
              msg: tr.count + ' 名乘员已抵达 ' + dest.name + '。' });
            return false;
          }
          tr.phase = 'blocked';
          emit({ level: 'critical', type: 'TRANSFER_BLOCKED', source: 'mod:' + dest.id,
            msg: tr.count + ' 名乘员抵达 ' + dest.name + ' 但舱门处于封闭状态，被迫舱外等待（舱外服余 ' +
              U.fmtTime(tr.suitMins) + '）。',
            chain: {
              steps: ['乘员转移 ETA 到达', dest.name + ' 此前被封闭（隔离阀关闭）',
                '乘员滞留舱外，持续消耗舱外服氧气'],
              recover: [
                { label: '打开 ' + dest.name + ' 舱门', action: 'unseal', payload: { mod: dest.id } }
              ]
            }
          });
        }
      }
      if (tr.phase === 'blocked') {
        tr.suitMins -= 1;
        if (!dest.sealed) {
          dest.crew += tr.count;
          emit({ level: 'info', type: 'TRANSFER_DONE', source: 'mod:' + dest.id,
            msg: dest.name + ' 舱门开启，' + tr.count + ' 名等待中的乘员进入舱内（舱外服余 ' +
              U.fmtTime(Math.max(0, tr.suitMins)) + '）。' });
          return false;
        }
        if (tr.suitMins <= 0) {
          s.totalCasualties += tr.count;
          dest.casualties += tr.count;
          emit({ level: 'critical', type: 'SUIT_O2_OUT', source: 'mod:' + dest.id,
            msg: tr.count + ' 名乘员在 ' + dest.name + ' 外耗尽舱外服氧气，未能存活。',
            chain: {
              steps: ['乘员转移至 ' + dest.name, '舱门封闭无法进入',
                '舱外服氧气持续消耗', '耗尽（余 0 分钟）'],
              recover: [
                { label: '回滚到转移前稳定节点', action: 'rollback-auto', payload: {} }
              ]
            }
          });
          return false;
        }
      }
      return true;
    });
  }

  /* ===== 电力：出力/需求/电池，含冷备设备启动浪涌互锁与按优先级卸载 ===== */
  function stepPower(s, emit) {
    s.equipment.forEach(function (q) { q.shed = false; });

    var starting = s.power.starting ? sim.eq(s, s.power.starting) : null;
    /* 电源类设备启动瞬间：浪涌算需求，同时其出力已并入母线 */
    var supply = 0;
    s.equipment.forEach(function (q) {
      if (q.kind !== 'source') return;
      if (q.status === 'on') supply += (q.id === 'reactor' ? s.power.reactorOut : q.out);
      if (q === starting && q.status === 'starting') supply += q.out;
    });

    var demand = 0;
    s.equipment.forEach(function (q) {
      if (q === starting && q.status === 'starting') demand += q.inrush;
      else if (q.status === 'on') demand += q.pwr;
    });


    var net = supply - demand, unmet = 0;
    if (net >= 0) {
      var room = C.power.batteryCap - s.power.battery;
      s.power.battery += Math.min(net, C.power.maxChargeKw, room);
    } else {
      var need = -net;
      var fromBat = Math.min(need, C.power.maxDischargeKw, s.power.battery);
      s.power.battery -= fromBat;
      unmet = need - fromBat;
    }

    /* 容量缺口：按优先级数值从大到小卸载（越大越“可牺牲”） */
    if (unmet > 0.01) {
      var cands = s.equipment
        .filter(function (q) { return q.status === 'on' && !q.fixed && q.kind !== 'source'; })
        .sort(function (a, b) { return b.prio - a.prio || b.pwr - a.pwr; });
      var shedNames = [];
      for (var i = 0; i < cands.length && unmet > 0.01; i++) {
        cands[i].shed = true;
        unmet -= cands[i].pwr;
        demand -= cands[i].pwr;
        shedNames.push(cands[i].name);
      }
      emit({
        level: shedNames.length ? 'warn' : 'critical',
        type: 'LOAD_SHED', source: 'power',
        msg: shedNames.length
          ? '电力缺口 ' + need.toFixed(0) + 'kW 超过电池支援能力，已按优先级卸载：' + shedNames.join('、') + '。'
          : '电力严重不足且已无负载可卸载，关键设备面临断电。',
        chain: {
          steps: ['用电需求 ≈ ' + Math.round(demand) + 'kW / 发电出力 ' + supply.toFixed(0) + 'kW',
            '电池放电触及上限 ' + C.power.maxDischargeKw + 'kW',
            shedNames.length ? '调度器按设备优先级卸载非关键负载' : '全部可卸载负载已切除，仍存在缺口'],
          recover: [
            { label: '启动备用燃料电池', action: 'start-equip', payload: { equip: 'fuelcell' } },
            { label: '回滚到上一稳定节点', action: 'rollback-auto', payload: {} }
          ]
        }
      });
    }

    if (s.power.battery <= 0.01 && supply < demand) {
      throttle(s, emit, 'power-collapse', 10, {
        level: 'critical', type: 'POWER_COLLAPSE', source: 'power',
        msg: '电池耗尽且发电出力低于关键负载，全基地进入级联断电风险。',
        chain: {
          steps: ['发电出力不足', '电池电量耗尽', '关键生命保障设备将被卸载'],
          recover: [
            { label: '启动备用燃料电池', action: 'start-equip', payload: { equip: 'fuelcell' } },
            { label: '回滚到上一稳定节点', action: 'rollback-auto', payload: {} }
          ]
        }
      });
    }
    s.power.demand = demand; s.power.supplied = supply;
  }

  /* 限频告警：同 key 每 cooldownTicks 最多一次 */
  function throttle(s, emit, key, cooldown, ev) {
    var last = s.alerts['throttle:' + key];
    if (last !== undefined && s.t - last < cooldown) return;
    s.alerts['throttle:' + key] = s.t;
    emit(ev);
  }

  /* O₂ 产出进入管道，按目标舱 share 权重加权分配；水电解同时消耗饮用水。
   * 多台洗涤器共享全基地可处理 CO₂ 预算，避免重复“过量清除”。 */
  function stepGasProduction(s) {
    var o2pool = 0, scrubCap = 0, recycle = 0, farmWater = 0, farmO2 = 0;
    var scrubbers = [];
    s.equipment.forEach(function (q) {
      if (!sim.running(q)) return;
      if (q.kind === 'o2gen') {
        if (s.water.potable > 0.5) { o2pool += q.rate; s.water.potable = Math.max(0, s.water.potable - 0.2); }
      } else if (q.kind === 'scrubber') {
        scrubCap += q.rate; scrubbers.push(q);
      } else if (q.kind === 'recycler') {
        recycle += q.rate;
      } else if (q.kind === 'growlight') {
        farmO2 += q.o2rate; farmWater += q.water;
      }
    });

    if (o2pool > 0) {
      var targets = s.mods.filter(function (m) { return !m.sealed && m.share > 0; });
      var wsum = targets.reduce(function (n, m) { return n + m.share; }, 0);
      if (wsum > 0) {
        targets.forEach(function (m) {
          m.inflow.push({ at: s.t + C.inflowDelayTicks, amount: o2pool * m.share / wsum });
        });
      }
    }
    s.mods.forEach(function (m) {
      var arriving = m.inflow.filter(function (f) { return f.at <= s.t; });
      var amount = arriving.reduce(function (n, f) { return n + f.amount; }, 0) + (m.id === 'farm' ? farmO2 : 0);
      if (amount) m.gas.o2 = Math.min(C.moduleCap.o2, m.gas.o2 + amount / m.volume);
      m.inflow = m.inflow.filter(function (f) { return f.at > s.t; });
    });

    /* CO₂ 洗涤：全部洗涤器共享“可处理总量”预算；
     * 一半能力优先服务设备所在舱，其余按各舱 CO₂ 存量比例外溢到开启舱段。
     * 每舱清除量严格不超过其当前存量。 */
    if (scrubCap > 0 && scrubbers.length) {
      var stock = {};
      s.mods.forEach(function (m) { stock[m.id] = Math.max(0, m.gas.co2 * m.volume); });
      var removed = {};
      s.mods.forEach(function (m) { removed[m.id] = 0; });

      /* 本舱优先 */
      var localBudget = scrubCap * 0.6, remaining = localBudget;
      scrubbers.forEach(function (q) {
        var take = Math.min(localBudget / scrubbers.length, stock[q.mod], remaining);
        stock[q.mod] -= take; removed[q.mod] += take; remaining -= take;
      });

      /* 富余能力（含预留的 40% 外溢份额）按存量比例分配给未封闭舱 */
      var spillTotal = scrubCap - localBudget + remaining;
      var reachable = {};
      s.mods.forEach(function (m) { reachable[m.id] = !m.sealed; });
      var stockSum = 0;
      s.mods.forEach(function (m) {
        if (reachable[m.id]) stockSum += stock[m.id];
      });
      if (stockSum > 0) {
        s.mods.forEach(function (m) {
          if (!reachable[m.id]) return;
          var take = Math.min(spillTotal * stock[m.id] / stockSum, stock[m.id]);
          stock[m.id] -= take; removed[m.id] += take;
        });
      }
      s.mods.forEach(function (m) {
        m.gas.co2 = Math.max(0, m.gas.co2 - removed[m.id] / m.volume);
      });
    }

    /* 水回收：废水 -> 饮用水（回收率 0.92） */
    if (recycle > 0 && s.water.waste > 0) {
      var pulled = Math.min(recycle, s.water.waste);
      s.water.waste -= pulled;
      var potRoom = C.water.potableCap - s.water.potable;
      s.water.potable = Math.min(C.water.potableCap, s.water.potable + pulled * 0.92);
      if (potRoom < pulled * 0.92) s.water.waste += (pulled * 0.92 - potRoom) / 0.92;
    }
    if (farmWater > 0) s.water.potable = Math.max(0, s.water.potable - farmWater);
  }

  /* 乘员呼吸（含转移中乘员消耗舱外服氧气，不改变舱内气体） */
  function stepCrewBreathing(s) {
    var cr = C.crew;
    s.mods.forEach(function (m) {
      if (!m.crew) return;
      var n = m.crew;
      var o2avail = m.gas.o2 * m.volume;
      var used = Math.min(o2avail, cr.o2Rate * n);
      m.gas.o2 = Math.max(0, m.gas.o2 - used / m.volume);
      m.gas.co2 = Math.min(C.moduleCap.co2, m.gas.co2 + cr.co2Rate * n / m.volume);
    });
  }

  /* 开启舱口：双舱交换混合模型（质量守恒、无条件稳定）。
   * 每分钟从两端各取 f 比例气体互换；f 随阀位变化。
   * 组分因此自然扩散，压差因此自然均压，无需单独扩散项。 */
  function stepFlow(s) {
    s.edges.forEach(function (e) {
      if (!e.open || e.valve <= 0.01) return;
      var A = sim.mod(s, e.a), B = sim.mod(s, e.b);
      if (A.sealed || B.sealed) return;
      var f = C.equalConductance * e.valve;
      var Va = A.volume, Vb = B.volume;
      ['o2', 'co2', 'n2'].forEach(function (g) {
        var qa = A.gas[g] * Va, qb = B.gas[g] * Vb;
        /* A->B 净流量 = f * (qa·Vb - qb·Va) / (Va+Vb)，混合平衡方向 */
        var flow = f * (qa * Vb - qb * Va) / (Va + Vb);
        flow = U.clamp(flow, -qb * 0.5, qa * 0.5);
        A.gas[g] = Math.max(0, A.gas[g] - flow / Va);
        B.gas[g] = Math.max(0, B.gas[g] + flow / Vb);
      });
    });
  }

  function stepLeaks(s) {
    s.mods.forEach(function (m) {
      if (!m.leak) return;
      var p = sim.pressure(m);
      if (p <= 0.1) return;
      var r = C.leak[m.leak.rate];
      ['o2', 'co2', 'n2'].forEach(function (g) {
        var frac = m.gas[g] / p;
        m.gas[g] = Math.max(0, m.gas[g] - r * frac);
      });
    });
  }

  /* 高压/高氧安全阀向真空泄放 */
  function stepVenting(s) {
    s.mods.forEach(function (m) {
      var p = sim.pressure(m);
      if (p > C.thresholds.pressureHighVent) {
        var over = p - C.thresholds.pressureHighVent;
        ['o2', 'co2', 'n2'].forEach(function (g) {
          m.gas[g] = Math.max(0, m.gas[g] - over * m.gas[g] / p);
        });
      }
      if (m.gas.o2 > C.thresholds.o2HighVent) m.gas.o2 = C.thresholds.o2HighVent;
    });
  }

  function stepWater(s) {
    var n = sim.crewCount(s) + s.transits.reduce(function (a, tr) { return a + tr.count; }, 0);
    var drink = C.crew.waterRate * n, waste = C.crew.wasteRate * n;
    s.water.potable = Math.max(0, s.water.potable - drink);
    s.water.waste = Math.min(C.water.wasteCap, s.water.waste + waste);
  }

  /* 危险暴露计时：缺氧 / 高 CO2 / 低压 / 断水；累计 30 分钟减员 */
  function stepDanger(s, emit) {
    var waterOut = s.water.potable <= 0.05;
    s.mods.forEach(function (m) {
      if (!m.crew) { m.dangerMin = 0; return; }
      var bad = m.gas.o2 < C.thresholds.o2LowCrit ||
        m.gas.co2 > C.thresholds.co2Crit ||
        sim.pressure(m) < C.thresholds.pressureLowCrit;
      if (bad) m.dangerMin += 1; else m.dangerMin = Math.max(0, m.dangerMin - 1);
      if (m.dangerMin === C.thresholds.dangerMinsToCasualty) {
        m.crew -= 1; m.casualties += 1; s.totalCrew -= 1; s.totalCasualties += 1;
        emit({
          level: 'critical', type: 'CASUALTY', source: 'mod:' + m.id,
          msg: m.name + ' 一名乘员因持续恶劣环境（缺氧/高压 CO₂/失压）罹难。',
          chain: {
            steps: [
              m.gas.o2 < C.thresholds.o2LowCrit ? 'O₂ 分压跌至 ' + m.gas.o2.toFixed(1) + ' kPa' : null,
              m.gas.co2 > C.thresholds.co2Crit ? 'CO₂ 分压升至 ' + m.gas.co2.toFixed(1) + ' kPa' : null,
              sim.pressure(m) < C.thresholds.pressureLowCrit ? '舱压跌至 ' + sim.pressure(m).toFixed(0) + ' kPa' : null,
              '危险暴露累计 ' + C.thresholds.dangerMinsToCasualty + ' 分钟'
            ].filter(Boolean),
            recover: [
              { label: '向 ' + m.name + ' 增配 O₂', action: 'valve', payload: { mod: m.id, share: 2 } },
              { label: '回滚到上一稳定节点', action: 'rollback-auto', payload: {} }
            ]
          }
        });
      }
    });
    s.alerts['waterOut'] = waterOut;
  }

  /* 阈值穿越告警（warn/crit 两级，只在跨越边界时记录一次） */
  function checkAlerts(s, emit) {
    var T = C.thresholds;
    function fire(key, level, type, modId, msg, chain) {
      var st = s.alerts[key];
      if (st === level) return;
      s.alerts[key] = level;
      if (level) emit({ level: level, type: type, source: modId ? 'mod:' + modId : 'system', msg: msg, chain: chain });
    }
    s.mods.forEach(function (m) {
      var p = sim.pressure(m);
      var lvl = (!m.crew && !m.leak) ? null
        : (p < T.pressureLowCrit || m.gas.o2 < T.o2LowCrit || m.gas.co2 > T.co2Crit ? 'critical'
          : (p < T.pressureLowWarn || m.gas.o2 < T.o2LowWarn || m.gas.co2 > T.co2Warn ? 'warn' : null));
      if (lvl === 'critical') {
        var reasons = [];
        if (p < T.pressureLowCrit) reasons.push('舱压 ' + p.toFixed(0) + 'kPa（< ' + T.pressureLowCrit + '）');
        if (m.gas.o2 < T.o2LowCrit) reasons.push('O₂ ' + m.gas.o2.toFixed(1) + 'kPa（< ' + T.o2LowCrit + '）');
        if (m.gas.co2 > T.co2Crit) reasons.push('CO₂ ' + m.gas.co2.toFixed(1) + 'kPa（> ' + T.co2Crit + '）');
        fire('crit:' + m.id, 'critical', 'CRIT_ENV', m.id,
          m.name + ' 进入致命环境：' + reasons.join('；') + '。',
          {
            steps: [m.leak ? m.name + ' 存在 ' + ({minor:'轻微',major:'严重',catastrophic:'灾难性'})[m.leak.rate] + '泄漏' : null,
              '气体沿开启舱口持续流失/混合', reasons.join('；')].filter(Boolean),
            recover: [
              { label: '封闭 ' + m.name,  'action': 'seal', payload: { mod: m.id } },
              { label: '增配 O₂ 到该舱', action: 'valve', payload: { mod: m.id, share: 2 } },
              { label: '转移乘员出该舱', action: 'transfer-dialog', payload: { mod: m.id } }
            ]
          });
      } else {
        fire('crit:' + m.id, lvl, lvl === 'warn' ? 'WARN_ENV' : null, m.id,
          lvl ? m.name + ' 环境参数偏离安全窗口。' : '');
      }
    });
    fire('water', s.water.potable <= 0 ? 'critical' : (s.water.potable < 80 ? 'warn' : null),
      s.water.potable <= 0 ? 'WATER_OUT' : 'WATER_LOW', null,
      s.water.potable <= 0 ? '饮用水耗尽，乘员开始脱水计时。' : '饮用水储位偏低（' + s.water.potable.toFixed(0) + 'L）。');
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
