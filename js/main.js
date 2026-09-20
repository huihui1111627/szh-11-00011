/* 主控制器：时钟循环、命令分发（事务）、恢复动作路由、存档与重入 */
(function (root) {
  var MLSS = globalThis.MLSS, U = MLSS.U, C = MLSS.CONFIG, UI = (MLSS.UI = MLSS.UI || {});

  document.addEventListener('DOMContentLoaded', function () {
    var manager = MLSS.persist.load() || new MLSS.Manager();
    var resumed = MLSS.persist.exists();
    var running = true, rate = 600, lastFrame = 0, accMin = 0;

    var app = {
      manager: function () { return manager; },
      save: function () {
        MLSS.persist.scheduleSave(manager, function (dirty) {
          var el = document.getElementById('save-state');
          el.textContent = dirty ? '保存中…' : '已同步';
          el.className = 'save-state' + (dirty ? ' dirty' : '');
        });
      },

      /* 所有指令唯一入口：失败 → toast + 因果链 + 恢复按钮，状态不变 */
      dispatch: function (cmd, mgrTarget) {
        var res = manager.command(cmd, mgrTarget);
        if (!res.ok) {
          showFailure(cmd, res);
          return res;
        }
        afterChange(res.event);
        return res;
      },
      scenario: function (key) {
        var res = manager.scenario(key);
        if (!res.ok) { showFailure({ type: 'scenario' }, res); return res; }
        afterChange(res.event);
        return res;
      },
      rollback: function (cpId) {
        var target = manager.active();
        var res = manager.rollback(target, cpId);
        if (!res.ok) UI.toast({ level: 'fail', title: '回滚失败', msg: res.error });
        else {
          UI.toast({ level: 'ok', title: '已恢复稳定节点', msg: '失败操作之后的状态已丢弃。' });
          manager.activeId = target.id;
          refreshAll(true); save();
        }
      },

      /* 因果链上的恢复动作路由 */
      runRecovery: function (rec) {
        var s = manager.active().state;
        switch (rec.action) {
          case 'seal':
          case 'unseal':
            app.dispatch({ type: rec.action, payload: rec.payload }); break;
          case 'valve':
            app.dispatch({ type: 'valve', payload: rec.payload });
            UI.schematic.select({ kind: 'mod', id: rec.payload.mod });
            UI.controls.render({ kind: 'mod', id: rec.payload.mod });
            break;
          case 'edge':
            app.dispatch({ type: 'edge', payload: rec.payload }); break;
          case 'start-equip':
            app.dispatch({ type: 'toggleEquip', payload: { equip: rec.payload.equip, on: true } }); break;
          case 'transfer-dialog':
            UI.controls.openTransferDialog(rec.payload.mod);
            UI.forecast.switchTab('control');
            break;
          case 'repairLeak':
            if (rec.payload && rec.payload.mod)
              app.dispatch({ type: 'repairLeak', payload: { mod: rec.payload.mod } });
            else UI.forecast.switchTab('control');
            break;
          case 'unseal-list':
          case 'suggest-shed':
          case 'noop':
            UI.forecast.switchTab('control'); break;
          case 'rollback-auto': {
            var auto = s.checkpoints.filter(function (c) { return c.kind === 'auto'; })[0];
            if (auto) app.rollback(auto.id);
            else UI.toast({ level: 'fail', title: '没有可回滚的自动节点',
              msg: '可在“可恢复节点”页手动选择。' });
            break;
          }
          default:
            UI.toast({ level: '', title: rec.label, msg: '该建议需要在调度面板中手动执行。' });
        }
      },

      refreshAll: refreshAll
    };
    UI.app = app;

    /* ===== 初始化视图 ===== */
    UI.schematic.build(manager.active().state);
    refreshAll(true);
    bindControls();

    /* 关闭/刷新前把防抖中的存档强制落盘，保证重入不丢进度 */
    window.addEventListener('pagehide', function () {
      MLSS.persist.flush(manager);
    });

    if (resumed) {
      UI.toast({
        level: 'ok', ttl: 6000,
        title: '已恢复上次推演',
        msg: '从 T+' + U.fmtTime(manager.active().state.t) + ' 继续；' +
          manager.strategies.length + ' 套救援方案已加载。'
      });
    }

    /* ===== 主循环：按速率累计模拟分钟，批量推进所有策略 ===== */
    function frame(ts) {
      if (!lastFrame) lastFrame = ts;
      var dtMs = ts - lastFrame;
      lastFrame = ts;
      if (running && rate > 0) {
        accMin += dtMs / 1000 * rate / 60;
        if (accMin >= 1) {
          var steps = Math.floor(accMin);
          accMin -= steps;
          manager.advance(Math.min(steps, 60));
          afterTick(steps);
        }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    /* ===== 绑定顶栏与侧栏 ===== */
    function bindControls() {
      var pauseBtn = document.getElementById('btn-pause');
      pauseBtn.onclick = function () {
        running = !running;
        pauseBtn.textContent = running ? '⏸ 暂停' : '▶ 继续';
        pauseBtn.classList.toggle('running', !running);
      };
      document.getElementById('speed').onchange = function (e) {
        rate = +e.target.value;
        if (rate === 0) { running = false; pauseBtn.textContent = '▶ 继续'; pauseBtn.classList.add('running'); }
      };
      document.getElementById('btn-step').onclick = function () {
        running = false;
        pauseBtn.textContent = '▶ 继续';
        pauseBtn.classList.add('running');
        manager.advance(1);
        afterTick(1);
      };

      document.querySelectorAll('#side-tabs nav button').forEach(function (b) {
        b.onclick = function () {
          var name = b.getAttribute('data-tab');
          UI.forecast.switchTab(name);
          if (name === 'forecast') UI.forecast.renderBaseline();
          if (name === 'events' || name === 'checkpoints') refreshAll(false);
        };
      });

      document.querySelectorAll('.filters .chip').forEach(function (b) {
        b.onclick = function () {
          document.querySelectorAll('.filters .chip').forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          UI.events.setFilter(b.getAttribute('data-filter'));
          UI.events.render();
        };
      });

      document.getElementById('btn-snapshot').onclick = function () {
        manager.snapshot(manager.active(), '手动打点（T+' + U.fmtTime(manager.active().state.t) + '）', 'manual');
        UI.checkpoints.render(); save();
        UI.toast({ level: 'ok', title: '已创建手动恢复节点' });
      };

      document.querySelectorAll('.quick-ops [data-scenario]').forEach(function (b) {
        b.onclick = function () { app.scenario(b.getAttribute('data-scenario')); };
      });

      document.getElementById('btn-export').onclick = function () {
        MLSS.persist.saveNow(manager);
        MLSS.persist.exportBlob(manager);
      };
      document.getElementById('btn-import').onclick = function () {
        document.getElementById('import-file').click();
      };
      document.getElementById('import-file').onchange = function (e) {
        var file = e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          try {
            MLSS.persist.bump();
            manager = MLSS.persist.importText(reader.result);
            UI.app.manager = function () { return manager; };
            MLSS.persist.saveNow(manager);
            UI.schematic.rebuild(manager.active().state);
            refreshAll(true);
            UI.toast({ level: 'ok', title: '存档已导入', msg: '多套方案已加载并继续推演。' });
          } catch (err) {
            UI.toast({ level: 'fail', title: '导入失败', msg: err.message });
          }
        };
        reader.readAsText(file);
        e.target.value = '';
      };
      document.getElementById('btn-reset').onclick = function () {
        if (!confirm('放弃当前全部方案与存档，重新开始一套初始推演？')) return;
        MLSS.persist.clear();
        MLSS.persist.bump();
        manager = new MLSS.Manager();
        UI.app.manager = function () { return manager; };
        UI.schematic.rebuild(manager.active().state);
        refreshAll(true);
        save();
      };

      UI.bus.on('select', function (sel) {
        UI.forecast.switchTab('control');
        UI.controls.render(sel);
      });
    }

    function activeTab() {
      return document.querySelector('.tabpane.active').getAttribute('data-pane');
    }
    function save() { app.save(); }

    function afterTick(steps) {
      var tab = activeTab();
      UI.schematic.render(manager.active().state);
      UI.metrics.render(false);
      UI.strategy.render();
      if (tab === 'events') UI.events.render();
      if (tab === 'checkpoints') UI.checkpoints.render();
      var newCrit = manager.active().state.events
        .filter(function (e) { return e.level === 'critical' && e.t >= manager.active().state.t - steps - 1; });
      save();
    }

    function afterChange(ev) {
      refreshAll(true);
      save();
      if (ev && ev.level === 'critical') {
        UI.toast({
          level: 'crit', title: '严重告警', msg: ev.msg,
          chain: ev.chain,
          recoverHandler: app.runRecovery
        });
      }
    }

    function showFailure(cmd, res) {
      UI.toast({
        level: 'fail', ttl: 12000,
        title: '操作未执行（状态保持不变）',
        msg: res.error,
        chain: res.chain,
        recoverHandler: app.runRecovery
      });
    }

    function refreshControlIfSelected() {
      var sel = UI.schematic.getSelection();
      if (sel) UI.controls.render(sel);
    }

    function refreshAll(full) {
      var s = manager.active().state;
      UI.schematic.render(s);
      UI.metrics.render(true);
      UI.strategy.render();
      UI.events.render();
      UI.checkpoints.render();
      if (full) {
        refreshControlIfSelected();
        var tab = activeTab();
        if (tab === 'forecast') UI.forecast.renderBaseline();
      }
    }
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
