// ==UserScript==
// @name         Workamajig Task Links
// @namespace    https://xzito.com/
// @version      0.2.0
// @description  Hover a row on a project Schedule page to get a link button: copies a task deep link (scrolls to/highlights the row) or the assignment URL for each assignee slot.
// @match        https://app20.workamajig.com/platinum/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/xzito/workamajig-task-links/main/workamajig-task-links.user.js
// @downloadURL  https://raw.githubusercontent.com/xzito/workamajig-task-links/main/workamajig-task-links.user.js
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const BASE = location.origin + '/platinum/';
  const SS_KEY = 'wjl.pendingTask';

  // Workamajig rewrites the URL on load and drops the hash, so capture it now (document-start).
  (function captureHash() {
    const m = /[#&]task=(\d+)/.exec(location.hash);
    if (m) try { sessionStorage.setItem(SS_KEY, m[1]); } catch (e) {}
  })();

  const qs = () => new URLSearchParams(location.search);
  const isSchedulePage = () => qs().get('aid') === 'projects.schedule.edit2';
  const assignmentUrl = (taskUserKey) => `${BASE}?aid=projects.production.assignment&k=${taskUserKey}`;
  const taskUrl = (projectKey, taskKey) => `${BASE}?aid=projects.schedule.edit2&k=${projectKey}#task=${taskKey}`;

  const state = { projectKey: null, map: null, loading: null, hoverKey: null, hoverRow: null };

  // ---------- data ----------
  // Same server call the schedule page itself makes; rt is the per-session request token.
  async function loadSchedule(projectKey) {
    const rt = (window.System && window.System.user && window.System.user.rt) || '';
    const p = new URLSearchParams();
    p.set('tranID', String(Date.now()));
    p.set('c', 'Modules.Projects.Schedule');
    p.set('m', 'getSchedule');
    p.set('rt', rt);
    p.set('params', JSON.stringify({
      projectKey: Number(projectKey), searchKeys: null, includeTransactions: false,
      loadBucketDetail: false, application: 'wjl getSchedule', performRecalc: false,
      fromNotification: false, origData: null
    }));
    const r = await fetch(BASE + 'data.aspx?Modules.Projects.Schedule.getSchedule', { method: 'POST', body: p, credentials: 'same-origin' });
    const j = await r.json();
    const rows = (j.data && j.data.projectTaskUserData) || [];
    const map = new Map();
    for (const tu of rows) {
      if (!map.has(tu.TaskKey)) map.set(tu.TaskKey, []);
      map.get(tu.TaskKey).push({
        taskUserKey: tu.TaskUserKey,
        user: (tu.UserName || '').trim() || '(unassigned slot)',
        status: [tu.ServiceDescription, tu.StatusName].filter(Boolean).join(' · ')
      });
    }
    return map;
  }

  function ensureData() {
    const k = qs().get('k');
    if (!k) return;
    if (state.projectKey === k && (state.map || state.loading)) return;
    state.projectKey = k; state.map = null;
    state.loading = loadSchedule(k)
      .then(m => { state.map = m; state.loading = null; })
      .catch(e => { state.loading = null; console.warn('[wjl] getSchedule failed', e); });
  }

  // ---------- UI (overlay only; never modifies the grid's own DOM) ----------
  let btn, menu, toastEl;

  function ensureUi() {
    if (btn) return;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'wjl-btn';
    btn.title = 'Copy link to this task / assignment';
    btn.textContent = '🔗';
    btn.style.cssText = 'position:fixed;z-index:99998;display:none;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;line-height:1;padding:2px 4px;box-shadow:0 1px 3px rgba(0,0,0,.15)';
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openMenu(); });
    btn.addEventListener('mouseenter', () => { btn.dataset.hover = '1'; });
    btn.addEventListener('mouseleave', () => { delete btn.dataset.hover; scheduleHide(); });
    document.body.appendChild(btn);
  }

  let hideTimer;
  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!btn.dataset.hover && !menu) btn.style.display = 'none'; }, 350);
  }

  function showFor(row) {
    ensureUi();
    const cell = row.querySelector('grid-cell[data-idx="0"]') || row;
    const r = cell.getBoundingClientRect();
    if (!r.width) return;
    state.hoverKey = row.getAttribute('data-key');
    state.hoverRow = row;
    btn.style.left = (r.right - 26) + 'px';
    btn.style.top = (r.top + Math.max(0, (r.height - 20) / 2)) + 'px';
    btn.style.display = 'block';
    clearTimeout(hideTimer);
  }

  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:8px 14px;border-radius:6px;font:13px/1.4 sans-serif;z-index:99999;opacity:0;transition:opacity .2s;pointer-events:none;max-width:80vw;white-space:pre-wrap';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => (toastEl.style.opacity = '0'), 1800);
  }

  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); toast('Copied ' + label); }
    catch (e) { window.prompt('Copy this link:', text); }
  }

  function closeMenu() { if (menu) { menu.remove(); menu = null; } scheduleHide(); }

  function openMenu() {
    if (menu) { closeMenu(); return; }
    const taskKey = state.hoverKey;
    const projectKey = state.projectKey || qs().get('k');
    const name = (state.hoverRow?.querySelector('grid-cell[data-idx="0"] span')?.textContent || '').trim();
    const assignees = (state.map && state.map.get(Number(taskKey))) || [];

    menu = document.createElement('div');
    menu.id = 'wjl-menu';
    menu.style.cssText = 'position:fixed;z-index:99999;background:#fff;color:#222;border:1px solid #ccc;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.18);min-width:280px;font:13px/1.4 sans-serif;padding:4px 0';
    const r = btn.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 320) + 'px';
    menu.style.top = (r.bottom + 4) + 'px';
    menu.addEventListener('mousedown', e => e.stopPropagation());

    const item = (label, sub, onClick) => {
      const d = document.createElement('div');
      d.style.cssText = 'padding:6px 12px;cursor:pointer;white-space:nowrap';
      d.innerHTML = `<div>${label}</div>${sub ? `<div style="font-size:11px;color:#777">${sub}</div>` : ''}`;
      d.addEventListener('mouseenter', () => (d.style.background = '#f2f2f2'));
      d.addEventListener('mouseleave', () => (d.style.background = ''));
      d.addEventListener('click', ev => { ev.stopPropagation(); onClick(); closeMenu(); });
      menu.appendChild(d);
    };
    const header = document.createElement('div');
    header.style.cssText = 'padding:4px 12px 6px;font-weight:600;border-bottom:1px solid #eee;margin-bottom:4px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    header.textContent = name || 'Task ' + taskKey;
    menu.appendChild(header);

    item('Copy task link', 'opens the schedule and highlights this row (needs this script)', () => copy(taskUrl(projectKey, taskKey), 'task link'));
    if (!state.map) item('<i>Loading assignments…</i>', '', () => {});
    else if (!assignees.length) item('<i>No assignment slots on this task</i>', 'add an assignment to get an assignment URL', () => {});
    assignees.forEach(a => item(`Copy assignment link · ${a.user}`, a.status, () => copy(assignmentUrl(a.taskUserKey), 'assignment link for ' + a.user)));
    if (assignees.length > 1) item('Copy all assignment links', 'one per line, with names', () =>
      copy(assignees.map(a => `${name} — ${a.user}: ${assignmentUrl(a.taskUserKey)}`).join('\n'), 'all links'));

    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('mousedown', closeMenu, { once: true }), 0);
  }

  // ---------- deep link ----------
  function handlePendingTask() {
    let tk = null;
    try { tk = sessionStorage.getItem(SS_KEY); } catch (e) {}
    if (!tk) return;
    let tries = 0;
    const t = setInterval(() => {
      const row = document.querySelector(`grid-row[data-key="${tk}"]`);
      if (row) {
        clearInterval(t);
        try { sessionStorage.removeItem(SS_KEY); } catch (e) {}
        row.scrollIntoView({ block: 'center' });
        const cells = row.querySelector('grid-cells') || row;
        cells.style.transition = 'box-shadow .3s';
        cells.style.boxShadow = 'inset 0 0 0 2px #f5a623';
        setTimeout(() => (cells.style.boxShadow = ''), 5000);
        toast('Task highlighted');
      } else if (++tries > 60) { clearInterval(t); try { sessionStorage.removeItem(SS_KEY); } catch (e) {} }
    }, 250);
  }

  // ---------- wiring ----------
  function onOver(e) {
    if (!isSchedulePage()) return;
    const row = e.target.closest && e.target.closest('grid-row[data-key]');
    if (row) showFor(row);
    else if (btn && !e.target.closest('#wjl-btn,#wjl-menu')) scheduleHide();
  }

  let lastHref = '';
  function tick() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      if (menu) closeMenu();
      if (btn) btn.style.display = 'none';
      if (isSchedulePage()) { ensureData(); handlePendingTask(); }
    }
  }

  function start() {
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('scroll', () => { if (btn && !menu) btn.style.display = 'none'; }, true);
    setInterval(tick, 500);
    tick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
