/* 公共工具：MLSS 命名空间在浏览器与 Node 下都可挂载 */
(function (root) {
  var MLSS = root.MLSS || (root.MLSS = {});
  if (typeof globalThis !== "undefined") globalThis.MLSS = MLSS;
  MLSS.U = {
    clamp: function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); },
    min: function () {
      var m = Infinity;
      for (var i = 0; i < arguments.length; i++) {
        if (arguments[i] !== null && isFinite(arguments[i]) && arguments[i] < m) m = arguments[i];
      }
      return m === Infinity ? null : m;
    },
    fmtTime: function (mins) {
      if (mins === null || !isFinite(mins)) return '∞';
      mins = Math.max(0, Math.round(mins));
      var d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      if (d > 0) return d + '天' + pad(h) + ':' + pad(m);
      return pad(h) + ':' + pad(m);
    },
    solLabel: function (mins) {
      var sol = Math.floor(mins / 1488) + 1, within = mins % 1488;
      return '第 ' + sol + ' 火星日 · ' + MLSS.U.fmtTime(within);
    },
    clone: function (o) {
      if (typeof structuredClone === 'function') return structuredClone(o);
      return JSON.parse(JSON.stringify(o));
    },
    shortId: function () { return Math.random().toString(36).slice(2, 8); },
    nowISO: function () { return new Date().toISOString(); },
    byId: function (arr, id) {
      for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
      return null;
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = MLSS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
