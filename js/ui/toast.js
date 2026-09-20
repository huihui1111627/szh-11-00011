/* UI 基础设施：事件总线、toast、模态框 */
(function (root) {
  var MLSS = globalThis.MLSS;
  var UI = MLSS.UI = MLSS.UI || {};

  var listeners = {};
  UI.bus = {
    on: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit: function (ev, data) { (listeners[ev] || []).forEach(function (fn) { fn(data); }); }
  };

  UI.toast = function (opts) {
    var layer = document.getElementById('toast-layer');
    var el = document.createElement('div');
    el.className = 'toast ' + (opts.level || '');
    var chainHtml = '';
    if (opts.chain && (opts.chain.steps || (opts.chain.recover && opts.chain.recover.length))) {
      chainHtml = '<div class="chain open">' +
        (opts.chain.steps || []).map(function (s) { return '<div class="chain-step">' + escapeHtml(s) + '</div>'; }).join('') +
        (opts.chain.recover && opts.chain.recover.length
          ? '<div class="chain-recover"><span class="rc-label">可恢复节点 / 建议动作</span><div>' +
            opts.chain.recover.map(function (a, i) {
              return '<button class="btn small" data-i="' + i + '">' + escapeHtml(a.label) + '</button>';
            }).join('') + '</div></div>'
          : '') +
        '</div>';
    }
    var recActions = (opts.chain && opts.chain.recover || []).map(function (a) {
      return { label: a.label,
        onClick: opts.recoverHandler ? function () { opts.recoverHandler(a); } : null };
    }).filter(function (a) { return a.onClick; });
    var allActions = recActions.concat(opts.actions || []);
    var actionsHtml = allActions.map(function (a, i) {
      return '<button class="btn small" data-i="' + i + '">' + escapeHtml(a.label) + '</button>';
    }).join('');
    el.innerHTML =
      '<div class="toast-title"><span>' + escapeHtml(opts.title || '') + '</span><span class="event-time">' +
        escapeHtml(opts.time || '') + '</span></div>' +
      (opts.msg ? '<div>' + escapeHtml(opts.msg) + '</div>' : '') + chainHtml +
      (actionsHtml ? '<div>' + actionsHtml + '</div>' : '');
    el.querySelectorAll('button[data-i]').forEach(function (b) {
      b.onclick = function () {
        var a = allActions[+b.getAttribute('data-i')];
        if (a && a.onClick) a.onClick();
        el.remove();
      };
    });
    layer.appendChild(el);
    setTimeout(function () { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; },
      opts.ttl || 9000);
    setTimeout(function () { el.remove(); }, (opts.ttl || 9000) + 500);
  };

  UI.modal = function (contentNode) {
    var layer = document.getElementById('modal-layer');
    layer.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'modal';
    box.appendChild(contentNode);
    layer.appendChild(box);
    layer.hidden = false;
    return {
      close: function () { layer.innerHTML = ''; layer.hidden = true; }
    };
  };

  UI.escapeHtml = escapeHtml;
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
