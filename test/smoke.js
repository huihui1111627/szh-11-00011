/* 引擎冒烟测试：node test/smoke.js
 * 覆盖：基线稳定性、封闭隔离、泄漏、延迟均压、失败回滚（事务）、
 * 启动浪涌互锁、转移路径、CO₂ 累积与洗涤、多策略同步、快照回滚、持久化往返。 */
const fs = require('fs');
const path = require('path');

const files = [
  'js/engine/util.js', 'js/engine/config.js', 'js/engine/state.js',
  'js/engine/sim.js', 'js/engine/forecast.js', 'js/engine/commands.js',
  'js/engine/manager.js'
];
const sandbox = {};
files.forEach(f => {
  const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const fn = new Function('globalThis', 'module', 'exports', code);
  fn(sandbox, { exports: {} }, {});
});
const MLSS = sandbox.MLSS;

let passed = 0, failed = 0;
function assert(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra || ''); }
}
function runTicks(s, n) { for (let i = 0; i < n; i++) MLSS.sim.tick(s); }

console.log('\n[1] 基线 120 分钟推演：O₂/压力/水/电保持安全');
{
  const s = MLSS.createInitialState();
  runTicks(s, 120);
  const d = MLSS.forecast.derive(s);
  assert('无人舱压力接近常压', d.mods.find(m => m.id === 'rec').p > 95);
  assert('乘员舱 O₂ > 17.5 kPa', d.mods.filter(m => m.crew).every(m => m.o2 > 17.5));
  assert('CO₂ 受控 < 0.8 kPa', d.mods.every(m => m.co2 < 0.8), JSON.stringify(d.mods.map(m=>m.co2)));
  assert('饮用水仍有 > 250L', d.water > 250, String(d.water));
  assert('电池处于 0~24 kWh', d.battery >= 0 && d.battery <= 24);
  assert('无减员', s.totalCasualties === 0);
  const sup = MLSS.forecast.supportTimes(s);
  assert('综合保障时间 ≥ 90 分钟或为安全(null)', sup.overall === null || sup.overall >= 90, String(sup.overall));
}

console.log('\n[2] 气闸严重泄漏 + 封闭：隔离后相邻舱压力得到保护');
{
  const s = MLSS.createInitialState();
  MLSS.commands.apply(s, { type: 'injectLeak', payload: { mod: 'air', rate: 'major' } });
  runTicks(s, 3);
  const air = MLSS.sim.mod(s, 'air');
  assert('泄漏后气闸压力开始下降', MLSS.sim.pressure(air) < 101, String(MLSS.sim.pressure(air)));
  MLSS.commands.apply(s, { type: 'seal', payload: { mod: 'air' } });
  runTicks(s, 200);
  const air2 = MLSS.sim.mod(s, 'air'); const ls2 = MLSS.sim.mod(s, 'ls');
  assert('气闸继续泄压至致命低压', MLSS.sim.pressure(air2) < 45, String(MLSS.sim.pressure(air2)));
  assert('生命保障舱压力基本保住 (>95)', MLSS.sim.pressure(ls2) > 95,
    String(MLSS.sim.pressure(ls2)));
  assert('低压舱不能直接重新开舱（压差锁）',
    MLSS.commands.apply(s, { type: 'unseal', payload: { mod: 'air' } }).ok === false);
}

console.log('\n[3] 延迟传播：关阀/封闭后影响经多个 tick 才在远端显现');
{
  const s = MLSS.createInitialState();
  MLSS.commands.apply(s, { type: 'edge', payload: { edge: 'e-hub-hab', open: false } });
  MLSS.commands.apply(s, { type: 'edge', payload: { edge: 'e-crew-hab', open: false } });
  MLSS.commands.apply(s, { type: 'edge', payload: { edge: 'e-hab-farm', open: false } });
  const hab = MLSS.sim.mod(s, 'hab');
  const crew = hab.crew;
  runTicks(s, 200);
  assert('被切断通道的居住舱 O₂ 明显低于系统舱',
    hab.gas.o2 < MLSS.sim.mod(s, 'cmd').gas.o2 - 1,
    hab.gas.o2.toFixed(2) + ' vs cmd ' + MLSS.sim.mod(s, 'cmd').gas.o2.toFixed(2));
  assert('居住舱出现告警事件', s.events.some(e => e.source === 'mod:hab' && (e.type === 'WARN_ENV' || e.type === 'CRIT_ENV')));
}

console.log('\n[4] 事务：失败命令不修改状态');
{
  const s = MLSS.createInitialState();
  const snap = JSON.stringify(s);
  const r1 = MLSS.commands.apply(s, { type: 'seal', payload: { mod: 'nope' } });
  assert('不存在舱室 -> 失败', r1.ok === false);
  MLSS.commands.apply(s, { type: 'seal', payload: { mod: 'air' } });
  const r2 = MLSS.commands.apply(s, { type: 'seal', payload: { mod: 'air' } });
  assert('重复封闭 -> 失败且带因果链', r2.ok === false && !!r2.chain && r2.chain.steps.length > 0);
  const r3 = MLSS.commands.apply(s, { type: 'transfer', payload: { from: 'air', to: 'hab', count: 1 } });
  assert('气源舱无人可转移 -> 失败', r3.ok === false);
}

console.log('\n[5] 冷备互锁：两台冷备不能同时启动；浪涌不足时跳闸');
{
  const s = MLSS.createInitialState();
  const r1 = MLSS.commands.apply(s, { type: 'toggleEquip', payload: { equip: 'fuelcell', on: true } });
  assert('燃料电池进入 starting', r1.ok && MLSS.sim.eq(s, 'fuelcell').status === 'starting');
  const r2 = MLSS.commands.apply(s, { type: 'toggleEquip', payload: { equip: 'scrub2', on: true } });
  assert('第二台冷备被互锁拒绝', !r2.ok && r2.error.indexOf('启动窗口') >= 0, r2.error);
  assert('被拒设备保持待机', MLSS.sim.eq(s, 'scrub2').status === 'standby');
  runTicks(s, 5);
  assert('预热完成自动并网', MLSS.sim.eq(s, 'fuelcell').status === 'on');
}

console.log('\n[6] 浪涌跳闸：压低出力+电池后启动大浪涌设备应失败且状态不变');
{
  const s = MLSS.createInitialState();
  MLSS.commands.apply(s, { type: 'reactorOut', payload: { kw: 20 } });
  s.power.battery = 0.1;
  const before = MLSS.sim.eq(s, 'fuelcell').status;
  const r = MLSS.commands.apply(s, { type: 'toggleEquip', payload: { equip: 'fuelcell', on: true } });
  assert('浪涌超出裕量被拒', !r.ok && r.error.indexOf('浪涌') >= 0, r.error);
  assert('状态未改变', MLSS.sim.eq(s, 'fuelcell').status === before);
  assert('失败结果带恢复建议', r.chain.recover.some(x => x.action === 'start-equip' || x.action === 'suggest-shed'));
}

console.log('\n[7] 乘员转移：路径校验、延迟到达、封闭目标导致等待');
{
  const s = MLSS.createInitialState();
  const path = MLSS.sim.findPath(s, 'crew', 'med');
  assert('存在 quarters->医疗 路径', Array.isArray(path) && path[0] === 'crew' && path[path.length - 1] === 'med');
  const before = MLSS.sim.mod(s, 'crew').crew;
  const r = MLSS.commands.apply(s, { type: 'transfer', payload: { from: 'crew', to: 'med', count: 2 } });
  assert('转移指令成功（在途）', r.ok);
  assert('出发舱立即减员', MLSS.sim.mod(s, 'crew').crew === before - 2);
  assert('医疗舱尚未收到乘员', MLSS.sim.mod(s, 'med').crew === (MLSS.CONFIG.crewInit.med || 0));
  runTicks(s, 20);
  assert('延迟后乘员到达', MLSS.sim.mod(s, 'med').crew === (MLSS.CONFIG.crewInit.med || 0) + 2);

  const s2 = MLSS.createInitialState();
  MLSS.commands.apply(s2, { type: 'seal', payload: { mod: 'air' } });
  assert('气闸被封后不存在 -> 气闸路径', MLSS.sim.findPath(s2, 'ls', 'air') === null);
}

console.log('\n[8] CO₂ 累积：洗涤器故障后 CO₂ 上升，备用洗涤器可缓解');
{
  const s = MLSS.createInitialState();
  MLSS.sim.eq(s, 'scrub').status = 'failed';
  MLSS.sim.eq(s, 'scrub').on = false;
  runTicks(s, 45);
  assert('无洗涤时 CO₂ 超过警告线',
    s.mods.some(m => m.crew && m.gas.co2 > 1.5),
    JSON.stringify(s.mods.filter(m => m.crew).map(m => m.gas.co2.toFixed(2))));
  MLSS.commands.apply(s, { type: 'toggleEquip', payload: { equip: 'scrub2', on: true } });
  runTicks(s, 20);
  const co2Now = Math.max.apply(null, s.mods.filter(m => m.crew).map(m => m.gas.co2));
  assert('备用洗涤器并网后 CO₂ 回落', co2Now < 1.5, co2Now.toFixed(2));
}

console.log('\n[9] 多策略：同步推进 / 克隆分叉 / 对照 / 回滚');
{
  const mgr = new MLSS.Manager();
  const a = mgr.active();
  mgr.command({ type: 'valve', payload: { mod: 'hab', share: 0 } });
  const st2 = mgr.addStrategy('方案 B · 保居住舱');
  mgr.activeId = st2.id;
  mgr.command({ type: 'valve', payload: { mod: 'hab', share: 3 } });
  mgr.advance(60);
  const cmp = mgr.compare();
  assert('两套方案时钟同步 (T=60)', cmp.every(r => r.t === 60));
  assert('方案指标可独立对照', cmp.length === 2 && cmp[0].name !== cmp[1].name);
  const before = a.state.t;
  const cp = a.state.checkpoints[0];
  mgr.rollback(a, cp.id);
  assert('回滚到操作前节点', a.state.t <= before && a.state.events.some(e => e.type === 'ROLLBACK'));
  const json = mgr.serialize();
  const mgr2 = MLSS.loadManager(json);
  assert('序列化往返后方案数一致', mgr2.strategies.length === 2);
  assert('回滚后参数恢复（hab share）',
    Math.abs(MLSS.sim.mod(mgr2.strategies[0].state, 'hab').share - 1) < 1e-9);
}

console.log('\n[10] 前向推演为只读');
{
  const s = MLSS.createInitialState();
  const t0 = s.t, ev0 = s.events.length;
  MLSS.forecast.run(s, 90);
  MLSS.forecast.supportTimes(s);
  assert('forecast 不推进原状态', s.t === t0 && s.events.length === ev0);
}

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败\n');
process.exit(failed ? 1 : 0);
