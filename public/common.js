'use strict';

// 通用前端工具：API 调用、令牌、Toast、SVG 构造
const App = (() => {
  function token() { return localStorage.getItem('token'); }
  function setSession(data) {
    localStorage.setItem('token', data.token);
    localStorage.setItem('role', data.role);
    localStorage.setItem('name', data.name);
  }
  function clearSession() {
    ['token', 'role', 'name'].forEach((k) => localStorage.removeItem(k));
  }
  function role() { return localStorage.getItem('role'); }
  function name() { return localStorage.getItem('name'); }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    const resp = await fetch(path, { ...opts, headers });
    let data = null;
    try { data = await resp.json(); } catch (_) { data = {}; }
    if (resp.status === 401) {
      clearSession();
      if (!location.pathname.endsWith('index.html') && location.pathname !== '/') {
        location.href = '/index.html';
      }
      throw new Error(data.error || '未登录');
    }
    if (!resp.ok || data.ok === false) {
      const err = new Error(data.error || `请求失败 (${resp.status})`);
      err.data = data;
      throw err;
    }
    return data;
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === 'class') node.setAttribute('class', v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function html(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  function toast(msg, kind = 'info', ms = 4200) {
    let host = document.querySelector('.toast-host');
    if (!host) {
      host = html('div', { class: 'toast-host' });
      document.body.appendChild(host);
    }
    const t = html('div', { class: `toast ${kind}` }, msg);
    host.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, ms - 400);
    setTimeout(() => t.remove(), ms);
  }

  const OCC_TEXT = { free: '空闲', occupied: '占用', unknown: '未知(按占用)' };
  const SIG_TEXT = { green: '绿灯(允许)', red: '红灯(停车)' };
  const POS_TEXT = { N: 'N 定位/直股', R: 'R 反位/弯股' };

  /* ------------------------- 当前站场（演练副本） ------------------------- */

  // 会话当前站场（启动时从后端拉取并缓存；选择后刷新）
  let sessionInfo = null;

  async function loadSession() {
    sessionInfo = await api('/api/session');
    return sessionInfo;
  }
  function currentYard() { return sessionInfo ? sessionInfo.yard : null; }
  function allYards() { return sessionInfo ? sessionInfo.yards : []; }

  /**
   * 顶栏站场切换条：显示当前站场，下拉选择原站场/演练副本。
   * @param {Function} [onChanged] 切换成功后的回调（通常触发页面重新加载数据）
   */
  function yardSwitcher(onChanged) {
    const box = html('span', { class: 'yard-switcher' });
    const label = html('span', { class: 'yard-label' }, '当前站场：');
    const sel = html('select', { class: 'yard-select', title: '选择当前演练站场（副本与原站场独立运行）' });
    box.appendChild(label);
    box.appendChild(sel);
    function paint(yards, currentId) {
      sel.innerHTML = '';
      for (const y of yards) {
        const opt = document.createElement('option');
        opt.value = String(y.id);
        opt.textContent = y.isOriginal ? '原站场' : `演练副本：${y.name}（#${y.id}）`;
        if (y.id === currentId) opt.selected = true;
        sel.appendChild(opt);
      }
    }
    if (sessionInfo) paint(sessionInfo.yards, sessionInfo.yard.id);
    sel.addEventListener('change', async () => {
      try {
        const data = await api('/api/session/yard', {
          method: 'PUT', body: JSON.stringify({ yardId: Number(sel.value) })
        });
        sessionInfo = { yard: data.yard, yards: data.yards, me: sessionInfo ? sessionInfo.me : null };
        paint(data.yards, data.yard.id);
        toast(`已切换至${data.yard.isOriginal ? '原站场' : `演练副本“${data.yard.name}”`}`, 'ok', 2600);
        if (onChanged) await onChanged(data.yard);
      } catch (e) {
        if (sessionInfo) sel.value = String(sessionInfo.yard.id);
        toast(e.message, 'err', 5000);
      }
    });
    box._refresh = () => { if (sessionInfo) paint(sessionInfo.yards, sessionInfo.yard.id); };
    return box;
  }

  return {
    api, el, html, toast, token, setSession, clearSession, role, name,
    OCC_TEXT, SIG_TEXT, POS_TEXT,
    loadSession, currentYard, allYards, yardSwitcher,
    get session() { return sessionInfo; }
  };
})();
