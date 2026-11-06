// ==UserScript==
// @name         Workamajig Task Links
// @namespace    https://xzito.com/
// @version      0.7.3
// @description  Hover a task row anywhere in Workamajig Platinum (project Schedule, My Tasks, My Time) to copy a task deep link, the project link, or the assignment URL for each assignee slot. Also widens the Assignment page, shows hours logged vs planned, and flags a missing task description (with an inline editor for users who can edit tasks).
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
  const SS_POST = 'wjl.pendingPost';
  const VERSION = '0.7.3';
  window.WJL_VERSION = VERSION;
  try { console.info('[wjl] Workamajig Task Links v' + VERSION); } catch (e) {}

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
  async function call(cls, method, params, raw) {
    const rt = (window.System && window.System.user && window.System.user.rt) || '';
    const p = new URLSearchParams();
    p.set('tranID', String(Date.now()));
    p.set('c', cls); p.set('m', method); p.set('rt', rt);
    p.set('params', JSON.stringify(params));
    const r = await fetch(`${BASE}data.aspx?${cls}.${method}`, { method: 'POST', body: p, credentials: 'same-origin' });
    const j = await r.json();
    return raw ? j : (j.data || {});
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
        const users = (d.users || []).map(u => ({ UserKey: u.UserKey, UserName: (u.UserName || '').trim(), Email: u.Email || '', ClientVendorLogin: +u.ClientVendorLogin || 0 }));
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
        return { tasks, slots, byTuk, users };
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
            taskName: t.DetailTaskName || t.FullTaskName || '', projectName: t.FullProjectName || t.ProjectName || '',
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
    btn.style.top = (r.top + Math.min(4, Math.max(0, (r.height - 20) / 2))) + 'px';
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
    const foot = document.createElement('div'); foot.style.cssText = 'padding:4px 12px 2px;font-size:10px;color:#aaa;text-align:right'; foot.textContent = 'Task Links v' + VERSION;
    setTimeout(() => menu && menu.appendChild(foot), 0);
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
    if (ref.projectKey && aid() !== 'projects.schedule.edit2') item('Copy project link', 'project dashboard', () => copy(urls.project(ref.projectKey), 'project link'));

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
  // Dim everything except the row (four panes around it, like a modal backdrop) and outline it; fades on interaction or after 4 s.
  // Dim everything except the row (four panes around it, like a modal backdrop) and outline it.
  // Panes follow the row every frame, so late layout shifts or app scrolling on a fresh load don't misplace them.
  // Ends on the user's own input (wheel, click, key, touch) or after 5 s; programmatic scrolls don't end it.
  function spotlight(row) {
    const mk = css => { const d = document.createElement('div'); d.className = 'wjl-spot'; d.style.cssText = 'position:fixed;z-index:99990;pointer-events:none;transition:opacity .4s;opacity:0;' + css; document.body.appendChild(d); return d; };
    const dim = 'background:rgba(0,0,0,.38);';
    const [pTop, pBottom, pLeft, pRight, ring] = [
      mk(dim), mk(dim), mk(dim), mk(dim),
      mk('border-radius:3px;box-shadow:0 0 0 2px #f5a623,0 0 0 6px rgba(245,166,35,.35)')
    ];
    const els = [pTop, pBottom, pLeft, pRight, ring];
    const place = () => {
      const el = row.isConnected ? row : document.querySelector(`grid-row.datarow[data-key="${row.getAttribute('data-key')}"]`);
      if (el && el !== row) row = el;
      const r = row.getBoundingClientRect();
      if (!r.width) return false;
      const pad = 2, top = r.top - pad, bottom = r.bottom + pad, left = r.left - pad, right = r.right + pad, h = bottom - top;
      Object.assign(pTop.style, { left: '0', top: '0', width: '100vw', height: Math.max(0, top) + 'px' });
      Object.assign(pBottom.style, { left: '0', top: bottom + 'px', width: '100vw', height: Math.max(0, innerHeight - bottom) + 'px' });
      Object.assign(pLeft.style, { left: '0', top: top + 'px', width: Math.max(0, left) + 'px', height: h + 'px' });
      Object.assign(pRight.style, { left: right + 'px', top: top + 'px', width: Math.max(0, innerWidth - right) + 'px', height: h + 'px' });
      Object.assign(ring.style, { left: left + 'px', top: top + 'px', width: (right - left) + 'px', height: h + 'px' });
      return true;
    };
    let done = false, raf = 0;
    const loop = () => { if (done) return; place(); raf = requestAnimationFrame(loop); };
    loop();
    requestAnimationFrame(() => els.forEach(e => (e.style.opacity = '1')));
    const evs = ['wheel', 'mousedown', 'keydown', 'touchstart'];
    const end = () => {
      if (done) return; done = true; cancelAnimationFrame(raf);
      evs.forEach(t => document.removeEventListener(t, end, true));
      els.forEach(e => (e.style.opacity = '0'));
      setTimeout(() => els.forEach(e => e.remove()), 450);
    };
    setTimeout(() => evs.forEach(t => document.addEventListener(t, end, true)), 300);
    setTimeout(end, 5000);
  }


  function handlePendingTask() {
    let tk = null; try { tk = sessionStorage.getItem(SS_KEY); } catch (e) {}
    if (!tk || aid() !== 'projects.schedule.edit2') return;
    let tries = 0;
    const t = setInterval(() => {
      const row = document.querySelector(`grid-row[data-key="${tk}"]`);
      if (row) {
        clearInterval(t); try { sessionStorage.removeItem(SS_KEY); } catch (e) {}
        row.scrollIntoView({ block: 'center' });
        setTimeout(() => spotlight(row), 400);
        // The app can still shift or reset scroll while it finishes loading; re-center if the row drifted out of view.
        [800, 1600].forEach(ms => setTimeout(() => {
          const el = document.querySelector(`grid-row.datarow[data-key="${tk}"]`);
          if (!el) return;
          const r = el.getBoundingClientRect();
          if (r.top < 80 || r.bottom > innerHeight - 40) el.scrollIntoView({ block: 'center' });
        }, ms));
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
      // Full width; header row grows with a long title; title wraps at a smaller size instead of truncating.
      wideStyle.textContent = '#desktop > section > page.wide{width:calc(100vw - var(--sn-w,232px) - var(--sn-gap) * 2) !important;grid-template-rows:minmax(90px,auto) 1fr !important}' +
        '#desktop > section > page.wide > header{min-height:90px;padding-bottom:6px}' +
        '#desktop > section > page.wide > header hgroup{min-width:0;flex:1 1 auto}' +
        '#desktop > section > page.wide > header h1{max-width:none !important;white-space:normal !important;font-size:2.4rem !important;line-height:1.2 !important;margin-top:0 !important;overflow:visible !important}' +
        '#desktop > section > page.wide > header h5{white-space:normal !important;overflow:visible !important}' +
        '#wjl-hours{border-collapse:collapse;margin:2px 0 10px;font-size:12px;color:#555}' +
        '#wjl-hours th{font-weight:400;color:#999;text-align:right;padding:0 0 2px 14px}' +
        '#wjl-hours th:first-child{text-align:left;padding-left:0}' +
        '#wjl-hours td{padding:1px 0 1px 14px;text-align:right;white-space:nowrap}' +
        '#wjl-hours td:first-child{text-align:left;padding-left:0;color:#333}';
    }
    if (on && !wideStyle.isConnected) document.head.appendChild(wideStyle);
    if (!on && wideStyle.isConnected) wideStyle.remove();
    if (!on) return;

    const key = qs().get('k');
    const due = document.querySelector('page.open div.pad-b-l > h2');
    if (!key || !due || due.parentElement.querySelector('#wjl-hours')) return;
    const box = document.createElement('table');
    box.id = 'wjl-hours';
    box.innerHTML = '<tr><td style="color:#999">Loading hours…</td></tr>';
    due.insertAdjacentElement('afterend', box);
    const fmt = h => String(Math.round((h || 0) * 100) / 100);
    const cell = (tag, txt) => { const c = document.createElement(tag); c.textContent = txt; return c; };
    const row = (cells, tag) => { const r = document.createElement('tr'); cells.forEach(c => r.appendChild(cell(tag || 'td', c))); return r; };
    getAssignment(key).then(async a => {
      if (!a.taskKey) { box.remove(); return; }
      const rows = [row(['Hours', 'Logged', 'Planned', 'Left'], 'th')];
      try {
        const t = (await getSchedule(a.projectKey)).tasks.get(a.taskKey);
        if (t) rows.push(row(['Whole task', fmt(t.actualHours), fmt(t.plannedHours), fmt(t.plannedHours - t.actualHours)]));
      } catch (e) { /* schedule not readable for this user */ }
      rows.push(row([(a.user || 'This assignment').split(' ')[0], fmt(a.actualHours), fmt(a.plannedHours), fmt(a.plannedHours - a.actualHours)]));
      box.innerHTML = '';
      rows.forEach(r => box.appendChild(r));
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
    ask.addEventListener('click', async () => {
      ask.disabled = true; ask.textContent = 'Opening a new post…';
      let pm = null;
      try { pm = await resolveProjectManager(a.projectKey); } catch (e) { /* no PM, keep the default recipients */ }
      const req = { taskKey: a.taskKey, projectKey: a.projectKey, taskName: a.taskName, projectName: a.projectName,
        taskUrl: urls.task(a.projectKey, a.taskKey), assignmentUrl: urls.assignment(a.taskUserKey), pm, ts: Date.now() };
      try { sessionStorage.setItem(SS_POST, JSON.stringify(req)); } catch (e) {}
      // Same screen the native "new conversation" button opens, pre-linked to this task.
      location.assign(`${BASE}?aid=projects.diary.add&k=${a.projectKey}&io=${encodeURIComponent(JSON.stringify({ taskKey: a.taskKey }))}`);
    });
    box.appendChild(ask);
    if (a.canEditTasks) {
      const edit = document.createElement('button');
      edit.type = 'button'; edit.style.cssText = btnCss;
      edit.textContent = 'Add a description';
      edit.addEventListener('click', () => { edit.style.display = 'none'; openEditor(); });
      box.appendChild(edit);
    }
    anchor ? anchor.insertAdjacentElement('beforebegin', box) : sec.appendChild(box);

    function openEditor() {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-top:10px';
      const ta = document.createElement('textarea');
      ta.rows = 5;
      ta.placeholder = 'What is this task supposed to deliver? Scope, inputs, done criteria, links…';
      ta.style.cssText = 'display:block;width:100%;box-sizing:border-box;padding:8px;border:1px solid #c9a24a;border-radius:4px;font:inherit;font-size:13px;resize:vertical';
      const save = document.createElement('button');
      save.type = 'button'; save.style.cssText = btnCss + ';background:#5a4500;color:#fff';
      save.textContent = 'Save description';
      const cancel = document.createElement('button');
      cancel.type = 'button'; cancel.style.cssText = btnCss;
      cancel.textContent = 'Cancel';
      const sched = document.createElement('a');
      sched.href = urls.task(a.projectKey, a.taskKey);
      sched.textContent = 'or edit it in the Schedule';
      sched.style.cssText = 'font-size:12px;color:#5a4500;margin-left:4px';
      const msg = document.createElement('div');
      msg.style.cssText = 'font-size:12px;margin-top:6px';
      wrap.append(ta, save, cancel, sched, msg);
      box.appendChild(wrap);
      ta.focus();
      cancel.addEventListener('click', () => { wrap.remove(); box.querySelectorAll('button').forEach(b => (b.style.display = '')); });
      save.addEventListener('click', async () => {
        const text = ta.value.trim();
        if (!text) { msg.textContent = 'Type a description first.'; return; }
        save.disabled = cancel.disabled = true; msg.textContent = 'Saving…';
        try {
          await saveTaskDescription(a.projectKey, a.taskKey, text);
          box.remove();
          showDescription(sec, text);
          assignmentCache.delete(Number(a.taskUserKey));
          toast('Description saved');
        } catch (e) {
          save.disabled = cancel.disabled = false;
          msg.textContent = 'Could not save: ' + (e && e.message || e) + '. You can still add it in the Schedule.';
        }
      });
    }
  }

  function showDescription(sec, text) {
    const d = document.createElement('div');
    d.className = 'pad-section';
    d.id = 'wjl-desc';
    const h = document.createElement('h2'); h.textContent = 'Task Description';
    const body = document.createElement('div'); body.style.whiteSpace = 'pre-wrap'; body.textContent = text;
    d.append(h, body);
    sec.insertAdjacentElement('afterbegin', d);
  }

  // Writes a task description the same way the Schedule page does: a fresh copy of the task row
  // (from getSchedule) with only Description changed, inside the schedule's save envelope.
  // Verified Nov 2026: identical side effects to the native save (DateUpdated bumps on all tasks, nothing else).
  async function saveTaskDescription(projectKey, taskKey, text) {
    projectKey = Number(projectKey); taskKey = Number(taskKey);
    const init = await call('Modules.Projects.Schedule', 'initSchedule', { loaded: true, ProjectKey: projectKey });
    const project = init.project;
    if (!project || !project.ProjectKey) throw new Error('could not load the project');
    if (project.ScheduleLockedByKey) throw new Error('the schedule is currently locked for editing');
    const sched = await call('Modules.Projects.Schedule', 'getSchedule', {
      projectKey, searchKeys: null, includeTransactions: false, loadBucketDetail: false,
      application: 'wjl saveDescription', performRecalc: false, fromNotification: false, origData: null
    });
    const row = (sched.tasks || []).find(t => t.TaskKey === taskKey);
    if (!row) throw new Error('task not found in the schedule');
    if ((row.Description || '').replace(/<[^>]*>/g, '').trim()) throw new Error('someone just added a description; reload to see it');
    row.Description = text; row.rowstate = 'US';
    const res = await call('Modules.Projects.Schedule', 'updateScheduleDM', {
      project, projectKey, tasksDM: { insertedItems: [], updatedItems: [row], deletedItems: [] },
      taskUsersDM: null, predsDM: { insertedItems: [], updatedItems: [], deletedItems: [] },
      removeProjectUsers: [], addedAssignments: [], tasksFromTemplate: 0,
      scheduleSessionID: sched.scheduleSessionID, newMods: null, poUpdateList: []
    }, true);
    if (res.errors && res.errors.length) throw new Error(res.errors.map(e => e.message).join('; '));
    scheduleCache.delete(String(projectKey));
    return true;
  }

  let lastHref = '';
  // The project manager, as a recipient row: name from the project record, key/email from the project team list.
  async function resolveProjectManager(projectKey) {
    const init = await call('Modules.Projects.Schedule', 'initSchedule', { loaded: true, ProjectKey: Number(projectKey) });
    const name = ((init.project || {}).ProjectManagerName || '').trim();
    if (!name) return null;
    const users = (await getSchedule(projectKey)).users;
    const hit = users.find(u => u.UserName === name && !u.ClientVendorLogin) || users.find(u => u.UserName === name);
    return hit ? { UserKey: hit.UserKey, UserName: hit.UserName, Email: hit.Email } : { UserName: name };
  }

  // On the New Post screen: fill subject, body and recipients from the pending request.
  function handlePendingPost() {
    let req = null;
    try { req = JSON.parse(sessionStorage.getItem(SS_POST) || 'null'); } catch (e) {}
    if (!req) return;
    if (Date.now() - req.ts > 120000) { try { sessionStorage.removeItem(SS_POST); } catch (e) {} return; }
    let tries = 0;
    const t = setInterval(() => {
      const pg = document.querySelector('page.open[data-aid="projects.diary.add"]');
      const model = pg && pg.view && pg.view.module && pg.view.module.model;
      const subj = pg && pg.querySelector('input[name="Subject"]');
      const ed = pg && pg.querySelector('richtexteditor[name="Notes"]');
      const ready = model && model.diary && model.diary.si && Number(model.diary.si.TaskKey) === Number(req.taskKey) && subj && ed && model.emailTo && model.emailTo.source;
      if (!ready) { if (++tries > 80) clearInterval(t); return; }
      clearInterval(t);
      try { sessionStorage.removeItem(SS_POST); } catch (e) {}
      try { fillPost(pg, model, req); toast('Post prefilled — review and Save'); }
      catch (e) { console.warn('[wjl] prefill failed', e); }
    }, 250);
  }

  function fillPost(pg, model, req) {
    const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const first = req.pm && req.pm.UserName ? req.pm.UserName.split(' ')[0] : '';
    const subject = 'Task description needed: ' + req.taskName;
    const body =
      `<p>Hi${first ? ' ' + esc(first) : ''},</p>` +
      `<p>The task <b>${esc(req.taskName)}</b> on ${esc(req.projectName)} has no description, so it is not clear what it should deliver. Could you add one? Useful to have: what is in and out of scope, any inputs or links, and what done looks like.</p>` +
      `<p>Task: <a href="${esc(req.taskUrl)}">${esc(req.taskUrl)}</a><br>Assignment: <a href="${esc(req.assignmentUrl)}">${esc(req.assignmentUrl)}</a></p>` +
      `<p>Thanks!</p>`;

    const subj = pg.querySelector('input[name="Subject"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(subj, subject);
    subj.dispatchEvent(new Event('input', { bubbles: true }));
    subj.dispatchEvent(new Event('change', { bubbles: true }));
    try { model.diary.setValue('Subject', subject); } catch (e) {}

    const ed = pg.querySelector('richtexteditor[name="Notes"]');
    let attempts = 0;
    const putBody = () => {
      ed.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertHTML', false, body);
      if (ed.textContent.trim()) {
        // The editor syncs to the model lazily; write it now so Save always carries the body.
        try { model.diary.setValue('Notes', '<span class="usr ver2">' + ed.innerHTML + '</span>'); } catch (e) {}
        subj.focus(); return;
      }
      if (++attempts < 8) { setTimeout(putBody, 300); return; }
      // Editor never took focus: write the model directly, the same shape the editor produces.
      ed.innerHTML = body;
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      try { model.diary.setValue('Notes', '<span class="usr ver2">' + body + '</span>'); } catch (e) {}
      subj.focus();
    };
    setTimeout(putBody, 150);

    if (req.pm && req.pm.UserKey) {
      const e = model.emailTo;
      e.source.map(r => r.UserKey).forEach(k => e.removeByKey(k));
      e.addItem({ UserKey: req.pm.UserKey, UserName: req.pm.UserName, Email: req.pm.Email || '', ClientVendorLogin: 0,
        k: req.pm.UserKey, l: req.pm.UserName, label: req.pm.UserName, key: req.pm.UserKey, title: req.pm.Email || '' });
      e.fire();
      model.diary.setValue('ContactUserKeys', String(req.pm.UserKey));
      model.diary.setValue('ContactUserNames', req.pm.UserName);
    }
  }

  function tick() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      if (menu) closeMenu();
      if (btn) btn.style.display = 'none';
      handlePendingTask();
      if (aid() === 'projects.diary.add') handlePendingPost();
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
