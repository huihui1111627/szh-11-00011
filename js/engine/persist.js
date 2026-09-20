/* 持久化：自动存档到 localStorage，重入页面后继续未完成推演；支持 JSON 导入/导出。 */
(function (root) {
  var MLSS = root.MLSS;
  var KEY = 'mlss-save-v1', timer = null;
  var generation = 0;

  var persist = MLSS.persist = {
    exists: function () {
      try { return !!localStorage.getItem(KEY); } catch (e) { return false; }
    },
    saveNow: function (manager) {
      try {
        localStorage.setItem(KEY, manager.serialize());
        return true;
      } catch (e) {
        console.warn('存档失败', e);
        return false;
      }
    },
    flush: function (manager) {
      if (timer) { clearTimeout(timer); timer = null; }
      persist.saveNow(manager);
    },
    scheduleSave: function (manager, cb) {
      if (timer) { if (cb) cb(true); return; }   // 已有待写入：避免高频 tick 不断重置定时器
      if (cb) cb(true);   // 立即标记“保存中…”
      var gen = generation;
      timer = setTimeout(function () {
        timer = null;
        var ok = gen === generation && persist.saveNow(manager);
        if (cb) cb(false, ok);
      }, 600);
    },
    load: function () {
      try {
        var raw = localStorage.getItem(KEY);
        if (!raw) return null;
        generation++;               // 读档换世：作废此前所有挂起写入
        if (timer) { clearTimeout(timer); timer = null; }
        return MLSS.loadManager(raw);
      } catch (e) {
        console.warn('读档失败', e);
        return null;
      }
    },
    /* 导入/重置后显式换世，避免旧 manager 的延迟写入覆盖新存档 */
    bump: function () {
      generation++;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    clear: function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
    },
    exportBlob: function (manager) {
      var blob = new Blob([manager.serialize()], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'mlss-save-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    },
    importText: function (text) {
      return MLSS.loadManager(text);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
