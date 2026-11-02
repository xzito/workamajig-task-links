// ==UserScript==
// @name         Workamajig Task Links
// @namespace    https://xzito.com/
// @version      0.5.0
// @description  Hover a task row anywhere in Workamajig Platinum (project Schedule, My Tasks, My Time) to copy a task deep link, the project link, or the assignment URL for each assignee slot. Also widens the Assignment page, shows hours logged vs planned, and flags a missing task description.
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
  const aid = () => qs().get('aid') || '';
  const urls = {
    project: (pk) => `${BASE}?aid=dashboards.project.dash&k=${pk}`,
    schedule: (pk) => `${BASE}?aid=projects.schedule.edit2&k=${pk}`,
    task: (pk, tk) => `${BASE}?aid=projects.schedule.edit2&k=${pk}#task=${tk}`,
    assignment: (tuk) => `${BASE}?aid=projects.production.assignment&k=${tuk}`
  };

  // ---------- server calls (same endpoints the app uses; rt is the session request token) ----------
  async function call(cls, method, params) {
    const rt = (window.System && window.System.user && window.System.user.rt) || '';
    const p = new URLSearchParams();
    p.set('tranID', String(Date.now()));
    p.set('c', cls); p.set('m', method); p.set('rt', rt);
    p.set('params', JSON.stringify(params));
    const r = await fetch(`${BASE}data.aspx?${cls}.${method}`, { method: 'POST', body: p, credentials: 'same-origin' });
    const j = await r.json();
    return j.data || {};
  }

  // projectKey -> { tasks: Map<TaskKey,{id,name}>, slots: Map<TaskKey,[slot]>, byTuk: Map<TaskUserKey,TaskKey> }
  const scheduleCache = new Map();
  function getSchedule(projectKey) {
    projectKey = String(projectKey);
    if (!scheduleCache.has(projectKey)) {
      scheduleCache.set(projectKey, call('Modules.Projects.Schedule', 'getSchedule', {
        projectKey: Number(projectKey), searchKeys: null, includeTransactions: false, loadBucketDetail: false,
        application: 'wjl getSchedule', performRecalc: false, fromNotification: false, origData: null
      }).then(d => {
        const tasks = new Map(), slots = new Map(), byTuk = new Map();
        for (const t of d.tasks || []) tasks.set(t.TaskKey, { id: t.TaskID, name: t.TaskName, actualHours: +t.ActualHours || 0, plannedHours: +t.AllocatedHours || 0 });
        for (const tu of d.projectTaskUserData || []) {
          if (!slots.has(tu.TaskKey)) slots.set(tu.TaskKey, []);
          slots.get(tu.TaskKey).push({
            taskUserKey: tu.TaskUserKey, userKey: tu.UserKey,
            user: (tu.UserName || '').trim() || '(unassigned slot)',
            status: [tu.ServiceDescription, tu.StatusName].filter(Boolean).join(' · ')
          });
          byTuk.set(tu.TaskUserKey, tu.TaskKey);
        }
        return { tasks, slots, byTuk };
      }).catch(e => { scheduleCache.delete(projectKey); throw e; }));
    }
    return scheduleCache.get(projectKey);
  }

  // My Time: TimeKey (GUID) -> {projectKey, taskKey, userKey}. Loaded per work date.
  const timeCache = new Map();
  function getTime(workDate) {
    const k = workDate || 'today';
    if (!timeCache.has(k)) {
      timeCache.set(k, call('WJAPP.Modules.User.Today', 'loadTime', workDate ? { workDate } : {})
        .then(d => new Map((d.table || []).map(t => [t.TimeKey, { projectKey: t.ProjectKey, taskKey: t.TaskKey, userKey: t.UserKey }])))
        .catch(e => { timeCache.delete(k); throw e; }));
    }
    return timeCache.get(k);
  }

  function pageDate() {
    // "Friday, October 30, 2026" in the My Time header
    const m = /([A-Z][a-z]+day),\s+([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/.exec(document.body.innerText || '');
    if (!m) return null;
    const d = new Date(`${m[2]} ${m[3]}, ${m[4]}`);
    return isNaN(d) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00:00`;
  }

  // Assignment key -> { projectKey, taskKey, userKey } (used by card/tile views anywhere in the app)
  const assignmentCache = new Map();
  function getAssignment(taskUserKey) {
    taskUserKey = Number(taskUserKey);
    if (!assignmentCache.has(taskUserKey)) {
      assignmentCache.set(taskUserKey, call('Modules.Projects.Production', 'loadAssignment', { TaskUserKey: taskUserKey })
        .then(d => {
          const t = (d.table || [])[0];
          if (!t) return { taskUserKey };
          const rights = (d.init && d.init.rights) || {};
          return {
            projectKey: t.ProjectKey, taskKey: t.TaskKey, taskUserKey, userKey: t.UserKey, user: t.UserFullName,
            actualHours: +t.ActualHours || 0, plannedHours: +t.Hours || 0,
            taskDescription: (t.TaskDescription || '').replace(/<[^>]*>/g, '').trim(),
            canEditTasks: !!rights.prjedittasks
          };
        })
        .catch(e => { assignmentCache.delete(taskUserKey); throw e; }));
    }
    return assignmentCache.get(taskUserKey);
  }

  // Any element the app itself navigates from: <li data-target="<screen id>" data-key="<key>"> (Today cards, lists, etc.)
  async function resolveTarget(el) {
    const target = el.getAttribute('data-target'), key = el.getAttribute('data-key');
    if (target === 'projects.production.assignment' && /^\d+$/.test(key)) return getAssignment(key);
    if (target === 'dashboards.project.dash' || target === 'projects.schedule.edit2') return { projectKey: key };
    return { generic: `${BASE}?aid=${target}&k=${encodeURIComponent(key)}`, label: target };
  }

  // ---------- page adapters: grid row -> { projectKey, taskKey?, taskUserKey?, userKey? } ----------
  const adapters = {
    'projects.schedule.edit2': async (row) => ({ projectKey: qs().get('k'), taskKey: Number(row.dataset.key) }),

    'today.creative': async (row) => {
      if (!/^\d+$/.test(row.dataset.key)) return null; // group rows are PK<ProjectKey>
      const taskUserKey = Number(row.dataset.key);
      let g = row.previousElementSibling, projectKey = null;
      while (g) {
        const k = g.getAttribute('data-group-key') || g.getAttribute('data-key') || '';
        if (/^PK\d+$/.test(k)) { projectKey = k.slice(2); break; }
        g = g.previousElementSibling;
      }
      if (!projectKey) return { taskUserKey };
      const s = await getSchedule(projectKey);
      return { projectKey, taskUserKey, taskKey: s.byTuk.get(taskUserKey) || null };
    },

    'user.timeEntry.edit': async (row) => {
      if (!/^[0-9a-f-]{36}$/i.test(row.dataset.key)) return null;
      const wd = pageDate();
      let hit = (await getTime(wd)).get(row.dataset.key);
      if (!hit && wd) hit = (await getTime(null)).get(row.dataset.key);
      return hit || null;
    }
  };

  // ---------- UI (overlay only; never modifies the grid's own DOM) ----------
  let btn, menu, toastEl, hideTimer;
  const state = { hoverRow: null };

  function ensureUi() {
    if (btn) return;
    btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'wjl-btn'; btn.title = 'Copy link to this task / assignment'; btn.textContent = '🔗';
    btn.style.cssText = 'position:fixed;z-index:99998;display:none;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;line-height:1;padding:2px 4px;box-shadow:0 1px 3px rgba(0,0,0,.15)';
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openMenu(); });
    btn.addEventListener('mouseenter', () => { btn.dataset.hover = '1'; });
    btn.addEventListener('mouseleave', () => { delete btn.dataset.hover; scheduleHide(); });
    document.body.appendChild(btn);
  }
  function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (btn && !btn.dataset.hover && !menu) btn.style.display = 'none'; }, 350); }
  function showFor(row) {
    ensureUi();
    const cell = (row.tagName === 'GRID-ROW' && row.querySelector('grid-cell[data-idx="0"]')) || row;
    const r = cell.getBoundingClientRect();
    if (!r.width) return;
    state.hoverRow = row;
    btn.style.left = (r.right - 26) + 'px';
    btn.style.top = (row.tagName === 'GRID-ROW' ? r.top + Math.max(0, (r.height - 20) / 2) : r.top + 4) + 'px';
    btn.style.display = 'block';
    clearTimeout(hideTimer);
  }
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div'); toastEl.id = 'wjl-toast';
      toastEl.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:8px 14px;border-radius:6px;font:13px/1.4 sans-serif;z-index:99999;opacity:0;transition:opacity .2s;pointer-events:none;max-width:80vw;white-space:pre-wrap';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg; toastEl.style.opacity = '1';
    clearTimeout(toastEl._t); toastEl._t = setTimeout(() => (toastEl.style.opacity = '0'), 1800);
  }
  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); toast('Copied ' + label); }
    catch (e) { window.prompt('Copy this link:', text); }
  }
  function closeMenu() { if (menu) { menu.remove(); menu = null; } scheduleHide(); }

  function rowName(row) {
    const c = row.querySelector('grid-cell[data-idx="0"], .ac-subphase, header, h1, h2, h3');
    return (c ? c.textContent : row.textContent).replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  async function openMenu() {
    if (menu) { closeMenu(); return; }
    const row = state.hoverRow;
    const adapter = row && (row.tagName === 'GRID-ROW' ? adapters[aid()] : resolveTarget);
    if (!row || !adapter) return;

    menu = document.createElement('div'); menu.id = 'wjl-menu';
    menu.style.cssText = 'position:fixed;z-index:99999;background:#fff;color:#222;border:1px solid #ccc;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.18);min-width:280px;font:13px/1.4 sans-serif;padding:4px 0';
    const r = btn.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 340) + 'px';
    menu.style.top = (r.bottom + 4) + 'px';
    menu.addEventListener('mousedown', e => e.stopPropagation());
    const header = document.createElement('div');
    header.style.cssText = 'padding:4px 12px 6px;font-weight:600;border-bottom:1px solid #eee;margin-bottom:4px;max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    header.textContent = rowName(row);
    menu.appendChild(header);
    const body = document.createElement('div'); menu.appendChild(body);
    const item = (label, sub, onClick) => {
      const d = document.createElement('div');
      d.style.cssText = 'padding:6px 12px;cursor:' + (onClick ? 'pointer' : 'default') + ';white-space:nowrap';
      d.innerHTML = `<div>${label}</div>${sub ? `<div style="font-size:11px;color:#777">${sub}</div>` : ''}`;
      if (onClick) {
        d.addEventListener('mouseenter', () => (d.style.background = '#f2f2f2'));
        d.addEventListener('mouseleave', () => (d.style.background = ''));
        d.addEventListener('click', ev => { ev.stopPropagation(); onClick(); closeMenu(); });
      }
      body.appendChild(d);
    };
    item('<i>Loading…</i>');
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('mousedown', closeMenu, { once: true }), 0);

    let ref = null, sched = null;
    try {
      ref = await adapter(row);
      if (ref && ref.projectKey) sched = await getSchedule(ref.projectKey);
    } catch (e) { console.warn('[wjl]', e); }
    if (!menu) return;
    body.innerHTML = '';
    if (!ref) { item('<i>No task on this row</i>'); return; }
    if (ref.generic) { item('Copy link', ref.label, () => copy(ref.generic, 'link')); return; }

    const t = ref.taskKey && sched && sched.tasks.get(ref.taskKey);
    const taskLabel = t ? `${t.id} - ${t.name}` : rowName(row);
    if (ref.projectKey && ref.taskKey) item('Copy task link', 'opens the schedule and highlights this task (needs this script)', () => copy(urls.task(ref.projectKey, ref.taskKey), 'task link'));
    if (ref.projectKey) item('Copy project link', 'project dashboard', () => copy(urls.project(ref.projectKey), 'project link'));

    let slots = (ref.taskKey && sched && sched.slots.get(ref.taskKey)) || [];
    if (!slots.length && ref.taskUserKey) slots = [{ taskUserKey: ref.taskUserKey, user: 'this assignment', status: '' }];
    const mine = ref.userKey ? slots.filter(s => s.userKey === ref.userKey) : [];
    const ordered = mine.concat(slots.filter(s => !mine.includes(s)));
    if (!ordered.length) item('<i>No assignment slots on this task</i>', 'add an assignment to get an assignment URL');
    ordered.forEach(s => item(`Copy assignment link · ${s.user}`, s.status, () => copy(urls.assignment(s.taskUserKey), 'assignment link for ' + s.user)));
    if (ordered.length > 1) item('Copy all assignment links', 'one per line, with names', () =>
      copy(ordered.map(s => `${taskLabel} — ${s.user}: ${urls.assignment(s.taskUserKey)}`).join('\n'), 'all links'));
  }

  // ---------- deep link: #task=<TaskKey> on the schedule page ----------
  function handlePendingTask() {
    let tk = null; try { tk = sessionStorage.getItem(SS_KEY); } catch (e) {}
    if (!tk || aid() !== 'projects.schedule.edit2') return;
    let tries = 0;
    const t = setInterval(() => {
      const row = document.querySelector(`grid-row[data-key="${tk}"]`);
      if (row) {
        clearInterval(t); try { sessionStorage.removeItem(SS_KEY); } catch (e) {}
        row.scrollIntoView({ block: 'center' });
        const cells = row.querySelector('grid-cells') || row;
        cells.style.transition = 'box-shadow .3s'; cells.style.boxShadow = 'inset 0 0 0 2px #f5a623';
        setTimeout(() => (cells.style.boxShadow = ''), 5000);
        toast('Task highlighted');
      } else if (++tries > 60) { clearInterval(t); try { sessionStorage.removeItem(SS_KEY); } catch (e) {} }
    }, 250);
  }

  // ---------- wiring ----------
  function onOver(e) {
    if (!e.target.closest) return;
    const row = adapters[aid()] && e.target.closest('grid-row[data-key]');
    const card = !row && e.target.closest('[data-target*="."][data-key]');
    if (row && row.classList.contains('datarow')) showFor(row);
    else if (card) showFor(card);
    else if (btn && !e.target.closest('#wjl-btn,#wjl-menu')) scheduleHide();
  }
  // ---------- Assignment page: full width + hours logged ----------
  const ASSIGN_AID = 'projects.production.assignment';
  let wideStyle;
  function assignmentPage() {
    const on = aid() === ASSIGN_AID;
    if (!wideStyle) {
      wideStyle = document.createElement('style');
      wideStyle.id = 'wjl-wide';
      // Same width the app gives non-"wide" pages, and let the task title wrap instead of truncating.
      wideStyle.textContent = '#desktop > section > page.wide{width:calc(100vw - var(--sn-w,232px) - var(--sn-gap) * 2) !important}' +
        '#desktop > section > page.wide h1{max-width:none !important;white-space:normal !important}';
    }
    if (on && !wideStyle.isConnected) document.head.appendChild(wideStyle);
    if (!on && wideStyle.isConnected) wideStyle.remove();
    if (!on) return;

    const key = qs().get('k');
    const due = document.querySelector('page.open div.pad-b-l > h2');
    if (!key || !due || due.parentElement.querySelector('#wjl-hours')) return;
    const box = document.createElement('div');
    box.id = 'wjl-hours';
    box.style.cssText = 'margin:2px 0 8px;font-size:13px;line-height:1.5;color:#555';
    box.textContent = 'Loading hours…';
    due.insertAdjacentElement('afterend', box);
    const fmt = h => (Math.round(h * 100) / 100) + ' h';
    getAssignment(key).then(async a => {
      if (!a.taskKey) { box.remove(); return; }
      const lines = [];
      try {
        const t = (await getSchedule(a.projectKey)).tasks.get(a.taskKey) || {};
        lines.push(`Task: ${fmt(t.actualHours || 0)} logged` + (t.plannedHours ? ` of ${fmt(t.plannedHours)} planned` : ''));
      } catch (e) { /* schedule not readable for this user */ }
      lines.push(`This assignment${a.user ? ' (' + a.user + ')' : ''}: ${fmt(a.actualHours)} logged` + (a.plannedHours ? ` of ${fmt(a.plannedHours)} planned` : ''));
      box.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
    }).catch(() => box.remove());
    getAssignment(key).then(a => { if (a.taskKey) missingDescription(a); }).catch(() => {});
  }

  // "Description of Work" tab: say so when the task has no description, and offer the next step.
  function missingDescription(a) {
    if (a.taskDescription) return;
    const sec = document.querySelector('page.open [data-bind-visible="dp@section == \'desc\'"]');
    if (!sec || sec.querySelector('#wjl-nodesc')) return;
    const anchor = sec.querySelector('div.pad-t-l') || sec.firstElementChild;
    const box = document.createElement('div');
    box.id = 'wjl-nodesc';
    box.style.cssText = 'margin:0 0 18px;padding:12px 14px;border:1px solid #f0c36d;border-left-width:4px;border-radius:6px;background:#fff8e5;color:#5a4500;font-size:13px;line-height:1.5';
    const btnCss = 'margin:8px 8px 0 0;padding:5px 10px;border:1px solid #c9a24a;border-radius:4px;background:#fff;color:#5a4500;cursor:pointer;font:inherit;font-size:12px';
    box.innerHTML = '<div><b>This task has no description.</b> Nobody has written down what this assignment is supposed to deliver.</div>';
    const ask = document.createElement('button');
    ask.type = 'button'; ask.style.cssText = btnCss;
    ask.textContent = 'Request details in a conversation';
    ask.title = 'Opens the Conversations tab and starts a new post';
    ask.addEventListener('click', () => {
      const tab = document.querySelector('page.open button[data-action="clickTab"][data-key="conv"]');
      if (tab) tab.click();
      let n = 0;
      const t = setInterval(() => {
        const b = document.querySelector('page.open button[data-action="newPost"]');
        if (b && b.offsetParent) { clearInterval(t); b.click(); }
        else if (++n > 20) clearInterval(t);
      }, 150);
    });
    box.appendChild(ask);
    if (a.canEditTasks) {
      const edit = document.createElement('button');
      edit.type = 'button'; edit.style.cssText = btnCss;
      edit.textContent = 'Add a description in the Schedule';
      edit.title = 'Opens the project schedule with this task highlighted; use the Description column there';
      edit.addEventListener('click', () => { location.assign(urls.task(a.projectKey, a.taskKey)); });
      box.appendChild(edit);
    }
    anchor ? anchor.insertAdjacentElement('beforebegin', box) : sec.appendChild(box);
  }

  let lastHref = '';
  function tick() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      if (menu) closeMenu();
      if (btn) btn.style.display = 'none';
      handlePendingTask();
    }
    assignmentPage();
  }
  function start() {
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('scroll', () => { if (btn && !menu) btn.style.display = 'none'; }, true);
    setInterval(tick, 500);
    tick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
