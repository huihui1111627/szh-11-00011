/* 命令层：所有用户操作走 apply(state, cmd)。
 * 成功：就地修改状态并返回 {ok:true, event}；失败：状态不变，返回 {ok:false, error, chain}。
 * 调用方（manager）在克隆体上试算，成功才提交，因此失败绝不会覆盖上一稳定状态。 */
(function (root) {
  var MLSS = root.MLSS, C = MLSS.CONFIG, U = MLSS.U, sim = MLSS.sim;
  var cmd = MLSS.commands = {};

  cmd.LABELS = {
    seal: '封闭舱段', unseal: '开启舱段', edge: '操作舱口阀',
    valve: '调整氧气分配', priority: '调整设备优先级',
    toggleEquip: '启停设备', repairEquip: '维修设备',
    transfer: '乘员转移', injectLeak: '注入泄漏', repairLeak: '修复泄漏',
    reactorOut: '调整反应堆出力'
  };

  function fail(type, msg, steps, recover) {
    return { ok: false, error: msg, chain: { steps: steps || [msg], recover: recover || [] } };
  }

  cmd.apply = function (s, c) {
    var h = handlers[c.type];
    if (!h) return fail('UNKNOWN', '未知指令：' + c.type);
    try {
      var r = h(s, c.payload || {});
      if (!r || r.ok === false) return r || fail('UNKNOWN', '指令未生效');
      return { ok: true, event: r.event, label: c.label || cmd.LABELS[c.type] };
    } catch (e) {
      return fail('EXCEPTION', '指令执行异常：' + e.message, ['内部错误：' + e.message]);
    }
  };

  var handlers = {};

  handlers.seal = function (s, p) {
    var m = sim.mod(s, p.mod);
    if (!m) return fail('NO_MOD', '找不到该舱室。');
    if (m.sealed) return fail('ALREADY', m.name + ' 已处于封闭状态。');
    var inside = s.transits.filter(function (tr) { return tr.to === m.id && tr.phase === 'blocked'; });
    m.sealed = true;
    return { event: { level: 'warn', type: 'SEALED', source: 'mod:' + m.id,
      msg: m.name + ' 已封闭：与所有相邻舱室的空气/氧气连通被切断，乘员仍可在舱内活动。',
      chain: {
        steps: ['封闭隔离阀（含所有相邻舱口）', m.name + ' 成为独立大气段',
          '舱内 O₂/压力 仅靠本舱缓冲，不再获得系统补给'],
        recover: [{ label: '重新开启 ' + m.name, action: 'unseal', payload: { mod: m.id } }]
      } } };
  };

  handlers.unseal = function (s, p) {
    var m = sim.mod(s, p.mod);
    if (!m) return fail('NO_MOD', '找不到该舱室。');
    if (!m.sealed) return fail('ALREADY', m.name + ' 并未封闭。');
    if (sim.pressure(m) < C.thresholds.pressureLowCrit) {
      return fail('PRESSURE_LOCK',
        m.name + ' 内压过低（' + sim.pressure(m).toFixed(0) + 'kPa），禁止直接开启，否则相邻舱空气将倒灌并快速失压。',
        [m.name + ' 当前舱压 ' + sim.pressure(m).toFixed(0) + 'kPa',
          '与相邻舱存在巨大压差', '开启隔离阀会把相邻舱空气一同泄放'],
        [
          { label: '先向该舱恢复 O₂ 供给', action: 'valve', payload: { mod: m.id, share: 2 } },
          { label: '维持封闭并继续修复', action: 'repairLeak', payload: { mod: m.id } }
        ]);
    }
    m.sealed = false;
    return { event: { level: 'info', type: 'UNSEALED', source: 'mod:' + m.id,
      msg: m.name + ' 重新并入基地大气回路（存在轻微压差时将自动均压）。' } };
  };

  handlers.edge = function (s, p) {
    var e = sim.edge(s, p.edge);
    if (!e) return fail('NO_EDGE', '找不到该管线。');
    var A = sim.mod(s, e.a), B = sim.mod(s, e.b);
    if (p.open === false) {
      if (!e.open) return fail('ALREADY', A.name + '↔' + B.name + ' 舱口已关闭。');
      e.open = false;
      return { event: { level: 'warn', type: 'EDGE_CLOSED', source: 'edge:' + e.id,
        msg: A.name + ' ↔ ' + B.name + ' 舱口已关闭，气体不再交换。',
        chain: {
          steps: ['关闭 ' + A.name + '↔' + B.name + ' 舱口阀', '该路径从气体网络中移除',
          '需绕行其他舱口，均压与 O₂ 输送延迟增加'],
          recover: [{ label: '重新打开该舱口', action: 'edge', payload: { edge: e.id, open: true } }]
        } } };
    }
    if (p.valve !== undefined) {
      var v = U.clamp(p.valve, 0, 1);
      e.valve = v;
      if (!e.open) e.open = true;
      return { event: { level: 'info', type: 'VALVE_EDGE', source: 'edge:' + e.id,
        msg: A.name + ' ↔ ' + B.name + ' 阀位调整为 ' + Math.round(v * 100) + '%（气体交换速率改变）。' } };
    }
    e.open = true;
    return { event: { level: 'info', type: 'EDGE_OPENED', source: 'edge:' + e.id,
      msg: A.name + ' ↔ ' + B.name + ' 舱口已打开。' } };
  };

  handlers.valve = function (s, p) {
    var m = sim.mod(s, p.mod);
    if (!m) return fail('NO_MOD', '找不到该舱室。');
    var share = U.clamp(p.share, 0, 3);
    var old = m.share;
    m.share = share;
    return { event: { level: 'info', type: 'O2_SHARE', source: 'mod:' + m.id,
      msg: m.name + ' O₂ 分配权重 ' + old + ' → ' + share +
        (share === 0 ? '（已切断该舱氧气供给）' : '；产出的氧气按全基地权重重新切分，经管道约 ' +
          C.inflowDelayTicks + ' 分钟后到达。') } };
  };

  handlers.priority = function (s, p) {
    var q = sim.eq(s, p.equip);
    if (!q) return fail('NO_EQ', '找不到该设备。');
    var prio = U.clamp(Math.round(p.prio), 0, 100);
    var old = q.prio;
    q.prio = prio;
    return { event: { level: 'info', type: 'PRIORITY', source: 'eq:' + q.id,
      msg: q.name + ' 卸载优先级 ' + old + ' → ' + prio + '（数值越大，电力紧张时越早被卸载）。' } };
  };

  function powerHeadroom(s, extraKw) {
    var p = s.power, demand = 0;
    s.equipment.forEach(function (q) {
      if (q.status === 'on') demand += q.pwr;
    });
    var supply = p.reactorOut;
    s.equipment.forEach(function (q) {
      if (q.kind === 'source' && q.id !== 'reactor' && q.status === 'on') supply += q.out;
    });
    return supply - demand - extraKw + Math.min(C.power.maxDischargeKw, p.battery);
  }

  handlers.toggleEquip = function (s, p) {
    var q = sim.eq(s, p.equip);
    if (!q) return fail('NO_EQ', '找不到该设备。');

    /* 正在启动中：取消启动，释放互锁窗口 */
    if (q.status === 'starting' && p.on === false) {
      q.status = 'standby'; q.on = false; q.readyAt = null;
      if (s.power.starting === q.id) s.power.starting = null;
      s.schedule = s.schedule.filter(function (t) { return !(t.type === 'equip-ready' && t.equip === q.id); });
      return { event: { level: 'info', type: 'EQ_ABORT', source: 'eq:' + q.id,
        msg: q.name + ' 启动序列已中止，冷备启动窗口已释放。' } };
    }

    if (p.on) {
      if (q.status === 'on') return fail('ALREADY', q.name + ' 已在运行。');
      if (q.cold && q.backup) {
        /* 互锁 1：同一时刻只允许一台冷备设备启动 */
        if (s.power.starting && s.power.starting !== q.id) {
          var other = sim.eq(s, s.power.starting);
          return fail('START_LOCKED',
            q.name + ' 无法启动：' + (other ? other.name : '另一台冷备设备') + ' 正在占用启动窗口（' +
              C.maxConcurrentStarts + ' 台/次限制）。',
            ['备用设备为冷态，启动需 ' + q.startMin + ' 分钟预热',
              other ? other.name + ' 当前处于 starting 状态' : '启动窗口被占用',
              '同时启动多台冷备设备将产生叠加浪涌'],
            [
              { label: '等待 ' + (other ? other.name : '当前设备') + ' 并网后再启动', action: 'noop', payload: {} },
              { label: '中止对方启动并改用本设备', action: 'toggleEquip', payload: { equip: s.power.starting, on: false } }
            ]);
        }
        /* 互锁 2：浪涌功率必须被出力+电池裕量覆盖 */
        var headroom = powerHeadroom(s, q.inrush);
        if (headroom < 0) {
          return fail('INRUSH_TRIP',
            q.name + ' 启动浪涌 ' + q.inrush + 'kW 超出电网裕量（缺口 ' + (-headroom).toFixed(0) +
              'kW），启动器已保护性跳闸，状态未改变。',
            ['冷备设备并网瞬间产生 ' + q.inrush + 'kW 浪涌（持续 1 分钟）',
              '当前可用裕量（出力 - 负载 + 电池放电上限）= ' + headroom.toFixed(0) + 'kW',
              '硬启动会拉低母线电压并触发级联卸载'],
            [
              { label: '先卸载低优先级设备…', action: 'suggest-shed', payload: {} },
              { label: '启动燃料电池增发出力', action: 'start-equip', payload: { equip: 'fuelcell' } },
              { label: '回滚到上一稳定节点', action: 'rollback-auto', payload: {} }
            ]);
        }
        q.status = 'starting'; q.on = true; q.readyAt = s.t + q.startMin;
        s.power.starting = q.id;
        s.schedule.push({ at: s.t + q.startMin, type: 'equip-ready', equip: q.id });
        return { event: { level: 'warn', type: 'EQ_START', source: 'eq:' + q.id,
          msg: q.name + ' 开始冷态启动（' + q.startMin + ' 分钟后并网），期间占用启动窗口并产生 ' +
            q.inrush + 'kW 浪涌。' } };
      }
      q.status = 'on'; q.on = true;
      return { event: { level: 'info', type: 'EQ_ON', source: 'eq:' + q.id,
        msg: q.name + ' 已开启。' } };
    }

    if (q.fixed) return fail('FIXED', q.name + ' 为固定设备，不能从调度台直接关闭。');
    q.status = q.backup ? 'standby' : 'off'; q.on = false;
    return { event: { level: 'info', type: 'EQ_OFF', source: 'eq:' + q.id,
      msg: q.name + ' 已' + (q.backup ? '转为热备/冷备待机' : '关闭') + '。' } };
  };

  handlers.repairEquip = function (s, p) {
    var q = sim.eq(s, p.equip);
    if (!q) return fail('NO_EQ', '找不到该设备。');
    if (q.status !== 'failed') return fail('NOT_FAILED', q.name + ' 并未故障。');
    q.status = q.backup ? 'standby' : 'off';
    return { event: { level: 'info', type: 'EQ_REPAIRED', source: 'eq:' + q.id,
      msg: q.name + ' 维修完成（演练设定：维修即时完成），可重新启动。' } };
  };

  handlers.transfer = function (s, p) {
    var from = sim.mod(s, p.from), to = sim.mod(s, p.to);
    if (!from || !to) return fail('NO_MOD', '源舱或目标舱不存在。');
    var count = Math.min(p.count || 1, from.crew);
    if (count <= 0) return fail('NO_CREW', from.name + ' 没有可转移的乘员。');
    if (!to.sealed && to.crew + count > to.crewCap)
      return fail('FULL', to.name + ' 乘员容量不足（当前 ' + to.crew + '/' + to.crewCap + '）。');
    var path = sim.findPath(s, from.id, to.id);
    if (!path) {
      var sealedNeighbors = s.mods.filter(function (m) { return m.sealed; }).map(function (m) { return m.name; });
      return fail('NO_PATH',
        '不存在 ' + from.name + ' → ' + to.name + ' 的连通路径：封闭舱段（' +
          (sealedNeighbors.join('、') || '若干关闭的舱口') + '）切断了全部通道。',
        ['乘员转移要求全程通过有人加压舱段', '当前气体/通道网络不连通',
          '强行打开封闭舱会让泄漏段重新获得空气来源'],
        [
          { label: '查看并重新开启封闭舱', action: 'unseal-list', payload: {} },
          { label: '先完成泄漏修复再开舱', action: 'repairLeak', payload: {} },
          { label: '改选其他目标舱', action: 'noop', payload: {} }
        ]);
    }
    from.crew -= count;
    var delay = path.slice(1).reduce(function (d, mid, i) {
      var e = s.edges.filter(function (x) {
        return (x.a === path[i] && x.b === mid) || (x.b === path[i] && x.a === mid);
      })[0];
      return d + (e ? e.dist : 2);
    }, 0);
    s.transits.push({ id: U.shortId(), from: from.id, to: to.id, count: count,
      phase: 'traveling', remain: delay, suitMins: C.crew.suitO2Mins, path: path });
    return { event: { level: 'action', type: 'TRANSFER', source: 'mod:' + from.id,
      msg: count + ' 名乘员 ' + from.name + ' → ' + to.name + '，经 ' +
        path.map(function (id) { return sim.mod(s, id).short; }).join('-') +
        '，预计 ' + delay + ' 分钟到达。' } };
  };

  handlers.injectLeak = function (s, p) {
    var m = sim.mod(s, p.mod);
    if (!m) return fail('NO_MOD', '找不到该舱室。');
    if (m.leak) return fail('LEAK_EXISTS', m.name + ' 已存在泄漏，请先修复。');
    var rate = ['minor', 'major', 'catastrophic'].indexOf(p.rate) >= 0 ? p.rate : 'major';
    m.leak = { rate: rate, repairReadyAt: null };
    var cn = { minor: '轻微', major: '严重', catastrophic: '灾难性' }[rate];
    return { event: { level: 'critical', type: 'LEAK', source: 'mod:' + m.id,
      msg: '【情景注入】' + m.name + ' 外壳出现 ' + cn + '破损，泄漏率约 ' +
        C.leak[rate].toFixed(2) + ' kPa/分钟（' + (C.leak[rate] * 60).toFixed(0) +
        ' kPa/小时），气体开始向真空泄放。' } };
  };

  handlers.repairLeak = function (s, p) {
    var m = sim.mod(s, p.mod);
    if (!m) return fail('NO_MOD', '找不到该舱室。');
    if (!m.leak) return fail('NO_LEAK', m.name + ' 当前没有泄漏。');
    if (m.leak.repairReadyAt !== null) return fail('REPAIRING',
      m.name + ' 破损维修已在进行中，预计 ' + U.fmtTime(m.leak.repairReadyAt - s.t) + ' 后完成。');
    m.leak.repairReadyAt = s.t + C.leakRepairMins;
    s.schedule.push({ at: s.t + C.leakRepairMins, type: 'repair-done', mod: m.id });
    return { event: { level: 'info', type: 'REPAIR_START', source: 'mod:' + m.id,
      msg: m.name + ' 破损维修作业已派出，预计 ' + C.leakRepairMins + ' 分钟完成（建议先封闭舱段控制损失）。' } };
  };

  handlers.reactorOut = function (s, p) {
    var kw = U.clamp(p.kw, 0, 70);
    var old = s.power.reactorOut;
    s.power.reactorOut = kw;
    return { event: { level: kw < old ? 'warn' : 'info', type: 'REACTOR', source: 'power',
      msg: '反应堆出力 ' + old.toFixed(0) + 'kW → ' + kw.toFixed(0) + 'kW。' } };
  };

  handlers.noop = function () { return { event: { level: 'info', type: 'NOOP', msg: '请在调度面板手动完成该动作。' } }; };

  /* 情景演练：一步到位的预设 */
  cmd.scenario = function (s, key) {
    if (key === 'leak') return cmd.apply(s, { type: 'injectLeak', payload: { mod: 'air', rate: 'major' } });
    if (key === 'scrubber') {
      var q = sim.eq(s, 'scrub');
      q.status = 'failed'; q.on = false; q.shed = false;
      return { ok: true, event: { level: 'critical', type: 'EQ_FAILED', source: 'eq:scrub',
        msg: '【情景注入】主 CO₂ 洗涤器故障停机，CO₂ 将开始累积；医疗舱有一台冷态备用洗涤器。' } };
    }
    if (key === 'power') return cmd.apply(s, { type: 'reactorOut', payload: { kw: 35 } });
    return fail('NO_SCENARIO', '未知情景。');
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
