/* 存档：localStorage 自动保存 + JSON 导入导出；重新进入可继续未完成推演 */
(function () {
  const MLS = window.MLS;
  const KEY = "mls_save_v1";
  const VERSION = 1;

  function save(root) {
    try {
      const payload = {
        version: VERSION,
        savedAt: Date.now(),
        speed: root.speed,
        activeId: root.activeId,
        strategies: root.strategies,
      };
      localStorage.setItem(KEY, JSON.stringify(payload));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data.version !== VERSION) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) {}
  }

  function exportJSON(root) {
    return JSON.stringify({
      version: VERSION, savedAt: Date.now(), speed: root.speed,
      activeId: root.activeId, strategies: root.strategies,
    }, null, 2);
  }

  function importJSON(text) {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.strategies) || !data.strategies.length)
      throw new Error("存档结构无效：缺少 strategies");
    for (const st of data.strategies) {
      if (!st.id || !st.name || !st.state || !st.state.nodes)
        throw new Error("存档结构无效：策略数据不完整");
    }
    return data;
  }

  MLS.persistence = { save, load, clear, exportJSON, importJSON, KEY };
})();
