/* 可恢复节点：每次成功操作前的自动快照 + 手动打点，可随时回滚 */
(function (root) {
  var MLSS = globalThis.MLSS, U = MLSS.U, UI = (MLSS.UI = MLSS.UI || {});
  var esc = UI.escapeHtml;

  function render() {
    var s = UI.app.manager().active().state;
    var host = document.getElementById('checkpoint-list');
    if (!s.checkpoints.length) {
      host.innerHTML = '<div class="empty">尚无快照。<br>每次成功操作前都会自动保留一个稳定节点，也可手动打点。</div>';
      return;
    }
    host.innerHTML = s.checkpoints.slice(0, 25).map(function (cp) {
      return '<div class="cp-item" data-id="' + cp.id + '">' +
        '<div class="cp-head"><span class="cp-time">T+' + U.fmtTime(cp.t) + '</span>' +
          '<span class="cp-tag ' + (cp.kind === 'auto' ? 'auto' : '') + '">' +
            (cp.kind === 'auto' ? '自动 · 操作前' : '手动') + '</span></div>' +
        '<div class="cp-reason">' + esc(cp.reason || '稳定状态快照') + '</div>' +
        '<button class="btn small">↩ 回滚到该节点</button></div>';
    }).join('');
    host.querySelectorAll('.cp-item button').forEach(function (b) {
      b.onclick = function () {
        var id = b.closest('.cp-item').getAttribute('data-id');
        UI.app.rollback(id);
      };
    });
  }

  UI.checkpoints = { render: render };
})(typeof globalThis !== 'undefined' ? globalThis : this);
