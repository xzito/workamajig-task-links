// ==UserScript==
// @name         Workamajig Task Links
// @namespace    https://xzito.com/
// @version      0.31.0
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
  const SS_KEY = 'uxa.pendingTask';
  const SS_POST = 'uxa.pendingPost';
  const SS_MODAL = 'uxa.pendingModal'; // My Time → schedule handoff: open a task's board modal on arrival
  // The `application` tag Workamajig stamps on every schedule API call shows up in their server logs. We send the exact
  // string the native schedule screen uses for getSchedule (captured live), so our reads are indistinguishable from a
  // normal schedule refresh in those logs rather than announcing a third-party tool.
  const SCHED_APP = 'scheduleEdit getSchedule';
  const VERSION = '0.99.8';
  // Presence marker (neutral, no brand) so a second injected copy stands down. Not a product tell in Workamajig's DOM.
  window.__uxaV = VERSION;

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
    assignment: (tuk) => `${BASE}?aid=projects.production.assignment&k=${tuk}`,
    thread: (rk) => `${BASE}?aid=projects.diary.thread&k=${rk}`
  };

  // Open a screen the way Workamajig's own buttons do (Views.openPage), so it joins the app's page stack and the
  // browser Back button closes it again. Workamajig keeps its own stack and overrides Back to "close the top page";
  // a full page load (location.assign) bypasses that stack, and Back then lands on some other screen.
  function openApp(aidName, k, io) {
    try {
      if (window.Views && typeof Views.openPage === 'function' && typeof window.Action === 'function') {
        Views.openPage(io ? new Action(aidName, k, io) : new Action(aidName, k));
        return;
      }
    } catch (e) { console.warn('[uxa] openPage failed, falling back to a page load', e); }
    location.assign(`${BASE}?aid=${aidName}` + (k != null ? `&k=${encodeURIComponent(k)}` : '') + (io ? `&io=${encodeURIComponent(JSON.stringify(io))}` : ''));
  }
  // Plain left click on one of our links: open in-app. Cmd/Ctrl/Shift/middle click keep the browser's new-tab behavior.
  const plainClick = e => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);

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
        application: SCHED_APP, performRecalc: false, fromNotification: false, origData: null
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
        return { tasks, slots, byTuk, users, raw: d };
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
      const key = row.dataset.key || '';
      // Day view: the row key is a TimeKey (GUID) -> full task context via loadTime.
      if (/^[0-9a-f-]{36}$/i.test(key)) {
        const wd = pageDate();
        let hit = (await getTime(wd)).get(key);
        if (!hit && wd) hit = (await getTime(null)).get(key);
        if (hit) return hit;
      }
      // Week view: rows key on PK<TaskUserKey> and aren't in the day loadTime map.
      // Resolve the project from the enclosing group header (data-group-key="PK<ProjectKey>"),
      // then enrich with the task from the schedule when the row key is a known assignment.
      const projectKey = timeGroupProjectKey(row);
      if (!projectKey) return null;
      const m = /^PK(\d+)$/.exec(key);
      if (m) {
        try {
          const taskKey = (await getSchedule(projectKey)).byTuk.get(Number(m[1]));
          if (taskKey) return { projectKey, taskUserKey: Number(m[1]), taskKey };
        } catch (e) { /* schedule unavailable -> project links only */ }
      }
      return { projectKey };
    }
  };

  // My Time group-header walk: the summaryHeader above a row carries data-group-key="PK<ProjectKey>";
  // data rows have no data-group-key, so they're skipped.
  function timeGroupProjectKey(row) {
    let g = row.previousElementSibling;
    while (g) {
      const k = g.getAttribute('data-group-key') || '';
      if (/^PK\d+$/.test(k)) return k.slice(2);
      g = g.previousElementSibling;
    }
    return null;
  }

  // ---------- UI (overlay only; never modifies the grid's own DOM) ----------
  let btn, menu, toastEl, hideTimer;
  const state = { hoverRow: null };

  function ensureUi() {
    if (btn) return;
    btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'uxa-btn'; btn.title = 'Copy link to this task / assignment';
    // WMJ's own row-action affordance is a "…" pill; match it instead of a link glyph (three dots, same grey oval).
    btn.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.5" cy="8" r="1.4"/></svg>';
    btn.style.cssText = 'position:fixed;z-index:99998;display:none;border:1px solid #d7dbe0;border-radius:999px;background:#eef1f4;color:#5b6670;cursor:pointer;line-height:0;padding:4px 7px;box-shadow:0 1px 2px rgba(0,0,0,.12)';
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
      toastEl = document.createElement('div'); toastEl.id = 'uxa-toast';
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

    menu = document.createElement('div'); menu.id = 'uxa-menu';
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
    } catch (e) { console.warn('[uxa]', e); }
    if (!menu) return;
    body.innerHTML = '';
    if (!ref) { item('<i>No task on this row</i>'); return; }
    if (ref.generic) { item('Copy link', ref.label, () => copy(ref.generic, 'link')); return; }

    // "Go to project" — jump straight to this project's sub-pages. Not shown on the Schedule page (already in-project).
    if (projectMenuOn() && ref.projectKey && aid() !== 'projects.schedule.edit2') {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'padding:6px 12px 2px;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#999';
      hdr.textContent = 'Go to project';
      body.appendChild(hdr);
      projectNavItems(ref.projectKey).forEach(n => item(n.label, n.sub, n.open));
      const hr = document.createElement('div');
      hr.style.cssText = 'margin:4px 0;border-top:1px solid #eee';
      body.appendChild(hr);
    }

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
      copy(ordered.map(s => `${taskLabel} — ${s.user}: ${urls.assignment(s.taskUserKey)}`).join('\n'), 'all links'));    ordered.forEach(s => item(`Open assignment in new tab · ${s.user}`, s.status, () => window.open(urls.assignment(s.taskUserKey), '_blank', 'noopener')));
  }

  // ---------- deep link: #task=<TaskKey> on the schedule page ----------
  // Dim everything except the row (four panes around it, like a modal backdrop) and outline it; fades on interaction or after 4 s.
  // Dim everything except the row (four panes around it, like a modal backdrop) and outline it.
  // Panes follow the row every frame, so late layout shifts or app scrolling on a fresh load don't misplace them.
  // Ends on the user's own input (wheel, click, key, touch) or after 5 s; programmatic scrolls don't end it.
  // The visible schedule row for a TaskKey (the page also has hidden template/gantt grids that reuse grid-row markup).
  function findTaskRow(tk) {
    // Only the topmost open Schedule page: an older copy may sit underneath while a new one loads on top.
    const pg = schedulePage();
    const all = [...(pg || document).querySelectorAll(`grid-row.datarow[data-key="${tk}"]`)];
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return all.find(el => el.closest('#grdProjectSchedule') && vis(el)) || all.find(vis) || null;
  }

  function spotlight(row) {
    if (document.querySelector('.uxa-spot')) return;
    const mk = css => { const d = document.createElement('div'); d.className = 'uxa-spot'; d.style.cssText = 'position:fixed;z-index:99990;pointer-events:none;transition:opacity .4s;opacity:0;' + css; document.body.appendChild(d); return d; };
    const dim = 'background:rgba(0,0,0,.38);';
    const [pTop, pBottom, pLeft, pRight, ring] = [
      mk(dim), mk(dim), mk(dim), mk(dim),
      mk('border-radius:3px;box-shadow:0 0 0 2px #f5a623,0 0 0 6px rgba(245,166,35,.35)')
    ];
    const els = [pTop, pBottom, pLeft, pRight, ring];
    const place = () => {
      const el = row.isConnected && row.getBoundingClientRect().width ? row : findTaskRow(row.getAttribute('data-key'));
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


  let pendingTimer = null;
  function handlePendingTask() {
    let tk = null; try { tk = sessionStorage.getItem(SS_KEY); } catch (e) {}
    // One poller at a time: the app rewrites the URL while loading, which would otherwise start a second one.
    if (!tk || aid() !== 'projects.schedule.edit2' || pendingTimer) return;
    let tries = 0;
    const t = pendingTimer = setInterval(() => {
      const row = findTaskRow(tk);
      if (row) {
        clearInterval(t); pendingTimer = null; try { sessionStorage.removeItem(SS_KEY); } catch (e) {}
        row.scrollIntoView({ block: 'center' });
        setTimeout(() => spotlight(row), 400);
        // The app can still shift or reset scroll while it finishes loading; re-center if the row drifted out of view.
        [800, 1600].forEach(ms => setTimeout(() => {
          const el = findTaskRow(tk);
          if (!el) return;
          const r = el.getBoundingClientRect();
          if (r.top < 80 || r.bottom > innerHeight - 40) el.scrollIntoView({ block: 'center' });
        }, ms));
      } else if (++tries > 60) { clearInterval(t); pendingTimer = null; try { sessionStorage.removeItem(SS_KEY); } catch (e) {} }
    }, 250);
  }

  // ---------- My Time: make each running-timer card's project + assignment clickable, and show the customer ----------
  // The timer panel's cards (<li data-key=TimerKey>) show the task, service, project name and number but link nowhere
  // (clicking edits the timer). We resolve each timer to its project/task/assignment via loadTimers, then: the task
  // opens the assignment's board modal (handed off to the project's schedule, since the modal lives there and a timer
  // often has no assignment slot), the project opens its dashboard, and the customer name is shown beneath (not a link).
  let timerMap = null, timerMapAt = 0, timerLoading = false, timerClickBound = false;
  const clientNames = new Map(); // projectKey(str) -> ClientName ('' while loading / when none)
  function loadTimersData() {
    if (timerLoading || (timerMap && Date.now() - timerMapAt < 15000)) return;
    timerLoading = true;
    call('Framework.CommonObjects.Time', 'loadTimers', {}).then(d => {
      const m = new Map();
      for (const t of (d && d.table) || []) m.set(String(t.TimerKey), { pk: t.ProjectKey, taskKey: t.TaskKey, tuk: t.TaskUserKey || 0 });
      timerMap = m; timerMapAt = Date.now();
    }).catch(() => {}).then(() => { timerLoading = false; });
  }
  function clientNameFor(pk, cb) {
    const key = String(pk);
    if (clientNames.has(key)) { cb(clientNames.get(key)); return; }
    clientNames.set(key, '');
    call('Modules.Projects.Schedule', 'initSchedule', { loaded: true, ProjectKey: Number(pk) })
      .then(d => { const n = String((d && d.project && d.project.ClientName) || '').trim(); clientNames.set(key, n); cb(n); })
      .catch(() => { clientNames.delete(key); });
  }
  function bindTimerClicks() {
    if (timerClickBound) return; timerClickBound = true;
    // One capture-phase listener beats Workamajig's own card click (which edits the timer) and survives re-renders.
    document.addEventListener('click', e => {
      const el = e.target.closest && e.target.closest('.uxa-tlink');
      if (!el) return;
      const info = timerMap && timerMap.get(el.dataset.uxaKey);
      if (!info || !(Number(info.pk) > 0)) return; // never navigate with a missing project key (would load a k=null all-projects board)
      e.preventDefault(); e.stopImmediatePropagation();
      if (el.dataset.uxaKind === 'asg' && Number(info.taskKey) > 0) { try { sessionStorage.setItem(SS_MODAL, JSON.stringify({ pk: String(info.pk), taskKey: info.taskKey, tuk: info.tuk || 0, ts: Date.now() })); } catch (err) {} openApp('projects.schedule.edit2', info.pk); }
      else openApp('dashboards.project.dash', info.pk);
    }, true);
  }
  function ensureTimerStyle() {
    if (document.getElementById('uxa-timer-style')) return;
    const s = document.createElement('style'); s.id = 'uxa-timer-style';
    s.textContent = '.uxa-tlink{cursor:pointer}.uxa-tlink:hover{text-decoration:underline;color:#2b6cb0}.uxa-cust{font-size:11px;opacity:.8}';
    (document.head || document.documentElement).appendChild(s);
  }
  function timersTick() {
    if (aid() !== 'user.timeEntry.edit') return;
    const cards = [...document.querySelectorAll('li[data-key]')].filter(li => li.querySelector('[data-action="editTimer"]'));
    if (!cards.length) return;
    if (!timerMap) { loadTimersData(); return; }
    ensureTimerStyle(); bindTimerClicks();
    for (const li of cards) {
      if (li.dataset.uxaDone === '1') continue;
      const key = String(li.dataset.key);
      const info = timerMap.get(key);
      if (!info) { loadTimersData(); continue; } // a timer not in our map yet (just started) — refresh and retry next tick
      const body = li.querySelector('[data-action="editTimer"]');
      if (!body) continue;
      const mark = (el, kind) => { if (!el) return; el.classList.add('uxa-tlink'); el.dataset.uxaKind = kind; el.dataset.uxaKey = key; };
      // The card layout varies — task timers (task / service / project name / project number) vs project-level timers
      // (project name / project number) — so find rows by content, not a fixed class: the first row is the name, and the
      // project-number row matches a project-code pattern. Our own customer line is skipped. Many timers have a project
      // but no task (TaskKey null); only the name of a real-task timer opens the modal, otherwise everything opens the
      // project. No project → no links.
      const hasProj = Number(info.pk) > 0, hasTask = Number(info.taskKey) > 0;
      const kids = [...body.children].filter(c => c.tagName === 'DIV' && !c.classList.contains('uxa-cust'));
      const nameEl = kids[0] || null;
      const numEl = kids.find(c => /^\d{2}-\S+-\d+$/.test((c.textContent || '').trim())) || null;
      if (hasProj) {
        if (nameEl) mark(nameEl, hasTask ? 'asg' : 'proj');
        if (numEl && numEl !== nameEl) mark(numEl, 'proj');
      }
      if (hasProj && !body.querySelector('.uxa-cust')) {
        const c = document.createElement('div'); c.className = 'muted uxa-cust';
        const anchor = numEl || kids[kids.length - 1];
        if (anchor) anchor.insertAdjacentElement('afterend', c); else body.appendChild(c);
        clientNameFor(info.pk, n => { if (n) c.textContent = n; else c.remove(); });
      }
      li.dataset.uxaDone = '1';
    }
  }
  // On the schedule, honor a pending "open this task's modal" handoff from the My Time timer cards.
  let pendingModalTimer = null;
  function handlePendingModal() {
    let raw = null; try { raw = sessionStorage.getItem(SS_MODAL); } catch (e) {}
    if (!raw || aid() !== 'projects.schedule.edit2' || pendingModalTimer) return;
    let req; try { req = JSON.parse(raw); } catch (e) { try { sessionStorage.removeItem(SS_MODAL); } catch (_) {} return; }
    if (!(Number(req.pk) > 0) || !(Number(req.taskKey) > 0)) { try { sessionStorage.removeItem(SS_MODAL); } catch (e) {} return; } // guard: never act on a null project/task
    if (String(qs().get('k')) !== String(req.pk)) return; // wait until the schedule for that project is up
    let tries = 0;
    const t = pendingModalTimer = setInterval(() => {
      if (schedulePage()) {
        clearInterval(t); pendingModalTimer = null; try { sessionStorage.removeItem(SS_MODAL); } catch (e) {}
        board.reopen = { ref: { taskKey: req.taskKey, tuk: req.tuk || 0 }, pk: String(req.pk), ts: Date.now() };
        if (!board.on) openBoard(); else loadBoard(); // loadBoard() opens the modal from board.reopen once data lands
      } else if (++tries > 80) { clearInterval(t); pendingModalTimer = null; try { sessionStorage.removeItem(SS_MODAL); } catch (e) {} }
    }, 250);
  }

  // ---------- Schedule List view: strike through completed tasks (like the Calendar's done chips) ----------
  // The native list shows completed tasks plainly. We fade the row and strike the task name (only the name cell —
  // grid-cellgroup.locked), matching the Calendar's struck-green done style. Rows are virtualized (recycled on
  // scroll), so each tick we set/clear the class on every visible row from a completed-TaskKey set for this project.
  let strikeSet = null, strikeFor = null;
  function ensureListStyle() {
    if (document.getElementById('uxa-list-style')) return;
    const s = document.createElement('style'); s.id = 'uxa-list-style';
    s.textContent = 'grid-row.uxa-done { opacity: .72; } grid-row.uxa-done grid-cellgroup.locked { text-decoration: line-through; text-decoration-color: #9ec49e; color: #6f9e6f; }';
    (document.head || document.documentElement).appendChild(s);
  }
  function listStrikeTick() {
    const grid = document.querySelector('#grdProjectSchedule');
    if (!grid) return;
    const pk = qs().get('k');
    if (!pk) return;
    if (strikeFor !== pk) {
      strikeFor = pk; strikeSet = null;
      getSchedule(pk).then(s => { if (qs().get('k') !== pk) return; strikeSet = new Set(((s.raw && s.raw.tasks) || []).filter(t => +t.PercComp >= 100 || !!t.ActComplete).map(t => Number(t.TaskKey))); })
        .catch(() => { if (strikeFor === pk) strikeFor = null; });
    }
    if (!strikeSet) return;
    ensureListStyle();
    grid.querySelectorAll('grid-row.datarow[data-key]').forEach(r => r.classList.toggle('uxa-done', strikeSet.has(Number(r.dataset.key))));
  }

  // ---------- Any Workamajig grid: shadow the frozen (locked) columns so it's obvious they don't scroll ----------
  // WMJ freezes the first N columns (the grid's "Locked Column Count") as position:sticky grid-cellgroup.locked, with
  // no visual boundary. A right-edge shadow makes the freeze obvious — globally, on every grid that shares this
  // structure (Projects, My Time, schedule, …).
  function ensureFrozenStyle() {
    if (document.getElementById('uxa-frozen-style')) return;
    const s = document.createElement('style'); s.id = 'uxa-frozen-style';
    // A hard 1px edge (continuous down the whole frozen column, since each row's locked group abuts the next) plus a
    // soft depth shadow — reads as one line, not per-row blobs. box-shadow doesn't affect layout, so no width shift.
    // ...plus a little breathing room so the frozen column's text doesn't crowd the shadow line, and the first
    // scrolling column doesn't start hard against it.
    s.textContent = 'grid-cellgroup.locked{box-shadow:1px 0 0 rgba(0,0,0,.14), 6px 0 8px -4px rgba(0,0,0,.16)}'
      // ...but not on the empty filler row below the content (a bare grid-row.main with no header/data/summary class),
      // where the shadow would otherwise dangle as a stray stub in the footer band.
      + 'grid-row.main:not(.datarow):not(.summaryHeader):not(.summaryFooter):not(.column-header-2):not(.column-header) grid-cellgroup.locked{box-shadow:none}'
      + 'grid-cellgroup.locked grid-cell:last-child{padding-right:12px}'
      + 'grid-cellgroup.unlocked grid-cell:first-child{padding-left:10px}'
      // Same idea for the pinned insert-row bar (grid-toolbar), which stays above the scrolling rows: a hard top line +
      // a soft upward shadow (box-shadow, so no layout shift) make it read as a frozen bar the content tucks under.
      + 'grid-toolbar{box-shadow:0 -1px 0 rgba(0,0,0,.14), 0 -6px 8px -4px rgba(0,0,0,.16);position:relative;z-index:6}';
    (document.head || document.documentElement).appendChild(s);
  }
  function frozenShadowTick() {
    if (document.querySelector('grid-cellgroup.locked')) ensureFrozenStyle();
  }

  // Grouped grids: wash each project group-header row in a light blue, and italicize each group subtotal row with its
  // label indented to line up with the rows above it — so the parent and its total stand apart from the rows between
  // them. Scoped to just the grids the user asked for (My Time week/day = #grdWeek/#grdDay, the Projects list =
  // #grdProductionDash, the Today list = #grdMyTasks), so no other grid is touched. These grids share the same row
  // markup (summaryHeader at 26px, depth-1 rows at 42px), so one rule set fits all. Display only — no data changes.
  // Gated via timeGroupsOn() (sync -> ON('time.grouprows')).
  const TG_GRIDS = ['grdWeek', 'grdDay', 'grdProductionDash', 'grdMyTasks'];
  function timeGroupsOn() { return true; }
  function ensureTimeGroupStyle() {
    if (document.getElementById('uxa-timegroup-style')) return;
    const s = document.createElement('style'); s.id = 'uxa-timegroup-style';
    const each = suffix => TG_GRIDS.map(g => '#' + g + ' ' + suffix).join(',');
    // Content rows across every target grid (header, data, group header + subtotal) — used to frame the table.
    const CONTENT_ROWS = ['grid-row.column-header-2', 'grid-row.datarow', 'grid-row.summaryHeader', 'grid-row.summaryFooter'];
    const edges = TG_GRIDS.flatMap(g => CONTENT_ROWS.map(r => '#' + g + ' ' + r)).join(',');
    s.textContent =
      // Group-header (parent) rows: the wash is set on the row AND its cells/cellgroups so it also covers any frozen
      // "locked" column, which paints its own background over the row.
      each('grid-row.summaryHeader') + ',' + each('grid-row.summaryHeader grid-cellgroup') + ',' + each('grid-row.summaryHeader grid-cell')
        + '{background-color:rgba(59,130,246,.12) !important}'
      // Subtotal (summaryFooter) rows: italic across the row; indent just the label cell (grid-cell.dgTree) to 42px,
      // matching the depth-1 rows' first-column text above it. A grid with no subtotal rows just gets the header wash.
      + each('grid-row.summaryFooter') + '{font-style:italic !important}'
      + each('grid-row.summaryFooter grid-cell.dgTree') + '{padding-left:42px !important}'
      // Side frame around the table, in WMJ's own line colour (#cccccc). Framed with the ROWS, not cells: WMJ's own
      // full-width per-row line proves each content-row box spans the whole table width, so a LEFT + RIGHT border on
      // every content row stacks into continuous side edges; a TOP border on the header row closes the head. (Cell
      // targeting was unreliable — the cell-bearing group and the "last" cell vary by layout.) The foot is handled on
      // the scroll container below, not per-row: WMJ already draws a #ccc separator under every row, so the "last" row's
      // line floats wherever the virtualised window ends, not at the real table bottom.
      + edges + '{border-left:1px solid #cccccc !important;border-right:1px solid #cccccc !important}'
      + each('grid-row.column-header-2') + '{border-top:1px solid #cccccc !important}'
      // Depth cues, like the frozen-column shadow. Top: float the sticky column header above the body with a soft
      // downward shadow so rows read as scrolling under it. Foot: close the table on the SCROLL CONTAINER (grid-section),
      // whose fixed bottom edge is the real table bottom (not the last virtualised row) — a border plus a soft upward
      // inset shadow so the body tucks under it. The grand-total grid-footer sits below grid-section and stays outside
      // the frame (that was the row "below" the table that the old per-row bottom border kept landing on).
      + each('grid-header') + '{position:relative;z-index:4;box-shadow:0 5px 7px -3px rgba(0,0,0,.13) !important}'
      + each('grid-section') + '{border-bottom:1px solid #cccccc !important;box-shadow:inset 0 -8px 7px -7px rgba(0,0,0,.13) !important}'
      // Hide the empty row-action gutter (grid-row-header: edit/delete/select indicators) on these read-mostly views —
      // it's the narrow blank first column the frame was boxing. The group chevron is in grid-cell.dgTree, not here, so
      // collapse still works. Scoped to the target grids only (the schedule keeps its gutter, where those actions matter).
      + each('grid-row-header') + '{display:none !important}'
      // ...and reclaim the gap it left: WMJ's `datagrid.showindicator > grid-row.main` rule reserves 40px of row
      // padding-left for that indicator, which stays even with the element hidden. Zero it (id-scoped + !important beats
      // WMJ's class rule) so the rows sit flush to the table's left border instead of leaving a blank 40px column.
      // EXCEPT the expanded inline time-entry editor (grid-row...editing), which relies on that 40px to inset its form
      // fields — leave those rows alone so the editor's Project/Task/etc. keep their left spacing.
      + each('grid-row.main:not(.editing)') + '{padding-left:0 !important}';
    (document.head || document.documentElement).appendChild(s);
  }
  function timeGroupTick() {
    const on = timeGroupsOn(), existing = document.getElementById('uxa-timegroup-style');
    if (on && !existing && TG_GRIDS.some(id => document.getElementById(id))) ensureTimeGroupStyle();
    else if (!on && existing) existing.remove();
  }

  // ---------- New-task link toast: after Workamajig's native New Task form saves, offer the new task's link ----------
  // Gated via taskToastOn() (sync -> ON('nav.tasktoast')). We watch ONLY while a New Task (projects.schedule.taskAdd)
  // form is open: a scoped observer wraps window.fetch to read the save response — the authoritative new ProjectKey +
  // TaskKey, which also covers the all-projects picker where the project is chosen inside the form — and is removed the
  // moment the form closes (no permanent global patch). The form clearing (Add more after save) or closing reveals the
  // caught task as a toast with Open + Copy. Read-only: we never alter a request, and nothing here writes to Workamajig
  // (the user's own Save does the write); the toast just hands back the link to the task that was created.
  let ntaFetch = null, ntaWrapper = null;  // original + our wrapper, while the observer is installed
  let ntaCaught = null;                    // { projectKey, taskKey, name } from a save response this form session
  let ntaName = '';                        // the latest non-empty Task Name typed in the open form
  function ntaScan(url, j) {
    // Only save-type responses (not reads) carry a just-created task; filter by the data.aspx method token so a plain
    // schedule read (full of existing TaskKeys) can't be mistaken for a creation.
    const method = (/data\.aspx\?([^&#]*)/i.exec(url) || [])[1] || '';
    if (!/sav|updat|insert|add|creat/i.test(method) || /load|get|fetch|search|list/i.test(method)) return;
    const stack = [j]; let n = 0;
    while (stack.length && n < 6000) {
      const o = stack.pop(); n++;
      if (!o || typeof o !== 'object') continue;
      const tk = Number(o.TaskKey), pk = Number(o.ProjectKey);
      if (tk > 0 && pk > 0 && typeof o.TaskName === 'string' && o.TaskName.trim()) {
        // Prefer the task whose name matches what was typed; otherwise keep the latest seen.
        if (!ntaCaught || (ntaName && o.TaskName.trim().toLowerCase() === ntaName.toLowerCase())) {
          ntaCaught = { projectKey: pk, taskKey: tk, name: o.TaskName.trim() };
        }
      }
      for (const k in o) { const v = o[k]; if (v && typeof v === 'object') stack.push(v); }
    }
  }
  function ntaInstall() {
    if (ntaFetch) return;
    ntaFetch = window.fetch;
    const orig = ntaFetch;
    ntaWrapper = function (...args) {
      const p = orig.apply(this, args);
      try {
        const url = String((args[0] && args[0].url) || args[0] || '');
        if (/data\.aspx/i.test(url)) p.then(r => { try { r.clone().json().then(j => ntaScan(url, j)).catch(() => {}); } catch (e) {} }).catch(() => {});
      } catch (e) {}
      return p;
    };
    window.fetch = ntaWrapper;
    ntaCaught = null; ntaName = '';
  }
  function ntaRemove() {
    if (!ntaFetch) return;
    try { if (window.fetch === ntaWrapper) window.fetch = ntaFetch; } catch (e) {}  // only if nobody wrapped after us
    ntaFetch = null; ntaWrapper = null;
  }
  function taskToastOn() { return true; }
  function ntaTick() {
    if (!taskToastOn()) { ntaRemove(); return; }
    const pg = document.querySelector('page.open[data-aid="projects.schedule.taskAdd"]');
    if (pg) {
      ntaInstall();
      const nameEl = pg.querySelector('input[name="TaskName"]');
      const name = nameEl ? (nameEl.value || '').trim() : '';
      if (name) ntaName = name;                                 // remember the latest typed name
      else if (ntaName) { ntaFinish(ntaName); ntaName = ''; }   // name cleared (Add more save) while form open
    } else if (ntaFetch) {
      if (ntaName) { ntaFinish(ntaName); ntaName = ''; }        // form closed: a save or a cancel
      ntaRemove();
    }
  }
  // A save looks to have happened; wait briefly for its response to be caught, then toast the new task. No caught task
  // within the window means it was a cancel (or a save whose response we couldn't read) — stay silent rather than guess.
  function ntaFinish(name) {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (ntaCaught) { clearInterval(iv); const c = ntaCaught; ntaCaught = null; ntaReveal(c); }
      else if (tries > 20) clearInterval(iv);  // ~6s
    }, 300);
  }
  // Resolve the new task's assignment (TaskUserKey) so the toast can open/copy the assignment, not just the schedule.
  // The native save already committed the task + its assignee, so a fresh getSchedule (cache busted, since the write
  // bypassed our cache) carries the new assignment in projectTaskUserData. No assignee → fall back to the task link.
  async function ntaReveal(info) {
    let tuk = 0;
    try {
      scheduleCache.delete(String(info.projectKey));
      const sched = await getSchedule(info.projectKey);
      const slots = sched.slots.get(Number(info.taskKey)) || [];
      const s = slots.find(x => Number(x.userKey) > 0) || slots[0];
      if (s) tuk = Number(s.taskUserKey) || 0;
    } catch (e) { /* offline or locked — fall back to the task link */ }
    ntaToast({ projectKey: info.projectKey, taskKey: info.taskKey, taskUserKey: tuk, name: info.name });
  }
  function ensureNtaStyle() {
    if (document.getElementById('uxa-nta-style')) return;
    const s = document.createElement('style'); s.id = 'uxa-nta-style';
    s.textContent = '#uxa-nta{position:fixed;right:20px;bottom:20px;z-index:100000;background:#fff;color:#222;border:1px solid #d6d6d6;border-left:4px solid #7ab51d;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.18);font:13px/1.4 -apple-system,Segoe UI,sans-serif;padding:12px 14px;max-width:340px;animation:uxaNtaIn .18s ease}'
      + '@keyframes uxaNtaIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}'
      + '#uxa-nta .t{font-weight:600}#uxa-nta .n{color:#555;margin:2px 0 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '#uxa-nta .row{display:flex;gap:8px;align-items:center}'
      + '#uxa-nta button{font:inherit;font-size:12px;border-radius:5px;padding:5px 12px;cursor:pointer;border:1px solid #ccc;background:#fff}'
      + '#uxa-nta .open{background:#7ab51d;border-color:#7ab51d;color:#fff}'
      + '#uxa-nta .x{margin-left:auto;border:0;background:none;color:#999;font-size:16px;line-height:1;padding:2px 4px}';
    (document.head || document.documentElement).appendChild(s);
  }
  function ntaToast(info) {
    ensureNtaStyle();
    const old = document.getElementById('uxa-nta'); if (old) old.remove();
    const tuk = Number(info.taskUserKey) > 0 ? Number(info.taskUserKey) : 0;
    // Prefer the assignment (what you share with whoever's assigned); only an unassigned task falls back to the task link.
    const link = tuk ? urls.assignment(tuk) : urls.task(info.projectKey, info.taskKey);
    const el = document.createElement('div'); el.id = 'uxa-nta';
    el.innerHTML = '<div class="row"><span class="t">Task created</span><button class="x" title="Dismiss">×</button></div>'
      + '<div class="n"></div>'
      + `<div class="row"><button class="open">Open ${tuk ? 'assignment' : 'task'}</button><button class="copy">Copy link</button></div>`;
    el.querySelector('.n').textContent = info.name;
    document.body.appendChild(el);
    const close = () => { clearTimeout(el._t); el.remove(); };
    el.querySelector('.x').onclick = close;
    el.querySelector('.copy').onclick = () => copy(link, tuk ? 'assignment link' : 'task link');
    el.querySelector('.open').onclick = () => {
      if (tuk) { openApp(ASSIGN_AID, tuk); }
      else { try { sessionStorage.setItem(SS_KEY, String(info.taskKey)); } catch (e) {} openApp('projects.schedule.edit2', info.projectKey); }
      close();
    };
    el._t = setTimeout(close, 12000);
  }

  // ---------- Grids: prefix "$" on dollar columns (across Workamajig) ----------
  // Gated via gridCurrencyOn() (sync -> ON('grid.currency')). Workamajig marks no cell as currency — a grid cell is known
  // only by column index, and counts, hours and money all look alike. But a grid's row data uses stable native field names
  // (TotalLaborGross, AdvanceBilled, BilledAmount, ...), so we classify a numeric field as money by its NAME — override-
  // proof, since a Field Label Override changes only the header — then find which column shows it by matching cell values
  // to the record across several rows (so a coincidental tie on 0 can't fool it). Rows pair to records generically through
  // the grid controller's rendered vdom (each entry carries .key + .data), so this works on ANY data grid, not just
  // Projects. A <style> prefixes "$" via ::before on the money columns, recomputed when a grid or column set changes.
  function gridCurrencyOn() { return true; }
  const CUR_MONEY = f => /gross|profit|budget|billed|amount|cost|expense|labor|advance|revenue|price|deposit|paid|balance|retainer|fee/i.test(f)
    && !/hours?|hrs|perc|count|qty|number|key|status|color|days?|date|update|locked|isfav|order\b|\bid\b/i.test(f);
  let curSig = '';
  // One grid -> the column indexes that are money. recByKey pairs a DOM row (data-key) to its record via the controller's
  // rendered vdom (v.key -> v.data) — generic across grids, no per-grid key field to know.
  function curDetectGrid(gridEl, ctl) {
    const recByKey = new Map();
    for (const v of (ctl.vdom || [])) { if (v && v.data && typeof v.data === 'object') recByKey.set(String(v.key), v.data); }
    if (!recByKey.size) return [];
    const numeric = new Set();
    for (const d of recByKey.values()) for (const k in d) if (typeof d[k] === 'number') numeric.add(k);
    const money = [...numeric].filter(CUR_MONEY);
    if (!money.length) return [];
    const rows = [...gridEl.querySelectorAll('grid-row.datarow[data-key]')].filter(r => recByKey.has(r.getAttribute('data-key')));
    if (rows.length < 2) return [];
    const sample = rows.find(r => r.querySelector('grid-cell[data-idx]:not(.header)'));
    if (!sample) return [];
    const colIdxs = [...sample.querySelectorAll('grid-cell[data-idx]:not(.header)')].map(c => c.getAttribute('data-idx'));
    const out = [];
    for (const idx of colIdxs) {
      for (const F of money) {
        let ok = 0, seen = 0, first = null, distinct = false, bad = false;
        for (const r of rows) {
          const rec = recByKey.get(r.getAttribute('data-key')); if (typeof rec[F] !== 'number') { bad = true; break; }
          const c = r.querySelector('grid-cell[data-idx="' + idx + '"]:not(.header)'); if (!c) continue;
          const raw = (c.textContent || '').trim(); if (raw === '') continue;
          const num = parseFloat(raw.replace(/[,\s]/g, '')); if (isNaN(num)) { bad = true; break; }
          seen++; if (Math.abs(num - rec[F]) < 0.02) ok++; else { bad = true; break; }
          if (first === null) first = num; else if (num !== first) distinct = true;
        }
        if (!bad && ok === seen && seen >= 2 && distinct) { out.push(idx); break; }  // this column IS money
      }
    }
    return out;
  }
  // Every data grid on the page that exposes a controller with vdom + keyed data rows.
  function curGrids() {
    const seen = new Set(), grids = [];
    for (const pg of document.querySelectorAll('page.open')) {
      const gmap = pg.view && pg.view.grids; if (!gmap) continue;
      const keys = gmap instanceof Map ? [...gmap.keys()] : Object.keys(gmap);
      for (const gid of keys) {
        if (!gid || seen.has(gid)) continue; seen.add(gid);
        const ctl = gmap instanceof Map ? gmap.get(gid) : gmap[gid];
        const el = document.getElementById(gid);
        if (el && ctl && Array.isArray(ctl.vdom) && el.querySelector('grid-row.datarow[data-key]')) grids.push({ gid, el, ctl });
      }
    }
    return grids;
  }
  function gridCurrencyTick() {
    const existing = document.getElementById('uxa-cur-style');
    if (!gridCurrencyOn()) { if (existing) existing.remove(); curSig = ''; return; }
    const grids = curGrids();
    if (!grids.length) { if (existing) existing.remove(); curSig = ''; return; }
    // Signature = each grid's id + its header set; a grid opening/closing or a layout switch changes it and recomputes.
    const sig = grids.map(g => g.gid + ':' + [...g.el.querySelectorAll('grid-cell.header[data-idx]')].map(h => h.getAttribute('data-idx') + (h.textContent || '').trim()).join(',')).join('|');
    if (sig === curSig && existing) return;
    const rules = [];
    for (const g of grids) for (const i of curDetectGrid(g.el, g.ctl)) rules.push('#' + g.gid + ' grid-cell[data-idx="' + i + '"]:not(.header):not(:empty)::before{content:"$"}');
    if (!rules.length) return;  // data not ready yet — retry next tick without locking the signature
    curSig = sig;
    const st = existing || document.createElement('style');
    if (!existing) { st.id = 'uxa-cur-style'; (document.head || document.documentElement).appendChild(st); }
    st.textContent = rules.join('');
  }

  // ---------- Projects grid: a "budget consumed" bar on each project row ----------
  // Gated via budgetBarOn() (sync -> ON('grid.budgetbar')). On the Projects list (grdProductionDash), each row gets a
  // small gauge showing how much of the project's CURRENT budget (dollars) has been consumed to date, borrowing the
  // look of Workamajig's native "% Complete" bar. All figures come from the row's own record (stable native fields):
  //   budget   = CurrentBudgetLaborGross + CurrentBudgetExpenseGross   (the "Budget Labor + Expenses" column)
  //   consumed = TotalLaborGross + TotalCostsGross                     (the "Current Labor + Expenses" column)
  // We place the bar inside whichever cell actually shows the consumed figure, found by matching cell text to the
  // record (rename-proof, layout-proof) and cached per column set — so it rides along in any layout that surfaces that
  // $ column (e.g. the Accounting layout), and simply doesn't appear in layouts that don't (e.g. a pure PM layout).
  function budgetBarOn() { return true; }
  const BB_GID = 'grdProductionDash';
  function bbColor(pct) { return pct > 1 ? '#e53e3e' : (pct >= 0.85 ? '#dd8800' : '#38a169'); }
  function bbMoney(n) { return '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function bbHours(n) { return (Math.round(n * 100) / 100).toLocaleString('en-US') + ' hrs'; }
  function ensureBudgetBarStyle() {
    if (document.getElementById('uxa-bbar-style')) return;
    const s = document.createElement('style'); s.id = 'uxa-bbar-style';
    // The gauge sits directly under the dollar figure (not at the cell bottom — these grouped rows can be very tall, which
    // would strand a bottom-anchored bar far from its number, even reading as the next row's). We lay the consumed cell out
    // as a right-aligned column (number, then bar) so the two stay glued together at any row height. The track is a neutral
    // rail; fill + label share one health colour (green under budget, amber near it, red over). The label sits beside the
    // bar (not on it) so it reads at any fill, 2% or 112% alike. pointer-events stay off the bar so cell clicks pass
    // through; only the label accepts hover, to surface the exact dollars in its tooltip.
    s.textContent = '.uxa-bbar{display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-top:3px;pointer-events:none}'
      + '.uxa-bbar .uxa-bbar-track{position:relative;width:62px;height:7px;border-radius:4px;background:#e3e6ea;overflow:hidden;flex:0 0 auto}'
      + '.uxa-bbar .uxa-bbar-fill{position:absolute;left:0;top:0;bottom:0;border-radius:4px}'
      + '.uxa-bbar .uxa-bbar-lbl{font:700 10px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.2px;pointer-events:auto;cursor:default}';
    (document.head || document.documentElement).appendChild(s);
  }
  // Lay the consumed cell out so the bar sits right under its number; undo it when the cell loses its bar (grids recycle
  // cells on scroll, so a cell that no longer carries a bar must return to its native layout).
  function bbSetCell(cell) {
    // Block (not flex): the dollar figure stays on one inline line — including the "$" the currency feature adds as a
    // ::before, which a flex column would stack onto its own line — and the bar, a block, flows directly beneath it.
    // text-align:right keeps the figure and bar on the right, matching the dollar column; block flow keeps the figure at
    // the cell top, aligned with the other columns' values in tall grouped rows.
    cell.style.display = 'block'; cell.style.textAlign = 'right';
  }
  function bbClearCell(cell) {
    if (!cell) return;
    for (const p of ['display', 'textAlign', 'flexDirection', 'alignItems', 'justifyContent', 'gap']) cell.style[p] = '';
  }
  // Each gauge: its "consumed" figure (numer) over its budget (denom), drawn in whichever cell displays that consumed
  // figure. The cell is found by matching cell text to numer across rows (rename-/layout-proof), so a bar rides along in
  // any layout that surfaces its column and stays away from ones that don't:
  //   money — Current Labor + Expenses (TotalLaborGross + TotalCostsGross) over the current $ budget (Accounting layout)
  //   hours — Budget Hrs Actual (ActualHours) over Budget Hrs Est / original budget hours (PM layout)
  const BB_SPECS = [
    // money: value-match the combined figure, but NEVER a split Total Labor/Costs column — when a project has zero costs
    // those tie the sum, which would wrongly draw the $ bar on "Total Labor Gross" in the hours (PM) layout.
    { key: 'money', noun: 'Budget consumed', fmt: bbMoney, excludeField: /TotalLaborGross|TotalCostsGross/i,
      numer: r => (+r.TotalLaborGross || 0) + (+r.TotalCostsGross || 0),
      denom: r => (+r.CurrentBudgetLaborGross || 0) + (+r.CurrentBudgetExpenseGross || 0) },
    // hours: the "Budget Hrs Actual" column, found by its stable field token (ActualHours) so a label override can't move
    // it; over the original budget hours ("Budget Hrs Est"), matching how that layout derives "Budget Hrs Remaining".
    { key: 'hours', noun: 'Hours used', fmt: bbHours, field: /ActualHours$/i,
      numer: r => (+r.ActualHours || 0),
      denom: r => (+r.OriginalBudgetHours || 0) }
  ];
  let bbSig = '', bbIdx = {}; // spec key -> column index (or -1) for the current column set
  // ctl.columns is a stable "field|Label,field|Label,…" list in column order; index i -> that column's field token.
  function bbColTokens(ctl) { return String((ctl && ctl.columns) || '').split(',').map(t => (t.split('|')[0] || '').trim()); }
  // The column index for a spec: its field token if named (robust to label overrides), else the column whose cells match
  // numer(record) across rows (≥2 distinct, exact), skipping any excluded field. -1 if none.
  function bbMatchIdx(gridEl, recByKey, spec, tokens) {
    const rows = [...gridEl.querySelectorAll('grid-row.datarow[data-key]')].filter(r => recByKey.has(r.getAttribute('data-key')));
    if (rows.length < 2) return -1;
    const sample = rows.find(r => r.querySelector('grid-cell[data-idx]:not(.header)'));
    if (!sample) return -1;
    const idxs = [...sample.querySelectorAll('grid-cell[data-idx]:not(.header)')].map(c => c.getAttribute('data-idx'));
    if (spec.field) { for (const idx of idxs) if (spec.field.test(tokens[Number(idx)] || '')) return idx; }
    for (const idx of idxs) {
      if (spec.excludeField && spec.excludeField.test(tokens[Number(idx)] || '')) continue;
      let ok = 0, seen = 0, first = null, distinct = false, bad = false;
      for (const r of rows) {
        const rec = recByKey.get(r.getAttribute('data-key'));
        const c = r.querySelector('grid-cell[data-idx="' + idx + '"]:not(.header)'); if (!c) continue;
        const raw = (c.textContent || '').trim(); if (raw === '') continue;
        const num = parseFloat(raw.replace(/[$,\s]/g, '')); if (isNaN(num)) { bad = true; break; }
        seen++; if (Math.abs(num - spec.numer(rec)) < 0.02) ok++; else { bad = true; break; }
        if (first === null) first = num; else if (num !== first) distinct = true;
      }
      if (!bad && seen >= 2 && ok === seen && distinct) return idx;
    }
    return -1;
  }
  function bbPlace(cell, consumed, budget, spec) {
    const pct = consumed / budget, disp = Math.round(pct * 100), col = bbColor(pct);
    const old = cell.querySelector(':scope > .uxa-bbar');
    if (old && old.dataset.pct === String(disp) && old.dataset.spec === spec.key) return; // unchanged -> leave it
    if (old) old.remove();
    bbSetCell(cell);
    const bar = document.createElement('span');
    bar.className = 'uxa-bbar'; bar.dataset.pct = String(disp); bar.dataset.spec = spec.key;
    bar.innerHTML = '<span class="uxa-bbar-track"><span class="uxa-bbar-fill" style="width:' + Math.max(0, Math.min(100, pct * 100)) + '%;background:' + col + '"></span></span>'
      + '<span class="uxa-bbar-lbl" style="color:' + col + '" title="' + spec.noun + ': ' + disp + '% — ' + spec.fmt(consumed) + ' of ' + spec.fmt(budget) + '">' + disp + '%</span>';
    cell.appendChild(bar);
  }
  function budgetBarTick() {
    const grid = budgetBarOn() ? curGrids().find(g => g.gid === BB_GID) : null;
    if (!grid) { document.querySelectorAll('.uxa-bbar').forEach(b => { bbClearCell(b.parentElement); b.remove(); }); bbSig = ''; bbIdx = {}; return; }
    const recByKey = new Map();
    for (const v of (grid.ctl.vdom || [])) if (v && v.data && typeof v.data === 'object') recByKey.set(String(v.key), v.data);
    if (!recByKey.size) return;
    // Recompute each spec's column only when the column set changes; a change also clears every bar so stale ones (on
    // columns the new layout drops) can't linger on recycled cells.
    const sig = [...grid.el.querySelectorAll('grid-cell.header[data-idx]')].map(h => h.getAttribute('data-idx') + (h.textContent || '').trim()).join(',');
    if (sig !== bbSig) {
      grid.el.querySelectorAll('.uxa-bbar').forEach(b => { bbClearCell(b.parentElement); b.remove(); });
      const tokens = bbColTokens(grid.ctl);
      bbIdx = {}; for (const spec of BB_SPECS) bbIdx[spec.key] = bbMatchIdx(grid.el, recByKey, spec, tokens);
      bbSig = sig;
    }
    if (!BB_SPECS.some(s => bbIdx[s.key] >= 0)) return; // no gauge columns in this layout
    ensureBudgetBarStyle();
    for (const spec of BB_SPECS) {
      const idx = bbIdx[spec.key]; if (idx < 0) continue;
      for (const row of grid.el.querySelectorAll('grid-row.datarow[data-key]')) {
        const rec = recByKey.get(row.getAttribute('data-key'));
        const cell = row.querySelector('grid-cell[data-idx="' + idx + '"]:not(.header)');
        if (!rec || !cell) continue;
        const budget = spec.denom(rec), consumed = spec.numer(rec);
        const old = cell.querySelector(':scope > .uxa-bbar');
        if (!(budget > 0)) { if (old) { old.remove(); bbClearCell(cell); } continue; } // no budget set -> no meaningful %
        bbPlace(cell, consumed, budget, spec);
      }
    }
  }

  // ---------- Schedule row-detail slideout: rich text for the native Task Description ----------
  // Gated (sync wraps the nativeDescTick() call with ON('desc.richtext')). The slideout's description is a plain
  // <textarea name="Description"> in div.taskDetailsSide; we hide it and drop our rich editor (the card-modal one) in its
  // place, saving through the proven saveTaskDescription path — NOT Workamajig's native save. The task is the selected
  // schedule row; saveTaskDescription verifies the current server text first, so a wrong key fails safely with no bad
  // write. Idempotent + re-seeds when a row switch reuses the textarea (unless the user is mid-edit).
  function ensureNdescStyle() {
    if (document.getElementById('uxa-ndesc-style')) return;
    const s = document.createElement('style'); s.id = 'uxa-ndesc-style';
    s.textContent = RTE_CSS +
      // WMJ keeps the description's read (text-holder) and edit (textarea) views in <div.text-sizer> panes inside one
      // .input-control and flips between them; we hide both panes on the control we take over, so only our editor shows.
      '.uxa-deschost > .text-sizer{display:none !important}' +
      '.uxa-ndesc{margin-top:4px}.uxa-ndesc .rtein{min-height:90px}' +
      '.uxa-ndesc-row{display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap}' +
      '.uxa-ndesc-save{background:#7ab51d;color:#fff;border:0;border-radius:5px;padding:5px 12px;cursor:pointer;font:inherit;font-size:12px}' +
      '.uxa-ndesc-save:disabled{opacity:.6;cursor:default}' +
      '.uxa-ndesc-cancel{background:#fff;border:1px solid #ccc;border-radius:5px;padding:5px 10px;cursor:pointer;font:inherit;font-size:12px}' +
      '.uxa-ndesc-msg{font-size:11px;color:#888}';
    (document.head || document.documentElement).appendChild(s);
  }
  function nativeDescTick() {
    if (aid() !== 'projects.schedule.edit2') return;
    // The ACTIVE slideout (a visible taskDetailsSide — there's also a hidden template copy). Work off the slideout, not
    // off a *visible* textarea: WMJ opens a task that already has a description in READ mode, where the edit textarea is
    // hidden, so keying on textarea visibility made our editor appear only intermittently (edit-mode tasks) and miss the
    // read-mode ones.
    const side = [...document.querySelectorAll('div.taskDetailsSide')].find(s => s.offsetParent);
    if (!side) return;
    const ta = side.querySelector('textarea[name="Description"]');
    if (!ta) return;
    const control = ta.closest('.input-control');
    if (!control) return;
    const sel = document.querySelector('#grdProjectSchedule grid-row.datarow[class*="select"][data-key], grid-row.datarow.selected[data-key]');
    const taskKey = sel ? Number(sel.getAttribute('data-key')) : 0;
    const pk = qs().get('k');
    if (!taskKey || !pk) return; // can't tie it to a task yet — retry next tick
    const cur = ta.value || '';
    let host = control.querySelector(':scope > .uxa-ndesc');
    if (host) {
      // Already enhanced: if a row switch reused this control (task/text changed), re-seed — but not while editing.
      if ((host.dataset.uxaTask !== String(taskKey) || host.dataset.uxaOrig !== cur) && document.activeElement !== host.querySelector('.rtein')) {
        host.dataset.uxaTask = String(taskKey); host.dataset.uxaOrig = cur;
        const edEl = host.querySelector('.rtein'); if (edEl) edEl.innerHTML = descToHtml(cur);
        const m = host.querySelector('.uxa-ndesc-msg'); if (m) m.textContent = '';
      }
      return;
    }
    ensureNdescStyle();
    // Hide WMJ's read + edit panes (uxa-deschost) and append our editor as a direct child of the control, so it shows
    // whenever the task is selected — read or edit state alike — instead of living inside the pane WMJ hides in read mode.
    control.classList.add('uxa-deschost');
    host = document.createElement('div');
    host.className = 'uxa-ndesc';
    host.dataset.uxaTask = String(taskKey); host.dataset.uxaOrig = cur;
    host.innerHTML = rteEditor(descToHtml(cur)) +
      '<div class="uxa-ndesc-row"><button type="button" class="uxa-ndesc-save">Save description</button><button type="button" class="uxa-ndesc-cancel">Revert</button><span class="uxa-ndesc-msg"></span></div>';
    control.appendChild(host);
    wireRte(host.querySelector('.rte'));
    const msg = m => { const el = host.querySelector('.uxa-ndesc-msg'); if (el) el.textContent = m || ''; };
    host.querySelector('.uxa-ndesc-cancel').addEventListener('click', e => { e.preventDefault(); const edEl = host.querySelector('.rtein'); if (edEl) edEl.innerHTML = descToHtml(host.dataset.uxaOrig || ''); msg(''); });
    host.querySelector('.uxa-ndesc-save').addEventListener('click', async e => {
      e.preventDefault(); const btn = e.currentTarget; btn.disabled = true; msg('Saving…');
      const tk = Number(host.dataset.uxaTask), orig = host.dataset.uxaOrig || '', html = rteRead(host);
      try {
        await saveTaskDescription(qs().get('k'), tk, html, orig);
        host.dataset.uxaOrig = html; ta.value = html; try { ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true })); } catch (err) {}
        msg('Saved ✓'); toast('Description saved');
      } catch (err) { msg(''); toast('Could not save: ' + (err && err.message || err)); }
      btn.disabled = false;
    });
  }

  // ---------- wiring ----------
  // ---------- Add our items to Workamajig's own ⋯ menus ----------
  // Schedule rows: button[data-action="popup setTask"][data-key=TaskKey]  -> menu#taskMoreMenu
  // Task cards (Today/My Tasks): button[data-target="timeMenu"][data-key=TaskUserKey] -> menu#timeMenu
  const NATIVE_MENUS = [
    {
      trigger: 'button[data-action="popup setTask"][data-key]', menu: 'menu#taskMoreMenu',
      when: () => aid() === 'projects.schedule.edit2',
      ref: async key => ({ projectKey: qs().get('k'), taskKey: Number(key) })
    },
    {
      trigger: 'button[data-target="timeMenu"][data-key]', menu: 'menu#timeMenu',
      when: () => true,
      ref: key => (/^\d+$/.test(key) ? getAssignment(key) : Promise.resolve(null))
    }
  ];

  function onNativeMenuClick(e) {
    if (!e.target.closest) return;
    for (const nm of NATIVE_MENUS) {
      const trigger = e.target.closest(nm.trigger);
      if (!trigger || !nm.when()) continue;
      const refP = nm.ref(trigger.getAttribute('data-key'));
      refP.then(r => r && r.projectKey && getSchedule(r.projectKey)).catch(() => {});
      let n = 0;
      const t = setInterval(() => {
        const m = [...document.querySelectorAll(nm.menu)].find(x => x.offsetParent);
        if (m) { clearInterval(t); fillNativeMenu(m, refP); }
        else if (++n > 20) clearInterval(t);
      }, 50);
      return;
    }
  }

  async function fillNativeMenu(m, refP) {
    m.querySelectorAll('.uxa-native').forEach(x => x.remove());
    const group = document.createElement('div');
    group.className = 'uxa-native';
    group.style.cssText = 'border-top:1px solid #e5e5e5;margin-top:4px;padding-top:8px';
    m.appendChild(group);
    // Match the menu's own button classes (spacing differs between menus), swapping in the link icon.
    const proto = m.querySelector('button:not(.uxa-native button)');
    const baseCls = proto ? [...proto.classList].filter(c => !/^i-/.test(c) && c !== 'bound').join(' ') : 'btn-std icon-l text';
    const dismiss = () => {
      const dlg = m.closest('dialog');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      setTimeout(() => { if (dlg && dlg.offsetParent) document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); }, 50);
    };
    const note = text => { const d = document.createElement('div'); d.style.cssText = 'font-size:11px;color:#999;padding:2px 0 6px 28px'; d.textContent = text; group.appendChild(d); return d; };
    const add = (label, title, onClick, icon) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = baseCls + ' ' + (icon || 'i-link');
      b.setAttribute('data-action', 'none');
      b.textContent = label;
      if (title) b.title = title;
      b.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); onClick(); dismiss(); }, true);
      group.appendChild(b);
    };
    const loading = note('Loading links…');
    let ref = null, sched = null;
    try { ref = await refP; if (ref && ref.projectKey) sched = await getSchedule(ref.projectKey); } catch (e) {}
    loading.remove();
    if (!group.isConnected) return;
    if (!ref || !ref.projectKey) { note('No task found for this item'); return; }

    const onSchedule = aid() === 'projects.schedule.edit2';
    const rawTask = ref.taskKey && sched && sched.raw && (sched.raw.tasks || []).find(x => Number(x.TaskKey) === Number(ref.taskKey));
    if (timeActionsOn() && timerEligible(rawTask)) add('Start timer', 'Start a Workamajig timer on this task (shows in My Time)', () => startTimerFor(ref.projectKey, ref.taskKey, 0), 'i-timer');
    if (ref.taskKey) add('Copy task link', 'Opens the schedule and spotlights this task (needs Task Links)', () => copy(urls.task(ref.projectKey, ref.taskKey), 'task link'));
    if (!onSchedule) add('Copy project link', 'Project dashboard', () => copy(urls.project(ref.projectKey), 'project link'));

    const t = ref.taskKey && sched && sched.tasks.get(ref.taskKey);
    let slots = (ref.taskKey && sched && sched.slots.get(ref.taskKey)) || [];
    if (!slots.length && ref.taskUserKey) slots = [{ taskUserKey: ref.taskUserKey, user: ref.user || 'this assignment', status: '' }];
    const mine = ref.userKey ? slots.filter(sl => sl.userKey === ref.userKey) : [];
    const ordered = mine.concat(slots.filter(sl => !mine.includes(sl)));
    ordered.forEach(sl => add(`Copy assignment link · ${sl.user.split(' ')[0]}`, `${sl.user}${sl.status ? ' · ' + sl.status : ''}`, () => copy(urls.assignment(sl.taskUserKey), 'assignment link for ' + sl.user)));
    if (ordered.length > 1) add('Copy all assignment links', 'One per line, with names', () =>
      copy(ordered.map(sl => `${t ? t.id + ' - ' + t.name : 'Task'} — ${sl.user}: ${urls.assignment(sl.taskUserKey)}`).join('\n'), 'all links'));
    ordered.forEach(sl => add(`Open assignment in new tab · ${sl.user.split(' ')[0]}`, `${sl.user}${sl.status ? ' · ' + sl.status : ''}`,
      () => window.open(urls.assignment(sl.taskUserKey), '_blank', 'noopener'), 'i-newtab'));
    if (!ordered.length) note('No assignments on this task');
  }

  function onOver(e) {
    if (!e.target.closest) return;
    // On the Schedule the links live in Workamajig's own row ⋯ menu instead (see nativeMenu below).
    const row = adapters[aid()] && aid() !== 'projects.schedule.edit2' && e.target.closest('grid-row[data-key]');
    let card = !row && e.target.closest('[data-target*="."][data-key]');
    // Cards with their own ⋯ time menu get our links inside it instead (see NATIVE_MENUS).
    if (card && card.querySelector('button[data-target="timeMenu"][data-key]')) card = null;
    if (row && row.classList.contains('datarow')) showFor(row);
    else if (card) showFor(card);
    else if (btn && !e.target.closest('#uxa-btn,#uxa-menu')) scheduleHide();
  }
  // ---------- Assignment page: full width + hours logged ----------
  const ASSIGN_AID = 'projects.production.assignment';
  let wideStyle;
  function assignmentPage() {
    const on = aid() === ASSIGN_AID;
    // Styles stay while an assignment page is anywhere in the stack (e.g. under a New Post panel), so it keeps its layout.
    const present = on || !!document.querySelector('page.open[data-aid="projects.production.assignment"]');
    if (!wideStyle) {
      const P = '#desktop > section > page.wide[data-aid="projects.production.assignment"]';
      wideStyle = document.createElement('style');
      wideStyle.id = 'uxa-wide';
      // Same width the app gives non-"wide" pages, and let the task title wrap instead of truncating.
      // Full width; header row grows with a long title; title wraps at a smaller size instead of truncating.
      wideStyle.textContent = `${P}{width:calc(100vw - var(--sn-w,232px) - var(--sn-gap) * 2) !important;grid-template-rows:minmax(90px,auto) 1fr !important}` +
        // A panel (New Post, Reply, …) slid in on top: squeeze into the space to its left instead of hiding under it,
        // and drop the to-do rail so the description keeps room.
        `${P}:has(~ page.open){width:calc(100vw - var(--sn-w,232px) - var(--sn-gap) * 2 - 912px) !important;min-width:520px !important}` +
        `${P}:has(~ page.open) > section > #uxa-asgrail{display:none !important}` +
        `${P} > header{min-height:90px;padding-top:18px;padding-bottom:8px;box-sizing:border-box}` +
        `${P} > header hgroup{min-width:0;flex:1 1 auto}` +
        `${P} > header h1{max-width:none !important;white-space:normal !important;font-size:2.4rem !important;line-height:1.2 !important;margin-top:0 !important;overflow:visible !important}` +
        `${P} > header h5{white-space:normal !important;overflow:visible !important;position:static !important;display:block !important;margin-top:2px !important}` +
        '#uxa-hours{border-collapse:collapse;margin:2px 0 10px;font-size:12px;color:#555}' +
        '#uxa-hours th{font-weight:400;color:#999;text-align:right;padding:0 0 2px 14px}' +
        '#uxa-hours th:first-child{text-align:left;padding-left:0}' +
        '#uxa-hours td{padding:1px 0 1px 14px;text-align:right;white-space:nowrap}' +
        '#uxa-hours td:first-child{text-align:left;padding-left:0;color:#333}';
    }
    if (present && !wideStyle.isConnected) document.head.appendChild(wideStyle);
    if (!present && wideStyle.isConnected) wideStyle.remove();
    asgLayoutStyle(present && asgLayoutOn());
    if (!on) { asg.tabFixed = false; return; }

    const key = qs().get('k');
    assignmentLinks(key);
    if (key && asgLayoutOn()) getAssignment(key).then(a => { if (a.taskKey && aid() === ASSIGN_AID && qs().get('k') === key) asgLayout(a); }).catch(() => {});
    const due = document.querySelector('page.open div.pad-b-l > h2');
    if (!key || !due || due.parentElement.querySelector('#uxa-hours')) return;
    const box = document.createElement('table');
    box.id = 'uxa-hours';
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

  // Small action row under the assignment title: open the task in its schedule, copy task / assignment links.
  function assignmentLinks(key) {
    const hg = document.querySelector('page.open[data-aid="projects.production.assignment"] > header hgroup');
    if (!key || !hg || hg.querySelector('#uxa-asglinks')) return;
    const host = document.createElement('div');
    host.id = 'uxa-asglinks';
    host.style.cssText = 'display:block;margin-top:6px';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { all: initial; display: block; font-family: inherit; color-scheme: light; }
      * { box-sizing: border-box; font-family: inherit; }
      .row { display: flex; flex-wrap: wrap; gap: 6px; }
      a, button { display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 12px; line-height: 1; padding: 6px 10px; border: 1px solid #d6d6d6; border-radius: 999px; background: #fff; color: #333; cursor: pointer; text-decoration: none; }
      a:hover, button:hover { background: #f4f4f4; border-color: #c4c4c4; }
      svg { width: 13px; height: 13px; flex: none; }
      .status { font: inherit; font-size: 12px; font-weight: 600; line-height: 1; padding: 6px 26px 6px 12px; border-radius: 999px; border: 1px solid rgba(0,0,0,.08); background: var(--c, #ddd) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23222' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 10px center / 9px 6px; color: #111; cursor: pointer; appearance: none; -webkit-appearance: none; }
      .status:disabled { opacity: .6; cursor: default; }
      [hidden] { display: none !important; }
    </style>
    <div class="row" hidden>
      <select class="status" title="Assignment status (same as dragging on the Today or project board)" hidden></select>
      <a class="open" title="Open this task in the project schedule, spotlighted"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>Open in schedule</a>
      <button type="button" class="ctask" title="Copy a link that opens the schedule and spotlights this task"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 013.6 3.6L10.6 8M9 11.5l-1.2 1.2a2.6 2.6 0 01-3.6-3.6L5.4 8"/></svg>Copy task link</button>
      <button type="button" class="lay" title="Switch between the new layout (conversation and to-dos inline) and Workamajig's classic tabs"></button>
      <button type="button" class="casg" title="Copy the link to this assignment page"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 013.6 3.6L10.6 8M9 11.5l-1.2 1.2a2.6 2.6 0 01-3.6-3.6L5.4 8"/></svg>Copy assignment link</button>
    </div>`;
    ['click', 'mousedown', 'keydown'].forEach(t => host.addEventListener(t, e => e.stopPropagation()));
    hg.appendChild(host);
    getAssignment(key).then(a => {
      if (!a || !a.projectKey || !a.taskKey) { host.remove(); return; }
      const taskUrl = urls.task(a.projectKey, a.taskKey);
      const open = root.querySelector('.open');
      open.href = taskUrl;
      // Same-tab click: stash the task so the schedule spotlights it (the app strips the #task hash on load).
      open.addEventListener('click', e => {
        if (!plainClick(e)) return;
        e.preventDefault();
        try { sessionStorage.setItem(SS_KEY, String(a.taskKey)); } catch (err) {}
        openApp('projects.schedule.edit2', a.projectKey);
      });
      root.querySelector('.ctask').addEventListener('click', () => copy(taskUrl, 'task link'));
      root.querySelector('.casg').addEventListener('click', () => copy(urls.assignment(key), 'assignment link'));
      const lay = root.querySelector('.lay');
      lay.textContent = asgLayoutOn() ? 'Classic layout' : 'New layout';
      lay.addEventListener('click', () => { setAsgLayout(!asgLayoutOn()); location.reload(); });
      root.querySelector('.row').hidden = false;
      setupStatusSelect(root.querySelector('.status'), a, key);
    }).catch(() => host.remove());
  }

  async function serverPercComp(tuk) {
    try { const t = ((await call('Modules.Projects.Production', 'loadAssignment', { TaskUserKey: Number(tuk) })).table || [])[0]; return t ? +t.PercComp || 0 : null; }
    catch (e) { return null; }
  }

  // Assignment status dropdown: same single-assignment call as the Today board and the project board.
  async function setupStatusSelect(sel, a, tuk) {
    const pg = () => document.querySelector('page.open[data-aid="projects.production.assignment"]');
    const ta = () => { const p = pg(); const m = p && p.view && p.view.module && p.view.module.model; return m && m.taskAssignment; };
    let statuses = [];
    try { statuses = ((await getSchedule(a.projectKey)).raw.taskUserStatus || []).map(x => ({ k: x.k, l: x.l })); } catch (e) {}
    if (!statuses.length) return;
    const current = () => { const t = ta(); return t && t.si && t.si.TaskUserStatusKey > 0 ? t.si.TaskUserStatusKey : 0; };
    const paint = () => {
      const k = current();
      sel.innerHTML = (k ? '' : '<option value="0">No status</option>') + statuses.map(x => `<option value="${x.k}" ${x.k === k ? 'selected' : ''}>${esc(x.l)}</option>`).join('');
      const st = statuses.find(x => x.k === k);
      sel.style.setProperty('--c', (st && STATUS_COLORS[st.l]) || '#e2e2e2');
    };
    paint();
    sel.hidden = false;
    sel.addEventListener('change', async () => {
      const k = Number(sel.value), st = statuses.find(x => x.k === k);
      if (!k || !st) return;
      sel.disabled = true;
      try {
        const res = await call('WJAPP.Modules.Project.Traffic', 'updateAssignmentStatus', { TaskUserKey: Number(tuk), TaskUserStatusKey: k }, true);
        if (res.errors && res.errors.length) throw new Error(res.errors.map(x => x.message).join('; '));
        // Update the page's own model so its "% complete" button and anything bound to it refresh. Mirror Workamajig's
        // Default Percent Complete for the new status (the status call alone doesn't set it), else read back the server's.
        const defPct = statusDefaultPct(st.l);
        let pc = null;
        if (defPct != null) { try { pc = await saveAssignmentPercComp(a.projectKey, Number(tuk), defPct); } catch (e) { pc = await serverPercComp(tuk); } }
        else pc = await serverPercComp(tuk);
        const t = ta();
        if (t && t.si) { t.si.TaskUserStatusKey = k; t.si.StatusName = st.l; if (pc != null) t.si.PercComp = pc; t.fire(); }
        scheduleCache.delete(String(a.projectKey));
        assignmentCache.delete(Number(tuk));
        toast(`Status: ${st.l}`);
      } catch (err) {
        toast('Could not change the status: ' + (err && err.message || err));
      }
      sel.disabled = false;
      paint();
    });
  }

  // "Description of Work" tab: say so when the task has no description, and offer the next step.
  // Rendered in a Shadow DOM: Workamajig's global CSS (e.g. textarea{position:absolute;inset:0;height:100%},
  // button{height:var(--btnHeight)}) would otherwise reshape anything we add to the page.
  function missingDescription(a) {
    if (a.taskDescription) return;
    const sec = document.querySelector('page.open [data-bind-visible="dp@section == \'desc\'"]');
    if (!sec || sec.querySelector('#uxa-nodesc')) return;
    const anchor = sec.querySelector('div.pad-t-l') || sec.firstElementChild;
    const host = document.createElement('div');
    host.id = 'uxa-nodesc';
    host.style.cssText = 'display:block;margin:0 0 20px;max-width:900px';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; display: block; font-family: inherit; color: #333; color-scheme: light; }
        * { box-sizing: border-box; font-family: inherit; }
        .card { border: 1px solid #ecd9a6; border-left: 4px solid #e0a82e; border-radius: 8px; background: #fffaf0; padding: 14px 16px; font-size: 13px; line-height: 1.5; }
        .card.editing { background: #fff; border-color: #d9d9d9; border-left-color: #7ab51d; }
        .title { font-weight: 600; font-size: 14px; color: #333; margin: 0 0 2px; }
        .sub { color: #6b6b6b; margin: 0; }
        .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
        button { font: inherit; font-size: 13px; line-height: 1; padding: 8px 14px; border-radius: 6px; cursor: pointer; border: 1px solid #cfcfcf; background: #fff; color: #333; }
        button:hover:not(:disabled) { background: #f5f5f5; }
        button.primary { background: #7ab51d; border-color: #7ab51d; color: #fff; font-weight: 600; }
        button.primary:hover:not(:disabled) { background: #6a9f18; }
        button:disabled { opacity: .6; cursor: default; }
        textarea { display: block; width: 100%; min-height: 140px; max-height: 50vh; margin-top: 10px; padding: 10px 12px; border: 1px solid #cfcfcf; border-radius: 6px; font: inherit; font-size: 13px; line-height: 1.5; color: #222; background: #fff; caret-color: #222; resize: vertical; overflow: auto; }
        textarea::placeholder { color: #999; }
        textarea::selection { background: #cfe6a8; color: #222; }
        textarea:focus { outline: none; border-color: #7ab51d; box-shadow: 0 0 0 3px rgba(122,181,29,.18); }
        ${RTE_CSS}
        .link { background: none; border: none; padding: 0; color: #1a8fbf; font-size: 12px; cursor: pointer; }
        .link:hover:not(:disabled) { background: none; text-decoration: underline; }
        .spacer { flex: 1; }
        .hint { color: #999; font-size: 11px; }
        .msg { font-size: 12px; margin-top: 8px; }
        .msg.err { color: #c0392b; }
        [hidden] { display: none !important; }
      </style>
      <div class="card">
        <p class="title">This task has no description</p>
        <p class="sub view">Nobody has written down what this assignment is supposed to deliver.</p>
        <p class="sub edit" hidden>Describe what this task should deliver so the assignee can start without guessing.</p>
        <div class="row view">
          <button type="button" class="primary add" hidden>Add a description</button>
          <button type="button" class="ask">Request details in a conversation</button>
        </div>
        <div class="edit" hidden>
          ${rteEditor('')}
          <div class="row">
            <button type="button" class="primary save">Save description</button>
            <button type="button" class="cancel">Cancel</button>
            <button type="button" class="link outline">Insert outline</button>
            <span class="spacer"></span>
            <span class="hint">⌘/Ctrl + Enter to save · Esc to cancel</span>
          </div>
          <div class="msg"></div>
        </div>
      </div>`;
    const $ = sel => root.querySelector(sel);
    const card = $('.card'), save = $('.save'), cancel = $('.cancel'), msg = $('.msg'), ask = $('.ask'), add = $('.add');
    const ed = () => $('.rtein');
    const show = editing => {
      card.classList.toggle('editing', editing);
      root.querySelectorAll('.view').forEach(e => (e.hidden = editing));
      root.querySelectorAll('.edit').forEach(e => (e.hidden = !editing));
      $('.title').textContent = editing ? 'Add a task description' : 'This task has no description';
      if (editing) { wireRte($('.rte')); const e = ed(); if (e) { e.setAttribute('data-ph', 'Goal, scope, inputs and links, and what done looks like…'); e.focus(); } }
    };

    ask.addEventListener('click', async () => {
      ask.disabled = true; ask.textContent = 'Opening a new post…';
      let pm = null;
      try { pm = await resolveProjectManager(a.projectKey); } catch (e) { /* no PM, keep the default recipients */ }
      const req = { taskKey: a.taskKey, projectKey: a.projectKey, taskName: a.taskName, projectName: a.projectName,
        taskUrl: urls.task(a.projectKey, a.taskKey), assignmentUrl: urls.assignment(a.taskUserKey), pm, ts: Date.now() };
      try { sessionStorage.setItem(SS_POST, JSON.stringify(req)); } catch (e) {}
      // Same screen the native "new conversation" button opens, pre-linked to this task.
      openApp('projects.diary.add', a.projectKey, { taskKey: a.taskKey });
      ask.disabled = false; ask.textContent = 'Request details in a conversation';
    });

    if (a.canEditTasks) add.hidden = false;
    add.addEventListener('click', () => { show(true); msg.textContent = ''; });
    cancel.addEventListener('click', () => { show(false); });
    $('.outline').addEventListener('click', () => {
      const e = ed(); if (!e) return; e.focus();
      const outline = '<p>Goal:</p><p>Scope (in / out):</p><p>Inputs and links:</p><p>Done when:</p>';
      if (!e.textContent.trim()) e.innerHTML = outline; else document.execCommand('insertHTML', false, outline);
    });
    // Keep the app's own shortcuts from firing while typing in the editor.
    ['keydown', 'keyup', 'keypress'].forEach(t => root.addEventListener(t, e => {
      if (!(e.target.closest && e.target.closest('.rtein'))) return;
      e.stopPropagation();
      if (t !== 'keydown') return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }
    }));
    save.addEventListener('click', async () => {
      const html = rteRead(root);
      if (!descHasText(html)) { msg.className = 'msg err'; msg.textContent = 'Type a description first.'; const e = ed(); if (e) e.focus(); return; }
      save.disabled = cancel.disabled = true; save.textContent = 'Saving…'; msg.className = 'msg'; msg.textContent = '';
      try {
        await saveTaskDescription(a.projectKey, a.taskKey, html);
        host.remove();
        showDescription(sec, html);
        assignmentCache.delete(Number(a.taskUserKey));
        toast('Description saved');
      } catch (e) {
        save.disabled = cancel.disabled = false; save.textContent = 'Save description';
        msg.className = 'msg err';
        msg.textContent = 'Could not save: ' + (e && e.message || e) + '. You can still add it in the Schedule.';
      }
    });
    anchor ? anchor.insertAdjacentElement('beforebegin', host) : sec.appendChild(host);
  }

  function showDescription(sec, html) {
    const d = document.createElement('div');
    d.className = 'pad-section';
    d.id = 'uxa-desc';
    const h = document.createElement('h2'); h.textContent = 'Task Description';
    const body = document.createElement('div'); body.innerHTML = descToHtml(html);
    d.append(h, body);
    sec.insertAdjacentElement('afterbegin', d);
  }

  // Writes a task description the same way the Schedule page does: a fresh copy of the task row
  // (from getSchedule) with only Description changed, inside the schedule's save envelope.
  // Verified Nov 2026: identical side effects to the native save (DateUpdated bumps on all tasks, nothing else).
  async function saveTaskDescription(projectKey, taskKey, text, expected) {
    projectKey = Number(projectKey); taskKey = Number(taskKey);
    const init = await call('Modules.Projects.Schedule', 'initSchedule', { loaded: true, ProjectKey: projectKey });
    const project = init.project;
    if (!project || !project.ProjectKey) throw new Error('could not load the project');
    if (project.ScheduleLockedByKey) throw new Error('the schedule is currently locked for editing');
    const sched = await call('Modules.Projects.Schedule', 'getSchedule', {
      projectKey, searchKeys: null, includeTransactions: false, loadBucketDetail: false,
      application: SCHED_APP, performRecalc: false, fromNotification: false, origData: null
    });
    const row = (sched.tasks || []).find(t => t.TaskKey === taskKey);
    if (!row) throw new Error('task not found in the schedule');
    const norm = v => String(v || '').replace(/\r\n/g, '\n').trim();
    if (norm(row.Description) !== norm(expected)) {
      throw new Error(norm(expected) ? 'someone else changed this description while you were editing; reload to see their version'
        : 'someone just added a description; reload to see it');
    }
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

  // Rename a task the same proven way saveTaskDescription writes a description: a fresh task row from getSchedule with
  // only TaskName changed, sent in the schedule's save envelope with rowstate 'US' (the same path Workamajig uses when
  // you edit a task name inline on the schedule). Verifies the current server name first, so a stale edit fails safely.
  async function saveTaskName(projectKey, taskKey, name, expected) {
    projectKey = Number(projectKey); taskKey = Number(taskKey);
    name = String(name || '').trim();
    if (!name) throw new Error('enter a task name');
    const init = await call('Modules.Projects.Schedule', 'initSchedule', { loaded: true, ProjectKey: projectKey });
    const project = init.project;
    if (!project || !project.ProjectKey) throw new Error('could not load the project');
    if (project.ScheduleLockedByKey) throw new Error('the schedule is currently locked for editing');
    const sched = await call('Modules.Projects.Schedule', 'getSchedule', {
      projectKey, searchKeys: null, includeTransactions: false, loadBucketDetail: false,
      application: SCHED_APP, performRecalc: false, fromNotification: false, origData: null
    });
    const row = (sched.tasks || []).find(t => t.TaskKey === taskKey);
    if (!row) throw new Error('task not found in the schedule');
    const norm = v => String(v || '').replace(/\s+/g, ' ').trim();
    if (norm(row.TaskName) !== norm(expected)) throw new Error('someone else renamed this task while you were editing; reload to see their version');
    row.TaskName = name; row.rowstate = 'US';
    const res = await call('Modules.Projects.Schedule', 'updateScheduleDM', {
      project, projectKey, tasksDM: { insertedItems: [], updatedItems: [row], deletedItems: [] },
      taskUsersDM: null, predsDM: { insertedItems: [], updatedItems: [], deletedItems: [] },
      removeProjectUsers: [], addedAssignments: [], tasksFromTemplate: 0,
      scheduleSessionID: sched.scheduleSessionID, newMods: null, poUpdateList: []
    }, true);
    if (res.errors && res.errors.length) throw new Error(res.errors.map(e => e.message).join('; '));
    scheduleCache.delete(String(projectKey));
    return name;
  }

  // Delete a task from the card details modal. Same schedule-save envelope as the others, but the full task row goes in
  // tasksDM.deletedItems; Workamajig cascades the task's assignments itself (verified live — no orphaned taskUsers, and
  // the task count drops by exactly one). Verifies the task still exists and its name matches, so a stale modal can't
  // delete the wrong task after a reload.
  async function deleteTask(projectKey, taskKey, expectedName) {
    projectKey = Number(projectKey); taskKey = Number(taskKey);
    const init = await call('Modules.Projects.Schedule', 'initSchedule', { loaded: true, ProjectKey: projectKey });
    const project = init.project;
    if (!project || !project.ProjectKey) throw new Error('could not load the project');
    if (project.ScheduleLockedByKey) throw new Error('the schedule is currently locked for editing');
    const sched = await call('Modules.Projects.Schedule', 'getSchedule', {
      projectKey, searchKeys: null, includeTransactions: false, loadBucketDetail: false,
      application: SCHED_APP, performRecalc: false, fromNotification: false, origData: null
    });
    const row = (sched.tasks || []).find(t => t.TaskKey === taskKey);
    if (!row) throw new Error('this task no longer exists (it may already have been deleted); reload');
    if (expectedName != null) {
      const norm = v => String(v || '').replace(/\s+/g, ' ').trim();
      if (norm(row.TaskName) !== norm(expectedName)) throw new Error('this task changed since you opened it; reload before deleting');
    }
    const res = await call('Modules.Projects.Schedule', 'updateScheduleDM', {
      project, projectKey, tasksDM: { insertedItems: [], updatedItems: [], deletedItems: [row] },
      taskUsersDM: null, predsDM: { insertedItems: [], updatedItems: [], deletedItems: [] },
      removeProjectUsers: [], addedAssignments: [], tasksFromTemplate: 0,
      scheduleSessionID: sched.scheduleSessionID, newMods: null, poUpdateList: []
    }, true);
    if (res.errors && res.errors.length) throw new Error(res.errors.map(e => e.message).join('; '));
    scheduleCache.delete(String(projectKey));
    return true;
  }

  // Set an assignment's planned hours (the "planned" number in the card modal is taskUser.Hours). The taskUser row goes
  // in taskUsersDM.updatedItems with rowstate 'US'; Workamajig recomputes the task's AllocatedHours itself (verified live
  // — setting Hours to N propagates to the task total). Only the assignment's planned hours change, not the budget/estimate.
  async function saveAssignmentHours(projectKey, taskUserKey, hours) {
    projectKey = Number(projectKey); taskUserKey = Number(taskUserKey); hours = Number(hours);
    if (!isFinite(hours) || hours < 0) throw new Error('enter a number of hours (0 or more)');
    const init = await call('Modules.Projects.Schedule', 'initSchedule', { loaded: true, ProjectKey: projectKey });
    const project = init.project;
    if (!project || !project.ProjectKey) throw new Error('could not load the project');
    if (project.ScheduleLockedByKey) throw new Error('the schedule is currently locked for editing');
    const sched = await call('Modules.Projects.Schedule', 'getSchedule', {
      projectKey, searchKeys: null, includeTransactions: false, loadBucketDetail: false,
      application: SCHED_APP, performRecalc: false, fromNotification: false, origData: null
    });
    const tu = (sched.projectTaskUserData || []).find(x => x.TaskUserKey === taskUserKey);
    if (!tu) throw new Error('this assignment no longer exists; reload');
    tu.Hours = hours; tu.rowstate = 'US';
    const res = await call('Modules.Projects.Schedule', 'updateScheduleDM', {
      project, projectKey, tasksDM: { insertedItems: [], updatedItems: [], deletedItems: [] },
      taskUsersDM: { insertedItems: [], updatedItems: [tu], deletedItems: [] },
      predsDM: { insertedItems: [], updatedItems: [], deletedItems: [] },
      removeProjectUsers: [], addedAssignments: [], tasksFromTemplate: 0,
      scheduleSessionID: sched.scheduleSessionID, newMods: null, poUpdateList: []
    }, true);
    if (res.errors && res.errors.length) throw new Error(res.errors.map(e => e.message).join('; '));
    scheduleCache.delete(String(projectKey));
    return hours;
  }

  // The "% Complete" each status is worth, mirroring Workamajig's own "Default Percent Complete" (Scheduling → ⋯ → Edit
  // Assignment Statuses). Natively, setting a status sets the assignment's % to this; the board's updateAssignmentStatus
  // call doesn't, so Project Health and the Projects dashboard drifted. Keyed by status NAME (case-insensitive) so it
  // survives status-key changes; a status not listed here leaves % to Workamajig (we don't guess).
  const STATUS_PCT = { 'backlog': 0, 'ready': 0, 'in progress': 10, 'ready for review/blocked': 80, 'completed': 100 };
  function statusDefaultPct(name) {
    const k = (name || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(STATUS_PCT, k) ? STATUS_PCT[k] : null;
  }
  // Persist an assignment's % Complete the same proven way saveAssignmentHours persists planned hours: the fresh taskUser
  // row from getSchedule, PercComp changed, rowstate 'US', in the schedule save envelope. Called after the status itself
  // is saved, so the row already carries the new status and this touches only the percent.
  async function saveAssignmentPercComp(projectKey, taskUserKey, pct) {
    projectKey = Number(projectKey); taskUserKey = Number(taskUserKey); pct = Number(pct);
    if (!isFinite(pct) || pct < 0 || pct > 100) throw new Error('percent must be 0–100');
    const init = await call('Modules.Projects.Schedule', 'initSchedule', { loaded: true, ProjectKey: projectKey });
    const project = init.project;
    if (!project || !project.ProjectKey) throw new Error('could not load the project');
    if (project.ScheduleLockedByKey) throw new Error('the schedule is currently locked for editing');
    const sched = await call('Modules.Projects.Schedule', 'getSchedule', {
      projectKey, searchKeys: null, includeTransactions: false, loadBucketDetail: false,
      application: SCHED_APP, performRecalc: false, fromNotification: false, origData: null
    });
    const tu = (sched.projectTaskUserData || []).find(x => x.TaskUserKey === taskUserKey);
    if (!tu) throw new Error('this assignment no longer exists; reload');
    if (+tu.PercComp === pct) return pct;  // already there (e.g. Workamajig did apply it) — nothing to write
    tu.PercComp = pct; tu.rowstate = 'US';
    const res = await call('Modules.Projects.Schedule', 'updateScheduleDM', {
      project, projectKey, tasksDM: { insertedItems: [], updatedItems: [], deletedItems: [] },
      taskUsersDM: { insertedItems: [], updatedItems: [tu], deletedItems: [] },
      predsDM: { insertedItems: [], updatedItems: [], deletedItems: [] },
      removeProjectUsers: [], addedAssignments: [], tasksFromTemplate: 0,
      scheduleSessionID: sched.scheduleSessionID, newMods: null, poUpdateList: []
    }, true);
    if (res.errors && res.errors.length) throw new Error(res.errors.map(e => e.message).join('; '));
    scheduleCache.delete(String(projectKey));
    return pct;
  }

  // Set a task's due date the same way saveTaskDescription writes a description: a fresh task row from getSchedule with
  // only the dates changed, in the schedule's save envelope. Keeps Plan Start fixed and sets Plan Complete to the chosen
  // date (recomputing the working-day duration) — like editing Plan Complete in Workamajig's own task panel. If the new
  // date is before the start, the start moves with it.
  async function saveTaskDueDate(projectKey, taskKey, newYmd) {
    projectKey = Number(projectKey); taskKey = Number(taskKey);
    const init = await call('Modules.Projects.Schedule', 'initSchedule', { loaded: true, ProjectKey: projectKey });
    const project = init.project;
    if (!project || !project.ProjectKey) throw new Error('could not load the project');
    if (project.ScheduleLockedByKey) throw new Error('the schedule is currently locked for editing');
    const sched = await call('Modules.Projects.Schedule', 'getSchedule', {
      projectKey, searchKeys: null, includeTransactions: false, loadBucketDetail: false,
      application: SCHED_APP, performRecalc: false, fromNotification: false, origData: null
    });
    const row = (sched.tasks || []).find(t => t.TaskKey === taskKey);
    if (!row) throw new Error('task not found in the schedule');
    const dpart = s => String(s || '').slice(0, 10);
    const tpart = s => { const m = /T.*/.exec(String(s || '')); return m ? m[0] : 'T00:00:00'; };
    const D = v => new Date(v + 'T00:00:00');
    const workingDays = (a, b) => { if (b < a) return 1; let d = new Date(a), n = 0; while (d <= b) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; d.setDate(d.getDate() + 1); } return n || 1; };
    let start = dpart(row.PlanStart) || newYmd;
    if (D(newYmd) < D(start)) start = newYmd; // a task can't finish before it starts
    row.PlanStart = start + tpart(row.PlanStart);
    row.PlanComplete = newYmd + tpart(row.PlanComplete);
    row.PlanDuration = workingDays(D(start), D(newYmd));
    row.rowstate = 'US';
    const res = await call('Modules.Projects.Schedule', 'updateScheduleDM', {
      project, projectKey, tasksDM: { insertedItems: [], updatedItems: [row], deletedItems: [] },
      taskUsersDM: null, predsDM: { insertedItems: [], updatedItems: [], deletedItems: [] },
      removeProjectUsers: [], addedAssignments: [], tasksFromTemplate: 0,
      scheduleSessionID: sched.scheduleSessionID, newMods: null, poUpdateList: []
    }, true);
    if (res.errors && res.errors.length) throw new Error(res.errors.map(e => e.message).join('; '));
    scheduleCache.delete(String(projectKey));
    return { PlanStart: row.PlanStart, PlanComplete: row.PlanComplete };
  }

  // Create a brand-new top-level task due on a given day. Built to match Workamajig's own native "insert row" + Save
  // payload field-for-field — captured live from a native insert (Nov 2026) and replicated here, rather than inferred
  // from the read schema (the insert DM differs: TaskType 2 for a leaf, singular BudgetExpense/EstExpense, ApprovedCHLabor,
  // a self-referential BudgetTaskKey -1, TaskColor, the tuhTaskParms time-phasing window, and NO per-row rowstate — the
  // insertedItems bucket itself marks the insertion). v1 scope: a top-level task appended at the end, 1-day on the due
  // date, default priority (3-Medium), no assignee. Only the name, dates, numbering and week window are per-task.
  async function createTask(projectKey, name, dueYmd) {
    projectKey = Number(projectKey);
    name = String(name || '').trim();
    if (!name) throw new Error('enter a task name');
    const init = await call('Modules.Projects.Schedule', 'initSchedule', { loaded: true, ProjectKey: projectKey });
    const project = init.project;
    if (!project || !project.ProjectKey) throw new Error('could not load the project');
    if (project.ScheduleLockedByKey) throw new Error('the schedule is currently locked for editing');
    const sched = await call('Modules.Projects.Schedule', 'getSchedule', {
      projectKey, searchKeys: null, includeTransactions: false, loadBucketDetail: false,
      application: SCHED_APP, performRecalc: false, fromNotification: false, origData: null
    });
    const tasks = sched.tasks || [];
    const topNums = tasks.filter(t => !String(t.TaskID || '').includes('.'))
      .map(t => parseInt(t.TaskID, 10)).filter(n => Number.isFinite(n));
    const nextNum = (topNums.length ? Math.max.apply(null, topNums) : 0) + 1;
    const nextOrder = tasks.reduce((m, t) => Math.max(m, Number(t.ProjectOrder) || 0), 0) + 1;
    const count = tasks.length;
    const dt = dueYmd + 'T00:00:00';
    // The Mon–Sun week that contains the due date — matches WMJ's native time-phasing bucket window.
    const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + 'T00:00:00';
    const due = new Date(dt);
    const wkStart = new Date(due); wkStart.setDate(due.getDate() + (due.getDay() === 0 ? -6 : 1 - due.getDay()));
    const wkEnd = new Date(wkStart); wkEnd.setDate(wkStart.getDate() + 6);
    const row = {
      TaskKey: -1, ProjectKey: projectKey, SummaryTaskKey: 0, TaskName: name, TaskType: 2,
      TaskAssignmentTypeKey: null, TaskColor: '#0000FF', TrackBudget: 1, MoneyTask: 1, HourlyRate: 0,
      IOCommission: 0, ShowDescOnEst: 0, ServiceKey: null, Taxable: 0, Taxable2: 0, HideFromClient: 0,
      EstHours: 0, BudgetLabor: 0, EstLabor: 0, BudgetExpense: 0, EstExpense: 0,
      ApprovedCOHours: 0, ApprovedCHLabor: 0, ApprovedCOBudgetLabor: 0, ApprovedCOExpense: 0, ApprovedCOBudgetExp: 0,
      Contingency: 0, MasterTaskKey: 0, AllowAnyone: 0, EstimateHours: 0, FormCount: 0, ActualHours: 0,
      AllocatedHours: 0, AttachmentCount: 0, TaskConstraint: 0, ConstraintName: 'As Soon As Possible', WorkAnyDay: 0,
      PercComp: 0, PercCompSeparate: 1, PredecessorsComplete: 1, TaskPriorityKey: 205, PriorityName: '3-Medium',
      ScheduleTask: 1, TCProjectStatusKey: null, TCProjectStatus: '', TCProjectStatusID: '',
      PlanStart: dt, PlanComplete: dt, PlanDuration: 1, depth: 0, DisplayOrder: nextNum, TaskLevel: 0,
      ProjectOrder: nextOrder, TaskID: String(nextNum), additionalData: [], _idx: count,
      AssignedFullName: '', Assigned: '', AssignedServiceCodes: '', AssignedServiceDescription: '',
      BlockoutConflict: false, AssignedPreds: '', batch: 0,
      tuhTaskParms: {
        cols: [], bucketDelta: 0, status: '', PlanStart: dt, PlanComplete: dt,
        planningProjectAutoRollover: false, workDays: [0, 1, 1, 1, 1, 1, 0], fusionPastBucket: false, bucketPerWeek: false,
        buckets: [{ startDate: ymd(wkStart), endDate: ymd(wkEnd), prevWeek: false }]
      },
      insertedTaskProjectRollup: true, scheduled: true, scheduleOrder: count, maxDate: dt, ConstraintDate: dt,
      TaskStatus: 1, ScheduleNote: '', EventStart: null, EventEnd: null, BudgetTaskKey: -1
    };
    const res = await call('Modules.Projects.Schedule', 'updateScheduleDM', {
      project, projectKey, tasksDM: { insertedItems: [row], updatedItems: [], deletedItems: [] },
      taskUsersDM: null, predsDM: { insertedItems: [], updatedItems: [], deletedItems: [] },
      removeProjectUsers: [], addedAssignments: [], tasksFromTemplate: 0,
      scheduleSessionID: sched.scheduleSessionID, newMods: null, poUpdateList: []
    }, true);
    if (res.errors && res.errors.length) throw new Error(res.errors.map(e => e.message).join('; '));
    scheduleCache.delete(String(projectKey));
    return true;
  }

  // ---- assignments: add a person to a task, and move an assignment in time (Resource Schedule) ----
  // Both captured from / verified against Workamajig's own schedule save on a test task (Nov 2026).
  const schedRead = projectKey => call('Modules.Projects.Schedule', 'getSchedule', {
    projectKey, searchKeys: null, includeTransactions: false, loadBucketDetail: false,
    application: SCHED_APP, performRecalc: false, fromNotification: false, origData: null
  });
  const schedWorkDays = (aYmd, bYmd) => { const a = new Date(aYmd + 'T00:00:00'), b = new Date(bYmd + 'T00:00:00'); let n = 0; for (const d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; } return n || 1; };
  const schedTime = v => { const m = /T.*/.exec(String(v || '')); return m ? m[0] : 'T00:00:00'; };
  // Set a task row's plan span (keeps each field's time part), marking it for update.
  function schedSetTaskSpan(row, startYmd, endYmd) {
    row.PlanStart = startYmd + schedTime(row.PlanStart); row.PlanComplete = endYmd + schedTime(row.PlanComplete);
    row.PlanDuration = schedWorkDays(startYmd, endYmd); row.rowstate = 'US';
  }
  async function schedSave(projectKey, project, sched, tasksUpd, tuIns, tuUpd, added) {
    const res = await call('Modules.Projects.Schedule', 'updateScheduleDM', {
      project, projectKey, tasksDM: { insertedItems: [], updatedItems: tasksUpd, deletedItems: [] },
      taskUsersDM: { insertedItems: tuIns, updatedItems: tuUpd, deletedItems: [] },
      predsDM: { insertedItems: [], updatedItems: [], deletedItems: [] },
      removeProjectUsers: [], addedAssignments: added, tasksFromTemplate: 0,
      scheduleSessionID: sched.scheduleSessionID, newMods: null, poUpdateList: []
    }, true);
    if (res.errors && res.errors.length) throw new Error(res.errors.map(e => e.message).join('; '));
    scheduleCache.delete(String(projectKey));
  }
  // Assign a person to a task for a date span and a number of hours. task = { taskKey } for an existing task, or
  // { name } to create a new top-level task first. The inserted taskUser row mirrors the one Workamajig's own
  // assignment panel sends (TaskUserKey -1, the default status unless statusKey names another, APlanStart/APlanComplete, and the user's key in
  // addedAssignments so they join the project team). Workamajig's UI refuses assignment dates outside the task's own
  // dates but its server does not, so we widen the task's span to contain the assignment (never shrink it).
  async function addAssignment(projectKey, task, userKey, userName, hours, startYmd, endYmd, statusKey) {
    projectKey = Number(projectKey); userKey = Number(userKey); hours = Number(hours);
    if (!(projectKey > 0)) throw new Error('pick a project');
    if (!(userKey > 0)) throw new Error('no person selected');
    if (!isFinite(hours) || hours < 0) throw new Error('enter a number of hours (0 or more)');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(endYmd)) throw new Error('pick a start and end date');
    if (endYmd < startYmd) throw new Error('the end date is before the start date');
    let taskKey = Number(task && task.taskKey) || 0, created = false;
    if (!taskKey) {
      const name = String((task && task.name) || '').trim();
      if (!name) throw new Error('pick a task or enter a name for a new one');
      const had = new Set(((await schedRead(projectKey)).tasks || []).map(t => t.TaskKey));
      await createTask(projectKey, name, endYmd);
      const made = ((await schedRead(projectKey)).tasks || []).filter(t => !had.has(t.TaskKey) && String(t.TaskName || '').trim() === name).sort((a, b) => b.TaskKey - a.TaskKey)[0];
      if (!made) throw new Error('the task was created but could not be found again; reload and assign it from the schedule');
      taskKey = made.TaskKey; created = true;
    }
    const init = await call('Modules.Projects.Schedule', 'initSchedule', { loaded: true, ProjectKey: projectKey });
    const project = init.project;
    if (!project || !project.ProjectKey) throw new Error('could not load the project');
    if (project.ScheduleLockedByKey) throw new Error('the schedule is currently locked for editing');
    const sched = await schedRead(projectKey);
    const t = (sched.tasks || []).find(x => x.TaskKey === taskKey);
    if (!t) throw new Error('that task no longer exists; reload');
    if ((sched.projectTaskUserData || []).some(x => x.TaskKey === taskKey && x.UserKey === userKey)) throw new Error((userName || 'This person') + ' is already assigned to that task');
    const sts = sched.taskUserStatus || [], st = (Number(statusKey) > 0 && sts.find(x => x.k === Number(statusKey))) || sts.find(x => x.IsDefault) || sts[0] || {};
    const pct = statusDefaultPct(st.l);   // a status other than the default starts at that status's own % complete
    const u = (sched.users || []).find(x => x.UserKey === userKey) || {};
    const name = u.UserName || userName || '';
    const tasksUpd = [], ts = String(t.PlanStart || '').slice(0, 10), te = String(t.PlanComplete || '').slice(0, 10);
    const ns = created || !ts || startYmd < ts ? startYmd : ts, ne = created || !te || endYmd > te ? endYmd : te;
    if (ns !== ts || ne !== te) { schedSetTaskSpan(t, ns, ne); tasksUpd.push(t); }
    const row = {
      TaskUserKey: -1, TaskKey: taskKey, TaskUserStatusKey: st.k, StatusName: st.l || '', ServiceKey: 0, ServiceDescription: '',
      ActualHours: 0, UserKey: userKey, UserName: name, PercComp: pct == null ? 0 : pct, ProjectKey: projectKey, _idx: 0,
      Initials: u.Initials || name.split(/\s+/).map(w => w[0] || '').join('').toUpperCase(), batch: 0, ConflictChanged: 0, BlockoutConflict: 0,
      Hours: hours, ManualAdjustment: 0, APlanStart: startYmd + 'T00:00:00', APlanComplete: endYmd + 'T00:00:00', ActStart: ''
    };
    await schedSave(projectKey, project, sched, tasksUpd, [row], [], [userKey]);
    return { taskKey, created };
  }
  // Move an assignment to a new date span. If it is the task's only assignment and carries no dates of its own, the
  // TASK moves (the assignment follows it, as it did before). Otherwise the assignment gets its own dates and the task's
  // span is widened to contain them — other people's work on the task is never moved.
  async function saveAssignmentDates(projectKey, taskUserKey, startYmd, endYmd) {
    projectKey = Number(projectKey); taskUserKey = Number(taskUserKey);
    if (endYmd < startYmd) throw new Error('the end date is before the start date');
    const init = await call('Modules.Projects.Schedule', 'initSchedule', { loaded: true, ProjectKey: projectKey });
    const project = init.project;
    if (!project || !project.ProjectKey) throw new Error('could not load the project');
    if (project.ScheduleLockedByKey) throw new Error('the schedule is currently locked for editing');
    const sched = await schedRead(projectKey);
    const tu = (sched.projectTaskUserData || []).find(x => x.TaskUserKey === taskUserKey);
    if (!tu) throw new Error('this assignment no longer exists; reload');
    const t = (sched.tasks || []).find(x => x.TaskKey === tu.TaskKey);
    if (!t) throw new Error('the task no longer exists; reload');
    const alone = (sched.projectTaskUserData || []).filter(x => x.TaskKey === tu.TaskKey).length === 1;
    const ts = String(t.PlanStart || '').slice(0, 10), te = String(t.PlanComplete || '').slice(0, 10);
    // exactly what we are about to change, so the move can be undone (restoreAssignmentDates)
    const before = { taskStart: t.PlanStart, taskEnd: t.PlanComplete, taskDuration: t.PlanDuration, aStart: tu.APlanStart || null, aEnd: tu.APlanComplete || null };
    const tasksUpd = [], tuUpd = [];
    if (alone && !tu.APlanStart && !tu.APlanComplete) { schedSetTaskSpan(t, startYmd, endYmd); tasksUpd.push(t); }
    else {
      tu.APlanStart = startYmd + 'T00:00:00'; tu.APlanComplete = endYmd + 'T00:00:00'; tu.rowstate = 'US'; tuUpd.push(tu);
      const ns = alone || !ts || startYmd < ts ? startYmd : ts, ne = alone || !te || endYmd > te ? endYmd : te;
      if (ns !== ts || ne !== te) { schedSetTaskSpan(t, ns, ne); tasksUpd.push(t); }
    }
    await schedSave(projectKey, project, sched, tasksUpd, [], tuUpd, []);
    return before;
  }
  // Undo a saveAssignmentDates: put the task's span and the assignment's own dates back exactly as they were (the
  // `before` it returned). Only rows that actually differ are sent.
  async function restoreAssignmentDates(projectKey, taskUserKey, before) {
    projectKey = Number(projectKey); taskUserKey = Number(taskUserKey);
    const init = await call('Modules.Projects.Schedule', 'initSchedule', { loaded: true, ProjectKey: projectKey });
    const project = init.project;
    if (!project || !project.ProjectKey) throw new Error('could not load the project');
    if (project.ScheduleLockedByKey) throw new Error('the schedule is currently locked for editing');
    const sched = await schedRead(projectKey);
    const tu = (sched.projectTaskUserData || []).find(x => x.TaskUserKey === taskUserKey);
    if (!tu) throw new Error('this assignment no longer exists; reload');
    const t = (sched.tasks || []).find(x => x.TaskKey === tu.TaskKey);
    if (!t) throw new Error('the task no longer exists; reload');
    const tasksUpd = [], tuUpd = [], d10 = v => String(v || '').slice(0, 10);
    if (d10(t.PlanStart) !== d10(before.taskStart) || d10(t.PlanComplete) !== d10(before.taskEnd)) {
      t.PlanStart = before.taskStart; t.PlanComplete = before.taskEnd; t.PlanDuration = before.taskDuration; t.rowstate = 'US'; tasksUpd.push(t);
    }
    if (d10(tu.APlanStart) !== d10(before.aStart) || d10(tu.APlanComplete) !== d10(before.aEnd)) {
      tu.APlanStart = before.aStart; tu.APlanComplete = before.aEnd; tu.rowstate = 'US'; tuUpd.push(tu);
    }
    if (tasksUpd.length || tuUpd.length) await schedSave(projectKey, project, sched, tasksUpd, [], tuUpd, []);
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
      catch (e) { console.warn('[uxa] prefill failed', e); }
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

  // ---------- Assignment page layout: description + conversation in the main column, to-dos in a right rail ----------
  // Workamajig's own side column moves to the right (CSS order only) and loses the donut charts; the To Do List and
  // Conversations tabs are hidden because both now show inline. Everything we add is a Shadow DOM host.
  // "Classic layout" in the action row turns it off (remembered per browser).
  const ASG_LAYOUT_PREF = 'uxa.asgLayout';
  const SS_REPLY = 'uxa.pendingReply';
  const asgLayoutOn = () => { try { return localStorage.getItem(ASG_LAYOUT_PREF) !== 'classic'; } catch (e) { return true; } };
  const setAsgLayout = on => { try { localStorage.setItem(ASG_LAYOUT_PREF, on ? 'new' : 'classic'); } catch (e) {} };
  const ASG = 'page.open[data-aid="projects.production.assignment"]';
  const asg = { reload: false };
  let asgStyle;
  function asgLayoutStyle(on) {
    if (!asgStyle) {
      asgStyle = document.createElement('style');
      asgStyle.id = 'uxa-asg2';
      asgStyle.textContent =
        `${ASG} > section > sidesection div.pad-b-l > div.muted.x1-2,${ASG} > section > sidesection div.pad-b-l > div:has(canvas){display:none !important}` +
        `${ASG} button[data-action="clickTab"][data-key="todo"],${ASG} button[data-action="clickTab"][data-key="conv"]{display:none !important}`;
    }
    if (on && !asgStyle.isConnected) document.head.appendChild(asgStyle);
    if (!on && asgStyle.isConnected) asgStyle.remove();
  }

  function asgLayout(a) {
    const pg = document.querySelector(ASG);
    if (!pg) return;
    // Inline to-dos and conversations replace those tabs, so keep the page on Description of Work.
    const dp = pg.view && pg.view.module && pg.view.module.model && pg.view.module.model.dp;
    if (dp && (dp.section === 'todo' || dp.section === 'conv') && !asg.tabFixed) {
      const tab = pg.querySelector('button[data-action="clickTab"][data-key="desc"]');
      if (tab) { tab.click(); asg.tabFixed = true; }
    }
    // The app can reuse this page for another assignment; drop hosts that belong to a different task.
    pg.querySelectorAll('#uxa-asgtodo, #uxa-asgconv').forEach(h => { if (h.dataset.tk !== String(a.taskKey)) h.remove(); });
    // Workamajig's side column stays on the left; to-dos get their own rail on the right of the page.
    const body = pg.querySelector(':scope > section > page-body');
    let rail = pg.querySelector(':scope > section > #uxa-asgrail');
    if (body && !rail) {
      rail = document.createElement('aside');
      rail.id = 'uxa-asgrail';
      rail.style.cssText = 'display:block;flex:none;width:300px;box-sizing:border-box;border-left:1px solid #ececec;background:#fafafa;padding:20px 18px;overflow:auto';
      body.insertAdjacentElement('afterend', rail);
    }
    if (rail && !rail.querySelector('#uxa-asgtodo')) rail.appendChild(asgTodoHost(a));
    const sec = pg.querySelector('[data-bind-visible="dp@section == \'desc\'"]');
    let conv = sec && sec.querySelector('#uxa-asgconv');
    if (sec && !conv) {
      conv = asgConvHost(a);
      const pd = sec.querySelector(':scope > div.pad-t-l');
      pd ? pd.insertAdjacentElement('beforebegin', conv) : sec.appendChild(conv);
    } else if (conv && asg.reload) {
      // Back from a reply or new post: show it.
      conv.uxaLoad && conv.uxaLoad();
      const td = pg.querySelector('#uxa-asgtodo'); td && td.uxaLoad && td.uxaLoad();
    }
    asg.reload = false;
  }

  const SHADOW_BASE = `:host { all: initial; display: block; font-family: inherit; color: #333; color-scheme: light; }
      * { box-sizing: border-box; font-family: inherit; }
      [hidden] { display: none !important; }
      button { font: inherit; cursor: pointer; }
      .cap { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: #8a8a8a; margin: 0 0 8px; display: flex; align-items: center; gap: 6px; }
      .count { font-size: 11px; font-weight: 600; color: #666; background: #ececec; border-radius: 999px; padding: 1px 7px; letter-spacing: 0; }
      .muted { color: #999; font-size: 12px; }
      .err { color: #c0392b; font-size: 12px; margin-top: 6px; }
      .link { border: 0; background: none; padding: 0; color: #1a8fbf; font-size: 12px; text-decoration: underline; }
      .btn { font-size: 12px; line-height: 1; padding: 8px 12px; border: 1px solid #cfcfcf; border-radius: 6px; background: #fff; color: #333; white-space: nowrap; }
      .btn:hover:not(:disabled) { background: #f4f4f4; }
      .btn:disabled { opacity: .6; cursor: default; }
      input[type=text], textarea { font: inherit; font-size: 13px; color: #222; background: #fff; border: 1px solid #cfcfcf; border-radius: 6px; padding: 7px 9px; caret-color: #222; }
      input[type=text]:focus, textarea:focus { outline: none; border-color: #7ab51d; box-shadow: 0 0 0 3px rgba(122,181,29,.15); }`;

  // Keep the app's keyboard shortcuts out of our fields.
  const guardKeys = host => ['keydown', 'keyup', 'keypress'].forEach(t => host.addEventListener(t, e => e.stopPropagation()));

  // ----- right rail: to-dos (same calls as the board modal and the Schedule page) -----
  function asgTodoHost(a) {
    const host = document.createElement('div');
    host.id = 'uxa-asgtodo';
    host.dataset.tk = String(a.taskKey);
    host.style.cssText = 'display:block';
    const root = host.attachShadow({ mode: 'open' });
    const st = { todos: null, showDone: false, msg: '', busy: false };
    const R = () => (window.System && System.rights) || {};
    const enabled = () => !!(window.System && System.prefs && System.prefs.UseToDo) && R().prjViewToDos !== false;
    root.innerHTML = `<style>${SHADOW_BASE}
      .td { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; font-size: 13px; line-height: 1.35; border-bottom: 1px solid #efefef; }
      .td input { margin: 2px 0 0; flex: none; width: 15px; height: 15px; accent-color: #7ab51d; cursor: pointer; }
      .td .s { flex: 1; min-width: 0; word-break: break-word; }
      .td small { display: block; color: #999; font-size: 11px; margin-top: 2px; }
      .td.done .s { color: #999; text-decoration: line-through; }
      .td .del { visibility: hidden; border: 0; background: none; color: #aaa; font-size: 16px; line-height: 1; padding: 0 2px; }
      .td:hover .del { visibility: visible; }
      .td .del:hover { color: #c0392b; }
      .add { display: flex; gap: 6px; margin-top: 10px; }
      .add input { flex: 1; min-width: 0; }
      .more { margin-top: 6px; }
    </style><div class="cap">To-dos <span class="count">…</span></div><div class="body"><div class="muted">Loading…</div></div>`;
    const load = async () => {
      if (!enabled()) { host.hidden = true; return; }
      try {
        const res = await call('Modules.Projects.Schedule', 'loadScheduleToDos', { projectKey: Number(a.projectKey), copyToDoList: null }, true);
        if (res.errors && res.errors.length) throw new Error(res.errors[0].message);
        st.todos = ((res.data && res.data.todos) || []).filter(x => x.TaskKey === a.taskKey);
        st.msg = '';
      } catch (e) { st.todos = st.todos || []; st.msg = 'Could not load to-dos: ' + (e && e.message || e); }
      render();
    };
    host.uxaLoad = load;
    const render = () => {
      const canAdd = R().prjEditToDos !== false, canDel = !!R().prjDeleteToDos;
      const all = (st.todos || []).slice().sort((x, y) => (x.Completed - y.Completed) || ((x.DisplayOrder || 0) - (y.DisplayOrder || 0)));
      const open = all.filter(x => !x.Completed), done = all.filter(x => x.Completed);
      root.querySelector('.count').textContent = open.length;
      const meta = x => [x.UserFullName && x.UserFullName !== 'Not Assigned' ? esc(x.UserFullName) : '', x.ActivityDate ? 'Due ' + esc(fmtDate(x.ActivityDate)) : '', x.StatusName ? esc(x.StatusName) : ''].filter(Boolean).join(' · ');
      const row = x => `<div class="td ${x.Completed ? 'done' : ''}"><input type="checkbox" data-k="${x.ActivityKey}" ${x.Completed ? 'checked' : ''} ${canAdd ? '' : 'disabled'} title="${x.Completed ? 'Mark open' : 'Mark complete'}"><span class="s">${esc(x.Subject || '(no subject)')}${meta(x) ? `<small>${meta(x)}</small>` : ''}</span>${canDel ? `<button type="button" class="del" data-k="${x.ActivityKey}" title="Delete to-do">×</button>` : ''}</div>`;
      const draft = root.querySelector('.new'); const val = draft ? draft.value : ''; const hadFocus = root.activeElement === draft;
      root.querySelector('.body').innerHTML =
        (open.map(row).join('') || `<div class="muted">${all.length ? 'All done.' : 'No to-dos on this task yet.'}</div>`) +
        (done.length ? `<div class="more"><button type="button" class="link tog">${st.showDone ? 'Hide' : 'Show'} ${done.length} completed</button></div>${st.showDone ? done.map(row).join('') : ''}` : '') +
        (canAdd ? `<div class="add"><input type="text" class="new" placeholder="Add a to-do and press Enter"><button type="button" class="btn plus">Add</button></div>` : '') +
        (st.msg ? `<div class="err">${esc(st.msg)}</div>` : '');
      const n = root.querySelector('.new');
      if (n) { n.value = val; if (hadFocus || st.refocus) { n.focus(); st.refocus = false; } }
    };
    const add = async () => {
      const n = root.querySelector('.new'); const subject = (n && n.value || '').trim();
      if (!subject || st.busy) return;
      st.busy = true; n.disabled = true;
      const pk = Number(a.projectKey);
      try {
        const res = await call('Modules.Projects.Schedule', 'updateToDo', { projectKey: pk, todos: [{ ActivityKey: -1, ProjectKey: pk, TaskKey: a.taskKey, Subject: subject, Completed: 0, StatusName: '', rowstate: 'I' }] }, true);
        if (res.errors && res.errors.length) throw new Error(res.errors.map(x => x.message).join('; '));
        const map = ((res.data && res.data.keyMap) || []).find(x => x.OldKey === -1);
        st.todos.push({ ActivityKey: map ? map.NewKey : Date.now(), TaskKey: a.taskKey, Subject: subject, Completed: 0, StatusName: '', DisplayOrder: 999 });
        n.value = ''; st.msg = ''; st.refocus = true;
      } catch (e) { st.msg = 'Could not add: ' + (e && e.message || e); }
      st.busy = false; n.disabled = false;
      render();
    };
    root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('new')) { e.preventDefault(); add(); } });
    root.addEventListener('click', async e => {
      const t = e.target;
      if (t.classList.contains('plus')) return add();
      if (t.classList.contains('tog')) { st.showDone = !st.showDone; return render(); }
      if (t.classList.contains('del')) {
        const k = Number(t.dataset.k), td = st.todos.find(x => x.ActivityKey === k); if (!td) return;
        if (!confirm(`Delete the to-do "${td.Subject}"? This can't be undone.`)) return;
        try {
          const res = await call('Modules.Projects.Production', 'deleteToDo', { ActivityKey: k, ProjectKey: Number(a.projectKey), TaskKey: td.TaskKey }, true);
          if (res.errors && res.errors.length) throw new Error(res.errors.map(x => x.message).join('; '));
          st.todos = st.todos.filter(x => x.ActivityKey !== k); st.msg = '';
        } catch (err) { st.msg = 'Could not delete: ' + (err && err.message || err); }
        render();
      }
    });
    root.addEventListener('change', async e => {
      const t = e.target; if (t.type !== 'checkbox') return;
      const k = Number(t.dataset.k), td = st.todos.find(x => x.ActivityKey === k); if (!td) return;
      const prev = td.Completed; td.Completed = t.checked ? 1 : 0; render();
      try {
        const row = Object.assign({}, td, { ProjectKey: Number(a.projectKey), StatusName: td.StatusName || '', rowstate: 'U' });
        const res = await call('Modules.Projects.Schedule', 'updateToDo', { projectKey: Number(a.projectKey), todos: [row] }, true);
        if (res.errors && res.errors.length) throw new Error(res.errors.map(x => x.message).join('; '));
      } catch (err) { td.Completed = prev; st.msg = 'Could not update: ' + (err && err.message || err); render(); }
    });
    ['click', 'mousedown'].forEach(t => host.addEventListener(t, e => e.stopPropagation()));
    guardKeys(host);
    load();
    return host;
  }

  // Post bodies are HTML written by people (and email replies). Keep simple formatting and links, drop everything else.
  function cleanPostHtml(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const keep = new Set(['P', 'BR', 'A', 'B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'SPAN', 'DIV', 'BLOCKQUOTE', 'IMG', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'PRE', 'CODE', 'HR']);
    const drop = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'SVG', 'MATH', 'TEMPLATE']);
    [...doc.body.querySelectorAll('*')].reverse().forEach(el => {
      if (drop.has(el.tagName)) { el.remove(); return; }
      if (!keep.has(el.tagName)) { el.replaceWith(...el.childNodes); return; }
      const href = el.tagName === 'A' ? el.getAttribute('href') || '' : '';
      const src = el.tagName === 'IMG' ? el.getAttribute('src') || '' : '';
      [...el.attributes].forEach(at => el.removeAttribute(at.name));
      if (el.tagName === 'A') {
        if (/^(https?:|mailto:)/i.test(href.trim())) { el.setAttribute('href', href.trim()); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      }
      if (el.tagName === 'IMG') {
        if (/^(https:\/\/|\/platinum\/)/i.test(src.trim())) el.setAttribute('src', src.trim()); else el.remove();
      }
    });
    return doc.body.innerHTML;
  }

  // d is a UTC timestamp without a zone ("2026-07-24T21:42:00").
  const fmtWhen = d => {
    if (!d) return '';
    const x = new Date(String(d).slice(0, 19) + 'Z');
    if (isNaN(x)) return '';
    const sameYear = x.getFullYear() === new Date().getFullYear();
    return x.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' }) + ', ' + x.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  };

  // ----- main column: this task's conversations, threaded, with a reply box per thread -----
  // opts.compact: smaller heading for the board modal. opts.onNavigate: called before opening another screen.
  function asgConvHost(a, opts = {}) {
    const host = document.createElement('div');
    if (!opts.compact) host.id = 'uxa-asgconv';
    host.dataset.tk = String(a.taskKey);
    host.style.cssText = opts.compact ? 'display:block;margin:4px 0 0' : 'display:block;margin:8px 0 28px;max-width:920px';
    const nav = (...args) => { if (opts.onNavigate) opts.onNavigate(); openApp(...args); };
    const root = host.attachShadow({ mode: 'open' });
    const st = { posts: null, err: '', open: new Set(), more: new Set(), drafts: {} };
    root.innerHTML = `<style>${SHADOW_BASE}
      :host { font-size: 13px; }
      .top { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; }
      .top h2 { font-size: ${opts.compact ? '11px' : '20px'}; font-weight: ${opts.compact ? 600 : 500}; color: ${opts.compact ? '#8a8a8a' : '#333'}; margin: 0; ${opts.compact ? 'text-transform: uppercase; letter-spacing: .05em;' : ''} }
      .top .sp { flex: 1; }
      .thread { border: 1px solid #e6e6e6; border-radius: 10px; background: #fff; margin: 0 0 14px; overflow: hidden; }
      .subj { display: flex; align-items: baseline; gap: 8px; padding: 10px 14px; background: #fafafa; border-bottom: 1px solid #eee; font-weight: 600; font-size: 13px; color: #333; }
      .subj .s { flex: 1; min-width: 0; }
      .subj .open { font-weight: 400; }
      .msg { display: flex; gap: 10px; padding: 12px 14px 4px; }
      .msg + .msg { border-top: 1px solid #f2f2f2; }
      .av { width: 30px; height: 30px; border-radius: 50%; flex: none; background: #e4e4e4 center/cover no-repeat; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: #666; overflow: hidden; position: relative; }
      .av img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .mb { flex: 1; min-width: 0; }
      .who { font-size: 12px; color: #999; margin-bottom: 2px; }
      .who b { color: #333; font-weight: 600; margin-right: 6px; }
      .txt { font-size: 13px; line-height: 1.5; color: #333; word-break: break-word; overflow-wrap: anywhere; }
      .txt p { margin: 0 0 8px; }
      .txt img { max-width: 100%; height: auto; }
      .txt a { color: #1a8fbf; }
      .txt table { border-collapse: collapse; } .txt td, .txt th { border: 1px solid #e3e3e3; padding: 3px 6px; }
      .clamp { max-height: 9.5em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
      .new { font-size: 10px; font-weight: 600; color: #1a6fa0; background: #e3f1fa; border-radius: 999px; padding: 1px 6px; margin-left: 4px; }
      .att { font-size: 11px; color: #888; margin: 0 0 8px; }
      .tog { margin: 0 0 8px; }
      .earlier { padding: 8px 14px 0 54px; }
      .reply { display: flex; gap: 8px; align-items: flex-end; padding: 10px 14px 12px 54px; border-top: 1px solid #f2f2f2; }
      .reply textarea { flex: 1; min-width: 0; min-height: 36px; max-height: 240px; resize: vertical; line-height: 1.4; }
      .hint { font-size: 11px; color: #aaa; padding: 0 14px 10px 54px; margin-top: -6px; }
      .empty { border: 1px dashed #d8d8d8; border-radius: 10px; padding: 16px; color: #888; font-size: 13px; }
    </style><div class="top"><h2>Conversations</h2><span class="count">…</span><span class="sp"></span><button type="button" class="btn newpost">New conversation</button></div><div class="list"><div class="muted">Loading conversations…</div></div>`;

    const load = async () => {
      try {
        const res = await call('Modules.Projects.Production', 'getConversations', { Entity: 'tTask', EntityKey: a.taskKey }, true);
        if (res.errors && res.errors.length) throw new Error(res.errors[0].message);
        // One row per thread (its latest post); load each thread in full, as the native thread screen does.
        const latest = new Map();
        ((res.data && res.data.diary) || []).forEach(r => latest.set(r.RootActivityKey || r.ActivityKey, r));
        const threads = await Promise.all([...latest.entries()].map(async ([rk, r]) => {
          try {
            const t = await call('Modules.Projects.Production', 'loadThread', { loaded: true, ActivityKey: rk, LinkedProjectKey: null, loadWebDav: 0 }, true);
            const th = (!t.errors || !t.errors.length) && t.data && t.data.thread;
            if (!th || !th.length) throw new Error('empty');
            // loadThread dates are UTC.
            return th.map(x => Object.assign(x, { RootActivityKey: rk, _utc: x.DateAdded }));
          } catch (e) {
            // Fall back to the latest post alone (SortDate is its UTC time).
            return [Object.assign(r, { RootActivityKey: rk, _utc: r.SortDate })];
          }
        }));
        st.posts = threads.flat(); st.err = '';
      } catch (e) { st.posts = st.posts || []; st.err = 'Could not load conversations: ' + (e && e.message || e); }
      render();
      host.uxaLoaded = true;
      host.dispatchEvent(new CustomEvent('uxaconvloaded'));
    };
    host.uxaLoad = load;

    const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const msgHtml = p => {
      const key = p.ActivityKey, html = cleanPostHtml(p.Notes);
      const long = (p.Notes || '').replace(/<[^>]*>/g, '').length > 600;
      const open = st.open.has(key);
      return `<div class="msg"><div class="av">${initials(p.AddedByUserName || p.OriginatorUserName)}${p.AddedByKey ? `<img alt="" src="${BASE}common/logo.aspx?logo=avatar&k=${p.AddedByKey}&type=User">` : ''}</div>
        <div class="mb"><div class="who"><b>${esc(p.AddedByUserName || p.OriginatorUserName || 'Someone')}</b>${esc(fmtWhen(p._utc))}${!p.IsRead ? ' <span class="new">Unread</span>' : ''}</div>
        <div class="txt ${long && !open ? 'clamp' : ''}">${html || '<span class="muted">(no text)</span>'}</div>
        ${long ? `<button type="button" class="link tog" data-k="${key}">${open ? 'Show less' : 'Show more'}</button>` : ''}
        ${p.AttachmentCount ? `<div class="att">${p.AttachmentCount} attachment${p.AttachmentCount > 1 ? 's' : ''} · open the thread to view</div>` : ''}</div></div>`;
    };

    const render = () => {
      const list = root.querySelector('.list');
      // Remember reply drafts across re-renders.
      root.querySelectorAll('textarea[data-root]').forEach(t => { st.drafts[t.dataset.root] = t.value; });
      const posts = st.posts || [];
      const threads = new Map();
      posts.forEach(p => {
        const rk = p.RootActivityKey || p.ActivityKey;
        if (!threads.has(rk)) threads.set(rk, []);
        threads.get(rk).push(p);
      });
      const arr = [...threads.entries()].map(([rk, items]) => {
        items.sort((x, y) => String(x._utc).localeCompare(String(y._utc)));
        const first = items.find(x => x.ActivityKey === rk) || items[0];
        const last = items[items.length - 1];
        return { rk, items, subject: first.Subject || last.Subject || '(no subject)', latest: String(last._utc || '') };
      }).sort((x, y) => y.latest.localeCompare(x.latest));
      root.querySelector('.count').textContent = arr.length;
      if (!arr.length) {
        list.innerHTML = (st.err ? `<div class="err">${esc(st.err)}</div>` : '') + `<div class="empty">No conversations on this task yet. Start one to ask a question or share an update with the team.</div>`;
        return;
      }
      list.innerHTML = (st.err ? `<div class="err">${esc(st.err)}</div>` : '') + arr.map(t => {
        const showAll = st.more.has(t.rk) || t.items.length <= 4;
        const items = showAll ? t.items : [t.items[0]].concat(t.items.slice(-2));
        const hidden = t.items.length - items.length;
        return `<div class="thread"><div class="subj"><span class="s">${esc(t.subject)}</span>${t.items.length > 1 ? `<span class="count">${t.items.length}</span>` : ''}<button type="button" class="link copyconv" data-rk="${t.rk}" title="Copy a link to this conversation">Copy link</button><a class="link open" data-rk="${t.rk}" href="${urls.thread(t.rk)}">Open thread</a></div>
          ${msgHtml(items[0])}
          ${hidden ? `<div class="earlier"><button type="button" class="link moreb" data-rk="${t.rk}">Show ${hidden} earlier repl${hidden > 1 ? 'ies' : 'y'}</button></div>` : ''}
          ${items.slice(1).map(msgHtml).join('')}
          <div class="reply"><textarea rows="1" data-root="${t.rk}" placeholder="Write a reply"></textarea><button type="button" class="btn rbtn" data-rk="${t.rk}">Reply</button></div>
          <div class="hint">Type @ to mention a teammate (they're added to the recipients). Opens Workamajig's reply screen with your text; press Post Reply there.</div></div>`;
      }).join('');
      root.querySelectorAll('textarea[data-root]').forEach(t => { t.value = st.drafts[t.dataset.root] || ''; });
    };

    root.addEventListener('error', e => { if (e.target.tagName === 'IMG' && e.target.parentElement && e.target.parentElement.classList.contains('av')) e.target.remove(); }, true);
    // @mentions: type @ in a reply to pick a teammate. The person is recorded for this thread and added to the reply's
    // recipients on the reply screen, so an @mention actually pings them — Workamajig has no native way to do that.
    let mUsers = [];
    getSchedule(a.projectKey).then(s => { mUsers = (s.users || []).filter(u => !u.ClientVendorLogin && (u.UserName || '').trim()); }).catch(() => {});
    const mMentions = new Map(); // rk -> Map(userKey -> userName)
    const mState = { ta: null, items: [], idx: 0, start: -1 };
    const mMenu = document.createElement('div');
    mMenu.className = 'mmenu';
    mMenu.style.cssText = 'position:fixed;z-index:60;min-width:200px;max-width:300px;background:#fff;border:1px solid #d8d8d8;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.16);max-height:220px;overflow:auto;display:none;';
    root.appendChild(mMenu);
    const mClose = () => { mMenu.style.display = 'none'; mState.ta = null; mState.items = []; mState.start = -1; };
    const mRender = () => {
      if (!mState.items.length) { mClose(); return; }
      mMenu.innerHTML = mState.items.map((u, i) => `<div class="mrow" data-i="${i}" style="padding:7px 11px;cursor:pointer;font-size:13px;color:#333;${i === mState.idx ? 'background:#eef2fb;' : ''}">${esc(u.UserName)}</div>`).join('');
      mMenu.style.display = 'block';
    };
    const mScan = (ta) => {
      const v = ta.value, pos = ta.selectionStart;
      const m = /(^|[\s(])@([\w .'\-]{0,30})$/.exec(v.slice(0, pos));
      if (!m || !mUsers.length) { mClose(); return; }
      const q = m[2].toLowerCase();
      mState.ta = ta; mState.start = pos - m[2].length - 1; mState.idx = 0;
      mState.items = mUsers.filter(u => u.UserName.toLowerCase().includes(q)).slice(0, 8);
      if (!mState.items.length) { mClose(); return; }
      const r = ta.getBoundingClientRect();
      mMenu.style.left = Math.round(r.left) + 'px';
      mMenu.style.top = Math.round(Math.min(r.bottom + 4, innerHeight - 230)) + 'px';
      mRender();
    };
    const mPick = (u) => {
      const ta = mState.ta; if (!ta || !u) return;
      const v = ta.value, pos = ta.selectionStart, ins = '@' + u.UserName + ' ';
      ta.value = v.slice(0, mState.start) + ins + v.slice(pos);
      const np = mState.start + ins.length; ta.setSelectionRange(np, np);
      const rk = ta.dataset.root;
      if (rk) { if (!mMentions.has(rk)) mMentions.set(rk, new Map()); mMentions.get(rk).set(String(u.UserKey), u.UserName); }
      mClose(); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 240) + 'px'; ta.focus();
    };
    mMenu.addEventListener('click', e => { const r = e.target.closest('.mrow'); if (r) mPick(mState.items[+r.dataset.i]); });
    root.addEventListener('keydown', e => {
      if (mMenu.style.display !== 'block' || !mState.items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); mState.idx = (mState.idx + 1) % mState.items.length; mRender(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); mState.idx = (mState.idx - 1 + mState.items.length) % mState.items.length; mRender(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); mPick(mState.items[mState.idx]); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); mClose(); }
    }, true);
    root.addEventListener('input', e => {
      if (e.target.tagName === 'TEXTAREA') {
        const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 240) + 'px';
        if (t.dataset.root) mScan(t);
      }
    });
    root.addEventListener('click', e => {
      const t = e.target;
      if (t.classList.contains('tog')) { const k = Number(t.dataset.k); st.open.has(k) ? st.open.delete(k) : st.open.add(k); return render(); }
      if (t.classList.contains('moreb')) { st.more.add(Number(t.dataset.rk)); return render(); }
      if (t.classList.contains('newpost')) { nav('projects.diary.add', a.projectKey, { taskKey: a.taskKey }); return; }
      if (t.classList.contains('copyconv') && t.dataset.rk) { copy(urls.thread(t.dataset.rk), 'conversation link'); return; }
      if (t.classList.contains('open') && t.dataset.rk && plainClick(e)) { e.preventDefault(); nav('projects.diary.thread', Number(t.dataset.rk)); return; }
      if (t.classList.contains('rbtn')) {
        const rk = Number(t.dataset.rk);
        const ta = root.querySelector(`textarea[data-root="${rk}"]`);
        const text = (ta && ta.value || '').trim();
        const mentions = [...(mMentions.get(String(rk)) || new Map()).entries()].map(([k, name]) => ({ UserKey: Number(k), UserName: name }));
        if (text) { try { sessionStorage.setItem(SS_REPLY, JSON.stringify({ parent: rk, text, mentions, ts: Date.now() })); } catch (err) {} }
        st.drafts[rk] = '';
        nav('projects.diary.reply', rk);
      }
    });
    ['click', 'mousedown'].forEach(t => host.addEventListener(t, e => e.stopPropagation()));
    guardKeys(host);
    load();
    return host;
  }

  // Reply screen opened from the inline reply box: put the typed text in the editor (recipients stay as Workamajig sets them).
  function handlePendingReply() {
    let req = null;
    try { req = JSON.parse(sessionStorage.getItem(SS_REPLY) || 'null'); } catch (e) {}
    if (!req) return;
    if (Date.now() - req.ts > 120000) { try { sessionStorage.removeItem(SS_REPLY); } catch (e) {} return; }
    let tries = 0;
    const t = setInterval(() => {
      const pg = document.querySelector('page.open[data-aid="projects.diary.reply"]');
      const model = pg && pg.view && pg.view.module && pg.view.module.model;
      const ed = pg && pg.querySelector('richtexteditor[name="Notes"]');
      const ready = model && model.reply && model.reply.si && Number(model.reply.si.ParentActivityKey) === Number(req.parent) && ed;
      if (!ready) { if (++tries > 80) clearInterval(t); return; }
      clearInterval(t);
      try { sessionStorage.removeItem(SS_REPLY); } catch (e) {}
      const body = String(req.text).split(/\n{2,}/).map(par => '<p>' + esc(par).replace(/\n/g, '<br>') + '</p>').join('');
      let attempts = 0;
      const put = () => {
        ed.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertHTML', false, body);
        if (!ed.textContent.trim() && ++attempts < 8) { setTimeout(put, 300); return; }
        if (!ed.textContent.trim()) { ed.innerHTML = body; ed.dispatchEvent(new Event('input', { bubbles: true })); }
        try { model.reply.setValue('Notes', '<span class="usr ver2">' + ed.innerHTML + '</span>'); } catch (e) {}
        // @mentioned people → reply recipients, so the mention actually notifies them.
        let added = 0;
        if (req.mentions && req.mentions.length && model.emailTo && typeof model.emailTo.addItem === 'function') {
          try {
            const have = new Set((model.emailTo.source || []).map(r => String(r.UserKey)));
            req.mentions.forEach(u => {
              if (!u || !u.UserKey || have.has(String(u.UserKey))) return;
              model.emailTo.addItem({ UserKey: u.UserKey, UserName: u.UserName, Email: '', ClientVendorLogin: 0, k: u.UserKey, l: u.UserName, label: u.UserName, key: u.UserKey, title: '' });
              have.add(String(u.UserKey)); added++;
            });
            if (added) model.emailTo.fire();
          } catch (e) { console.warn('[uxa] add mention recipients failed', e); }
        }
        toast(added ? `Reply prefilled; ${added} mentioned ${added > 1 ? 'people' : 'person'} added to recipients. Review and Post Reply.` : 'Reply prefilled. Check the recipients, then Post Reply');
      };
      setTimeout(put, 150);
    }, 250);
  }

  // ---------- Project board (kanban) on the Schedule ----------
  // One card per assignment (status lives on the assignment, not the task). Drawn as a fixed overlay over the
  // schedule grid inside a Shadow DOM; the grid itself is never touched. Status changes use the same single-row
  // call as the Today board (WJAPP.Modules.Project.Traffic.updateAssignmentStatus).
  const BOARD_PREF = 'uxa.boardMode';
  const COMPLETED_KEY = 1048;
  const STATUS_COLORS = { 'Backlog': '#C2C2C2', 'Ready': '#B3DC6C', 'In Progress': '#16A765', 'Ready for Review/Blocked': '#F83A22', 'Completed': '#A47AE2' };
  const FALLBACK_COLORS = ['#7aa7d9', '#e0a82e', '#d07ad9', '#5cc2c2', '#9b9b9b'];
  const board = { on: false, host: null, root: null, toggle: null, projectKey: null, data: null, user: 0, search: '',
    showCompleted: false, timer: null, dirty: false, drag: null, seq: 0, view: 'board', calShow: false, calExpand: null,
    calAdd: null, calAdding: false };
  const COLLAPSE_PREF = 'uxa.boardCollapsed';
  board.collapsed = (() => { try { return JSON.parse(localStorage.getItem(COLLAPSE_PREF) || '{}') || {}; } catch (e) { return {}; } })();
  const saveCollapsed = () => { try { localStorage.setItem(COLLAPSE_PREF, JSON.stringify(board.collapsed)); } catch (e) {} };
  // Completed starts collapsed; every other column starts open. Choices are remembered by column name.
  const isCollapsed = name => (name in board.collapsed ? !!board.collapsed[name] : name === 'Completed');
  const showDone = () => !isCollapsed('Completed');
  const boardPref = () => { try { return localStorage.getItem(BOARD_PREF) === '1'; } catch (e) { return false; } };
  const setBoardPref = v => { try { localStorage.setItem(BOARD_PREF, v ? '1' : '0'); } catch (e) {} };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Rich text for task descriptions (Workamajig's Description field holds HTML; we render + edit a safe subset) ----------
  const DESC_ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'P', 'BR', 'UL', 'OL', 'LI', 'A', 'DIV', 'SPAN']);
  const DESC_DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'HEAD', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'IMG']);
  // Whitelist sanitizer. Built in a DETACHED element so nothing loads/runs; disallowed tags are unwrapped (text kept),
  // dangerous tags dropped whole, and every attribute stripped except a safe href on links.
  function sanitizeDescHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = String(html == null ? '' : html);
    const walk = node => {
      for (const c of [...node.childNodes]) {
        if (c.nodeType === 8) { c.remove(); continue; }     // comments
        if (c.nodeType !== 1) continue;                      // text nodes are fine
        if (DESC_DROP.has(c.tagName)) { c.remove(); continue; }
        if (!DESC_ALLOWED.has(c.tagName)) { c.replaceWith(...c.childNodes); continue; }
        for (const a of [...c.attributes]) {
          const keep = c.tagName === 'A' && a.name.toLowerCase() === 'href' && /^(https?:|mailto:)/i.test(String(a.value).trim());
          if (!keep) c.removeAttribute(a.name);
        }
        if (c.tagName === 'A') { c.setAttribute('target', '_blank'); c.setAttribute('rel', 'noopener noreferrer nofollow'); }
        walk(c);
      }
    };
    walk(tmp);
    return tmp.innerHTML.trim();
  }
  const descIsHtml = s => /<\/?(p|br|b|strong|i|em|u|ul|ol|li|a|div|span)\b/i.test(String(s || ''));
  // Description → HTML for display/editor: existing HTML is sanitized; plain text becomes paragraphs with <br>s.
  function descToHtml(raw) {
    raw = String(raw == null ? '' : raw);
    if (descIsHtml(raw)) return sanitizeDescHtml(raw);
    const e = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return raw.trim() ? raw.trim().split(/\n{2,}/).map(p => '<p>' + e(p).replace(/\n/g, '<br>') + '</p>').join('') : '';
  }
  // True when a description has real content (ignoring tags/whitespace).
  const descHasText = raw => { const t = document.createElement('div'); t.innerHTML = descToHtml(raw); return !!t.textContent.replace(/ /g, ' ').trim(); };
  const RTE_BAR = `<div class="rtebar">`
    + `<button type="button" class="rteb" data-cmd="bold" title="Bold (Ctrl/Cmd+B)"><b>B</b></button>`
    + `<button type="button" class="rteb" data-cmd="italic" title="Italic (Ctrl/Cmd+I)"><i>I</i></button>`
    + `<button type="button" class="rteb" data-cmd="underline" title="Underline"><u>U</u></button>`
    + `<button type="button" class="rteb" data-cmd="insertUnorderedList" title="Bulleted list">&#8226;</button>`
    + `<button type="button" class="rteb" data-cmd="insertOrderedList" title="Numbered list">1.</button>`
    + `<button type="button" class="rteb" data-cmd="createLink" title="Add a link">&#128279;</button>`
    + `<button type="button" class="rteb" data-cmd="removeFormat" title="Clear formatting">&#10005;</button></div>`;
  const rteEditor = html => `<div class="rte"><div class="rtein" contenteditable="true" role="textbox" aria-multiline="true">${html}</div>${RTE_BAR}</div>`;
  const rteRead = root => { const ed = root.querySelector('.rtein'); return ed ? sanitizeDescHtml(ed.innerHTML) : ''; };
  // CSS for the editor + rendered HTML, usable in any shadow root.
  const RTE_CSS = `
    .rte { border: 1px solid #cfcfcf; border-radius: 8px; overflow: hidden; background: #fff; }
    .rte:focus-within { border-color: #7ab51d; box-shadow: 0 0 0 3px rgba(122,181,29,.18); }
    .rtein { min-height: 120px; max-height: 40vh; overflow-y: auto; padding: 10px 12px; font-size: 13px; line-height: 1.55; color: #222; outline: none; }
    .rtein:empty:before { content: attr(data-ph); color: #aaa; }
    .rtein p { margin: 0 0 8px; } .rtein ul, .rtein ol { margin: 0 0 8px; padding-left: 22px; } .rtein a { color: #1a8fbf; }
    .rtebar { display: flex; gap: 2px; padding: 5px 6px; border-top: 1px solid #eee; background: #fafafa; }
    .rteb { font: inherit; font-size: 13px; min-width: 26px; height: 26px; border: 1px solid transparent; border-radius: 5px; background: none; color: #444; cursor: pointer; line-height: 1; }
    .rteb:hover { background: #ececec; }
    .desc-html { font-size: 13px; line-height: 1.55; color: #333; background: #fafafa; border: 1px solid #eee; border-radius: 8px; padding: 10px 12px; max-height: 40vh; overflow-y: auto; }
    .desc-html p { margin: 0 0 8px; } .desc-html p:last-child { margin-bottom: 0; } .desc-html ul, .desc-html ol { margin: 0 0 8px; padding-left: 22px; } .desc-html a { color: #1a8fbf; word-break: break-word; }`;
  // Wire a toolbar to the editor beside it (both under `root`). execCommand runs on the focused contenteditable.
  function wireRte(root) {
    const bar = root.querySelector('.rtebar'), ed = root.querySelector('.rtein');
    if (!bar || !ed || bar.dataset.wired) return;
    bar.dataset.wired = '1';
    bar.addEventListener('mousedown', e => {
      const b = e.target.closest('button[data-cmd]'); if (!b) return;
      e.preventDefault(); // keep the selection in the editor
      ed.focus();
      const cmd = b.dataset.cmd;
      if (cmd === 'createLink') { const url = prompt('Link address (https://…):', 'https://'); if (url && /^(https?:|mailto:)/i.test(url.trim())) document.execCommand('createLink', false, url.trim()); return; }
      try { document.execCommand(cmd, false, null); } catch (err) {}
    });
  }
  // Topmost Schedule page: "Open in schedule" from an assignment can stack a second copy on top of the first.
  const schedulePage = () => { const all = document.querySelectorAll('page.open[data-aid="projects.schedule.edit2"]'); return all[all.length - 1] || null; };
  const inSchedule = sel => { const pg = schedulePage(); return pg && pg.querySelector(sel); };

  function boardTick() {
    // Detached mode (the card modal shown over the Resource Schedule) has no schedule page under it: leave it alone
    // while its view is still up, and end it the moment the user navigates away.
    if (board.detached) { if (rs.open && aid() === board.detached.aid) return; boardDetachEnd(); }
    if (aid() !== 'projects.schedule.edit2') {
      if (board.on || board.host) closeBoard(true);
      closeListHygiene();
      board.noAuto = null;
      return;
    }
    ensureBoardToggle();
    checkListFilter();
    // Keep the "Showing …" chip current (e.g. when Hide Completed Tasks is toggled).
    if (board.toggle && !board.on) { const slot = board.toggle.shadowRoot.querySelector('.fslot'); const html = listFilterSummary(); if (slot && slot.dataset.html !== html) { slot.dataset.html = html; slot.innerHTML = html; } }
    const pk = qs().get('k');
    if (board.on && board.projectKey !== pk) { closeBoard(true); }
    let pending = null; try { pending = sessionStorage.getItem(SS_KEY); } catch (e) {}
    // A task deep link keeps this page load in List view so the spotlighted row stays visible.
    if (pending) board.noAuto = pk;
    if (!board.on && boardPref() && board.noAuto !== pk && inSchedule('#grdProjectSchedule grid-row[data-key]')) openBoard();
  }

  // List / Board switch: top right of the page header, next to Workamajig's "saved" indicator.
  function ensureBoardSeg() {
    const pg = schedulePage();
    if (board.seg && board.seg.isConnected && pg && pg.contains(board.seg)) return;
    if (board.seg) board.seg.remove();
    const spacer = pg && pg.querySelector(':scope > header > div.spacer');
    const fallback = pg && pg.querySelector('button[data-action="toggleGantt"]');
    if (!spacer && !fallback) return;
    const host = document.createElement('span');
    host.id = 'uxa-board-seg';
    host.style.cssText = 'display:inline-flex;align-self:center;vertical-align:middle;margin-right:12px;flex:none';
    const r = host.attachShadow({ mode: 'open' });
    r.innerHTML = `<style>
      :host { all: initial; font-family: inherit; color-scheme: light; }
      * { box-sizing: border-box; font-family: inherit; }
      .seg { display: inline-flex; border: 1px solid #cfcfcf; border-radius: 8px; overflow: hidden; background: #fff; }
      button { font: inherit; font-size: 12px; padding: 7px 14px; border: 0; background: #fff; color: #444; cursor: pointer; line-height: 1; }
      button + button { border-left: 1px solid #cfcfcf; }
      button.on { background: #333; color: #fff; font-weight: 600; }
    </style><div class="seg" title="Switch between the schedule list and a status board"><button type="button" class="list">List</button><button type="button" class="board">Board</button>${calEnabled() ? '<button type="button" class="cal" title="Open a calendar of tasks by due date">Calendar</button>' : ''}</div>`;
    r.querySelector('.list').addEventListener('click', () => { setBoardPref(false); closeBoard(); });
    r.querySelector('.board').addEventListener('click', () => { setBoardPref(true); closeListHygiene(); switchView('board'); });
    if (calEnabled()) { const cb = r.querySelector('.cal'); if (cb) cb.addEventListener('click', () => { closeListHygiene(); switchView('calendar'); }); }
    ['click', 'mousedown', 'keydown'].forEach(t => host.addEventListener(t, e => e.stopPropagation()));
    if (spacer) spacer.insertAdjacentElement('afterend', host); else fallback.parentElement.insertBefore(host, fallback);
    board.seg = host;
    syncToggle();
  }

  function ensureBoardToggle() {
    ensureBoardSeg();
    const spg = schedulePage();
    if (board.toggle && board.toggle.isConnected && spg && spg.contains(board.toggle)) return;
    if (board.toggle) board.toggle.remove();
    const anchor = inSchedule('button[data-action="toggleGantt"]');
    if (!anchor) return;
    const host = document.createElement('span');
    host.id = 'uxa-board-toggle';
    host.style.cssText = 'display:inline-flex;vertical-align:middle;margin:0 10px 0 12px';
    const r = host.attachShadow({ mode: 'open' });
    r.innerHTML = `<style>
      :host { all: initial; font-family: inherit; color-scheme: light; }
      * { box-sizing: border-box; font-family: inherit; }
      .seg { display: inline-flex; border: 1px solid #cfcfcf; border-radius: 8px; overflow: hidden; background: #fff; }
      button { font: inherit; font-size: 12px; padding: 7px 12px; border: 0; background: #fff; color: #444; cursor: pointer; line-height: 1; }
      button + button { border-left: 1px solid #cfcfcf; }
      button.on { background: #333; color: #fff; font-weight: 600; }
      [hidden] { display: none !important; }
      .wrap { display: inline-flex; align-items: center; gap: 10px; }
      .hyg { border: 1px solid #cfcfcf; border-radius: 8px; white-space: nowrap; }
      .hyg .n { color: #b07a00; font-weight: 600; margin-left: 2px; }
      .conv { border: 1px solid #cfcfcf; border-radius: 8px; white-space: nowrap; }
      .conv .n { color: #185fa5; font-weight: 600; margin-left: 2px; }
      .conv .u:not(:empty) { margin-left: 6px; font-size: 11px; font-weight: 600; color: #fff; background: #1a8fbf; border-radius: 999px; padding: 1px 6px; }
      .conv.open, .conv.on { background: #e6f1fb; border-color: #85b7eb; color: #0c447c; }
      .hyg.on { background: #fff4d6; border-color: #e0a82e; color: #6b4b00; }
      .fslot:empty { display: none; }
      .fslot { display: inline-flex; align-items: center; gap: 6px; }
      .fslot .flabel { font-size: 12px; font-weight: 700; color: #0c447c; }
      .fchip { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; font-size: 12px; font-weight: 600; color: #0c447c; background: #e6f1fb; border: 1px solid #85b7eb; border-radius: 999px; padding: 2px 3px 2px 10px; }
      .fchip .fh { font-weight: 400; color: #4a6f94; }
      .fchip .fx { border: 0; background: none; color: #0c447c; font-weight: 600; font-size: 14px; line-height: 1; width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; padding: 0; cursor: pointer; }
      .fchip .fx:hover { background: #cfe4f8; }
      .hrow.act { background: #f0f6fc; }
      .hrow.act .caret { color: #1a8fbf; font-size: 12px; }
      .fx2 { border: 0; background: none; padding: 0; color: #1a8fbf; text-decoration: underline; font-size: 12px; cursor: pointer; }
      .cvrow { display: flex; align-items: flex-start; }
      .cvrow .it { flex: 1; min-width: 0; }
      .ot { flex: none; border: 0; background: none; color: #1a8fbf; font-size: 11px; text-decoration: underline; padding: 6px 14px 0 4px; cursor: pointer; white-space: nowrap; }
      .ud { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #1a8fbf; vertical-align: middle; }
      .hyg.open { background: #fff4d6; border-color: #e0a82e; color: #6b4b00; }
      .hmenu { position: fixed; z-index: 10001; width: 380px; max-height: 70vh; overflow: auto; background: #fff; border: 1px solid #ddd; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 8px 0; font-size: 13px; color: #333; }
      .htitle { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #999; padding: 2px 14px 6px; }
      .hrow { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 14px; text-align: left; border: 0; border-radius: 0; background: #fff; cursor: pointer; font-size: 13px; color: #333; line-height: 1.3; }
      .hrow:hover { background: #f6f6f6; }
      .hrow[disabled] { cursor: default; color: #aaa; }
      .hrow[disabled]:hover { background: #fff; }
      .caret { width: 10px; color: #999; font-size: 10px; }
      .hl { flex: 1; min-width: 0; }
      .hl small { display: block; font-size: 11px; color: #999; }
      .hc { font-size: 12px; font-weight: 600; color: #8a5a00; background: #fff4d6; border-radius: 999px; padding: 1px 8px; }
      .hrow[disabled] .hc { color: #999; background: #f1f1f1; }
      .items { padding: 2px 0 6px; background: #fafafa; border-top: 1px solid #f0f0f0; border-bottom: 1px solid #f0f0f0; }
      .it { display: block; width: 100%; text-align: left; border: 0; border-radius: 0; background: none; padding: 5px 14px 5px 34px; font-size: 12px; color: #333; cursor: pointer; line-height: 1.35; }
      .it:hover { background: #eef6fb; }
      .it .id { color: #888; margin-right: 4px; }
      .it small { display: block; color: #999; font-size: 11px; }
      .onboard { display: block; border: 0; background: none; padding: 4px 14px 2px 34px; color: #1a8fbf; font-size: 12px; text-decoration: underline; cursor: pointer; }
      .hfoot { padding: 8px 14px 2px; font-size: 11px; color: #999; }
      .msg { padding: 10px 14px; color: #888; font-size: 12px; }
    </style><div class="wrap"><span class="fslot"></span><button type="button" class="conv" title="Tasks that have conversations">Conversations <span class="n">…</span><span class="u"></span> ▾</button><button type="button" class="hyg" title="Project hygiene: find open work with problems">Hygiene <span class="n">…</span> ▾</button></div>`;
    r.querySelector('.hyg').addEventListener('click', () => (listHyg.open === 'hyg' ? closeListHygiene() : openListHygiene('hyg')));
    r.querySelector('.fslot').addEventListener('click', e => { const b = e.target.closest('.fx'); if (!b) return; if (b.dataset.fx === 'search') clearNativeSearch(); else clearListFilter(); });
    r.querySelector('.conv').addEventListener('click', () => (listHyg.open === 'conv' ? closeListHygiene() : openListHygiene('conv')));
    // The menu lives in its own layer on <body>: inside the page, an ancestor turns position:fixed into
    // "relative to the page panel", which pushed the menu down and clipped it at the panel's right edge.
    if (board.hygMenu) board.hygMenu.remove();
    const mh = document.createElement('div');
    mh.id = 'uxa-hyg-menu';
    mh.style.cssText = 'position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:10001';
    const mr = mh.attachShadow({ mode: 'open' });
    mr.innerHTML = `<style>${r.querySelector('style').textContent}</style><div class="hmenu" hidden></div>`;
    mr.querySelector('.hmenu').addEventListener('click', onListHygieneClick);
    ['click', 'mousedown', 'keydown'].forEach(t => mh.addEventListener(t, e => e.stopPropagation()));
    document.body.appendChild(mh);
    board.hygMenu = mh;
    ['click', 'mousedown', 'keydown'].forEach(t => host.addEventListener(t, e => e.stopPropagation()));
    anchor.parentElement.insertBefore(host, anchor);
    board.toggle = host;
    listHyg.pk = null;
    syncToggle();
    loadListHygiene();
  }

  // ---------- Hygiene in List view ----------
  // The list grid can't be filtered without touching its markup, so the menu lists the affected tasks instead.
  // Clicking one scrolls to its row and spotlights it; "Show on board" opens the board with that filter on.
  // Conversations per task for a whole project: one getConversations call (one row per thread, latest post).
  // TaskKey -> { threads, unread (threads with unread posts), latest (UTC), latestRk, subject }
  async function loadProjectConvs(pk) {
    const res = await call('Modules.Projects.Production', 'getConversations', { Entity: 'tProject', EntityKey: Number(pk) }, true);
    if (res.errors && res.errors.length) throw new Error(res.errors[0].message);
    const map = new Map();
    ((res.data && res.data.diary) || []).forEach(r => {
      if (!r.TaskKey) return;
      const c = map.get(r.TaskKey) || { threads: 0, unread: 0, latest: '', latestRk: 0, subject: '' };
      c.threads++;
      if (r.UnreadCount > 0) c.unread++;
      const when = String(r.SortDate || '');
      if (when > c.latest) { c.latest = when; c.latestRk = r.RootActivityKey || r.ActivityKey; c.subject = r.Subject || ''; }
      map.set(r.TaskKey, c);
    });
    return map;
  }
  const convWord = n => `${n} conversation${n === 1 ? '' : 's'}`;

  const listHyg = { open: false, pk: null, model: null, expanded: null, err: '', seq: 0, convs: null, convErr: '' };

  async function loadListHygiene() {
    const pk = qs().get('k'), seq = ++listHyg.seq;
    if (listHyg.pk !== pk) { listHyg.model = null; listHyg.expanded = null; listHyg.convs = null; }
    listHyg.pk = pk; listHyg.err = ''; listHyg.convErr = '';
    scheduleCache.delete(String(pk));
    const convP = loadProjectConvs(pk).catch(e => { listHyg.convErr = String(e && e.message || e); return null; });
    try {
      const s = await getSchedule(pk);
      if (seq !== listHyg.seq) return;
      listHyg.model = boardModel(s.raw);
    } catch (e) {
      if (seq !== listHyg.seq) return;
      listHyg.err = String(e && e.message || e);
    }
    const cv = await convP;
    if (seq !== listHyg.seq) return;
    if (cv) listHyg.convs = cv;
    renderListHygiene();
  }

  // Open work per issue: assignment cards that aren't done, plus open tasks with nobody on them.
  function listHygieneItems(m) {
    const per = {};
    HYGIENE.forEach(h => {
      const rows = m.cards.filter(c => hygInScope(c) && h.card(c)).map(c => ({ taskKey: c.taskKey, taskId: c.taskId, taskName: c.taskName, group: c.group, order: c.order, who: c.userKey > 0 ? c.user : 'Empty assignment slot' }))
        .concat(m.unassigned.filter(t => h.task(t)).map(t => ({ taskKey: t.taskKey, taskId: t.taskId, taskName: t.taskName, group: t.group, order: t.order, who: 'Nobody assigned' })));
      rows.sort((a, b) => a.order - b.order);
      per[h.key] = rows;
    });
    return per;
  }

  function renderListHygiene() {
    if (!board.toggle) return;
    const r = board.toggle.shadowRoot;
    const n = r.querySelector('.hyg .n');
    const m = listHyg.model;
    n.textContent = m ? hygieneCounts(m).total : (listHyg.err ? '!' : '…');
    const cv = listHyg.convs;
    const cvUnread = cv ? [...cv.values()].filter(c => c.unread).length : 0;
    r.querySelector('.conv .n').textContent = cv ? cv.size : (listHyg.convErr ? '!' : '…');
    r.querySelector('.conv .u').textContent = cvUnread ? `${cvUnread} unread` : '';
    { const slot = r.querySelector('.fslot'), html = board.on ? '' : listFilterSummary(); if (slot.dataset.html !== html) { slot.dataset.html = html; slot.innerHTML = html; } }
    r.querySelector('.hyg').classList.toggle('on', !!(listFilter && listFilter.kind === 'hyg'));
    r.querySelector('.conv').classList.toggle('on', !!(listFilter && listFilter.kind === 'conv'));
    r.querySelector('.hyg').classList.toggle('open', listHyg.open === 'hyg');
    r.querySelector('.conv').classList.toggle('open', listHyg.open === 'conv');
    const menu = board.hygMenu && board.hygMenu.shadowRoot.querySelector('.hmenu');
    if (!menu) return;
    menu.hidden = !listHyg.open;
    if (!listHyg.open) return;
    const b = r.querySelector(listHyg.open === 'conv' ? '.conv' : '.hyg').getBoundingClientRect();
    menu.style.top = (b.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(b.left, innerWidth - 388)) + 'px';
    if (listHyg.open === 'conv') { renderListConvs(menu); return; }
    if (!m) { menu.innerHTML = `<div class="msg">${listHyg.err ? 'Could not load the schedule: ' + esc(listHyg.err) : 'Loading…'}</div>`; return; }
    const per = listHygieneItems(m);
    const act = listFilter && listFilter.kind === 'hyg' ? listFilter.key : null;
    const cp = hygCountPrefs(), nhc = nativeHideCompleted();
    const opts = `<div class="hopts" style="border-top:1px solid #ececec;margin-top:4px;padding:7px 12px;display:flex;flex-direction:column;gap:4px;font-size:12px;color:#555">`
      + `<label style="display:flex;align-items:center;gap:7px;cursor:${nhc ? 'default' : 'pointer'};${nhc ? 'opacity:.55' : ''}"><input type="checkbox" class="hopt" data-opt="completed" ${cp.completed && !nhc ? 'checked' : ''} ${nhc ? 'disabled' : ''}> Count completed tasks</label>`
      + `<label style="display:flex;align-items:center;gap:7px;cursor:pointer"><input type="checkbox" class="hopt" data-opt="summaries" ${cp.summaries ? 'checked' : ''}> Count summary tasks</label>`
      + (nhc ? `<small style="color:#999">Workamajig’s “Hide Completed Tasks” is on, so completed tasks stay out.</small>` : '')
      + `</div>`;
    menu.innerHTML = `<div class="htitle">Filter the list to open work that has…</div>` + HYGIENE.map(h => {
      const n = per[h.key].length;
      return `<button type="button" class="hrow ${act === h.key ? 'act' : ''}" data-k="${h.key}" ${n ? '' : 'disabled'}><span class="caret">${act === h.key ? '✓' : ''}</span><span class="hl">${h.label}<small>${h.hint}</small></span><span class="hc">${n}</span></button>`;
    }).join('') + opts + `<div class="hfoot">${act ? '<button type="button" class="fx2">Clear filter</button>' : 'Click an issue to show only those tasks.'}</div>`;
  }

  // Conversations menu: filter the list to tasks with conversations, or with unread posts.
  function renderListConvs(menu) {
    const cv = listHyg.convs;
    if (!cv) { menu.innerHTML = `<div class="msg">${listHyg.convErr ? 'Could not load conversations: ' + esc(listHyg.convErr) : 'Loading…'}</div>`; return; }
    const all = cv.size, unread = [...cv.values()].filter(c => c.unread).length;
    const act = listFilter && listFilter.kind === 'conv' ? listFilter.key : null;
    const row = (k, label, hint, n) => `<button type="button" class="hrow ${act === k ? 'act' : ''}" data-cv="${k}" ${n ? '' : 'disabled'}><span class="caret">${act === k ? '✓' : ''}</span><span class="hl">${label}<small>${hint}</small></span><span class="hc cvc">${n}</span></button>`;
    menu.innerHTML = `<div class="htitle">Filter the list to tasks…</div>` +
      row('any', 'With conversations', 'At least one conversation thread', all) +
      row('unread', 'With unread posts', 'A thread has posts you have not read', unread) +
      `<div class="hfoot">${act ? '<button type="button" class="fx2">Clear filter</button>' : 'Click one to show only those tasks.'}</div>`;
  }

  // ---------- List filter: Workamajig's own schedule filter, narrowed to a set of tasks ----------
  // The schedule's data source has a filter function (it handles Search and Hide Completed Tasks). We wrap it so a
  // row must also be one of our tasks or one of their parent groups. Nothing in the grid's markup is touched; the
  // app redraws the list itself, exactly as it does for Search.
  let listFilter = null; // { kind, key, label, leaf:Set, ds }
  function scheduleDs() { const pg = schedulePage(); const m = pg && pg.view && pg.view.module && pg.view.module.model; return m && m.scheduleTasks; }
  function installFilterWrap(ds) {
    const fo = ds && ds.options && ds.options.filter;
    if (!fo || typeof fo.f !== 'function') return false;
    if (!fo.uxaWrap || fo.f !== fo.uxaWrap) {
      const orig = fo.f;
      fo.uxaOrig = orig;
      // A chosen task shows if Workamajig's own filter allows it. A group heading shows only if at least one chosen
      // task under it is itself visible (so headings of completed, hidden matches don't linger on their own).
      fo.uxaWrap = function (item, idx, src) {
        const ok = orig.call(this, item, idx, src);
        if (!ok || !fo.uxaKeys) return ok;
        const k = item.TaskKey;
        if (fo.uxaLeaf.has(k)) return true;
        const under = fo.uxaUnder.get(k);
        if (!under) return false;
        const live = new Map((ds.source || []).map(t => [t.TaskKey, t]));
        return under.some(lk => { const l = live.get(lk); return !!l && orig.call(this, l, idx, src); });
      };
      fo.f = fo.uxaWrap;
    }
    return true;
  }
  function applyListFilter(kind, key, label, leafKeys) {
    const ds = scheduleDs();
    if (!ds || !installFilterWrap(ds)) { toast('Could not filter the list on this page'); return; }
    const src = ds.source || [];
    const byKey = new Map(src.map(t => [t.TaskKey, t]));
    const keys = new Set(), under = new Map();
    leafKeys.forEach(k => {
      if (!byKey.has(k)) return;
      keys.add(k);
      let x = byKey.get(byKey.get(k).SummaryTaskKey);
      while (x) { keys.add(x.TaskKey); if (!under.has(x.TaskKey)) under.set(x.TaskKey, []); under.get(x.TaskKey).push(k); x = byKey.get(x.SummaryTaskKey); }
    });
    const fo = ds.options.filter;
    fo.uxaLeaf = new Set(leafKeys); fo.uxaUnder = under; fo.uxaKeys = keys;
    listFilter = { kind, key, label, leaf: new Set(leafKeys), ds };
    ds.refresh(true);
    closeListHygiene();
    renderListHygiene();
  }
  function clearListFilter() {
    const lf = listFilter; listFilter = null;
    if (lf && lf.ds && lf.ds.options && lf.ds.options.filter) { lf.ds.options.filter.uxaKeys = null; try { lf.ds.refresh(true); } catch (e) {} }
    renderListHygiene();
  }
  // Drop the filter if its page went away; re-wrap if the app rebuilt its filter (e.g. after a settings reload).
  function checkListFilter() {
    if (!listFilter) return;
    const ds = scheduleDs();
    if (!ds || ds !== listFilter.ds) { listFilter = null; renderListHygiene(); return; }
    const fo = ds.options && ds.options.filter;
    if (fo && fo.f !== fo.uxaWrap) { const keys = fo.uxaKeys; installFilterWrap(ds); fo.uxaKeys = keys || null; if (!fo.uxaKeys) { listFilter = null; renderListHygiene(); } else ds.refresh(true); }
  }
  // Filter chips for the List toolbar: the MagicusPM hygiene/conversation filter (with a shown/hidden count) and
  // Workamajig's own Search box, each removable on its own. The search value is read live from the native box (not
  // board.search, which can lag on the list) so the chip can never go stale; boardTick re-renders the slot each tick.
  function listFilterSummary() {
    const chips = [];
    if (listFilter) {
      const ds = listFilter.ds, pg = schedulePage();
      const m = pg && pg.view && pg.view.module && pg.view.module.model;
      const hide = !!(m && m.searchTasks && m.searchTasks.si && Number(m.searchTasks.si.hideCompleted) === 1);
      const byKey = new Map((ds.source || []).map(t => [t.TaskKey, t]));
      const leaf = [...listFilter.leaf].filter(k => byKey.has(k));
      const hidden = hide ? leaf.filter(k => +byKey.get(k).PercComp >= 100).length : 0;
      const shown = leaf.length - hidden;
      const tip = `Only these tasks are shown in the list.${hidden ? ` ${hidden} more match but are completed, and Hide Completed Tasks is on.` : ''}`;
      chips.push(`<span class="fchip" title="${esc(tip)}">${esc(listFilter.label)} · ${shown}${hidden ? ` <span class="fh">+${hidden} hidden</span>` : ''}<button type="button" class="fx" data-fx="filter" title="Remove this filter" aria-label="Remove this filter">×</button></span>`);
    }
    const se = nativeSearch(), sv = se ? se.value.trim() : '';
    if (sv) chips.push(`<span class="fchip" title="Workamajig’s Search box is filtering the list.">Matching “${esc(sv)}”<button type="button" class="fx" data-fx="search" title="Clear the search" aria-label="Clear the search">×</button></span>`);
    return chips.length ? `<span class="flabel">Filters</span>${chips.join('')}` : '';
  }

  function openListHygiene(mode) {
    listHyg.open = mode || 'hyg';
    renderListHygiene();
    loadListHygiene();
    setTimeout(() => {
      document.addEventListener('mousedown', listHygOutside, true);
      document.addEventListener('keydown', listHygKey, true);
    }, 0);
  }

  function closeListHygiene() {
    if (!listHyg.open) return;
    listHyg.open = false;
    document.removeEventListener('mousedown', listHygOutside, true);
    document.removeEventListener('keydown', listHygKey, true);
    renderListHygiene();
  }

  function listHygOutside(e) { const path = e.composedPath(); if (!board.toggle || !(path.includes(board.toggle) || (board.hygMenu && path.includes(board.hygMenu)))) closeListHygiene(); }
  function listHygKey(e) { if (e.key === 'Escape') closeListHygiene(); }

  function onListHygieneClick(e) {
    if (e.target.classList && e.target.classList.contains('hopt')) {
      setHygCountPref(e.target.dataset.opt, e.target.checked);
      // If a hygiene filter is currently applied, re-apply it with the new scope so the list updates too.
      if (listFilter && listFilter.kind === 'hyg' && listHyg.model) {
        const key = listFilter.key, h = HYGIENE.find(x => x.key === key);
        if (h) applyListFilter('hyg', key, h.label, listHygieneItems(listHyg.model)[key].map(x => x.taskKey));
      }
      renderListHygiene();
      return;
    }
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('fx2')) { clearListFilter(); closeListHygiene(); return; }
    if (t.classList.contains('hrow') && t.dataset.k) {
      const h = HYGIENE.find(x => x.key === t.dataset.k); if (!h || !listHyg.model) return;
      if (listFilter && listFilter.kind === 'hyg' && listFilter.key === h.key) { clearListFilter(); closeListHygiene(); return; }
      applyListFilter('hyg', h.key, h.label, listHygieneItems(listHyg.model)[h.key].map(x => x.taskKey));
      return;
    }
    if (t.classList.contains('hrow') && t.dataset.cv) {
      const cv = listHyg.convs; if (!cv) return;
      const k = t.dataset.cv;
      if (listFilter && listFilter.kind === 'conv' && listFilter.key === k) { clearListFilter(); closeListHygiene(); return; }
      const keys = [...cv.entries()].filter(([, c]) => k === 'any' || c.unread).map(([tk]) => tk);
      applyListFilter('conv', k, k === 'any' ? 'With conversations' : 'Unread conversations', keys);
    }
  }


  function syncToggle() {
    if (board.seg) {
      const s = board.seg.shadowRoot;
      s.querySelector('.list').classList.toggle('on', !board.on);
      s.querySelector('.board').classList.toggle('on', board.on && board.view === 'board');
      const c = s.querySelector('.cal'); if (c) c.classList.toggle('on', board.on && board.view === 'calendar');
    }
    if (!board.toggle) return;
    const r = board.toggle.shadowRoot;
    // The board has its own Hygiene menu with real filtering.
    r.querySelector('.hyg').hidden = board.on;
    r.querySelector('.conv').hidden = board.on;
    if (board.on) closeListHygiene();
  }

  // Gantt, Templates, Task Detail and the column-set picker (e.g. "PM Advance View") only apply to the list, so hide them while the board is up.
  function setListOnlyButtons(hidden) {
    let st = document.getElementById('uxa-board-hide');
    if (!st) {
      st = document.createElement('style');
      st.id = 'uxa-board-hide';
      document.head.appendChild(st);
    }
    st.textContent = hidden
      ? 'page.open[data-aid="projects.schedule.edit2"] button[data-action="toggleGantt"],page.open[data-aid="projects.schedule.edit2"] button[data-action="toggleTemplates"],page.open[data-aid="projects.schedule.edit2"] button[data-action="toggleSide"],page.open[data-aid="projects.schedule.edit2"] button[data-action="save"],page.open[data-aid="projects.schedule.edit2"] div.input-control.lookup:has(> input[data-source="colSets"]){display:none!important}'
      : '';
  }

  // Switch the overlay between the status board and the calendar (both inline, same overlay). List closes the overlay.
  function switchView(v) {
    board.view = v;
    board.calExpand = null;
    if (board.on) { renderBoard(); syncToggle(); }
    else openBoard();
  }

  function openBoard() {
    const pg = schedulePage();
    if (!pg) return;
    const pk = qs().get('k');
    if (board.projectKey !== pk) board.user = 0;
    { const el = nativeSearch(); board.search = el ? el.value : ''; }
    if (listFilter) clearListFilter();
    board.on = true; board.projectKey = pk;
    syncToggle();
    setListOnlyButtons(true);
    if (!board.host) buildBoardHost();
    board.host.style.display = 'block';
    positionBoard();
    clearInterval(board.timer);
    board.timer = setInterval(positionBoard, 250);
    loadBoard();
  }

  function closeBoard(leaving) {
    const wasOn = board.on;
    board.on = false;
    setListOnlyButtons(false);
    clearInterval(board.timer);
    if (board.host) board.host.style.display = 'none';
    closeCardMenu();
    closeModal();
    syncToggle();
    if (leaving) { board.projectKey = null; board.data = null; }
    else if (wasOn) loadListHygiene();
    // The list underneath still shows statuses from before; let the app reload them.
    if (wasOn && board.dirty && !leaving) {
      board.dirty = false;
      const rb = inSchedule('button[data-action="refreshData"]');
      if (rb) rb.click();
    }
  }

  // Workamajig's own Search box (top left) filters the board too, so List and Board share one search.
  const nativeSearch = () => { const pg = schedulePage(); return pg && pg.querySelector('input[name="searchText"][data-source-target="scheduleTasks"]'); };
  function syncNativeSearch() {
    const el = nativeSearch();
    const v = el ? el.value : '';
    if (v !== board.search) { board.search = v; renderBoard(); }
  }
  function clearNativeSearch() {
    const el = nativeSearch();
    if (!el || !el.value) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('search', { bubbles: true }));
  }

  function positionBoard() {
    if (!board.host) return;
    if (board.on && board.data) syncNativeSearch();
    const grid = inSchedule('#grdProjectSchedule');
    const r = grid && grid.getBoundingClientRect();
    // Hide while another page or panel sits on top of the schedule.
    const pages = [...document.querySelectorAll('page.open')];
    const covered = pages.length > 1 && pages[pages.length - 1] !== schedulePage();
    if (!r || !r.width || covered || board.suspended) { board.host.style.visibility = 'hidden'; return; }
    board.host.style.visibility = 'visible';
    // Fill from the grid's top to near the viewport bottom — not the grid's own rendered height, which is short when
    // the list is filtered to a few rows (or just after adding a task), or the board's taller content gets clipped.
    const h = Math.max(220, innerHeight - r.top - 16);
    // Extend to near the viewport right so the board also covers the native row-detail slideout, which shrinks the
    // grid when open and would otherwise peek out beside the board.
    const w = Math.max(r.width, innerWidth - r.left - 2);
    Object.assign(board.host.style, { left: r.left + 'px', top: r.top + 'px', width: w + 'px', height: h + 'px' });
  }

  function buildBoardHost() {
    const host = document.createElement('div');
    host.id = 'uxa-board';
    host.style.cssText = 'position:fixed;z-index:10;display:none'; // under the app header (20) and sidebar fly-outs (30)
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { all: initial; font-family: inherit; color-scheme: light; }
      * { box-sizing: border-box; font-family: inherit; }
      .wrap { position: absolute; inset: 0; display: flex; flex-direction: column; background: #fff; color: #333; font-size: 13px; line-height: 1.4; }
      .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 2px 10px; border-bottom: 1px solid #eee; }
      .chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px 3px 3px; border: 1px solid #ddd; border-radius: 999px; background: #fff; cursor: pointer; font-size: 12px; color: #444; }
      .chip.all { padding: 5px 12px; }
      .chip.on { background: #333; border-color: #333; color: #fff; }
      .chip .n { color: #999; font-size: 11px; }
      .chip.on .n { color: #ccc; }
      .search { margin-left: auto; width: 200px; padding: 6px 10px; border: 1px solid #ddd; border-radius: 6px; font: inherit; font-size: 12px; color: #333; background: #fff; }
      .search:focus { outline: none; border-color: #7ab51d; }
      .chk { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: #555; cursor: pointer; user-select: none; }
      .fsum { flex-basis: 100%; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 12px; color: #6b4b00; background: #fff8e5; border: 1px solid #f0d9a0; border-radius: 6px; padding: 5px 10px; }
      .fsum .flabel { font-weight: 700; margin-right: 2px; }
      .fpill { display: inline-flex; align-items: center; gap: 2px; background: #fff; border: 1px solid #e3c98a; border-radius: 999px; padding: 2px 3px 2px 10px; color: #6b4b00; font-weight: 600; }
      .fpill .fpx { border: 0; background: none; cursor: pointer; color: #9a7a2a; font-size: 14px; line-height: 1; width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; padding: 0; }
      .fpill .fpx:hover { background: #f0d9a0; color: #5a3f00; }
      .fsum .mlink { border: 0; background: none; padding: 0; margin-left: 2px; color: #1a8fbf; font: inherit; font-size: 12px; cursor: pointer; text-decoration: underline; }
      .hwrap { position: relative; display: inline-block; }
      .icon.hyg .n { color: #b07a00; font-weight: 600; margin-left: 2px; }
      .icon.hyg.on { background: #fff4d6; border-color: #e0a82e; color: #6b4b00; }
      .hmenu { position: absolute; top: calc(100% + 6px); left: 0; z-index: 6; width: 300px; background: #fff; border: 1px solid #ddd; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.15); padding: 8px 0; }
      .htitle { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #999; padding: 2px 14px 6px; }
      .hrow { display: flex; align-items: center; gap: 10px; padding: 7px 14px; cursor: pointer; font-size: 13px; color: #333; }
      .hrow:hover { background: #f6f6f6; }
      .hl { flex: 1; min-width: 0; }
      .hl small { display: block; font-size: 11px; color: #999; }
      .hc { font-size: 12px; font-weight: 600; color: #8a5a00; background: #fff4d6; border-radius: 999px; padding: 1px 8px; }
      .hfoot { display: flex; gap: 14px; padding: 8px 14px 2px; border-top: 1px solid #eee; margin-top: 4px; }
      .hfoot .mlink { border: 0; background: none; padding: 0; color: #1a8fbf; font: inherit; font-size: 12px; cursor: pointer; text-decoration: underline; }
      .b.ob { background: #fde4e4; color: #b3261e; }
      .b.nh { background: #eef1f5; color: #4a5568; }
      .b.nd { background: #fff4d6; color: #8a5a00; }
      .b.tdb { background: #e6f1fb; color: #0c447c; }
      .b.tdb.done { background: #eaf3de; color: #3b6d11; }
      .b.cvb { background: #eeedfe; color: #3c3489; cursor: pointer; }
      .b.cvb:hover { text-decoration: underline; }
      .mconvslot { margin-top: 18px; padding-top: 14px; border-top: 1px solid #eee; }
      .b.cvb.unread { background: #534ab7; color: #fff; }
      .icon { border: 1px solid #ddd; background: #fff; border-radius: 6px; padding: 5px 9px; cursor: pointer; font-size: 13px; color: #555; }
      .cols { flex: 1; display: flex; gap: 12px; overflow-x: auto; overflow-y: hidden; padding: 12px 2px 4px; }
      .calnav { display: inline-flex; gap: 4px; }
      .calmonth { font-size: 15px; color: #222; margin: 0 6px; }
      .calhint { font-size: 11px; color: #999; }
      .calgrid { flex: 1; display: flex; flex-direction: column; min-height: 0; width: 100%; }
      .cdows { display: grid; grid-template-columns: repeat(7, 1fr); border-bottom: 1px solid #ececf1; }
      .cdow { padding: 6px 8px; font-size: 11px; color: #8a8a98; text-transform: uppercase; letter-spacing: .04em; }
      .cweeks { flex: 1; display: grid; grid-template-columns: repeat(7, 1fr); grid-auto-rows: minmax(92px, 1fr); overflow: auto; }
      .ccell { border-right: 1px solid #f0f0f4; border-bottom: 1px solid #f0f0f4; padding: 4px 5px; display: flex; flex-direction: column; gap: 3px; min-height: 0; overflow: hidden; }
      .ccell.out { background: #fafafb; }
      .ccell.drop { background: #eef6ff; outline: 2px solid #2b6cb0; outline-offset: -2px; }
      .cdn { font-size: 12px; color: #666; align-self: flex-end; flex: none; }
      .ccell.out .cdn { color: #c4c4cc; }
      .ccell.today .cdn { background: #2b6cb0; color: #fff; border-radius: 50%; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; }
      .cchips { display: flex; flex-direction: column; gap: 3px; overflow: hidden; min-height: 0; }
      .ccell.exp .cchips { overflow: auto; }
      .calchip { font-size: 11px; line-height: 1.25; padding: 2px 6px; border-radius: 5px; background: #eef1f6; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-left: 3px solid #9aa7bd; cursor: grab; flex: none; }
      .calchip:hover { background: #e4e9f1; }
      .calchip.ov { background: #fdecec; border-left-color: #e5484d; color: #a11111; }
      .calchip.done { background: #eef4ee; border-left-color: #8bbf8b; color: #4a7a4a; text-decoration: line-through; }
      .calchip.dragging { opacity: .4; }
      .ccell .caladd { align-self: flex-start; margin-top: auto; border: 0; background: transparent; color: #b4b4bc; font-size: 15px; line-height: 1; width: 18px; height: 18px; border-radius: 4px; cursor: pointer; opacity: 0; transition: opacity .1s; padding: 0; flex: none; }
      .ccell:hover .caladd { opacity: 1; }
      .ccell .caladd:hover { background: #eef1f6; color: #2b6cb0; }
      .ccell.adding { outline: 2px solid #8bc34a; outline-offset: -2px; }
      .caladdi { margin-top: 3px; width: 100%; box-sizing: border-box; font-size: 11px; padding: 3px 5px; border: 1px solid #8bc34a; border-radius: 5px; outline: none; flex: none; }
      .caladdi:disabled { opacity: .6; }
      .calmore { font-size: 10px; color: #2b6cb0; padding-left: 4px; cursor: pointer; flex: none; }
      .calmore:hover { text-decoration: underline; }
      .col { flex: 0 0 280px; width: 280px; min-width: 0; display: flex; flex-direction: column; border-radius: 10px; background: color-mix(in srgb, var(--c) 12%, #fff); min-height: 0; border: 2px solid transparent; transition: border-color .12s; }
      .col.collapsed { flex-basis: 52px; width: 52px; cursor: pointer; }
      .col.drop { border-color: var(--c); }
      .head { display: flex; align-items: center; gap: 6px; padding: 10px 10px 8px; border-bottom: 2px solid var(--c); }
      .tog { flex: none; border: 0; background: transparent; color: #666; cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 4px; border-radius: 5px; }
      .tog:hover { background: rgba(0,0,0,.07); color: #222; }
      .col.collapsed .tog { order: -1; }
      .pill { min-width: 0; background: var(--c); color: #111; font-weight: 600; font-size: 12px; padding: 4px 12px; border-radius: 999px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .count { font-size: 11px; color: #666; background: rgba(0,0,0,.06); border-radius: 999px; padding: 1px 7px; }
      .hrs { margin-left: auto; font-size: 11px; color: #777; white-space: nowrap; }
      .col.collapsed .head { flex-direction: column; border-bottom: 0; height: 100%; padding: 10px 6px; }
      .col.collapsed .pill { writing-mode: vertical-rl; transform: rotate(180deg); padding: 12px 4px; }
      .col.collapsed .hrs, .col.collapsed .list { display: none; }
      .list { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
      .empty { flex: none; color: #aaa; font-size: 12px; text-align: center; padding: 18px 6px; border: 1px dashed #d6d6d6; border-radius: 8px; }
      .card { flex: none; min-width: 0; overflow: hidden; display: block; text-decoration: none; color: inherit; background: #fff; border: 1px solid #e3e3e3; border-left: 4px solid var(--c); border-radius: 8px; padding: 10px 10px 8px; box-shadow: 0 1px 2px rgba(0,0,0,.05); cursor: grab; position: relative; }
      .card:hover { box-shadow: 0 3px 10px rgba(0,0,0,.10); }
      .card.dragging { opacity: .45; }
      .card.busy { opacity: .6; pointer-events: none; }
      .card.static { cursor: default; border-left-style: dashed; }
      .top { display: flex; gap: 6px; align-items: baseline; font-size: 11px; color: #888; padding-right: 22px; }
      .id { font-weight: 600; color: #666; white-space: nowrap; }
      .grp { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .name { font-weight: 600; font-size: 13px; color: #1a8fbf; margin: 3px 0 6px; }
      .badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
      .b { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: #f1f1f1; color: #555; }
      .b.over { background: #fde4e4; color: #b3261e; }
      .b.today { background: #efe6fb; color: #6a3fb5; }
      .prog { height: 4px; background: #eee; border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
      .prog i { display: block; height: 100%; background: #3bb3d6; }
      .foot { display: flex; align-items: center; gap: 8px; }
      .av { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; background: #ddd; flex: none; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #fff; }
      .who { flex: 1; min-width: 0; overflow: hidden; font-size: 12px; color: #444; line-height: 1.2; }
      .who small { display: block; color: #999; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .h { flex: none; margin-left: auto; font-size: 11px; color: #666; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .h.over { color: #b3261e; }
      .more { position: absolute; top: 6px; right: 6px; border: 0; background: transparent; color: #999; cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 5px; border-radius: 5px; }
      .more:hover { background: #f0f0f0; color: #333; }
      .menu { position: fixed; z-index: 5; background: #fff; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.15); padding: 4px 0; min-width: 220px; }
      .menu button { display: block; width: 100%; text-align: left; background: none; border: 0; padding: 8px 14px; font: inherit; font-size: 13px; color: #333; cursor: pointer; }
      .menu button:hover { background: #f4f4f4; }
      .mbg { position: fixed; inset: 0; z-index: 20; background: rgba(20,20,20,.45); display: flex; align-items: flex-start; justify-content: center; padding: 6vh 16px; overflow-y: auto; }
      .modal { width: min(1040px, 100%); background: #fff; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.3); border-top: 6px solid var(--c); display: flex; flex-direction: column; max-height: 88vh; }
      .mhead { position: relative; padding: 18px 56px 12px 22px; border-bottom: 1px solid #eee; }
      .mtop { display: flex; gap: 8px; font-size: 12px; color: #888; }
      .mtitle { margin: 4px 0 10px; font-size: 20px; font-weight: 600; color: #222; line-height: 1.3; }
      .mtitle .mrename { font-size: 12px; font-weight: 500; vertical-align: middle; margin-left: 8px; }
      .mnameedit { display: flex; gap: 8px; align-items: center; margin: 4px 0 10px; }
      .mnamei { flex: 1; min-width: 0; font: inherit; font-size: 18px; font-weight: 600; color: #222; padding: 6px 10px; border: 1px solid #cfcfcf; border-radius: 8px; }
      .mnamei:focus { outline: none; border-color: #7ab51d; box-shadow: 0 0 0 3px rgba(122,181,29,.18); }
      .mnamemsg { margin: 0 0 8px; }
      .mhoursi { width: 90px; font: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid #cfcfcf; border-radius: 8px; }
      .mhoursi:focus { outline: none; border-color: #7ab51d; box-shadow: 0 0 0 3px rgba(122,181,29,.18); }
      .mhrsu { font-size: 12px; color: #999; }
      .mbtn.mdelete { color: #b3261e; border-color: #e7b7b2; }
      .mbtn.mdelete:hover { background: #fdecea; border-color: #d9534f; }
      .mx { position: absolute; top: 12px; right: 14px; width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; font-size: 22px; color: #777; cursor: pointer; line-height: 1; }
      .mx:hover { background: #f1f1f1; color: #222; }
      .mstat { display: flex; gap: 8px; align-items: center; }
      .mstatus { font: inherit; font-size: 12px; font-weight: 600; line-height: 1; padding: 6px 28px 6px 12px; border-radius: 999px; border: 1px solid rgba(0,0,0,.08); background: var(--c) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23222' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 11px center / 9px 6px; color: #111; cursor: pointer; appearance: none; -webkit-appearance: none; }
      .mcols { display: flex; min-height: 0; flex: 1; }
      .mcols > .mbody { flex: 1; min-width: 0; }
      .mbody { padding: 16px 22px; overflow-y: auto; }
      .mtodo { flex: 0 0 310px; border-left: 1px solid #eee; background: #fcfcfc; padding: 16px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
      .mtodo h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #999; font-weight: 600; display: flex; align-items: center; gap: 6px; }
      .mtodo h3 .count { text-transform: none; }
      .tdlist { display: flex; flex-direction: column; gap: 2px; }
      .td { display: flex; align-items: flex-start; gap: 8px; padding: 6px 4px; border-radius: 6px; font-size: 13px; color: #333; }
      .td:hover { background: #f1f1f1; }
      .td input { margin-top: 2px; accent-color: #7ab51d; cursor: pointer; }
      .td.done .tds { color: #999; text-decoration: line-through; }
      .tds { flex: 1; min-width: 0; line-height: 1.35; word-break: break-word; }
      .tds small { display: block; font-size: 11px; color: #999; text-decoration: none; }
      .tddel { border: 0; background: none; color: #bbb; cursor: pointer; font-size: 16px; line-height: 1; padding: 0 2px; visibility: hidden; }
      .td:hover .tddel { visibility: visible; }
      .tddel:hover { color: #b3261e; }
      .tdmuted { font-size: 12px; color: #999; padding: 4px; }
      .tdtoggle { margin: 6px 4px 2px; align-self: flex-start; font-size: 12px; }
      .tdadd { display: flex; gap: 6px; margin-top: 8px; }
      .tdnew { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid #d0d0d0; border-radius: 8px; font: inherit; font-size: 13px; color: #222; background: #fff; }
      .tdnew:focus { outline: none; border-color: #7ab51d; box-shadow: 0 0 0 3px rgba(122,181,29,.18); }
      @media (max-width: 820px) { .mcols { flex-direction: column; } .mtodo { flex-basis: auto; border-left: 0; border-top: 1px solid #eee; } }
      .mbody label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #999; margin: 14px 0 5px; }
      .mbody label:first-child { margin-top: 0; }
      .mgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 4px 20px; }
      .mgrid label { margin-top: 0; }
      .mgrid > div { padding: 6px 0; font-size: 13px; color: #333; }
      .mgrid .over { color: #b3261e; }
      ${RTE_CSS}
      .mdesc { white-space: pre-wrap; font-size: 13px; line-height: 1.55; color: #333; background: #fafafa; border: 1px solid #eee; border-radius: 8px; padding: 10px 12px; max-height: 40vh; overflow-y: auto; }
      .mdesc a { color: #1a8fbf; word-break: break-all; }
      .mnodesc { font-size: 13px; color: #8a6d1a; background: #fffaf0; border: 1px solid #ecd9a6; border-radius: 8px; padding: 10px 12px; }
      .mlink { border: 0; background: none; padding: 0; color: #1a8fbf; font: inherit; font-size: 13px; cursor: pointer; text-decoration: underline; }
      .mta { display: block; width: 100%; min-height: 140px; padding: 10px 12px; border: 1px solid #cfcfcf; border-radius: 8px; font: inherit; font-size: 13px; line-height: 1.5; color: #222; background: #fff; resize: vertical; }
      .mta:focus { outline: none; border-color: #7ab51d; box-shadow: 0 0 0 3px rgba(122,181,29,.18); }
      .mrow { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
      .mhint { margin-left: auto; font-size: 11px; color: #999; }
      .mmsg { color: #b3261e; font-size: 12px; margin-top: 8px; }
      .mp { display: flex; gap: 8px; align-items: center; font-size: 13px; }
      .mp small { display: block; font-size: 11px; color: #999; }
      .mpeople { display: flex; flex-wrap: wrap; gap: 10px 22px; }
      .mfoot { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 12px 22px; border-top: 1px solid #eee; background: #fafafa; border-radius: 0 0 12px 12px; }
      .mbtn { font: inherit; font-size: 13px; padding: 8px 14px; border-radius: 8px; border: 1px solid #d0d0d0; background: #fff; color: #333; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; text-decoration: none; line-height: 1.2; }
      .mbtn .ic { width: 14px; height: 14px; flex: none; }
      .mbtn:hover { background: #f3f3f3; }
      .mbtn.primary { background: #7ab51d; border-color: #7ab51d; color: #fff; font-weight: 600; }
      .mbtn.primary:hover { background: #6a9f18; }
      .mbtn:disabled { opacity: .6; cursor: default; }
      .spacer { flex: 1; }
      .msg { padding: 30px; color: #888; text-align: center; }
      .msg.err { color: #b3261e; }
    </style><div class="wrap"><div class="bar"></div><div class="cols"><div class="msg">Loading board…</div></div></div>`;
    ['keydown', 'keyup', 'keypress'].forEach(t => root.addEventListener(t, e => e.stopPropagation()));
    root.addEventListener('keydown', e => {
      if (e.target && e.target.classList && e.target.classList.contains('caladdi')) {
        if (e.key === 'Enter') { e.preventDefault(); submitCalAdd(e.target); return; }
        if (e.key === 'Escape') { e.preventDefault(); board.calAdd = null; renderBoard(); return; }
        return;
      }
      if (!board.modal) return;
      if (e.key === 'Enter' && e.target && e.target.classList && e.target.classList.contains('tdnew')) { e.preventDefault(); addTodo(); return; }
      if (e.key === 'Enter' && e.target && e.target.classList && e.target.classList.contains('mnamei')) { e.preventDefault(); const b = root.querySelector('.mnamesave'); if (b) b.click(); return; }
      if (e.key === 'Enter' && e.target && e.target.classList && e.target.classList.contains('mhoursi')) { e.preventDefault(); const b = root.querySelector('.mhourssave'); if (b) b.click(); return; }
      if (e.key === 'Escape') { e.preventDefault(); if (board.modal.editing) { board.modal.editing = false; renderModal(); } else if (board.modal.editingName) { board.modal.editingName = false; board.modal.nameDraft = null; board.modal.nameMsg = ''; renderModal(); } else if (board.modal.editingHours) { board.modal.editingHours = false; board.modal.hoursDraft = null; board.modal.hoursMsg = ''; renderModal(); } else closeModal(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && board.modal.editing) { e.preventDefault(); const b = root.querySelector('.msave'); if (b) b.click(); }
    });
    root.addEventListener('click', onBoardClick);
    // Avatar images that fail to load fall back to initials.
    root.addEventListener('error', e => {
      const img = e.target;
      if (img.tagName !== 'IMG' || !img.classList.contains('av')) return;
      const sp = document.createElement('span'); sp.className = 'av'; sp.style.background = '#8a9bab'; sp.textContent = img.dataset.ini || '?';
      img.replaceWith(sp);
    }, true);
    root.addEventListener('change', e => { if (e.target.classList.contains('calshow')) { board.calShow = e.target.checked; renderBoard(); return; } if (e.target.classList.contains('hopt')) { setHygCountPref(e.target.dataset.opt, e.target.checked); renderBoard(); return; } if (e.target.classList.contains('hchk')) { const k = e.target.dataset.k; if (e.target.checked) board.hyg.add(k); else board.hyg.delete(k); renderBoard(); return; } if (e.target.classList.contains('showc')) { board.collapsed['Completed'] = !e.target.checked; saveCollapsed(); renderBoard(); return; } if (e.target.classList.contains('onlytd')) { board.onlyTodos = e.target.checked; renderBoard(); return; } if (e.target.classList.contains('onlycv')) { board.onlyConv = e.target.checked; renderBoard(); } });
    // Mouse-driven drag (native HTML5 drag on links drags the URL instead, and is unreliable inside shadow roots).
    root.addEventListener('dragstart', e => e.preventDefault());
    root.addEventListener('mousedown', onCardMouseDown);
    document.body.appendChild(host);
    board.host = host; board.root = root;
  }

  async function loadBoard() {
    const pk = board.projectKey, seq = ++board.seq;
    if (!(Number(pk) > 0)) return;   // never load with a missing project key
    board.convHosts = null; // conversation sections reload on the next modal open
    if (!board.data) board.root.querySelector('.cols').innerHTML = '<div class="msg">Loading board…</div>';
    scheduleCache.delete(String(pk));
    try {
      const s = await getSchedule(pk);
      if (seq !== board.seq || pk !== board.projectKey) return;
      board.data = s.raw;
      board.todos = null; board.todosFor = null;
      renderBoard();
      // Back from a reply / new post / thread opened from a card modal (leaving the Schedule rebuilds the board):
      // reopen that card, scrolled to its conversations.
      const ro = board.reopen;
      if (ro && ro.pk === pk && Date.now() - ro.ts < 30 * 60000) {
        board.reopen = null;
        board.modal = { ref: ro.ref, editing: false, draft: '', msg: '', scrollConv: true };
        board.host.style.zIndex = '40'; renderModal();
      } else if (ro && ro.pk !== pk) board.reopen = null;
      loadTodos();
      loadBoardConvs();
      } catch (e) {
      board.root.querySelector('.cols').innerHTML = `<div class="msg err">Could not load the schedule: ${esc(e && e.message || e)}</div>`;
    }
  }

  const hasDesc = t => !!String(t && t.Description || '').replace(/<[^>]*>/g, '').trim();
  // Project hygiene checks. Each applies to open work only: assignment cards that aren't done, plus open tasks with nobody assigned.
  const HYGIENE = [
    { key: 'nodesc', label: 'No description', hint: 'Task has no description', card: c => c.noDesc, task: t => t.noDesc },
    { key: 'overdue', label: 'Overdue', hint: 'Past its due date and not completed', card: c => c.days != null && c.days < 0, task: t => t.days != null && t.days < 0 },
    { key: 'overbudget', label: 'Over budget', hint: 'More hours logged than planned', card: c => c.planned > 0 && c.actual > c.planned, task: () => false },
    { key: 'nohours', label: 'No hours planned', hint: 'Assignment has 0 planned hours', card: c => !(c.planned > 0), task: () => false },
    { key: 'unassigned', label: 'Not assigned', hint: 'Task with nobody on it, or an empty assignment slot', card: c => c.userKey < 0, task: () => true }
  ];
  board.hyg = new Set();
  const issuesOf = (item, isTask) => HYGIENE.filter(h => (isTask ? h.task(item) : h.card(item))).map(h => h.key);
  const hygPass = (item, isTask) => !board.hyg.size || issuesOf(item, isTask).some(k => board.hyg.has(k));

  // Which rows the hygiene tally includes. Completed and summary rows are left out by default — completed work isn't an
  // open problem, and a summary would double-count the children beneath it — but a PM can switch either back on (saved
  // per browser). When Workamajig's own "Hide Completed Tasks" is on, completed rows aren't on screen, so they stay out
  // regardless, keeping the hygiene numbers in step with what the list shows.
  const HYG_COUNT_KEY = 'uxa.hygiene.counting';
  function hygCountPrefs() { try { return JSON.parse(localStorage.getItem(HYG_COUNT_KEY)) || {}; } catch (e) { return {}; } }
  function setHygCountPref(k, v) { const p = hygCountPrefs(); p[k] = !!v; try { localStorage.setItem(HYG_COUNT_KEY, JSON.stringify(p)); } catch (e) {} }
  function nativeHideCompleted() {
    const pg = schedulePage(); const mo = pg && pg.view && pg.view.module && pg.view.module.model;
    return !!(mo && mo.searchTasks && mo.searchTasks.si && Number(mo.searchTasks.si.hideCompleted) === 1);
  }
  // Does this card/open task belong in the hygiene tally? (cards carry .completed/.summary; unassigned items are open leaves)
  function hygInScope(item) {
    if (item.summary && !hygCountPrefs().summaries) return false;
    if (item.completed && !(hygCountPrefs().completed && !nativeHideCompleted())) return false;
    return true;
  }
  // Counts over the whole project's open work: per issue, and items with at least one issue.
  function hygieneCounts(m) {
    const items = m.cards.filter(hygInScope).map(c => issuesOf(c, false)).concat(m.unassigned.map(t => issuesOf(t, true)));
    const per = {}; HYGIENE.forEach(h => { per[h.key] = items.filter(i => i.includes(h.key)).length; });
    return { per, total: items.filter(i => i.length).length };
  }

  // Open leaf tasks with no description (summary rows and finished tasks don't count).
  function missingDescTasks(raw) {
    const parents = new Set((raw.tasks || []).map(t => t.SummaryTaskKey).filter(Boolean));
    return (raw.tasks || []).filter(t => !parents.has(t.TaskKey) && +t.PercComp < 100 && !hasDesc(t));
  }

  // Model: columns + cards from the raw getSchedule payload.
  function boardModel(raw = board.data) {
    const tasks = new Map((raw.tasks || []).map(t => [t.TaskKey, t]));
    const parents = new Set((raw.tasks || []).map(t => t.SummaryTaskKey).filter(Boolean));
    const tus = raw.projectTaskUserData || [];
    const statuses = (raw.taskUserStatus || []).map((st, i) => ({ key: st.k, name: st.l, color: STATUS_COLORS[st.l] || FALLBACK_COLORS[i % FALLBACK_COLORS.length] }));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cards = tus.map(tu => {
      const t = tasks.get(tu.TaskKey) || {};
      const status = tu.TaskUserStatusKey > 0 ? tu.TaskUserStatusKey : 0;
      const done = status === COMPLETED_KEY || (!status && (+tu.PercComp >= 100 || !!tu.ActComplete));
      // Completion regardless of status: a task can be 100% / actually complete while still carrying a work status.
      const completed = status === COMPLETED_KEY || +tu.PercComp >= 100 || !!tu.ActComplete;
      const dueRaw = tu.APlanComplete || t.PlanComplete;
      const due = dueRaw ? new Date(String(dueRaw).slice(0, 10) + 'T00:00:00') : null;
      const days = due ? Math.round((due - today) / 864e5) : null;
      return { tuk: tu.TaskUserKey, taskKey: tu.TaskKey, status, done, completed, summary: parents.has(tu.TaskKey), user: (tu.UserName || '').trim(), userKey: tu.UserKey || -1,
        initials: tu.Initials || '', service: tu.ServiceDescription || '', actual: +tu.ActualHours || 0, planned: +tu.Hours || 0,
        pc: +tu.PercComp || 0, due, days, taskId: t.TaskID || '', taskName: t.TaskName || '(task)', group: t.SummaryTaskName || '', order: t.ProjectOrder || 0, noDesc: !hasDesc(t) };
    });
    const assigned = new Set(tus.map(tu => tu.TaskKey));
    const unassigned = (raw.tasks || []).filter(t => !parents.has(t.TaskKey) && !assigned.has(t.TaskKey) && +t.PercComp < 100)
      .map(t => ({ taskKey: t.TaskKey, taskId: t.TaskID || '', taskName: t.TaskName || '(task)', group: t.SummaryTaskName || '', order: t.ProjectOrder || 0, noDesc: !hasDesc(t),
        days: t.PlanComplete ? Math.round((new Date(String(t.PlanComplete).slice(0, 10) + 'T00:00:00') - today) / 864e5) : null,
        due: t.PlanComplete ? new Date(String(t.PlanComplete).slice(0, 10) + 'T00:00:00') : null }));
    return { statuses, cards, unassigned };
  }

  // ---------- Calendar view (project tasks by due date; a modal over the schedule, ClickUp/Asana style) ----------
  function calEnabled() { return true; }
  const cal = { month: null };
  const CAL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const CAL_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const calYmd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Leaf tasks with a due date, tagged overdue/done. Summary rows are left out.
  function calTasks(raw) {
    const parents = new Set((raw.tasks || []).map(t => t.SummaryTaskKey).filter(Boolean));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return (raw.tasks || []).filter(t => !parents.has(t.TaskKey) && t.PlanComplete).map(t => {
      const date = String(t.PlanComplete).slice(0, 10);
      const d = new Date(date + 'T00:00:00');
      const done = +t.PercComp >= 100 || !!t.ActComplete;
      return { taskKey: t.TaskKey, taskId: t.TaskID || '', name: t.TaskName || '(task)', group: t.SummaryTaskName || '', date, done, overdue: !done && d < today };
    });
  }
  function calMonthDays(month) {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first); start.setDate(1 - first.getDay());
    const days = []; for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
    return days;
  }

  function renderBoard() {
    if (!board.root || !board.data) return;
    if (board.view === 'calendar') return renderCalendarView();
    const m = boardModel();
    // Toolbar: people chips (open work only), search, show completed, refresh.
    // Chip counts = open assignments that pass the other active filters (description, search), so numbers match the board.
    const q = board.search.trim().toLowerCase();
    const passes = c => !c.done && hygPass(c, false) && todoPass(c.taskKey) && convPass(c.taskKey) &&
      (!q || [c.taskId, c.taskName, c.group, c.user, c.service].some(v => String(v || '').toLowerCase().includes(q)));
    const people = new Map();
    m.cards.filter(c => !c.done).forEach(c => { const k = c.userKey; const p = people.get(k) || { key: k, name: c.user || 'Unassigned', initials: c.initials, n: 0 }; if (passes(c)) p.n++; people.set(k, p); });
    const open = m.cards.filter(passes).length;
    const chips = [`<button type="button" class="chip all ${board.user ? '' : 'on'}" data-user="0">Everyone <span class="n">${open}</span></button>`]
      .concat([...people.values()].sort((a, b) => b.n - a.n).map(p =>
        `<button type="button" class="chip ${board.user === p.key ? 'on' : ''}" data-user="${p.key}">${avatarHtml(p.key, p.name, p.initials)}${esc(p.name.split(' ')[0])} <span class="n">${p.n}</span></button>`));
    const bar = board.root.querySelector('.bar');
    bar.innerHTML = `<div class="chips">${chips.join('')}</div>
      <label class="chk"><input type="checkbox" class="showc" ${showDone() ? 'checked' : ''}> Show completed</label>
      <label class="chk" title="Only tasks that still have unfinished to-dos"><input type="checkbox" class="onlytd" ${board.onlyTodos ? 'checked' : ''}> Has open to-dos</label>
      <label class="chk" title="Only tasks that have at least one conversation"><input type="checkbox" class="onlycv" ${board.onlyConv ? 'checked' : ''}> Has conversations</label>
      <button type="button" class="icon collapse-all" title="Collapse every column">Collapse all</button>
      <button type="button" class="icon expand-all" title="Expand every column">Expand all</button>
      ${(() => { const hc = hygieneCounts(m); board.hygCounts = hc; const cpB = hygCountPrefs(), nhcB = nativeHideCompleted(); return `<span class="hwrap"><button type="button" class="icon hyg ${board.hyg.size ? 'on' : ''}" title="Project hygiene: find open work with problems">Hygiene <span class="n">${hc.total}</span> ▾</button>${board.hygOpen ? `<div class="hmenu">
        <div class="htitle">Show open work that has…</div>
        ${HYGIENE.map(h => `<label class="hrow"><input type="checkbox" class="hchk" data-k="${h.key}" ${board.hyg.has(h.key) ? 'checked' : ''}><span class="hl">${h.label}<small>${h.hint}</small></span><span class="hc">${hc.per[h.key]}</span></label>`).join('')}
        <div class="hopts" style="border-top:1px solid #ececec;margin-top:4px;padding:7px 12px;display:flex;flex-direction:column;gap:4px;font-size:12px;color:#555"><label style="display:flex;align-items:center;gap:7px;cursor:${nhcB ? 'default' : 'pointer'};${nhcB ? 'opacity:.55' : ''}"><input type="checkbox" class="hopt" data-opt="completed" ${cpB.completed && !nhcB ? 'checked' : ''} ${nhcB ? 'disabled' : ''}> Count completed tasks</label><label style="display:flex;align-items:center;gap:7px;cursor:pointer"><input type="checkbox" class="hopt" data-opt="summaries" ${cpB.summaries ? 'checked' : ''}> Count summary tasks</label>${nhcB ? `<small style="color:#999">Workamajig’s “Hide Completed Tasks” is on, so completed tasks stay out.</small>` : ''}</div>
        <div class="hfoot"><button type="button" class="mlink hall">Any issue</button><button type="button" class="mlink hnone">Clear</button></div></div>` : ''}</span>`; })()}
      <button type="button" class="icon refresh" style="margin-left:auto" title="Reload from Workamajig">↻</button>
      ${(() => {
        // One removable chip per active filter (person, each hygiene issue, search, to-dos, conversations), so it's
        // clear what's on and each can be dropped on its own via its ×. "Clear all" only when more than one is active.
        const chips = [];
        if (board.user) { const p = people.get(board.user); chips.push({ f: 'user', label: esc(p ? p.name : 'One person') }); }
        if (board.hyg.size) HYGIENE.filter(h => board.hyg.has(h.key)).forEach(h => chips.push({ f: 'hyg', k: h.key, label: esc(h.label) }));
        if (q) chips.push({ f: 'search', label: 'Matching “' + esc(board.search.trim()) + '”' });
        if (board.onlyTodos) chips.push({ f: 'todos', label: 'Has open to-dos' });
        if (board.onlyConv) chips.push({ f: 'conv', label: 'Has conversations' });
        if (!chips.length) return '';
        const pills = chips.map(c => `<span class="fpill">${c.label}<button type="button" class="fpx" data-f="${c.f}"${c.k ? ` data-k="${c.k}"` : ''} title="Remove this filter" aria-label="Remove this filter">×</button></span>`).join('');
        return `<div class="fsum"><span class="flabel">Filters</span>${pills}${chips.length > 1 ? '<button type="button" class="mlink fclear">Clear all</button>' : ''}</div>`;
      })()}`;
    board.model = m;
    renderColumns();
    if (board.modal) renderModal();
  }

  // Calendar as an inline board view: month nav in the toolbar, a month grid in place of the columns. Clicking a task
  // opens the same card modal as the board; dragging it to another day changes its due date.
  function renderCalendarView() {
    if (!cal.month) { const n = new Date(); cal.month = new Date(n.getFullYear(), n.getMonth(), 1); }
    const bar = board.root.querySelector('.bar');
    bar.innerHTML = `<span class="calnav"><button type="button" class="icon calprev" title="Previous month">‹</button><button type="button" class="icon caltoday">Today</button><button type="button" class="icon calnext" title="Next month">›</button></span>`
      + `<strong class="calmonth">${esc(CAL_MONTHS[cal.month.getMonth()])} ${cal.month.getFullYear()}</strong>`
      + `<label class="chk"><input type="checkbox" class="calshow" ${board.calShow ? 'checked' : ''}> Show completed</label>`
      + `<span class="calhint">Drag a task to change its due date · click to open · + to add</span>`
      + `<button type="button" class="icon refresh" style="margin-left:auto" title="Reload from Workamajig">↻</button>`;
    board.root.querySelector('.cols').innerHTML = calGridHtml();
    if (board.modal) renderModal();
  }
  function calGridHtml() {
    const byDate = new Map();
    // The shared search (Workamajig's own box, synced into board.search) filters the calendar too, like List and Board.
    const q = board.search.trim().toLowerCase();
    const matchQ = t => !q || [t.taskId, t.name, t.group].some(v => String(v || '').toLowerCase().includes(q));
    for (const t of calTasks(board.data)) { if (!board.calShow && t.done) continue; if (!matchQ(t)) continue; if (!byDate.has(t.date)) byDate.set(t.date, []); byDate.get(t.date).push(t); }
    const today = calYmd(new Date());
    const dows = CAL_DOW.map(d => `<div class="cdow">${d}</div>`).join('');
    const cells = calMonthDays(cal.month).map(d => {
      const key = calYmd(d), inMonth = d.getMonth() === cal.month.getMonth();
      const list = (byDate.get(key) || []).slice().sort((a, b) => (a.taskId || '').localeCompare(b.taskId || '', undefined, { numeric: true }));
      const expanded = board.calExpand === key;
      const shown = expanded ? list : list.slice(0, 4);
      const chips = shown.map(t => `<div class="calchip ${t.overdue ? 'ov' : ''} ${t.done ? 'done' : ''}" data-task="${t.taskKey}" title="${esc((t.taskId ? t.taskId + ' · ' : '') + t.name + (t.group ? ' — ' + t.group : ''))}">${esc(t.name)}</div>`).join('');
      const more = (!expanded && list.length > shown.length) ? `<div class="calmore" data-date="${key}">+${list.length - shown.length} more</div>` : '';
      const adding = board.calAdd === key;
      const addUi = !inMonth ? ''
        : adding ? `<input class="caladdi" type="text" placeholder="Task name…" data-date="${key}" maxlength="200" ${board.calAdding ? 'disabled' : ''}>`
        : `<button type="button" class="caladd" data-date="${key}" title="Add a task due this day">+</button>`;
      return `<div class="ccell ${inMonth ? '' : 'out'} ${key === today ? 'today' : ''} ${expanded ? 'exp' : ''} ${adding ? 'adding' : ''}" data-date="${key}"><span class="cdn">${d.getDate()}</span><div class="cchips">${chips}${more}</div>${addUi}</div>`;
    }).join('');
    return `<div class="calgrid"><div class="cdows">${dows}</div><div class="cweeks">${cells}</div></div>`;
  }
  // Create a task from the Calendar's inline "Task name…" box (Enter). Keeps the box disabled during the write so a
  // blur can't cancel mid-flight, then reloads the board so the new chip appears on its day.
  async function submitCalAdd(input) {
    const name = String(input.value || '').trim();
    const date = input.dataset.date;
    if (!name) { board.calAdd = null; renderBoard(); return; }
    board.calAdding = true; input.disabled = true;
    try {
      await createTask(board.projectKey, name, date);
      board.calAdd = null; board.calAdding = false;
      toast('Task created'); await loadBoard();
    } catch (err) {
      board.calAdding = false; input.disabled = false;
      toast('Could not create task: ' + (err && err.message || err));
    }
  }

  function renderColumns() {
    const m = board.model; if (!m) return;
    const q = board.search.trim().toLowerCase();
    const match = c => (!board.user || c.userKey === board.user) && (!board.hyg.size || (!c.done && hygPass(c, false))) && todoPass(c.taskKey) && convPass(c.taskKey) &&
      (!q || [c.taskId, c.taskName, c.group, c.user, c.service].some(v => String(v || '').toLowerCase().includes(q)));
    const sortCards = (a, b) => ((a.days == null) - (b.days == null)) || ((a.days ?? 0) - (b.days ?? 0)) || (a.order - b.order);
    const cols = [];
    const noStatus = m.cards.filter(c => !c.status && (!c.done || showDone()) && match(c));
    if (noStatus.length) cols.push({ key: 0, name: 'No status', color: '#d6d6d6', cards: noStatus, drop: false });
    m.statuses.forEach(st => {
      const isDone = st.key === COMPLETED_KEY;
      const cards = m.cards.filter(c => c.status === st.key && match(c) && (isDone || !c.done || showDone()));
      cols.push({ key: st.key, name: st.name, color: st.color, cards, drop: true });
    });
    if (!board.user) {
      const un = m.unassigned.filter(t => hygPass(t, true) && todoPass(t.taskKey) && convPass(t.taskKey)).filter(t => !q || [t.taskId, t.taskName, t.group].some(v => String(v).toLowerCase().includes(q)));
      if (un.length) cols.push({ key: -2, name: 'Not assigned', color: '#9b9b9b', cards: un, drop: false, unassigned: true });
    }
    cols.forEach(col => { col.collapsed = isCollapsed(col.name); });
    board.colNames = cols.map(c => c.name);
    const html = cols.map(col => {
      const list = col.collapsed ? '' : (col.cards.slice().sort(sortCards).map(c => col.unassigned ? unassignedCard(c) : cardHtml(c, col)).join('') || '<div class="empty">Drop a card here</div>');
      const hrs = col.unassigned ? '' : col.cards.reduce((s, c) => s + Math.max(0, c.planned - c.actual), 0);
      const n = col.cards.length;
      return `<section class="col ${col.collapsed ? 'collapsed' : ''}" style="--c:${col.color}" data-status="${col.key}" data-name="${esc(col.name)}" data-drop="${col.drop ? 1 : 0}" ${col.collapsed ? `title="Expand ${esc(col.name)}"` : ''}>
        <div class="head"><button type="button" class="tog" title="${col.collapsed ? 'Expand' : 'Collapse'} column">${col.collapsed ? '›' : '‹'}</button><span class="pill">${esc(col.name)}</span><span class="count">${n}</span>${hrs !== '' && !col.collapsed ? `<span class="hrs" title="Planned hours not yet logged">${fmtH(hrs)} left</span>` : ''}</div>
        <div class="list">${list}</div></section>`;
    }).join('');
    board.root.querySelector('.cols').innerHTML = html || '<div class="msg">No assignments on this project.</div>';
  }

  const fmtH = h => (Math.round(h * 100) / 100) + 'h';
  function avatarHtml(userKey, name, initials) {
    const ini = esc(initials || (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2));
    if (!userKey || userKey < 0) return `<span class="av" style="background:#bbb">?</span>`;
    return `<img class="av" alt="" src="${BASE}common/logo.aspx?logo=avatar&k=${userKey}&type=User" title="${esc(name)}" data-ini="${ini}">`;
  }
  function dueBadge(c) {
    if (!c.due) return '';
    const label = c.due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (c.done) return `<span class="b">Due ${label}</span>`;
    if (c.days < 0) return `<span class="b over">Overdue ${-c.days}d</span>`;
    if (c.days === 0) return `<span class="b today">Due today</span>`;
    return `<span class="b">Due ${label}</span>`;
  }
  function cardHtml(c, col) {
    const overHrs = c.planned > 0 && c.actual > c.planned;
    return `<a class="card" draggable="false" data-tuk="${c.tuk}" data-task="${c.taskKey}" href="${urls.assignment(c.tuk)}" style="--c:${col.color}">
      <div class="top"><span class="id">${esc(c.taskId)}</span><span class="grp">${esc(c.group)}</span></div>
      <button type="button" class="more" title="More">⋯</button>
      <div class="name">${esc(c.taskName)}</div>
      <div class="badges">${dueBadge(c)}${c.pc ? `<span class="b">${c.pc}%</span>` : ''}${todoBadge(c.taskKey)}${convBadge(c.taskKey)}${c.noDesc && !c.done ? '<span class="b nd">No description</span>' : ''}${!c.done && board.hyg.has('overbudget') && c.planned > 0 && c.actual > c.planned ? '<span class="b ob">Over budget</span>' : ''}${!c.done && board.hyg.has('nohours') && !(c.planned > 0) ? '<span class="b nh">No hours planned</span>' : ''}</div>
      ${c.pc ? `<div class="prog"><i style="width:${Math.min(100, c.pc)}%"></i></div>` : ''}
      <div class="foot">${avatarHtml(c.userKey, c.user, c.initials)}<span class="who">${esc(c.user || 'Unassigned slot')}<small>${esc(c.service)}</small></span>
      <span class="h ${overHrs ? 'over' : ''}" title="Logged / planned hours">${fmtH(c.actual)} / ${fmtH(c.planned)}</span></div></a>`;
  }
  function unassignedCard(t) {
    const label = t.due ? t.due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    return `<div class="card static" data-task="${t.taskKey}" style="--c:#9b9b9b" title="No one is assigned. Click to assign people.">
      <div class="top"><span class="id">${esc(t.taskId)}</span><span class="grp">${esc(t.group)}</span></div>
      <button type="button" class="more" title="More">⋯</button>
      <div class="name">${esc(t.taskName)}</div>
      <div class="badges">${label ? `<span class="b">Due ${label}</span>` : ''}<span class="b">No assignee</span>${todoBadge(t.taskKey)}${convBadge(t.taskKey)}${t.noDesc ? '<span class="b nd">No description</span>' : ''}</div></div>`;
  }

  function onBoardClick(e) {
    const t = e.target;
    if (board.justDragged) { e.preventDefault(); e.stopPropagation(); board.justDragged = false; return; }
    if (t.closest && t.closest('.mbg')) { onModalClick(e); return; }
    if (t.classList.contains('calprev')) { cal.month.setMonth(cal.month.getMonth() - 1); board.calExpand = null; renderBoard(); return; }
    if (t.classList.contains('calnext')) { cal.month.setMonth(cal.month.getMonth() + 1); board.calExpand = null; renderBoard(); return; }
    if (t.classList.contains('caltoday')) { const n = new Date(); cal.month = new Date(n.getFullYear(), n.getMonth(), 1); board.calExpand = null; renderBoard(); return; }
    if (t.classList.contains('calmore')) { board.calExpand = t.dataset.date; renderBoard(); return; }
    if (t.classList.contains('caladd')) {
      board.calAdd = t.dataset.date; renderBoard();
      const i = board.root.querySelector('.caladdi');
      if (i) { i.focus(); i.addEventListener('blur', () => { if (board.calAdd && !board.calAdding) { board.calAdd = null; renderBoard(); } }); }
      return;
    }
    if (t.classList.contains('caladdi')) return; // typing in the quick-add box
    if (board.calAdd && t.closest && t.closest('.ccell') && !t.closest('.calchip')) { board.calAdd = null; renderBoard(); return; }
    { const cc = t.closest && t.closest('.calchip'); if (cc) { const tk = Number(cc.dataset.task); const slot = (board.data.projectTaskUserData || []).find(x => x.TaskKey === tk && x.UserKey > 0); openModal({ taskKey: tk, tuk: slot ? slot.TaskUserKey : 0 }); return; } }
    if (t.classList.contains('chip')) { board.user = Number(t.dataset.user); renderBoard(); return; }
    if (t.closest && t.closest('.chip')) { board.user = Number(t.closest('.chip').dataset.user); renderBoard(); return; }
    if (t.classList.contains('refresh')) { loadBoard(); return; }
    if (t.classList.contains('fpx')) {
      const f = t.dataset.f;
      if (f === 'user') board.user = 0;
      else if (f === 'hyg') board.hyg.delete(t.dataset.k);
      else if (f === 'search') { board.search = ''; clearNativeSearch(); }
      else if (f === 'todos') board.onlyTodos = false;
      else if (f === 'conv') board.onlyConv = false;
      renderBoard(); return;
    }
    if (t.classList.contains('fclear')) { board.user = 0; board.hyg.clear(); board.onlyTodos = false; board.onlyConv = false; board.search = ''; clearNativeSearch(); board.hygOpen = false; renderBoard(); return; }
    if (t.closest && t.closest('.hyg')) { board.hygOpen = !board.hygOpen; renderBoard(); return; }
    if (t.classList.contains('hall')) { HYGIENE.forEach(h => board.hyg.add(h.key)); renderBoard(); return; }
    if (t.classList.contains('hnone')) { board.hyg.clear(); renderBoard(); return; }
    if (t.closest && t.closest('.hmenu')) return; // checkbox changes handled in the change listener
    if (board.hygOpen) { board.hygOpen = false; renderBoard(); }
    if (t.classList.contains('collapse-all') || t.classList.contains('expand-all')) {
      const v = t.classList.contains('collapse-all');
      (board.colNames || []).forEach(n => { board.collapsed[n] = v; });
      saveCollapsed(); renderBoard(); return;
    }
    const tog = t.closest && t.closest('.tog');
    const ccol = t.closest && t.closest('.col.collapsed');
    if (tog || ccol) {
      const col = (tog || ccol).closest('.col');
      const name = col.dataset.name;
      board.collapsed[name] = !isCollapsed(name);
      saveCollapsed(); renderBoard(); return;
    }
    if (t.classList.contains('more')) { e.preventDefault(); e.stopPropagation(); openCardMenu(t); return; }
    if (t.closest && t.closest('.menu')) return;
    closeCardMenu();
    const card = t.closest && t.closest('.card');
    if (!card) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // let the link open in a new tab
    e.preventDefault();
    openModal({ tuk: Number(card.dataset.tuk) || 0, taskKey: Number(card.dataset.task) });
    // Clicking the conversations badge jumps straight to the conversations.
    if (t.closest('.cvb') && board.modal) { board.modal.scrollConv = true; renderModal(); }
  }

  // ---- card details modal ----
  // Swallow Escape at the window (capture) while a board/calendar modal is open, so Workamajig's own close-page
  // handler never sees it and only the modal closes.
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && board.on && board.modal) { e.stopImmediatePropagation(); e.preventDefault(); if (board.modal.editing) { board.modal.editing = false; renderModal(); } else if (board.modal.editingName) { board.modal.editingName = false; board.modal.nameDraft = null; board.modal.nameMsg = ''; renderModal(); } else if (board.modal.editingHours) { board.modal.editingHours = false; board.modal.hoursDraft = null; board.modal.hoursMsg = ''; renderModal(); } else closeModal(); } }, true);
  function openModal(ref) { board.modal = { ref, editing: false, draft: '', msg: '' }; board.host.style.zIndex = '40'; renderModal(); const x = board.root && board.root.querySelector('.mx'); if (x) x.focus(); }
  function closeModal() { board.modal = null; if (board.host) board.host.style.zIndex = '10'; const bg = board.root && board.root.querySelector('.mbg'); if (bg) bg.remove(); if (board.detached) boardDetachEnd(); }
  // ---- detached card modal ----
  // The same card-details modal, on its own, over another of our views (the Resource Schedule) with no schedule page
  // underneath. We load that task's project schedule into the board state exactly as the board does, keep the board
  // itself hidden (only the modal's backdrop shows), and drop it all again when the modal closes. "Show in list" and
  // "Manage assignees" need the schedule page, so they are hidden here ("Open full assignment" covers both).
  async function openTaskModalDetached(pk, taskKey, tuk, userKey) {
    pk = String(pk || '');
    if (!(Number(pk) > 0) || !(Number(taskKey) > 0) || board.detached) return;
    if (!board.host) buildBoardHost();
    if (!document.getElementById('uxa-board-detached')) {
      const g = document.createElement('style'); g.id = 'uxa-board-detached';
      g.textContent = '#uxa-board[data-detached]{display:block!important;visibility:visible!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:99995!important}';
      (document.head || document.documentElement).appendChild(g);
    }
    if (!board.root.querySelector('style.detached')) {
      const st = document.createElement('style'); st.className = 'detached';
      st.textContent = '.wrap.detached{background:transparent}.wrap.detached>:not(.mbg){display:none!important}.wrap.detached .mlist,.wrap.detached .massign{display:none!important}';
      board.root.appendChild(st);
    }
    board.root.querySelector('.wrap').classList.add('detached');
    board.host.dataset.detached = '1';
    board.detached = { aid: aid(), userKey: Number(userKey) || 0 };
    board.on = true; board.reopen = null; board.user = 0;
    if (board.projectKey !== pk) board.data = null;
    board.projectKey = pk;
    toast('Opening task…');
    await loadBoard();
    if (!board.detached || board.projectKey !== pk) return;          // closed or superseded while loading
    if (!board.data || !(board.data.tasks || []).some(x => x.TaskKey === Number(taskKey))) { toast('Could not open that task'); boardDetachEnd(); return; }
    openModal({ taskKey: Number(taskKey), tuk: Number(tuk) || 0 });
    if (!board.modal && board.detached) boardDetachEnd();              // the modal feature is off: nothing to show
  }
  function boardDetachEnd() {
    const d = board.detached; if (!d) return;
    board.detached = null;
    if (board.host) { delete board.host.dataset.detached; const w = board.root.querySelector('.wrap'); if (w) w.classList.remove('detached'); }
    board.dirty = false;
    closeBoard(true);
    if (rs.open && d.userKey) rsReloadUser(d.userKey);               // the modal may have changed status / hours / dates
  }
  const linkify = txt => esc(txt).replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  const fmtDate = d => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  function renderModal() {
    const st = board.modal; if (!st || !board.data) return;
    const old = board.root.querySelector('.mbg');
    if (old) { const ed = old.querySelector('.rtein'); if (ed) st.draftHtml = ed.innerHTML; const ti = old.querySelector('.tdnew'); if (ti) st.tdDraft = ti.value; const ni = old.querySelector('.mnamei'); if (ni) st.nameDraft = ni.value; const hi = old.querySelector('.mhoursi'); if (hi) st.hoursDraft = hi.value; const ob = old.querySelector('.mbody'); if (ob) st.scrollTop = ob.scrollTop; }
    const raw = board.data, ref = st.ref;
    const t = (raw.tasks || []).find(x => x.TaskKey === ref.taskKey) || {};
    const tu = ref.tuk ? (raw.projectTaskUserData || []).find(x => x.TaskUserKey === ref.tuk) : null;
    const others = (raw.projectTaskUserData || []).filter(x => x.TaskKey === ref.taskKey && x.TaskUserKey !== ref.tuk);
    const statuses = raw.taskUserStatus || [];
    const color = tu ? (STATUS_COLORS[tu.StatusName] || '#d6d6d6') : '#9b9b9b';
    const canEdit = !!(window.System && System.rights && System.rights.prjedittasks);
    const planned = tu ? +tu.Hours || 0 : 0, actual = tu ? +tu.ActualHours || 0 : 0;
    const statusSel = tu ? `<select class="mstatus" style="--c:${color}">${tu.TaskUserStatusKey > 0 ? '' : '<option value="0" selected>No status</option>'}${statuses.map(x => `<option value="${x.k}" ${x.k === tu.TaskUserStatusKey ? 'selected' : ''}>${esc(x.l)}</option>`).join('')}</select>` : '<span class="b">Not assigned</span>';
    const descHtml = st.editing
      ? `${rteEditor(st.draftHtml != null ? st.draftHtml : descToHtml(st.base))}
         <div class="mrow"><button type="button" class="mbtn primary msave">Save description</button><button type="button" class="mbtn mcancel">Cancel</button><span class="mhint">⌘/Ctrl + Enter to save</span></div>`
      : descHasText(t.Description) ? `<div class="desc-html">${descToHtml(t.Description)}</div>${canEdit ? '<div class="mrow"><button type="button" class="mlink medit">Edit description</button></div>' : ''}`
      : `<div class="mnodesc">No description yet.${canEdit ? ' <button type="button" class="mlink madd">Add one</button>' : ''} <button type="button" class="mlink mask">Request details in a conversation</button></div>`;
    const todoHtml = renderTodoPanel(ref.taskKey, st);
    const people = others.map(o => `<div class="mp">${avatarHtml(o.UserKey || -1, o.UserName, o.Initials)}<span>${esc((o.UserName || 'Unassigned slot').trim())}<small>${esc(o.StatusName || 'No status')}</small></span></div>`).join('');
    const html = `<div class="mbg"><div class="modal" role="dialog" aria-modal="true" style="--c:${color}">
      <div class="mhead"><div class="mtop"><span class="id">${esc(t.TaskID || '')}</span><span class="grp">${esc(t.SummaryTaskName || '')}</span></div>
        <button type="button" class="mx" title="Close (Esc)">×</button>
        ${st.editingName
          ? `<div class="mnameedit"><input type="text" class="mnamei" aria-label="Task name" value="${esc(st.nameDraft != null ? st.nameDraft : (t.TaskName || ''))}"><button type="button" class="mbtn primary mnamesave">Save</button><button type="button" class="mbtn mnamecancel">Cancel</button></div>${st.nameMsg ? `<div class="mmsg mnamemsg">${esc(st.nameMsg)}</div>` : ''}`
          : `<h2 class="mtitle">${esc(t.TaskName || '(task)')}${canEdit && taskRenameOn() ? ' <button type="button" class="mlink mrename" title="Rename this task">Rename</button>' : ''}</h2>`}
        <div class="mstat">${statusSel}${tu && +tu.PercComp ? `<span class="b">${+tu.PercComp}% complete</span>` : ''}</div></div>
      <div class="mcols"><div class="mbody">
        <div class="mgrid">
          ${tu ? `<div><label>Assignee</label><div class="mp">${avatarHtml(tu.UserKey || -1, tu.UserName, tu.Initials)}<span>${esc((tu.UserName || 'Unassigned slot').trim())}<small>${esc(tu.ServiceDescription || '')}</small></span></div></div>` : ''}
          <div><label>Due</label>${st.editingDue
            ? `<div class="mrow"><input type="date" class="mduei" value="${String((tu && tu.APlanComplete) || t.PlanComplete || '').slice(0, 10)}"><button type="button" class="mbtn primary mduesave">Save</button><button type="button" class="mbtn mduecancel">Cancel</button></div>`
            : `<div>${fmtDate((tu && tu.APlanComplete) || t.PlanComplete)}${canEdit ? ' <button type="button" class="mlink medue">Change</button>' : ''}</div>`}</div>
          <div><label>Planned</label><div>${fmtDate(t.PlanStart)} → ${fmtDate(t.PlanComplete)}</div></div>
          ${tu ? `<div><label>Hours</label>${st.editingHours
            ? `<div class="mrow"><input type="number" class="mhoursi" min="0" step="0.25" value="${st.hoursDraft != null ? esc(st.hoursDraft) : planned}"><span class="mhrsu">planned hours</span><button type="button" class="mbtn primary mhourssave">Save</button><button type="button" class="mbtn mhourscancel">Cancel</button></div>${st.hoursMsg ? `<div class="mmsg">${esc(st.hoursMsg)}</div>` : ''}`
            : `<div class="${planned && actual > planned ? 'over' : ''}">${fmtH(actual)} logged of ${fmtH(planned)} planned${canEdit && taskHoursOn() ? ' <button type="button" class="mlink mhoursedit">Change</button>' : ''}</div>`}</div>` : ''}
        </div>
        <label>Task description</label>${descHtml}
        ${st.msg ? `<div class="mmsg">${esc(st.msg)}</div>` : ''}
        ${people ? `<label>Also on this task</label><div class="mpeople">${people}</div>` : ''}
        <div class="mconvslot"></div>
      </div>${todoHtml}</div>
      <div class="mfoot">
        ${tu ? `<a class="mbtn primary mopen" href="${urls.assignment(tu.TaskUserKey)}" target="_blank" rel="noopener" title="Opens the assignment in a new tab">Open full assignment<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v3a1 1 0 01-1 1H3.5a1 1 0 01-1-1V5a1 1 0 011-1h3"/></svg></a>` : ''}
        ${canEdit ? `<button type="button" class="mbtn ${tu ? '' : 'primary'} massign">${tu ? 'Manage assignees' : 'Assign people'}</button>` : ''}
        <button type="button" class="mbtn mlist">Show in list</button>
        ${timeActionsOn() && timerEligible(t) ? '<button type="button" class="mbtn mtimer" title="Start a Workamajig timer on this task (shows in My Time)">Start timer</button>' : ''}
        <span class="spacer"></span>
        ${canEdit && taskDeleteOn() ? '<button type="button" class="mbtn mdelete" title="Delete this task from the schedule">Delete task</button>' : ''}
        <button type="button" class="mbtn mcopyt" title="Copy a link that opens the schedule and spotlights this task"><svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.75A1.25 1.25 0 009.25 2.5h-5.5A1.25 1.25 0 002.5 3.75v5.5a1.25 1.25 0 001.25 1.25H5.5"/></svg>Copy task link</button>
        ${tu ? `<button type="button" class="mbtn mcopya" title="Copy the link to this assignment page"><svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.75A1.25 1.25 0 009.25 2.5h-5.5A1.25 1.25 0 002.5 3.75v5.5a1.25 1.25 0 001.25 1.25H5.5"/></svg>Copy assignment link</button>` : ''}
      </div></div></div>`;
    if (old) old.outerHTML = html; else board.root.querySelector('.wrap').insertAdjacentHTML('beforeend', html);
    // Conversations: one host per task, kept across re-renders so drafts and expanded posts survive.
    const slot = board.root.querySelector('.mconvslot');
    if (slot) {
      board.convHosts = board.convHosts || new Map();
      let ch = board.convHosts.get(ref.taskKey);
      if (!ch) {
        ch = asgConvHost({ projectKey: Number(board.projectKey), taskKey: ref.taskKey }, { compact: true, onNavigate: () => { board.reopen = { ref, pk: board.projectKey, ts: Date.now() }; closeModal(); } });
        board.convHosts.set(ref.taskKey, ch);
      } else if (st.reloadConv) ch.uxaLoad && ch.uxaLoad();
      st.reloadConv = false;
      slot.appendChild(ch);
      if (st.scrollConv) {
        st.scrollConv = false;
        // Jump (not smooth): the threads load a moment later and would interrupt a smooth scroll, so repeat once.
        const jump = () => { const mb = board.root.querySelector('.mbody'), sl = board.root.querySelector('.mconvslot'); if (mb && sl) mb.scrollTop += sl.getBoundingClientRect().top - mb.getBoundingClientRect().top - 8; };
        setTimeout(jump, 30);
        // Threads still loading: the body is too short to scroll yet, so jump again once they're in.
        if (!ch.uxaLoaded) ch.addEventListener('uxaconvloaded', () => setTimeout(jump, 30), { once: true });
      }
    }
    // Keep the body's scroll position when the modal redraws (e.g. when to-dos finish loading).
    if (st.scrollTop) { const nb = board.root.querySelector('.mbody'); if (nb) nb.scrollTop = st.scrollTop; }
    if (st.editing) {
      const rte = board.root.querySelector('.rte');
      if (rte) {
        wireRte(rte);
        const ed = rte.querySelector('.rtein');
        if (ed) {
          ed.setAttribute('data-ph', 'Goal, scope, inputs and links, and what done looks like…');
          ed.focus();
          try { const rg = document.createRange(); rg.selectNodeContents(ed); rg.collapse(false); const se = window.getSelection(); se.removeAllRanges(); se.addRange(rg); } catch (e) {}
        }
      }
    }
    else if (st.editingName) { const ni = board.root.querySelector('.mnamei'); if (ni && document.activeElement !== ni) { ni.focus(); ni.select(); } }
    else if (st.editingHours) { const hi = board.root.querySelector('.mhoursi'); if (hi && document.activeElement !== hi) { hi.focus(); hi.select(); } }
    else if (st.focusTodo) { const ti = board.root.querySelector('.tdnew'); if (ti) { ti.focus(); ti.setSelectionRange(ti.value.length, ti.value.length); } st.focusTodo = false; }
    const sel = board.root.querySelector('.mstatus');
    if (sel) sel.addEventListener('change', () => moveAssignment(ref.tuk, Number(sel.value)));
  }

  // ---- to-dos (same calls as the Schedule page: loadScheduleToDos / updateToDo / Production.deleteToDo) ----
  async function loadTodos() {
    const pk = board.projectKey;
    if (board.todosFor === pk && board.todos) return;
    board.todosFor = pk; board.todos = null;
    try {
      const res = await call('Modules.Projects.Schedule', 'loadScheduleToDos', { projectKey: Number(pk), copyToDoList: null }, true);
      if (res.errors && res.errors.length) throw new Error(res.errors[0].message);
      if (board.todosFor === pk) board.todos = (res.data && res.data.todos) || [];
    } catch (e) { if (board.todosFor === pk) { board.todos = []; board.todoErr = 'Could not load to-dos: ' + (e && e.message || e); } }
    renderBoard();
    if (board.modal) renderModal();
  }
  async function loadBoardConvs() {
    const pk = board.projectKey;
    try { const map = await loadProjectConvs(pk); if (board.projectKey === pk) { board.convs = map; board.convsFor = pk; renderBoard(); } }
    catch (e) { console.warn('[uxa] conversations', e); }
  }
  const boardConvs = () => (board.convs && board.convsFor === board.projectKey ? board.convs : null);
  const convPass = taskKey => { if (!board.onlyConv) return true; const m = boardConvs(); return !!(m && m.get(taskKey)); };
  function convBadge(taskKey) {
    const m = boardConvs(); const c = m && m.get(taskKey);
    if (!c) return '';
    return `<span class="b cvb ${c.unread ? 'unread' : ''}" title="${esc(convWord(c.threads))}${c.unread ? `, ${c.unread} with unread posts` : ''}. Latest: ${esc(c.subject)}">${convWord(c.threads)}${c.unread ? ` · ${c.unread} unread` : ''}</span>`;
  }

  // TaskKey -> { open, total } from the project's to-do list (null until loaded).
  function todoStats() {
    if (!board.todos || board.todosFor !== board.projectKey) return null;
    const map = new Map();
    board.todos.forEach(x => { const s = map.get(x.TaskKey) || { open: 0, total: 0 }; s.total++; if (!x.Completed) s.open++; map.set(x.TaskKey, s); });
    return map;
  }
  const todoPass = taskKey => { if (!board.onlyTodos) return true; const m = todoStats(); const s = m && m.get(taskKey); return !!(s && s.open); };
  function todoBadge(taskKey) {
    const m = todoStats(); const s = m && m.get(taskKey);
    if (!s) return '';
    return s.open
      ? `<span class="b tdb" title="${s.open} open, ${s.total - s.open} done">${s.open} open to-do${s.open > 1 ? 's' : ''}</span>`
      : `<span class="b tdb done" title="All ${s.total} to-dos done">✓ To-dos done</span>`;
  }
  function renderTodoPanel(taskKey, st) {
    const R = window.System && System.rights || {};
    if (!(window.System && System.prefs && System.prefs.UseToDo) || R.prjViewToDos === false) return '';
    if (!board.todos || board.todosFor !== board.projectKey) { loadTodos(); return '<aside class="mtodo"><h3>To-dos</h3><div class="tdmuted">Loading…</div></aside>'; }
    const canAdd = R.prjEditToDos !== false, canDel = !!R.prjDeleteToDos;
    const all = board.todos.filter(x => x.TaskKey === taskKey).sort((a, b) => (a.Completed - b.Completed) || ((a.DisplayOrder || 0) - (b.DisplayOrder || 0)));
    const open = all.filter(x => !x.Completed), done = all.filter(x => x.Completed);
    const row = x => `<div class="td ${x.Completed ? 'done' : ''}">
        <input type="checkbox" class="tdchk" data-k="${x.ActivityKey}" ${x.Completed ? 'checked' : ''} ${canAdd ? '' : 'disabled'} title="${x.Completed ? 'Mark open' : 'Mark complete'}">
        <span class="tds">${esc(x.Subject || '(no subject)')}${x.UserFullName && x.UserFullName !== 'Not Assigned' || x.ActivityDate || x.StatusName ? `<small>${[x.UserFullName && x.UserFullName !== 'Not Assigned' ? esc(x.UserFullName) : '', x.ActivityDate ? 'Due ' + esc(fmtDate(x.ActivityDate)) : '', x.StatusName ? esc(x.StatusName) : ''].filter(Boolean).join(' · ')}</small>` : ''}</span>
        ${canDel ? `<button type="button" class="tddel" data-k="${x.ActivityKey}" title="Delete to-do">×</button>` : ''}</div>`;
    return `<aside class="mtodo"><h3>To-dos <span class="count">${open.length}</span></h3>
      ${board.todoErr ? `<div class="mmsg">${esc(board.todoErr)}</div>` : ''}
      <div class="tdlist">${open.map(row).join('') || `<div class="tdmuted">${all.length ? 'All done.' : 'No to-dos on this task yet.'}</div>`}
      ${done.length ? `<button type="button" class="mlink tdtoggle">${st.showDoneTodos ? 'Hide' : 'Show'} ${done.length} completed</button>${st.showDoneTodos ? done.map(row).join('') : ''}` : ''}</div>
      ${canAdd ? `<div class="tdadd"><input class="tdnew" type="text" placeholder="Add a to-do and press Enter" value="${esc(st.tdDraft || '')}"><button type="button" class="mbtn tdplus" title="Add to-do">Add</button></div>` : ''}
      ${st.tdMsg ? `<div class="mmsg">${esc(st.tdMsg)}</div>` : ''}</aside>`;
  }
  async function addTodo() {
    const st = board.modal; if (!st) return;
    const input = board.root.querySelector('.tdnew'); const subject = (input && input.value || '').trim();
    if (!subject) return;
    const pk = Number(board.projectKey), taskKey = st.ref.taskKey;
    input.disabled = true; st.tdMsg = '';
    try {
      const res = await call('Modules.Projects.Schedule', 'updateToDo', { projectKey: pk, todos: [{ ActivityKey: -1, ProjectKey: pk, TaskKey: taskKey, Subject: subject, Completed: 0, StatusName: '', rowstate: 'I' }] }, true);
      if (res.errors && res.errors.length) throw new Error(res.errors.map(x => x.message).join('; '));
      const map = ((res.data && res.data.keyMap) || []).find(x => x.OldKey === -1);
      board.todos.push({ ActivityKey: map ? map.NewKey : Date.now(), TaskKey: taskKey, Subject: subject, Completed: 0, StatusName: '', DisplayOrder: 999 });
      st.tdDraft = ''; st.focusTodo = true; input.value = '';
    } catch (e) { st.tdMsg = 'Could not add: ' + (e && e.message || e); st.tdDraft = subject; }
    renderBoard(); renderModal();
  }
  async function toggleTodo(key, completed) {
    const st = board.modal; const td = (board.todos || []).find(x => x.ActivityKey === key); if (!td || !st) return;
    const prev = td.Completed; td.Completed = completed ? 1 : 0; st.tdMsg = ''; renderBoard(); renderModal();
    try {
      const row = Object.assign({}, td, { ProjectKey: Number(board.projectKey), StatusName: td.StatusName || '', rowstate: 'U' });
      const res = await call('Modules.Projects.Schedule', 'updateToDo', { projectKey: Number(board.projectKey), todos: [row] }, true);
      if (res.errors && res.errors.length) throw new Error(res.errors.map(x => x.message).join('; '));
    } catch (e) { td.Completed = prev; st.tdMsg = 'Could not update: ' + (e && e.message || e); renderBoard(); renderModal(); }
  }
  async function deleteTodo(key) {
    const st = board.modal; const td = (board.todos || []).find(x => x.ActivityKey === key); if (!td || !st) return;
    if (!confirm(`Delete the to-do "${td.Subject}"? This can't be undone.`)) return;
    try {
      const res = await call('Modules.Projects.Production', 'deleteToDo', { ActivityKey: key, ProjectKey: Number(board.projectKey), TaskKey: td.TaskKey }, true);
      if (res.errors && res.errors.length) throw new Error(res.errors.map(x => x.message).join('; '));
      board.todos = board.todos.filter(x => x.ActivityKey !== key); st.tdMsg = '';
    } catch (e) { st.tdMsg = 'Could not delete: ' + (e && e.message || e); }
    renderBoard(); renderModal();
  }

  async function onModalClick(e) {
    const st = board.modal; if (!st) return;
    // A click on a button's icon lands on the <svg>/<path>; treat it as a click on the button.
    const t = (e.target.closest && e.target.closest('svg') && e.target.closest('button, a')) || e.target;
    const ref = st.ref;
    if (t.classList.contains('mbg') || t.classList.contains('mx')) { closeModal(); return; }
    if (t.classList.contains('tdplus')) { addTodo(); return; }
    if (t.classList.contains('tddel')) { deleteTodo(Number(t.dataset.k)); return; }
    if (t.classList.contains('tdtoggle')) { st.showDoneTodos = !st.showDoneTodos; renderModal(); return; }
    if (t.classList.contains('tdchk')) { toggleTodo(Number(t.dataset.k), t.checked); return; }
    if (t.closest('a[href]')) return; // links in the description
    const tu = ref.tuk ? (board.data.projectTaskUserData || []).find(x => x.TaskUserKey === ref.tuk) : null;
    const task = (board.data.tasks || []).find(x => x.TaskKey === ref.taskKey) || {};
    if (t.classList.contains('mlist')) { closeModal(); showInList(ref.taskKey); return; }
    if (t.classList.contains('mtimer')) { startTimerFor(board.projectKey, ref.taskKey, ref.tuk); return; }
    if (t.classList.contains('massign')) { closeModal(); openNativeAssign(ref.taskKey); return; }
    if (t.classList.contains('mcopyt')) { copy(urls.task(board.projectKey, ref.taskKey), 'task link'); return; }
    if (t.classList.contains('mcopya')) { copy(urls.assignment(ref.tuk), 'assignment link'); return; }
    if (t.classList.contains('madd')) { st.editing = true; st.editingName = false; st.editingHours = false; st.draftHtml = ''; st.base = ''; st.msg = ''; renderModal(); return; }
    if (t.classList.contains('medit')) { st.editing = true; st.editingName = false; st.editingHours = false; st.base = task.Description || ''; st.draftHtml = null; st.msg = ''; renderModal(); return; }
    if (t.classList.contains('mcancel')) { st.editing = false; st.msg = ''; renderModal(); return; }
    if (t.classList.contains('mrename')) { st.editingName = true; st.editing = false; st.editingHours = false; st.nameDraft = null; st.nameMsg = ''; renderModal(); return; }
    if (t.classList.contains('mnamecancel')) { st.editingName = false; st.nameDraft = null; st.nameMsg = ''; renderModal(); return; }
    if (t.classList.contains('mhoursedit')) { st.editingHours = true; st.editing = false; st.editingName = false; st.hoursDraft = null; st.hoursMsg = ''; renderModal(); return; }
    if (t.classList.contains('mhourscancel')) { st.editingHours = false; st.hoursDraft = null; st.hoursMsg = ''; renderModal(); return; }
    if (t.classList.contains('mhourssave')) {
      if (!ref.tuk) { st.editingHours = false; renderModal(); return; }
      const inp = board.root.querySelector('.mhoursi'); const raw = inp ? inp.value.trim() : '';
      const val = Number(raw);
      if (raw === '' || !isFinite(val) || val < 0) { st.hoursMsg = 'Enter a number of hours (0 or more).'; st.hoursDraft = raw; renderModal(); return; }
      t.disabled = true; t.textContent = 'Saving…';
      try {
        await saveAssignmentHours(board.projectKey, ref.tuk, val);
        if (tu) tu.Hours = val;
        st.editingHours = false; st.hoursDraft = null; st.hoursMsg = ''; toast('Planned hours updated');
      } catch (err) { st.hoursMsg = 'Could not update hours: ' + (err && err.message || err); st.hoursDraft = raw; }
      renderBoard(); renderModal();
      return;
    }
    if (t.classList.contains('mdelete')) {
      if (!confirm(`Delete the task "${(task.TaskName || 'this task').trim()}"? This removes it and its assignments from the schedule and can't be undone.`)) return;
      t.disabled = true; t.textContent = 'Deleting…';
      try {
        await deleteTask(board.projectKey, ref.taskKey, task.TaskName || '');
        toast('Task deleted'); closeModal(); await loadBoard();
      } catch (err) { st.msg = 'Could not delete: ' + (err && err.message || err); renderModal(); }
      return;
    }
    if (t.classList.contains('mnamesave')) {
      const inp = board.root.querySelector('.mnamei'); const val = (inp && inp.value || '').trim();
      if (!val) { st.nameMsg = 'Enter a task name.'; st.nameDraft = ''; renderModal(); return; }
      if (val === String(task.TaskName || '').trim()) { st.editingName = false; st.nameDraft = null; st.nameMsg = ''; renderModal(); return; }
      t.disabled = true; t.textContent = 'Saving…';
      try {
        await saveTaskName(board.projectKey, ref.taskKey, val, task.TaskName || '');
        task.TaskName = val; st.editingName = false; st.nameDraft = null; st.nameMsg = ''; toast('Task renamed');
      } catch (err) { st.nameMsg = 'Could not rename: ' + (err && err.message || err); st.nameDraft = val; }
      renderBoard(); renderModal();
      return;
    }
    if (t.classList.contains('medue')) { st.editingDue = true; st.msg = ''; renderModal(); return; }
    if (t.classList.contains('mduecancel')) { st.editingDue = false; st.msg = ''; renderModal(); return; }
    if (t.classList.contains('mduesave')) {
      const inp = board.root.querySelector('.mduei'); const val = inp && inp.value;
      if (!val) { st.msg = 'Pick a date first.'; renderModal(); return; }
      t.disabled = true; t.textContent = 'Saving…';
      try {
        const r = await saveTaskDueDate(board.projectKey, ref.taskKey, val);
        task.PlanComplete = r.PlanComplete; task.PlanStart = r.PlanStart;
        st.editingDue = false; st.msg = ''; toast('Due date updated');
      } catch (err) { st.msg = 'Could not update the date: ' + (err && err.message || err); }
      renderBoard();
      return;
    }
    if (t.classList.contains('mask')) {
      t.disabled = true; t.textContent = 'Opening a new post…';
      let pm = null; try { pm = await resolveProjectManager(board.projectKey); } catch (err) {}
      const req = { taskKey: ref.taskKey, projectKey: board.projectKey, taskName: task.TaskName || '', projectName: [task.ProjectName, task.CompanyName].filter(Boolean).join(' / '),
        taskUrl: urls.task(board.projectKey, ref.taskKey), assignmentUrl: ref.tuk ? urls.assignment(ref.tuk) : urls.task(board.projectKey, ref.taskKey), pm, ts: Date.now() };
      try { sessionStorage.setItem(SS_POST, JSON.stringify(req)); } catch (err) {}
      closeModal();
      board.reopen = { ref, pk: board.projectKey, ts: Date.now() };
      openApp('projects.diary.add', Number(board.projectKey), { taskKey: ref.taskKey });
      return;
    }
    if (t.classList.contains('msave')) {
      const html = rteRead(board.root.querySelector('.rte') || board.root);
      if (!descHasText(html)) { st.msg = 'Type a description first.'; st.draftHtml = ''; renderModal(); return; }
      t.disabled = true; t.textContent = 'Saving…';
      try {
        await saveTaskDescription(board.projectKey, ref.taskKey, html, st.base || '');
        task.Description = html; st.editing = false; st.msg = ''; toast('Description saved');
      } catch (err) { st.msg = 'Could not save: ' + (err && err.message || err); st.draftHtml = html; }
      renderBoard();
    }
  }

  // Time actions. Gate (sync rewrites timeActionsOn() to ON('time.actions')). Only money/budget tasks accept time, so
  // we only offer "Start timer" there (and not on summary rows). Starting the timer uses Workamajig's own global
  // TimesheetTimer.newTimer (core.js, present on every page), so it shows up in My Time exactly like the native one.
  // Gate for renaming a task from the card details modal (sync rewrites taskRenameOn() to ON('board.taskrename')).
  function taskRenameOn() { return true; }
  // Gate for editing an assignment's planned hours from the card modal (sync -> ON('board.taskhours')).
  function taskHoursOn() { return true; }
  // Gate for deleting a task from the card modal (sync -> ON('board.taskdelete')). Destructive, so it ships default-off.
  function taskDeleteOn() { return true; }
  // Gate for the "Go to project" links in the row "…" menu (sync -> ON('nav.projectmenu')). Navigation only; no writes.
  function projectMenuOn() { return true; }
  // Project sub-pages, keyed by project. aid strings are Workamajig's own (captured from the project dashboard tabs);
  // Views.openPage(new Action(aid, projectKey)) opens each the way the native tabs do. The finance screens are shown
  // only when System.hasRight() says this user can reach them (edit rights imply view), so a user without access never
  // sees a link that would dead-end on Workamajig's own "no access" screen.
  function hasRightSafe(k) { try { return !!(window.System && typeof System.hasRight === 'function' && System.hasRight(k)); } catch (e) { return false; } }
  function projectNavItems(projectKey) {
    const pk = projectKey;
    const items = [
      { label: 'Project overview', sub: 'the project dashboard', aidName: 'dashboards.project.dash' },
      { label: 'Schedule', sub: 'tasks, assignments and dates', aidName: 'projects.schedule.edit2' },
      { label: 'Conversations', sub: 'the project diary', aidName: 'projects.diary.dash' }
    ];
    const canTran = hasRightSafe('billingviewtran') || hasRightSafe('billingedittran');
    const canInvoice = hasRightSafe('billingviewinvoice') || hasRightSafe('billingeditinvoice');
    if (canTran) items.push({ label: 'Transactions', sub: 'posted time, costs and bills', aidName: 'projects.production.transactions' });
    if (canTran) items.push({ label: 'Budget', sub: 'the project budget', aidName: 'projects.budget.dash' });
    if (canInvoice) items.push({ label: 'Billing', sub: 'invoices for this project', aidName: 'projects.billing.dash' });
    return items.map(it => ({ label: it.label, sub: it.sub, open: () => openApp(it.aidName, pk) }));
  }
  function timeActionsOn() { return true; }
  const timerEligible = t => !!t && Number(t.MoneyTask) === 1 && String(t.TaskType).toLowerCase() !== 'summary';
  function startTimerFor(projectKey, taskKey, tuk) {
    const T = window.TimesheetTimer;
    if (!T || typeof T.newTimer !== 'function') { toast('Timers are not available here'); return; }
    try { T.newTimer({ ProjectKey: Number(projectKey), TaskKey: Number(taskKey), TaskUserKey: Number(tuk) || 0 }); toast('Timer started — see My Time'); }
    catch (e) { toast('Could not start the timer: ' + (e && e.message || e)); }
  }

  function openCardMenu(btnEl) {
    closeCardMenu();
    const card = btnEl.closest('.card');
    const taskKey = Number(card.dataset.task), tuk = Number(card.dataset.tuk) || 0;
    const pk = board.projectKey;
    const m = document.createElement('div');
    m.className = 'menu';
    const items = [];
    if (tuk) items.push(['Open assignment', () => openApp(ASSIGN_AID, tuk)]);
    if (tuk) items.push(['Open assignment in new tab', () => window.open(urls.assignment(tuk), '_blank', 'noopener')]);
    items.push(['Show in list', () => showInList(taskKey)]);
    if (timeActionsOn() && timerEligible((board.data && board.data.tasks || []).find(x => x.TaskKey === taskKey))) items.push(['Start timer', () => startTimerFor(pk, taskKey, tuk)]);
    items.push(['Copy task link', () => copy(urls.task(pk, taskKey), 'task link')]);
    if (tuk) items.push(['Copy assignment link', () => copy(urls.assignment(tuk), 'assignment link')]);
    items.forEach(([label, fn]) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); closeCardMenu(); fn(); }); m.appendChild(b); });
    board.root.querySelector('.wrap').appendChild(m);
    const r = btnEl.getBoundingClientRect();
    m.style.left = Math.min(r.left, innerWidth - 240) + 'px';
    m.style.top = Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8) + 'px';
    board.menu = m;
  }
  function closeCardMenu() { if (board.menu) { board.menu.remove(); board.menu = null; } }

  // Opens Workamajig's own assignment panel (panel#pnlAssignments) for a task, with the board stepped aside,
  // then reloads the board once the panel closes (polling a few seconds for autosave to land).
  function openNativeAssign(taskKey) {
    const row = findTaskRow(taskKey);
    const btn = row && row.querySelector('button[data-action="openPanel"][data-action-topic="assignments"]');
    if (!btn) { toast('Opening the task in the list to assign people'); showInList(taskKey); return; }
    const slotsBefore = (board.data.projectTaskUserData || []).filter(x => x.TaskKey === taskKey).map(x => x.TaskUserKey + ':' + x.UserKey).join(',');
    board.suspended = true; positionBoard();
    btn.click();
    setTimeout(panelDimTick, 150);
    let seen = false, n = 0;
    const t = setInterval(() => {
      const open = !!inSchedule('panel#pnlAssignments.open');
      if (open) { seen = true; return; }
      if (!seen && ++n < 20) return; // panel not up yet
      clearInterval(t);
      board.suspended = false; positionBoard();
      if (!seen) { toast('Could not open the assignment panel'); return; }
      refreshUntilChanged(taskKey, slotsBefore);
    }, 250);
  }
  async function refreshUntilChanged(taskKey, before) {
    for (let i = 0; i < 8; i++) {
      await loadBoard();
      const now = (board.data && board.data.projectTaskUserData || []).filter(x => x.TaskKey === taskKey).map(x => x.TaskUserKey + ':' + x.UserKey).join(',');
      if (now !== before) { toast('Board updated'); return; }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  function showInList(taskKey) {
    setBoardPref(false);
    closeBoard();
    setTimeout(() => {
      const row = findTaskRow(taskKey);
      if (!row) { toast('Task is hidden in the list (completed tasks may be filtered)'); return; }
      row.scrollIntoView({ block: 'center' });
      setTimeout(() => spotlight(row), 300);
    }, 400);
  }

  // ---- drag and drop (mouse events) ----
  // Drag a calendar task to another day → change its due date (saveTaskDueDate). Mirrors the board's card drag.
  // A centered spinner over the board while a drag-to-reschedule saves and the board reloads (a few seconds).
  function calBusy(on) {
    const wrap = board.root && board.root.querySelector('.wrap');
    if (!wrap) return;
    let o = wrap.querySelector('.uxa-busy');
    if (on) {
      if (o) return;
      if (!board.root.querySelector('#uxa-busy-kf')) { const st = document.createElement('style'); st.id = 'uxa-busy-kf'; st.textContent = '@keyframes uxaspin{to{transform:rotate(360deg)}}'; board.root.appendChild(st); }
      o = document.createElement('div'); o.className = 'uxa-busy';
      o.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:rgba(255,255,255,.6);z-index:25;font:600 13px/1.4 inherit;color:#555';
      o.innerHTML = '<div style="width:26px;height:26px;border:3px solid #d5dbe4;border-top-color:#2b6cb0;border-radius:50%;animation:uxaspin .7s linear infinite"></div><span>Moving task…</span>';
      wrap.appendChild(o);
    } else if (o) o.remove();
  }
  function startCalDrag(e, chip) {
    const taskKey = Number(chip.dataset.task);
    const fromDate = (chip.closest('.ccell') || {}).dataset ? chip.closest('.ccell').dataset.date : null;
    const start = { x: e.clientX, y: e.clientY };
    const r = chip.getBoundingClientRect();
    let ghost = null, overCell = null;
    const cellAt = (x, y) => { const el = board.root.elementFromPoint(x, y); return el && el.closest && el.closest('.ccell'); };
    const move = ev => {
      if (!ghost) {
        if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 6) return;
        ghost = chip.cloneNode(true);
        Object.assign(ghost.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: Math.max(140, r.width) + 'px', margin: '0', zIndex: '30', pointerEvents: 'none', boxShadow: '0 8px 20px rgba(0,0,0,.22)', opacity: '.95' });
        board.root.querySelector('.wrap').appendChild(ghost);
        chip.classList.add('dragging');
        document.body.style.userSelect = 'none';
      }
      ev.preventDefault();
      ghost.style.left = (r.left + ev.clientX - start.x) + 'px';
      ghost.style.top = (r.top + ev.clientY - start.y) + 'px';
      const cell = cellAt(ev.clientX, ev.clientY);
      if (cell !== overCell) { if (overCell) overCell.classList.remove('drop'); overCell = cell; if (cell) cell.classList.add('drop'); }
    };
    const up = async ev => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      document.body.style.userSelect = '';
      if (!ghost) return; // no drag started → it's a click, handled by onBoardClick
      ghost.remove(); chip.classList.remove('dragging');
      if (overCell) overCell.classList.remove('drop');
      board.justDragged = true; setTimeout(() => { board.justDragged = false; }, 0);
      const cell = cellAt(ev.clientX, ev.clientY);
      const date = cell && cell.dataset.date;
      if (!date || date === fromDate) return;
      chip.style.opacity = '.5';
      calBusy(true); // the save + reload takes a few seconds — show a clear spinner so it's obviously working
      try { await saveTaskDueDate(board.projectKey, taskKey, date); toast('Due date updated'); await loadBoard(); }
      catch (err) { chip.style.opacity = ''; toast('Could not move: ' + (err && err.message || err)); }
      finally { calBusy(false); }
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  }

  function onCardMouseDown(e) {
    if (e.button !== 0) return;
    const chip = e.target.closest && e.target.closest('.calchip');
    if (chip) { startCalDrag(e, chip); return; }
    const card = e.target.closest && e.target.closest('.card[data-tuk]');
    if (!card || e.target.closest('.more')) return;
    const start = { x: e.clientX, y: e.clientY };
    const r = card.getBoundingClientRect();
    let ghost = null, overCol = null;
    const colAt = (x, y) => { const el = board.root.elementFromPoint(x, y); const col = el && el.closest && el.closest('.col'); return col && col.dataset.drop === '1' ? col : null; };
    const move = ev => {
      if (!ghost) {
        if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 6) return;
        closeCardMenu();
        ghost = card.cloneNode(true);
        Object.assign(ghost.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', margin: '0', zIndex: '10', pointerEvents: 'none', transform: 'rotate(2deg)', boxShadow: '0 10px 28px rgba(0,0,0,.22)', opacity: '.95' });
        board.root.querySelector('.wrap').appendChild(ghost);
        card.classList.add('dragging');
        document.body.style.userSelect = 'none';
      }
      ev.preventDefault();
      ghost.style.left = (r.left + ev.clientX - start.x) + 'px';
      ghost.style.top = (r.top + ev.clientY - start.y) + 'px';
      const col = colAt(ev.clientX, ev.clientY);
      if (col !== overCol) { if (overCol) overCol.classList.remove('drop'); overCol = col; if (col) col.classList.add('drop'); }
      // Auto-scroll the columns strip near its edges.
      const strip = board.root.querySelector('.cols'), sr = strip.getBoundingClientRect();
      if (ev.clientX > sr.right - 40) strip.scrollLeft += 14; else if (ev.clientX < sr.left + 40) strip.scrollLeft -= 14;
    };
    const up = ev => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      document.body.style.userSelect = '';
      if (!ghost) return;
      ghost.remove(); card.classList.remove('dragging');
      if (overCol) overCol.classList.remove('drop');
      board.justDragged = true; setTimeout(() => { board.justDragged = false; }, 0);
      const col = colAt(ev.clientX, ev.clientY);
      if (col) moveAssignment(Number(card.dataset.tuk), Number(col.dataset.status));
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  }

  async function moveAssignment(tuk, statusKey) {
    const tu = (board.data.projectTaskUserData || []).find(x => x.TaskUserKey === tuk);
    const st = (board.data.taskUserStatus || []).find(x => x.k === statusKey);
    if (!tu || !st || tu.TaskUserStatusKey === statusKey) return;
    const prev = { TaskUserStatusKey: tu.TaskUserStatusKey, StatusName: tu.StatusName, PercComp: tu.PercComp };
    Object.assign(tu, { TaskUserStatusKey: statusKey, StatusName: st.l });
    renderBoard();
    const el = board.root.querySelector(`.card[data-tuk="${tuk}"]`); if (el) el.classList.add('busy');
    try {
      const res = await call('WJAPP.Modules.Project.Traffic', 'updateAssignmentStatus', { TaskUserKey: tuk, TaskUserStatusKey: statusKey }, true);
      if (res.errors && res.errors.length) throw new Error(res.errors.map(x => x.message).join('; '));
      // Mirror Workamajig's native "Default Percent Complete" for the new status (the board's status call alone doesn't set
      // it). Write it ourselves where the status is one we know a default for; otherwise read back whatever the server has.
      const defPct = statusDefaultPct(st.l);
      let pc = null;
      if (defPct != null) { try { pc = await saveAssignmentPercComp(board.projectKey, tuk, defPct); } catch (e) { pc = await serverPercComp(tuk); } }
      else pc = await serverPercComp(tuk);
      if (pc != null) tu.PercComp = pc;
      board.dirty = true;
      renderBoard();
      toast(`Moved to ${st.l}`);
    } catch (err) {
      Object.assign(tu, prev);
      renderBoard();
      toast('Could not change the status: ' + (err && err.message || err));
    }
  }
  // Dim the page around Workamajig's assignment panel (panel#pnlAssignments), like a modal backdrop.
  // z-index 25 keeps it under the app's own dropdowns (#dialogContainer is z 10000). Clicking the dim closes
  // the panel through its own × button, so the app's unsaved-changes handling still applies.
  let panelDim = null;
  function panelDimTick() {
    if (panelDim) return;
    const p = [...document.querySelectorAll('panel#pnlAssignments.open')].find(x => x.offsetParent && x.getBoundingClientRect().width);
    if (!p) return;
    const mk = () => {
      const d = document.createElement('div');
      d.className = 'uxa-pdim';
      d.title = 'Close';
      d.style.cssText = 'position:fixed;z-index:35;background:rgba(20,20,20,.45);opacity:0;transition:opacity .2s;cursor:pointer';
      d.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
      d.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        const x = [...p.querySelectorAll('button')].find(b => /i-close/.test(b.className) && b.offsetParent);
        if (x) x.click();
      });
      document.body.appendChild(d);
      return d;
    };
    const [a, b, c, d] = [mk(), mk(), mk(), mk()];
    panelDim = [a, b, c, d];
    requestAnimationFrame(() => panelDim && panelDim.forEach(e => (e.style.opacity = '1')));
    const loop = () => {
      const r = p.isConnected && p.classList.contains('open') && p.offsetParent ? p.getBoundingClientRect() : null;
      if (!r || !r.width) { panelDim.forEach(e => e.remove()); panelDim = null; return; }
      Object.assign(a.style, { left: '0', top: '0', width: '100vw', height: Math.max(0, r.top) + 'px' });
      Object.assign(b.style, { left: '0', top: r.bottom + 'px', width: '100vw', height: Math.max(0, innerHeight - r.bottom) + 'px' });
      Object.assign(c.style, { left: '0', top: r.top + 'px', width: Math.max(0, r.left) + 'px', height: r.height + 'px' });
      Object.assign(d.style, { left: r.right + 'px', top: r.top + 'px', width: Math.max(0, innerWidth - r.right) + 'px', height: r.height + 'px' });
      requestAnimationFrame(loop);
    };
    loop();
  }

  // ---------- Tasks in Global Search (v0.31) ----------
  // Workamajig's Global Search (common.search) has no task category. The Assignments views (Search > Views >
  // Assignments) do have a server-side search over Project Number/Name, Task ID, Task Name and Assigned User Name
  // for active projects: ReportingManager.runListing with searchText. We load any one Assignments view's definition,
  // drop its conditions and groups, and run it with the Global Search text. Read-only; nothing is saved.
  const TS_SS = 'uxa.taskSearch';
  const ts = { def: null, defP: null, seq: 0, text: '', rows: null, err: '', loading: false, showMore: false, showOther: false, showDone: false, wired: new WeakSet() };
  function taskSearchDef() {
    if (ts.def) return Promise.resolve(ts.def);
    if (!ts.defP) ts.defP = (async () => {
      const RM = 'WJ.Reports.Framework.Platinum.ReportingManager';
      const v = await call(RM, 'getViews', { reportID: 'AssignmentTrafficList' });
      const views = (v.views || []).filter(x => x && x.reportKey);
      if (!views.length) throw new Error('No Assignments view is available to search with.');
      const d = await call(RM, 'loadReport', { reportKey: (views.find(x => +x.reportType === 1) || views[0]).reportKey });
      if (!d || !d.view) throw new Error('Could not load the Assignments view.');
      const def = JSON.parse(JSON.stringify(d));
      def.conditions = { nodeName: 'conditions', children: [] };
      def.groups = { nodeName: 'groups', children: [] };
      def.run = ''; def.rows = [];
      ts.def = def; return def;
    })().catch(e => { ts.defP = null; throw e; });
    return ts.defP;
  }
  async function runTaskSearch(text) {
    text = String(text || '').trim();
    const seq = ++ts.seq;
    ts.text = text; ts.err = ''; ts.showMore = ts.showOther = ts.showDone = false;
    if (text.length < 2) { ts.rows = null; ts.loading = false; renderTaskSearch(); return; }
    ts.loading = true; ts.rows = null; renderTaskSearch();
    try {
      const def = await taskSearchDef();
      const r = await call('WJ.Reports.Framework.Platinum.ReportingManager', 'runListing',
        { report: def, restrictOptions: { searchText: text }, dynamicOptions: {}, searchText: text, ExportType: 0, AutoPrint: false }, true);
      if (seq !== ts.seq) return;
      if (r.errors && r.errors.length) throw new Error(r.errors.map(x => x.message).join('; '));
      ts.rows = (r.data && r.data.rows) || [];
      try { sessionStorage.setItem(TS_SS, JSON.stringify({ text, rows: ts.rows })); } catch (e) {}
    } catch (e) {
      if (seq !== ts.seq) return;
      ts.err = (e && e.message) || String(e); ts.rows = null;
    }
    ts.loading = false; renderTaskSearch();
  }
  // Assignment rows -> one entry per task, ranked: task name / ID matches first, then project / assignee-only matches.
  function taskSearchGroups() {
    const q = ts.text.toLowerCase();
    const map = new Map();
    for (const r of ts.rows || []) {
      if (!r.TaskKey) continue;
      let t = map.get(r.TaskKey);
      if (!t) map.set(r.TaskKey, t = { taskKey: r.TaskKey, projectKey: r.ProjectKey, id: String(r.TaskID || '').trim(), name: String(r.TaskName || '').trim(),
        project: String(r.ProjectFullName || '').trim(), parent: String(r.SummaryTask || '').trim(), due: r.PlanComplete, asg: [] });
      const pct = +r.Assignment_Percentage_Complete || +r.PercComp || 0;
      t.asg.push({ tuk: r.TaskUserKeyPK, name: String(r.UserName || r.Assigned_Staff || '').trim(), status: String(r.Assignment_Status || '').trim(), pct });
    }
    const out = [...map.values()];
    for (const t of out) {
      t.done = t.asg.length > 0 && t.asg.every(a => a.pct >= 100 || /^complete/i.test(a.status));
      const n = t.name.toLowerCase();
      t.rank = n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : t.id.toLowerCase() === q ? 2 : 9;
    }
    out.sort((a, b) => a.rank - b.rank || (a.done - b.done) || String(b.due || '').localeCompare(String(a.due || '')) || a.name.localeCompare(b.name));
    return { direct: out.filter(t => t.rank < 9), other: out.filter(t => t.rank === 9) };
  }
  function searchPage() {
    const ps = [...document.querySelectorAll('page[data-aid="common.search"]')];
    return ps[ps.length - 1] || null;
  }
  function closeSearchPage(pg) {
    const x = pg && pg.querySelector('button.i-close');
    if (x) x.click();
  }
  function searchTick() {
    const pg = searchPage();
    if (!pg) return;
    const tab = pg.querySelector('tab#search');
    const lst = tab && tab.querySelector('#lstResults');
    const inp = tab && tab.querySelector('input[name="searchText"]');
    if (!lst || !inp) return;
    if (!ts.wired.has(pg)) {
      ts.wired.add(pg);
      const go = () => setTimeout(() => runTaskSearch(inp.value), 0);
      tab.addEventListener('click', e => { if (e.target.closest && e.target.closest('button[data-action="save"]')) go(); }, true);
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); }, true);
      // Native search restores its last results when reopened; restore ours to match.
      let last = null; try { last = JSON.parse(sessionStorage.getItem(TS_SS) || 'null'); } catch (e) {}
      if (last && last.text && (!inp.value || inp.value.trim() === last.text)) { ts.text = last.text; ts.rows = last.rows; ts.err = ''; ts.loading = false; }
      else if (inp.value.trim().length >= 2) runTaskSearch(inp.value);
    }
    let host = lst.parentElement.querySelector(':scope > #uxa-tsearch');
    if (!host) {
      host = document.createElement('div');
      host.id = 'uxa-tsearch';
      host.attachShadow({ mode: 'open' });
      host.shadowRoot.addEventListener('click', onTaskSearchClick);
      lst.parentElement.insertBefore(host, lst);
      renderTaskSearch();
    }
  }
  function renderTaskSearch() {
    const pg = searchPage();
    const host = pg && pg.querySelector('#uxa-tsearch');
    if (!host) return;
    const root = host.shadowRoot;
    const css = `<style>
      :host { display: block; font-family: LexendDeca, "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; color: #333; }
      .sec { margin: 8px 0 14px; }
      h2 { font-size: 18px; font-weight: 600; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; color: #222; cursor: pointer; user-select: none; }
      .badge { font-size: 12px; font-weight: 600; background: #eee; border-radius: 10px; padding: 1px 8px; color: #555; }
      .note { font-size: 12px; color: #888; padding: 2px 10px 8px; }
      .err { color: #b00020; }
      ul { list-style: none; margin: 0; padding: 0; }
      li { padding: 8px 10px; border-bottom: 1px solid #f0f0f0; border-radius: 4px; }
      li:hover { background: #f6f6f6; }
      li.done { opacity: .6; }
      a.t { color: #222; text-decoration: none; font-size: 13px; display: block; cursor: pointer; }
      a.t:hover .nm { text-decoration: underline; }
      .id { color: #888; margin-right: 4px; }
      .sub { font-size: 12px; color: #777; margin-top: 2px; }
      .who { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
      a.chip { font-size: 11px; border: 1px solid #ddd; border-radius: 10px; padding: 1px 8px; color: #444; text-decoration: none; background: #fff; }
      a.chip:hover { border-color: #999; }
      a.chip.none { color: #999; border-style: dashed; }
      .st { color: #888; }
      button.more { font: inherit; font-size: 12px; background: none; border: 0; color: #1a73a8; cursor: pointer; padding: 6px 10px; }
      .chev { font-size: 11px; color: #999; }
    </style>`;
    if (!ts.text && !ts.loading) { root.innerHTML = ''; host.style.display = 'none'; pg.classList.remove('uxa-hastasks'); return; }
    host.style.display = '';
    let body = '';
    let count = '';
    if (ts.loading) body = `<div class="note">Searching tasks…</div>`;
    else if (ts.err) body = `<div class="note err">Task search failed: ${esc(ts.err)}</div>`;
    else if (ts.text.length < 2) body = `<div class="note">Type at least 2 characters to search tasks.</div>`;
    else if (ts.rows) {
      const { direct, other } = taskSearchGroups();
      const open = direct.filter(t => !t.done), done = direct.filter(t => t.done);
      count = direct.length;
      const LIMIT = 15;
      const shown = ts.showMore ? open : open.slice(0, LIMIT);
      const item = t => {
        const who = t.asg.map(a => `<a class="chip${a.name ? '' : ' none'}" data-tuk="${esc(a.tuk)}" href="${urls.assignment(a.tuk)}" title="Open this assignment">${esc(a.name || 'Not assigned')}${a.status ? ` <span class="st">· ${esc(a.status)}</span>` : ''}</a>`).join('');
        return `<li class="${t.done ? 'done' : ''}"><a class="t" data-pk="${esc(t.projectKey)}" data-tk="${esc(t.taskKey)}" href="${urls.task(t.projectKey, t.taskKey)}" title="Open in the project schedule"><span class="id">${esc(t.id)}</span><span class="nm">${esc(t.name)}</span></a>
          <div class="sub">${esc(t.project)}${t.parent ? ' / ' + esc(t.parent) : ''}</div>${who ? `<div class="who">${who}</div>` : ''}</li>`;
      };
      body = `<ul>${shown.map(item).join('')}</ul>`;
      if (open.length > LIMIT && !ts.showMore) body += `<button class="more" data-act="more">Show all ${open.length} open tasks</button>`;
      if (done.length) body += ts.showDone ? `<ul>${done.map(item).join('')}</ul>` : `<button class="more" data-act="done">Show ${done.length} completed</button>`;
      if (!direct.length) body += `<div class="note">No task names match “${esc(ts.text)}”.</div>`;
      if (other.length) body += ts.showOther ? `<div class="note">Tasks in matching projects or assigned to matching people:</div><ul>${other.slice(0, 100).map(item).join('')}</ul>${other.length > 100 ? `<div class="note">Showing 100 of ${other.length}.</div>` : ''}`
        : `<button class="more" data-act="other">${other.length} more in matching projects or people</button>`;
      body += `<div class="note">Active projects only.</div>`;
    }
    // Workamajig's "Sorry, we were not able to find anything" note is for its own categories; hide it while tasks match.
    const hasHits = !!(ts.rows && !ts.loading && taskSearchGroups().direct.length);
    pg.classList.toggle('uxa-hastasks', hasHits);
    if (!document.getElementById('uxa-tsearch-style')) {
      const st = document.createElement('style'); st.id = 'uxa-tsearch-style';
      st.textContent = 'page[data-aid="common.search"].uxa-hastasks tab#search > div.flex-none.bound { display: none !important; }';
      document.head.appendChild(st);
    }
    const collapsed = ts.collapsed;
    root.innerHTML = `${css}<div class="sec"><h2 data-act="toggle">Tasks${count !== '' ? `<span class="badge">${count}</span>` : ''}<span class="chev">${collapsed ? '▸' : '▾'}</span></h2>${collapsed ? '' : body}</div>`;
  }
  function onTaskSearchClick(e) {
    const t = e.target.closest('[data-act], a');
    if (!t) return;
    const act = t.dataset.act;
    if (act) {
      if (act === 'toggle') ts.collapsed = !ts.collapsed;
      if (act === 'more') ts.showMore = true;
      if (act === 'done') ts.showDone = true;
      if (act === 'other') ts.showOther = true;
      renderTaskSearch(); return;
    }
    if (!plainClick(e)) return; // Cmd/Ctrl-click: let the link open a new tab
    e.preventDefault();
    const pg = searchPage();
    if (t.dataset.tuk) { closeSearchPage(pg); openApp(ASSIGN_AID, t.dataset.tuk); return; }
    if (t.dataset.tk) {
      try { sessionStorage.setItem(SS_KEY, String(t.dataset.tk)); } catch (err) {}
      // If that project's schedule is already the page under Search, just close Search and spotlight the row.
      const open = [...document.querySelectorAll('#desktop > section > page.open')].filter(x => x !== pg);
      const under = open[open.length - 1];
      const same = under && under.getAttribute('data-aid') === 'projects.schedule.edit2' && under.view && under.view.action && String(under.view.action.k) === String(t.dataset.pk);
      closeSearchPage(pg);
      if (!same) openApp('projects.schedule.edit2', t.dataset.pk);
      setTimeout(handlePendingTask, same ? 300 : 800);
    }
  }

  // ---------- My Time: show each task's status next to the task, editable where you're assigned ----------
  // Workamajig's My Time grid (user.timeEntry.edit, grid id grdDay40) lists time entries with a Task column but no sign
  // of where the work stands. We resolve each row's TimeKey -> project/task/user (getTime, cached per date) and read the
  // project schedule (getSchedule, cached per project). Two cases: if you HAVE an assignment on the task, we show its real
  // workflow status as an EDITABLE dropdown (the board statuses) and write changes via the board's updateAssignmentStatus;
  // if you don't (you can log time on tasks you're not assigned to), we fall back to a read-only pill with the status
  // derived from % complete ("● In progress · 60%"). Overlay only: appended to the Task cell, re-applied each tick so it
  // survives the grid's virtualization, cleared when the feature is off. Gated via timeStatusOn() (-> ON('time.taskstatus')).
  function timeStatusOn() { return true; }
  const tstatCache = new Map(); // TimeKey -> {label,color,pc} | 'pending' | 'none'
  function ensureTimeStatusStyle() {
    if (document.getElementById('uxa-tstat-style')) return;
    const s = document.createElement('style'); s.id = 'uxa-tstat-style';
    s.textContent = '.uxa-tstat{display:inline-flex;align-items:center;gap:5px;margin-left:8px;padding:1px 8px;border-radius:999px;background:#eef1f4;color:#44515e;font-size:11px;font-weight:600;vertical-align:middle;white-space:nowrap;line-height:1.5}'
      + '.uxa-tstat .d{width:7px;height:7px;border-radius:50%;flex:none}'
      + '.uxa-tstat.uxa-tstat-edit{padding-right:2px}'
      + ".uxa-tstat-sel{font:inherit;font-size:11px;font-weight:600;color:#44515e;border:0;background:transparent;cursor:pointer;appearance:none;-webkit-appearance:none;padding:0 15px 0 1px;line-height:1.5;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%2344515e' stroke-width='1.5'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 2px center;background-size:8px 5px}"
      + '.uxa-tstat-sel:focus{outline:none}';
    (document.head || document.documentElement).appendChild(s);
  }
  async function tstatResolve(timeKey, wd) {
    tstatCache.set(timeKey, 'pending');
    try {
      let hit = (await getTime(wd)).get(timeKey);
      if (!hit && wd) hit = (await getTime(null)).get(timeKey);
      if (!hit || !(Number(hit.taskKey) > 0)) { tstatCache.set(timeKey, 'none'); return; }
      const sched = await getSchedule(hit.projectKey);
      const raw = sched.raw || {};
      const t = (raw.tasks || []).find(x => Number(x.TaskKey) === Number(hit.taskKey));
      if (!t) { tstatCache.set(timeKey, 'none'); return; }
      const pc = Math.round(+t.PercComp || 0);
      const done = !!t.ActComplete || pc >= 100;
      // If this user has an assignment on the task, show the real, EDITABLE workflow status (the board statuses). Writing
      // reuses the board's updateAssignmentStatus. You can log time on tasks you aren't assigned to, so an unassigned row
      // has no assignment status to change — those fall back to the read-only derived pill below.
      const tu = (raw.projectTaskUserData || []).find(x => Number(x.TaskKey) === Number(hit.taskKey) && Number(x.UserKey) === Number(hit.userKey));
      if (tu && Number(tu.TaskUserKey) > 0) {
        const options = (raw.taskUserStatus || []).map(x => ({ k: x.k, l: x.l }));
        const statusKey = tu.TaskUserStatusKey > 0 ? tu.TaskUserStatusKey : 0;
        const statusName = (tu.StatusName || '').trim();
        const color = STATUS_COLORS[statusName] || (done ? '#1a7f37' : pc > 0 ? '#1a6dc4' : '#8a8a8a');
        tstatCache.set(timeKey, { tuk: Number(tu.TaskUserKey), projectKey: hit.projectKey, statusKey, statusName, options, color });
        return;
      }
      const label = done ? 'Complete' : pc > 0 ? 'In progress' : 'Not started';
      const color = done ? '#1a7f37' : pc > 0 ? '#1a6dc4' : '#8a8a8a';
      tstatCache.set(timeKey, { label, color, pc: done ? 100 : pc });
    } catch (e) { tstatCache.delete(timeKey); }
  }
  // Write a new workflow status for an assigned My Time row, the same way the board does (updateAssignmentStatus).
  async function tstatSetStatus(sel) {
    const key = sel.dataset.key, tuk = Number(sel.dataset.tuk), newKey = Number(sel.value);
    const info = tstatCache.get(key);
    if (!info || typeof info !== 'object' || !tuk) return;
    const prevKey = Number(info.statusKey) || 0;
    if (newKey === prevKey) return;
    sel.disabled = true;
    try {
      const res = await call('WJAPP.Modules.Project.Traffic', 'updateAssignmentStatus', { TaskUserKey: tuk, TaskUserStatusKey: newKey }, true);
      if (res.errors && res.errors.length) throw new Error(res.errors.map(e => e.message).join('; '));
      const opt = (info.options || []).find(o => o.k === newKey);
      info.statusKey = newKey; info.statusName = opt ? opt.l : '';
      info.color = STATUS_COLORS[info.statusName] || '#8a8a8a';
      tstatCache.set(key, info);
      // Mirror Workamajig's Default Percent Complete for the new status (the status call alone doesn't persist it).
      const defPct = statusDefaultPct(info.statusName);
      if (defPct != null && info.projectKey) { try { await saveAssignmentPercComp(info.projectKey, tuk, defPct); } catch (e) {} }
      const dot = sel.parentElement && sel.parentElement.querySelector('.d');
      if (dot) dot.style.background = info.color;
      toast('Status updated');
    } catch (e) {
      sel.value = String(prevKey);
      toast('Could not update status: ' + (e && e.message || e));
    } finally { sel.disabled = false; }
  }
  function timeStatusTick() {
    if (!timeStatusOn()) { document.querySelectorAll('.uxa-tstat').forEach(el => el.remove()); return; }
    if (aid() !== 'user.timeEntry.edit') return;
    ensureTimeStatusStyle();
    const wd = pageDate();
    for (const row of document.querySelectorAll('grid-row.datarow')) {
      const key = row.dataset.key;
      if (!/^[0-9a-f-]{36}$/i.test(key || '')) continue;
      const cell = row.querySelector('grid-cell[data-idx="1"]');
      if (!cell || !cell.textContent.trim()) continue; // wait until the task name is rendered
      const existing = cell.querySelector('.uxa-tstat');
      if (existing && existing.dataset.key === key) continue; // already correct for this row
      const info = tstatCache.get(key);
      if (info === undefined) { tstatResolve(key, wd); continue; } // fetch, render next tick
      if (info === 'pending') continue;
      if (existing) existing.remove();
      if (info === 'none') continue;
      if (info.tuk) {
        // Assigned: an editable dropdown of the real workflow statuses.
        const wrap = document.createElement('span');
        wrap.className = 'uxa-tstat uxa-tstat-edit'; wrap.dataset.key = key;
        const noStatus = Number(info.statusKey) > 0 ? '' : '<option value="0" selected>No status</option>';
        const opts = (info.options || []).map(o => `<option value="${o.k}"${o.k === info.statusKey ? ' selected' : ''}>${esc(o.l)}</option>`).join('');
        wrap.innerHTML = `<span class="d" style="background:${info.color}"></span><select class="uxa-tstat-sel" data-key="${esc(key)}" data-tuk="${info.tuk}" title="Change this assignment's status">${noStatus}${opts}</select>`;
        const sel = wrap.querySelector('select');
        sel.addEventListener('change', () => tstatSetStatus(sel));
        sel.addEventListener('mousedown', e => e.stopPropagation()); // let the native dropdown open, not the grid's cell edit
        sel.addEventListener('click', e => e.stopPropagation());
        cell.appendChild(wrap);
      } else {
        const pill = document.createElement('span');
        pill.className = 'uxa-tstat'; pill.dataset.key = key;
        pill.innerHTML = `<span class="d" style="background:${info.color}"></span>${esc(info.label)}${info.pc ? ' · ' + info.pc + '%' : ''}`;
        cell.appendChild(pill);
      }
    }
  }

  // The inline time-entry editor (My Time day/week, grid-row.editing) has a "done" checkbox but no way to set the task's
  // workflow STATUS. We add a labelled Status dropdown next to it, resolving the row's assignment and writing changes the
  // exact same way the status column does (tstatResolve + tstatSetStatus, i.e. updateAssignmentStatus). Only for tasks
  // you're assigned to (others have no assignment status to change). Shares the time.taskstatus toggle + cache.
  function ensureEditorStatusStyle() {
    if (document.getElementById('uxa-estat-style')) return;
    const s = document.createElement('style'); s.id = 'uxa-estat-style';
    s.textContent = '.uxa-estat{display:inline-flex;align-items:center;gap:6px;margin:4px 0 0 18px;vertical-align:middle}'
      + '.uxa-estat-lbl{font-size:12px;color:#8a95a1}';
    (document.head || document.documentElement).appendChild(s);
  }
  function editorStatusTick() {
    if (!timeStatusOn()) { document.querySelectorAll('.uxa-estat').forEach(el => el.remove()); return; }
    if (aid() !== 'user.timeEntry.edit') return;
    const row = document.querySelector('grid-row.editing[data-key]');
    if (!row) return;
    const key = row.dataset.key;
    if (!/^[0-9a-f-]{36}$/i.test(key || '')) return; // a saved time entry (TimeKey); new/unsaved rows have no assignment
    const form = row.querySelector('form');
    if (!form) return;
    const existing = form.querySelector('.uxa-estat');
    if (existing && existing.dataset.key === key) return;
    const info = tstatCache.get(key);
    if (info === undefined) { tstatResolve(key, pageDate()); return; } // fetch, render next tick
    if (info === 'pending') return;
    if (existing) existing.remove();
    if (info === 'none' || !info.tuk) return; // only an assigned task has a workflow status to change
    ensureTimeStatusStyle(); ensureEditorStatusStyle();
    const noStatus = Number(info.statusKey) > 0 ? '' : '<option value="0" selected>No status</option>';
    const opts = (info.options || []).map(o => `<option value="${o.k}"${o.k === info.statusKey ? ' selected' : ''}>${esc(o.l)}</option>`).join('');
    const wrap = document.createElement('span');
    wrap.className = 'uxa-estat'; wrap.dataset.key = key;
    wrap.innerHTML = `<span class="uxa-estat-lbl">Status</span><span class="uxa-tstat uxa-tstat-edit"><span class="d" style="background:${info.color}"></span><select class="uxa-tstat-sel" data-key="${esc(key)}" data-tuk="${info.tuk}" title="Change this assignment's status">${noStatus}${opts}</select></span>`;
    const sel = wrap.querySelector('select');
    sel.addEventListener('change', () => tstatSetStatus(sel));
    sel.addEventListener('mousedown', e => e.stopPropagation()); // open the native dropdown, not the grid's cell edit
    sel.addEventListener('click', e => e.stopPropagation());
    // Anchor beside the "I am done with this task" checkbox (its layout differs between the day and week editors).
    const doneLbl = [...form.querySelectorAll('label')].find(l => /done with this task/i.test(l.textContent || ''));
    const anchor = doneLbl ? (doneLbl.closest('div') || doneLbl) : null;
    if (anchor && anchor.parentElement) anchor.insertAdjacentElement('afterend', wrap);
    else form.appendChild(wrap);
  }

  // ---------- Grouped grids: a visible Collapse all / Expand all toggle in the page header ----------
  // Workamajig buries Collapse All / Expand All in the "…" menu. We float a labeled toggle right beside that header "…"
  // menu button (My Time, the schedule List, the Projects list) — body-appended and positioned from the anchor's rect, so
  // we never mutate WMJ's toolbar (inserting into it made the schedule re-render and strip the button in a loop). It drives
  // WMJ's own per-group twisty — a synthetic click on each summary row's tree cell — looping so nested groups open/close
  // too. Shown only on those pages (XALL_AIDS) when a grouped grid is present and not on the board/calendar overlay.
  // Gated via expandAllOn() (-> ON('grid.expandall')).
  function expandAllOn() { return true; }
  function toggleGroupRow(sh) {
    const cell = sh.querySelector('grid-cell.dgTree') || sh.querySelector('grid-cell');
    if (!cell) return;
    const r = cell.getBoundingClientRect();
    const x = r.left + 10, y = r.top + r.height / 2;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t =>
      cell.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y })));
  }
  async function setAllGroups(collapse) {
    // Nested groups appear/disappear as parents toggle (and WMJ updates a tick late), so re-query and repeat. Capped.
    for (let pass = 0; pass < 12; pass++) {
      const rows = [...document.querySelectorAll('grid-row.summaryHeader')]
        .filter(sh => collapse ? sh.classList.contains('expanded') : sh.classList.contains('collapsed'));
      if (!rows.length) break;
      rows.forEach(toggleGroupRow);
      await new Promise(r => setTimeout(r, 120));
    }
  }
  const XALL_ICON = c => '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' +
    (c ? 'M7 4l5 5 5-5M7 20l5-5 5 5' : 'M7 9l5-5 5 5M7 15l5 5 5-5') + '"/></svg>';
  function ensureExpandAllStyle() {
    if (document.getElementById('uxa-xall-style')) return;
    const s = document.createElement('style'); s.id = 'uxa-xall-style';
    // Height (30px) and corner radius (10px) match Workamajig's own small header buttons (the "+" / "…" beside it), so it
    // reads as one of them rather than a floating pill; the blue fill keeps it recognizable as ours.
    s.textContent = '#uxa-xall{position:fixed;z-index:40;box-sizing:border-box;height:30px;font:600 12px/1.2 -apple-system,Segoe UI,Roboto,sans-serif;color:#2b6cb0;background:#eef3fb;border:1px solid #cfe0f5;border-radius:10px;padding:0 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}'
      + '#uxa-xall:hover{background:#e2ecfa;border-color:#b9d3f2}'
      + '#uxa-xall:disabled{opacity:.6;cursor:default}';
    (document.head || document.documentElement).appendChild(s);
  }
  // The grouped grids that make sense (and where the header "…" menu lives): My Time, the schedule List, the Projects
  // list. Excludes dashboards and other views (e.g. the project dashboard, where there's nothing to collapse).
  const XALL_AIDS = ['user.timeEntry.edit', 'projects.schedule.edit2', 'projects.production.dash', 'today.creative'];
  function expandAllTick() {
    const old = document.getElementById('uxa-xall');
    if (!expandAllOn() || XALL_AIDS.indexOf(aid()) < 0 || (typeof board !== 'undefined' && board && board.on)) { if (old) old.remove(); return; }
    // Require a VISIBLE group header. On Today the list grid stays in the DOM (hidden) behind the card/board layouts, so
    // a plain querySelector would wrongly show the toggle there; only the list layout actually has visible headers.
    const sh = [...document.querySelectorAll('grid-row.summaryHeader')].find(x => x.getBoundingClientRect().width > 0);
    if (!sh) { if (old) old.remove(); return; }
    // Where to float the toggle. Most grouped-list pages have a header "…" menu button to sit beside; the project
    // Schedule does NOT (its only "…" is up in the title chrome, which threw the button to the top of the page). On the
    // schedule, anchor into its own toolbar instead — the empty gap after "Project Dates", before the right-aligned
    // controls. `pos` = { top, rowH, left }: top/rowH give the row to vertically centre on, left is the x to start at.
    const page = sh.closest('page') || document;
    let pos = null;
    if (aid() === 'projects.schedule.edit2') {
      const search = [...page.querySelectorAll('input')].find(i => /search/i.test(i.placeholder || '') && i.getBoundingClientRect().width);
      let bar = search ? search.parentElement : null;
      for (let i = 0; i < 6 && bar && !/hide completed/i.test(bar.textContent || ''); i++) bar = bar.parentElement;
      if (bar && /hide completed/i.test(bar.textContent || '')) {
        const ref = [...bar.querySelectorAll('h5')].find(h => /project dates/i.test(h.textContent || '')) || bar.querySelector('spacer') || search;
        const barR = bar.getBoundingClientRect(), refR = ref && ref.getBoundingClientRect();
        if (barR.width && refR && refR.width) pos = { top: barR.top, rowH: barR.height, left: refR.right + 12 };
      }
    } else {
      const anchor = [...page.querySelectorAll('button[data-action="menu"]')]
        .map(b => ({ b, r: b.getBoundingClientRect() })).filter(x => x.r.width > 0)
        .sort((a, b) => a.r.y - b.r.y).map(x => x.b)[0];
      if (anchor) { const r = anchor.getBoundingClientRect(); pos = { top: r.top, rowH: r.height, left: r.right + 10 }; }
    }
    if (!pos) { if (old) old.remove(); return; }
    ensureExpandAllStyle();
    let b = old;
    if (!b) {
      b = document.createElement('button'); b.id = 'uxa-xall'; b.type = 'button';
      b.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        const collapse = !!document.querySelector('grid-row.summaryHeader.expanded');
        b.disabled = true;
        setAllGroups(collapse).catch(() => {}).then(() => { b.disabled = false; });
      });
      document.body.appendChild(b); // float on <body>, NOT inside WMJ's toolbar — mutating the toolbar makes some pages
      // (the schedule) re-render and strip it, a flicker/thrash loop. We only READ the anchor's position, never touch it.
    }
    const collapse = !!document.querySelector('grid-row.summaryHeader.expanded');
    const label = collapse ? 'Collapse all' : 'Expand all';
    if (b.dataset.label !== label) { b.innerHTML = XALL_ICON(collapse) + '<span>' + label + '</span>'; b.dataset.label = label; }
    // Float at the computed anchor, vertically centered on its row.
    b.style.display = '';
    b.style.top = (pos.top + (pos.rowH - (b.offsetHeight || 30)) / 2) + 'px';
    b.style.left = pos.left + 'px';
  }

  // ---------- "Today" assignee views: filter the assignment cards down to one project ----------
  // The Today pages (today.creative, …) group your assignment cards by project but — unlike the To Do board — give no way
  // to narrow to one project. We add a Project dropdown under the Tasks search that hides the cards for projects you didn't
  // pick, in the card AND board layouts (both render .ac-card, which hides cleanly). The list layout is a virtualized grid
  // where hiding rows leaves gaps, so it's skipped. Matching is by project number (stable across layouts). Gated via
  // creativeFilterOn() (sync rewrites it to ON('today.projectfilter')).
  let creativeProj = '';        // selected project NUMBER (e.g. "26-C-LAFE-0151"), '' = all
  let creativeSearch = '';      // free-text query (project / client / task), lowercased, '' = none
  let creativeDueWeek = false;  // "Due this week" toggle
  function creativeFilterOn() { return true; }
  const projKeyOf = s => { const m = /^(\d{2}-(?:[A-Z]-)?[A-Z0-9]+-\d{3,4})/.exec((s || '').trim()); return m ? m[1] : (s || '').trim(); };
  const isProjText = s => /^\d{2}-[A-Z0-9]/.test((s || '').trim());
  function creativeProjects() {
    const map = new Map(); // projKey -> full display name
    document.querySelectorAll('h2').forEach(h => { const t = (h.textContent || '').trim(); if (isProjText(t)) map.set(projKeyOf(t), t); });
    document.querySelectorAll('.ac-card .ac-title').forEach(a => { const t = (a.textContent || '').trim(); if (isProjText(t) && !map.has(projKeyOf(t))) map.set(projKeyOf(t), t); });
    return [...map.entries()].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
  }
  const creativeCardHost = card => card.closest('li, taskcard') || card;
  // Monday-00:00 .. Sunday-23:59 of the week containing today.
  function creativeWeekBounds() {
    const n = new Date(), d = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    const mon = new Date(d); mon.setDate(d.getDate() - dow);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6); sun.setHours(23, 59, 59, 999);
    return [mon, sun];
  }
  const CREATIVE_MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  // A card's due DATE, read from its own display: the absolute ".ac-due" ("Due: Thursday, December 31" — year inferred so
  // the weekday matches) or a relative label ("Due today", "Due tomorrow", "Overdue 27d", "Due in 3d"). null if none/unparsable.
  function creativeCardDue(card) {
    const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
    const add = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
    const abs = card.querySelector('.ac-due');
    if (abs) {
      const m = /([A-Za-z]+day)\s*,\s*([A-Za-z]+)\s+(\d{1,2})/.exec(abs.textContent || '');
      if (m) {
        const wd = m[1].toLowerCase(), mon = CREATIVE_MONTHS.indexOf(m[2].toLowerCase()), day = +m[3];
        if (mon >= 0) {
          const y0 = new Date().getFullYear();
          for (const y of [y0, y0 + 1, y0 - 1]) {
            const d = new Date(y, mon, day);
            if (d.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase() === wd) return d;
          }
          // weekday didn't resolve a year (bad data); fall back to the year that lands nearest today
          let best = null, bestGap = Infinity;
          for (const y of [y0 - 1, y0, y0 + 1]) { const d = new Date(y, mon, day), g = Math.abs(d - today()); if (g < bestGap) { bestGap = g; best = d; } }
          return best;
        }
      }
    }
    const t = (card.textContent || '').toLowerCase();
    let mm;
    if (/\bdue today\b/.test(t)) return today();
    if (/\bdue tomorrow\b/.test(t)) return add(today(), 1);
    if (/\bdue yesterday\b/.test(t)) return add(today(), -1);
    if ((mm = /overdue\s+(\d+)\s*d\b/.exec(t))) return add(today(), -(+mm[1]));
    if ((mm = /due\s+in\s+(\d+)\s*d\b/.exec(t))) return add(today(), +mm[1]);
    if ((mm = /\bdue\s+(\d+)\s*d\b/.exec(t))) return add(today(), +mm[1]);
    return null;
  }
  // A card passes when it clears every active filter: project, text query, and "due this week".
  function creativeCardMatch(card) {
    if (creativeProj) { const a = card.querySelector('.ac-title'); if (projKeyOf(a ? a.textContent : '') !== creativeProj) return false; }
    if (creativeSearch && (card.textContent || '').toLowerCase().indexOf(creativeSearch) < 0) return false; // project + client + task text
    if (creativeDueWeek) { const d = creativeCardDue(card); if (!d) return false; const [a, b] = creativeWeekBounds(); if (d < a || d > b) return false; }
    return true;
  }
  function creativeApply() {
    const filtering = !!(creativeProj || creativeSearch || creativeDueWeek);
    document.querySelectorAll('.ac-card').forEach(card => {
      creativeCardHost(card).style.display = creativeCardMatch(card) ? '' : 'none';
    });
    // card layout: hide a project group header (an h2-headed li) when none of its cards are visible
    document.querySelectorAll('h2').forEach(h => {
      if (!isProjText(h.textContent)) return;
      const gli = h.closest('li'); if (!gli) return;
      const anyVisible = [...gli.querySelectorAll('.ac-card')].some(c => creativeCardHost(c).style.display !== 'none');
      gli.style.display = (!filtering || anyVisible) ? '' : 'none';
    });
  }
  function ensureCreativeFilterStyle() {
    if (document.getElementById('uxa-pf-style')) return;
    const s = document.createElement('style'); s.id = 'uxa-pf-style';
    s.textContent = '.uxa-projfilter{display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px;margin:8px 0 0;font:12px/1.2 -apple-system,Segoe UI,Roboto,sans-serif;color:#667;vertical-align:middle}'
      + ".uxa-projfilter select{font:inherit;font-size:13px;color:#222;padding:6px 26px 6px 10px;border:1px solid #d0d0d0;border-radius:8px;background:#fff;max-width:240px;cursor:pointer;appearance:none;-webkit-appearance:none;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23667788' stroke-width='1.5'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 9px center;background-size:9px 6px}"
      + '.uxa-projfilter select:focus,.uxa-pf-search:focus{outline:none;border-color:#7ab51d;box-shadow:0 0 0 3px rgba(122,181,29,.15)}'
      + '.uxa-pf-search{font:inherit;font-size:13px;color:#222;padding:6px 10px;border:1px solid #d0d0d0;border-radius:8px;background:#fff;width:200px}'
      + '.uxa-pf-search::placeholder{color:#9aa}'
      // "Due this week" is a toggle pill so its on/off state is obvious; the real checkbox is hidden but drives :checked.
      + '.uxa-pf-due{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;font:inherit;font-size:13px;color:#445;padding:6px 11px;border:1px solid #d0d0d0;border-radius:8px;background:#fff}'
      + '.uxa-pf-due input{position:absolute;opacity:0;width:0;height:0}'
      + '.uxa-pf-due .uxa-pf-box{width:14px;height:14px;border:1.5px solid #b7bcc6;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:10px;line-height:1}'
      + '.uxa-pf-due:has(input:checked){background:#eef6e6;border-color:#7ab51d;color:#3f6d12}'
      + '.uxa-pf-due:has(input:checked) .uxa-pf-box{background:#7ab51d;border-color:#7ab51d}'
      + '.uxa-pf-due:has(input:focus-visible){box-shadow:0 0 0 3px rgba(122,181,29,.15)}';
    (document.head || document.documentElement).appendChild(s);
  }
  function creativeFilterTick() {
    const existing = document.getElementById('uxa-projfilter');
    // Only the card/board layouts (where cards are actually visible). The list layout keeps the .ac-card nodes in the DOM
    // but hidden and shows a grid instead, so a plain .ac-card check would leave the filter lingering on the list view —
    // require at least one VISIBLE card. (The list view has Expand/Collapse all instead.)
    const cardLayout = [...document.querySelectorAll('.ac-card')].some(c => c.offsetParent !== null);
    if (!creativeFilterOn() || aid().indexOf('today.') !== 0 || !cardLayout) { if (existing) existing.remove(); return; }
    const anchor = document.querySelector('.frmTaskSearch');
    if (!anchor) { if (existing) existing.remove(); return; }
    const projects = creativeProjects();
    ensureCreativeFilterStyle();
    let wrap = existing;
    if (!wrap) {
      // A div (not a <label>) since it holds several controls: a free-text search (project / client / task), a "Due this
      // week" toggle, and — when there's more than one project — the existing project dropdown. All three feed creativeApply.
      wrap = document.createElement('div'); wrap.id = 'uxa-projfilter'; wrap.className = 'uxa-projfilter';
      wrap.innerHTML = '<input type="search" class="uxa-pf-search" placeholder="Search project or client" aria-label="Search tasks by project or client">'
        + '<label class="uxa-pf-due"><input type="checkbox"><span class="uxa-pf-box" aria-hidden="true">✓</span><span>Due this week</span></label>'
        + '<select class="uxa-pf-proj" aria-label="Filter by project" hidden></select>';
      wrap.querySelector('.uxa-pf-search').addEventListener('input', e => { creativeSearch = e.target.value.trim().toLowerCase(); creativeApply(); });
      wrap.querySelector('.uxa-pf-due input').addEventListener('change', e => { creativeDueWeek = e.target.checked; creativeApply(); });
      wrap.querySelector('.uxa-pf-proj').addEventListener('change', e => { creativeProj = e.target.value; creativeApply(); });
      (anchor.parentElement || anchor).appendChild(wrap);
    }
    const sel = wrap.querySelector('.uxa-pf-proj');
    if (projects.length >= 2) {
      sel.hidden = false;
      const sig = projects.map(p => p.key).join('|');
      if (sel.dataset.sig !== sig) {
        if (creativeProj && !projects.some(p => p.key === creativeProj)) creativeProj = '';
        sel.innerHTML = '<option value="">All projects</option>' + projects.map(p => `<option value="${esc(p.key)}"${p.key === creativeProj ? ' selected' : ''}>${esc(p.name.length > 46 ? p.name.slice(0, 44) + '…' : p.name)}</option>`).join('');
        sel.value = creativeProj;
        sel.dataset.sig = sig;
      }
    } else { sel.hidden = true; creativeProj = ''; sel.dataset.sig = ''; }
    creativeApply();
  }

  // ---------- Grid note cells: show "//"-separated / bulleted notes on their own lines ----------
  // Some grids (e.g. the Projects list) have free-text custom fields people use as notes, typed on one line with " // "
  // between bullet items ("• Jan 31 … // • Feb 28 …") because the field is single-line. We reformat the DISPLAY of any
  // leaf grid-cell div whose text uses that separator (or has 2+ bullets) so each item sits on its own line (white-space:
  // pre-line). Display only — editing still shows the stored one-line value. We reformat a cell ONCE (guarded by a data
  // attribute set to our output), so there's no mutation loop; on the grid's virtualized recycle the text changes and we
  // reformat the new value. Gated via noteBreaksOn() (sync rewrites it to ON('grid.notebreaks')).
  function noteBreaksOn() { return true; }
  function formatNote(t) {
    // Split only on a spaced " // " separator (whitespace before the //), never the "://" or "/a//b" inside a URL.
    return t.replace(/\s+\/\/\s*/g, '\n').replace(/\s*•\s+/g, '\n• ').replace(/^\s*\n/, '').replace(/\n{2,}/g, '\n').replace(/[ \t]+$/gm, '').trim();
  }
  function noteBreaksTick() {
    if (!noteBreaksOn()) return;
    // The note text lives in a leaf element inside the cell — often a <span>, not a <div> (e.g. span.usr), so match both.
    for (const el of document.querySelectorAll('grid-cell div, grid-cell span')) {
      if (el.children.length) continue; // leaf text only
      const t = el.textContent || '';
      if (el.dataset.uxaNb === t) continue; // already our formatted output for this value
      if (!/\s\/\/\s/.test(t) && (t.match(/•/g) || []).length < 2) continue; // only "//"-separated or multi-bullet notes
      const out = formatNote(t);
      if (out === t) { el.dataset.uxaNb = t; continue; }
      el.style.whiteSpace = 'pre-line';
      el.textContent = out;
      el.dataset.uxaNb = out;
    }
  }

  // ---------- Resource Schedule: an isolated person × week resourcing view ----------
  // Gated via resourceScheduleOn() (sync -> ON('resource.schedule')). Workamajig's Scheduling screen is a status-column
  // board with no "who is booked when" timeline. This is our own full-screen view (it renders nothing inside Workamajig's
  // screens, so their re-renders and layout never touch it): one lane per person, a capacity row per day (hours vs that
  // person's daily capacity, green / amber / red), and each assignment as a bar across the days it runs.
  // Data comes straight from the two reads the native Scheduling screen itself makes — the staff roster with daily
  // (Traffic.loadRMStaff), the viewer's Scheduling settings (Traffic.initRM: hours per day + their saved Users filter)
  // and one week of assignments per person (ResourceManagement.getUserAssignmentsForWeek, with the native screen's own
  // application tag). We ask for it WITHOUT the calendar sync the native screen requests: that option made a person
  // take 20-60 s to answer; without it a person loads in well under a second. Meetings are therefore opt-in ("Include
  // meetings"): a second, one-person-at-a-time pass that adds each day's meeting hours once it arrives. Daily hours
  // follow Workamajig's own model: a past day shows the time logged that day; today onward shows planned hours (each
  // assignment's weekly DisplayHours spread over its remaining active days); capacity is the viewer's Scheduling "max hours" per
  // weekday, exactly what the native staff tiles compare against. The view itself is read-only; clicking a bar opens the board's card-details
  // modal (detached mode), which can edit the task exactly as it does on the board. The
  // only thing we add to a native screen is the launcher button at the right of the Scheduling header.
  const RS_AID = 'projects.traffic.rm';
  const RS_CLS = 'WJAPP.Modules.Project.ResourceManagement';
  const RS_APP = 'getStaffSchedule_getStaffDetail';
  const RS_BAR = 34, RS_GAP = 4;                   // bar height + vertical gap, px
  const RS_FLAG = ['WorkSun', 'WorkMon', 'WorkTue', 'WorkWed', 'WorkThur', 'WorkFri', 'WorkSat'];                       // by Date.getDay()
  function resourceScheduleOn() { return true; }
  // Writing from the view — click a blank day to allocate someone, drag a bar to reschedule — is its own switch
  // (sync -> ON('resource.allocate')) and also needs Workamajig's own right to edit tasks.
  function resourceAllocateOn() { return true; }
  const rsCanAlloc = () => resourceAllocateOn() && !!(window.System && System.rights && System.rights.prjedittasks);
  const rs = {
    open: false, week: null,                       // week = the Monday being shown
    staff: null, staffErr: false,                  // roster rows from loadRMStaff (null = not loaded yet)
    data: new Map(),                               // "<weekIso>|<userKey>" -> null (loading) | { tasks, time, err }
    status: new Map(),                             // TaskUserStatusKey -> { color, name }
    maxHours: 8, filterKeys: null,                 // hours/day capacity + the viewer's saved Scheduling "Users" filter
    q: '', plannedOnly: false, weekends: false, useFilter: true, meetings: false, calBusy: false, sort: 'name', span: 2,   // span = weeks shown side by side (1 or 2)
    f: { me: false, client: new Set(), project: new Set(), owner: new Set(), role: new Set(), status: new Set() },   // Filter menu picks
    fl: {}, fmenu: null,
    undo: null, undoTimer: 0,                      // the last drag, while its Undo bar is showing
    vdays: [], alloc: null, drag: null, justDragged: false, redraw: false,   // visible day columns; open allocate form; bar drag                           // fl = labels of picked values (for chips); fmenu = null | 'root' | category
    collapsed: new Set(), gen: 0, raf: 0
  };
  const rsDate = s => { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const rsIso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + 'T00:00:00';
  const rsAdd = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const rsToday = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
  const rsMonday = d => rsAdd(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -((d.getDay() + 6) % 7));
  const rsWeeks = () => Array.from({ length: rs.span === 1 ? 1 : 2 }, (_, i) => rsAdd(rs.week, i * 7));   // the Mondays shown
  const rsYmd = d => rsIso(d).slice(0, 10);
  const rsNum = n => (Math.round(n * 10) / 10).toLocaleString('en-US');
  const rsLevel = (hrs, cap) => !cap ? (hrs > 0 ? 'over' : 'off') : (hrs / cap > 1.0001 ? 'over' : (hrs / cap >= 0.85 ? 'warn' : 'ok'));
  // Dark or white text, whichever reads on the status colour (Workamajig's palette runs from pale grey to deep red).
  function rsInk(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
    if (!m) return '#fff';
    return (0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16)) > 165 ? '#1f2d3d' : '#fff';
  }
  // An assignment is active on a day inside its (assignment-level, else task-level) plan span that is a working day for it.
  function rsActive(t, d) {
    const s = rsDate(t.APlanStart || t.PlanStart), e = rsDate(t.APlanComplete || t.PlanComplete);
    if (!s || !e || d < s || d > e) return false;
    const f = t[RS_FLAG[d.getDay()]];
    return f == null ? true : !!f;
  }
  // Per-day hours for one person. A past day shows the time logged that day. From today on, each assignment's
  // DisplayHours — Workamajig's allocation for THIS week — is spread evenly over the assignment's remaining active days
  // in the week (so on a Friday the whole week's remainder lands on Friday, exactly as the native tiles show it).
  // cap = hours per weekday; mt = the part of hrs that is meetings.
  function rsUserDays(rec, days) {
    const today = rsToday();
    const out = days.map(d => ({ cap: (d.getDay() === 0 || d.getDay() === 6) ? 0 : rs.maxHours, hrs: 0, logged: d < today, mt: 0 }));
    for (const t of rec.time) { const x = rsDate(t.PlanStart); if (!x) continue; days.forEach((d, i) => { if (out[i].logged && +x === +d) out[i].hrs += +t.Hours || 0; }); }
    for (const t of rec.tasks) {
      const dh = +t.DisplayHours || 0; if (!dh) continue;
      const idx = []; days.forEach((d, i) => { if (!out[i].logged && rsActive(t, d)) idx.push(i); });
      idx.forEach(i => { out[i].hrs += dh / idx.length; });
    }
    if (rs.meetings && Array.isArray(rec.cal)) for (const ev of rec.cal) {
      const x = rsDate(ev.PlanStart || ev.EventStart); if (!x) continue;
      days.forEach((d, i) => { if (!out[i].logged && +x === +d) { out[i].hrs += +ev.Hours || 0; out[i].mt += +ev.Hours || 0; } });
    }
    return out;
  }
  async function rsLoadStaff() {
    try {
      const d = await call('Modules.Project.Traffic', 'loadRMStaff', {});
      rs.staff = (d.table || []).filter(u => u && u.UserKey && u.UserName);
      rs.staffErr = false;
    } catch (e) { rs.staff = []; rs.staffErr = true; }
    try {   // the viewer's own Scheduling settings; optional (defaults stand if this read fails or changes shape)
      const init = (await call('Modules.Project.Traffic', 'initRM', {})).init || {};
      let t = (init.session || {}).trafficRM; if (typeof t === 'string') t = JSON.parse(t);
      if (t && +t.MaxHours > 0) rs.maxHours = +t.MaxHours;
      let sc = t && t.SearchCriteria; if (typeof sc === 'string') sc = JSON.parse(sc);
      const uf = (sc || []).find(c => c && c.Name === 'Users');
      const keys = uf ? String(uf.Keys == null ? '' : uf.Keys).split(',').map(Number).filter(Boolean) : [];
      rs.filterKeys = keys.length ? new Set(keys) : null;
    } catch (e) {}
    const ck = document.querySelector('#uxa-rs .uxa-rs-filter'); if (ck) ck.hidden = !rs.filterKeys;
    rsQueue(); rsDraw();
  }
  // One person's week (fast: no calendar sync), as the record the view draws from.
  async function rsWeekRec(userKey, wk, end) {
    const d = await call(RS_CLS, 'getUserAssignmentsForWeek', {
      userKey, startDate: wk, endDate: end, loadCalendars: false, loadTime: true, loadDaySlots: false,
      includePrior: 1, maxHours: rs.maxHours, predecessorsComplete: 0, showAssignmentZeroAllocated: 1, application: RS_APP,
      sessionUserOnly: false, openToDoOnly: 0, openDeliverablesOnly: 0, AutoExpandTaskGrid: 0, includePriorUnassigned: 1
    });
    (d.taskUserStatus || []).forEach(s => { if (s && s.TaskUserStatusKey != null) rs.status.set(s.TaskUserStatusKey, { color: s.StatusColor || '#7a8aa0', name: s.StatusName || '' }); });
    return { tasks: d.trafficTasks || [], time: d.trafficTime || [] };
  }
  // Quietly re-read one person's shown week (after the task modal closes); the lane keeps its old bars until it lands.
  async function rsReloadUser(userKey) {
    for (const w of rsWeeks()) {
      const wk = rsIso(w), key = wk + '|' + userKey, old = rs.data.get(key);
      if (!old) continue;
      try { const rec = await rsWeekRec(userKey, wk, rsIso(rsAdd(w, 6))); if (Array.isArray(old.cal)) rec.cal = old.cal; rs.data.set(key, rec); rsDrawSoon(); } catch (e) {}
    }
  }
  // Load the shown week for everyone not cached yet, four people at a time (the native screen loads them one by one).
  function rsQueue() {
    if (!rs.open || !rs.staff) return;
    const gen = rs.gen, todo = [];
    for (const w of rsWeeks()) for (const u of rsPeople()) if (!rs.data.has(rsIso(w) + '|' + u.UserKey)) todo.push({ u, w });   // first week first
    let i = 0;
    const worker = async () => {
      while (i < todo.length && rs.open && gen === rs.gen) {
        const { u, w } = todo[i++], wk = rsIso(w), key = wk + '|' + u.UserKey;
        if (rs.data.has(key)) continue;
        rs.data.set(key, null);
        try {
          rs.data.set(key, await rsWeekRec(u.UserKey, wk, rsIso(rsAdd(w, 6))));
        } catch (e) { rs.data.set(key, { tasks: [], time: [], err: true }); }
        rsDrawSoon();
      }
      rsQueueCal();
    };
    for (let k = 0; k < 4; k++) worker();
  }
  // Opt-in second pass: the same read WITH calendar sync, one person at a time (it is slow), to add meeting hours.
  async function rsQueueCal() {
    if (!rs.meetings || rs.calBusy || !rs.open) return;
    rs.calBusy = true;
    try {
      for (;;) {
        if (!rs.meetings || !rs.open) break;
        let u = null, week = null, wk = '';
        for (const w of rsWeeks()) { u = rsPeople().find(x => { const r = rs.data.get(rsIso(w) + '|' + x.UserKey); return r && !r.err && r.cal === undefined; }); if (u) { week = w; wk = rsIso(w); break; } }
        if (!u) break;
        const rec = rs.data.get(wk + '|' + u.UserKey); rec.cal = null;   // null = loading
        try {
          const d = await call(RS_CLS, 'getUserAssignmentsForWeek', {
            userKey: u.UserKey, startDate: wk, endDate: rsIso(rsAdd(week, 6)), loadCalendars: true, loadTime: false, loadDaySlots: false,
            includePrior: 1, maxHours: rs.maxHours, predecessorsComplete: 0, showAssignmentZeroAllocated: 1, application: RS_APP,
            sessionUserOnly: false, openToDoOnly: 0, openDeliverablesOnly: 0, AutoExpandTaskGrid: 0, includePriorUnassigned: 1
          });
          rec.cal = d.trafficCalendarEvents || [];
        } catch (e) { rec.cal = []; }
        rsDrawSoon();
      }
    } finally { rs.calBusy = false; }
  }
  // ---- Filter menu: Me + five pick-lists built from whatever is loaded for the shown week ----
  // Categories narrow the BARS (AND across categories, OR within one); a person with no matching bar drops out. The
  // capacity row always keeps the person's full load, so a filtered view never makes someone look free.
  const RS_FCATS = [['client', 'Client'], ['project', 'Project'], ['owner', 'Project owner'], ['role', 'Role'], ['status', 'Status']];
  const rsMe = () => Number(window.System && System.user && System.user.userKey) || 0;
  // An assignment's [value, label] pairs in one category. "Role" is the assignment's Workamajig service; "Project owner"
  // matches either the account manager or the project manager.
  function rsFVals(cat, t) {
    if (cat === 'client') { const v = String(t.CompanyName || '').trim() || 'No client'; return [[v, v]]; }
    if (cat === 'project') return [[String(t.ProjectKey), (t.ProjectNumber ? t.ProjectNumber + ' · ' : '') + (t.ProjectName || '')]];
    if (cat === 'owner') return [t.AccountManagerName, t.ProjectManagerName].map(x => String(x || '').trim()).filter((x, i, a) => x && a.indexOf(x) === i).map(x => [x, x]);
    if (cat === 'role') { const v = String(t.ServiceName || '').trim() || 'No service'; return [[v, v]]; }
    const st = rs.status.get(t.TaskUserStatusKey); return [[String(t.TaskUserStatusKey || 0), (st && st.name) || 'No status']];
  }
  const rsFCount = () => (rs.f.me ? 1 : 0) + RS_FCATS.reduce((a, c) => a + rs.f[c[0]].size, 0);
  const rsFTasksOn = () => RS_FCATS.some(c => rs.f[c[0]].size);
  function rsFPass(t) {
    for (const [c] of RS_FCATS) { const sel = rs.f[c]; if (sel.size && !rsFVals(c, t).some(x => sel.has(x[0]))) return false; }
    return true;
  }
  function rsFOptions(cat) {
    const m = new Map(), seen = new Set();
    for (const w of rsWeeks()) for (const u of rsPeople()) {
      const rec = rs.data.get(rsIso(w) + '|' + u.UserKey); if (!rec) continue;
      for (const t of rec.tasks) {
        const once = !seen.has(t.TaskUserKey); seen.add(t.TaskUserKey);   // count an assignment once across the weeks
        for (const [v, l] of rsFVals(cat, t)) { const o = m.get(v) || { v, l, n: 0 }; if (once) o.n++; m.set(v, o); }
      }
    }
    rs.f[cat].forEach(v => { if (!m.has(v)) m.set(v, { v, l: rs.fl[cat + '|' + v] || v, n: 0 }); });   // keep picks visible in other weeks
    return [...m.values()].sort((a, b) => a.l.localeCompare(b.l));
  }
  // The Filter button's count + the row of removable chips.
  function rsDrawChips() {
    const root = document.getElementById('uxa-rs'); if (!root) return;
    const n = rsFCount(), fb = root.querySelector('.uxa-rs-fbtn');
    fb.innerHTML = 'Filter' + (n ? ' <b>' + n + '</b>' : ''); fb.classList.toggle('on', !!n);
    let ch = rs.f.me ? '<span class="uxa-rs-chip">Me<button type="button" data-act="fme" title="Remove">×</button></span>' : '';
    for (const [c, lab] of RS_FCATS) rs.f[c].forEach(v => { ch += `<span class="uxa-rs-chip">${esc(lab)}: ${esc(rs.fl[c + '|' + v] || v)}<button type="button" data-act="fdel" data-cat="${c}" data-val="${esc(v)}" title="Remove">×</button></span>`; });
    if (ch) ch += '<button type="button" class="uxa-rs-clr" data-act="fclear">Clear all</button>';
    const box = root.querySelector('.uxa-rs-chips'); box.innerHTML = ch; box.hidden = !ch;
  }
  // The Filter popover: the category list, or one category's pick-list.
  function rsDrawPop() {
    const root = document.getElementById('uxa-rs'); if (!root) return;
    const pop = root.querySelector('.uxa-rs-fpop'); pop.hidden = !rs.fmenu; if (!rs.fmenu) { pop.innerHTML = ''; return; }
    if (rs.fmenu === 'root') {
      pop.innerHTML = `<button type="button" class="uxa-rs-fi${rs.f.me ? ' sel' : ''}" data-act="fme"><span>Me</span><em>${rs.f.me ? '✓' : ''}</em></button><hr>`
        + RS_FCATS.map(([c, lab]) => `<button type="button" class="uxa-rs-fi" data-act="fcat" data-cat="${c}"><span>${lab}</span><em>${rs.f[c].size || ''} ›</em></button>`).join('');
      return;
    }
    const cat = rs.fmenu, lab = (RS_FCATS.find(c => c[0] === cat) || [])[1] || '', opts = rsFOptions(cat);
    pop.innerHTML = `<button type="button" class="uxa-rs-fi uxa-rs-fback" data-act="fback"><span>‹ ${lab}</span></button>`
      + (opts.length > 8 ? '<input type="search" class="uxa-rs-fq" placeholder="Search" aria-label="Search options">' : '')
      + '<div class="uxa-rs-fopts">' + (opts.length ? opts.map(o => `<label class="uxa-rs-fo"><input type="checkbox" data-fcat="${cat}" data-fval="${esc(o.v)}" data-flab="${esc(o.l)}"${rs.f[cat].has(o.v) ? ' checked' : ''}><span>${esc(o.l)}</span><em>${o.n || ''}</em></label>`).join('') : '<div class="uxa-rs-msg">Nothing loaded for this week yet.</div>') + '</div>';
    const fq = pop.querySelector('.uxa-rs-fq'); if (fq) fq.focus();
  }
  // The people shown: everyone on the roster, or just the viewer's saved Scheduling "Users" filter when that's on.
  function rsPeople() { return (rs.staff || []).filter(u => !rs.useFilter || !rs.filterKeys || rs.filterKeys.has(u.UserKey)); }
  function rsDrawSoon() { if (rs.raf) return; rs.raf = setTimeout(() => { rs.raf = 0; rsDraw(); }, 60); }   // (a timer, not rAF: rAF stalls in a background tab)
  function ensureRsStyle() {
    if (document.getElementById('uxa-rs-style')) return;
    const s = document.createElement('style'); s.id = 'uxa-rs-style';
    const f = '-apple-system,Segoe UI,Roboto,sans-serif';
    s.textContent = '#uxa-rs-btn{font:13px/1 ' + f + ';cursor:pointer;margin:0 4px 0 8px;padding:8px 14px;border:1px solid #cfd6df;border-radius:8px;background:#fff;color:#334;display:inline-flex;align-items:center;gap:7px;flex:0 0 auto;align-self:center;white-space:nowrap}'
      + '#uxa-rs-btn:hover{border-color:#7ab51d;color:#3f6d12}'
      + '#uxa-rs{position:fixed;inset:0;z-index:99990;background:#fff;color:#243;font:13px/1.3 ' + f + ';display:flex;flex-direction:column}'
      + '#uxa-rs *{box-sizing:border-box}'
      + '.uxa-rs-top{flex:0 0 auto;display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:12px 18px;border-bottom:1px solid #e3e6ea}'
      + '.uxa-rs-title{font-size:18px;font-weight:700;color:#1f2d3d;margin-right:6px}'
      + '.uxa-rs-week{font-weight:600;color:#1f2d3d;min-width:150px}'
      + '.uxa-rs-b{font:inherit;cursor:pointer;padding:6px 10px;border:1px solid #cfd6df;border-radius:7px;background:#fff;color:#334;line-height:1}'
      + '.uxa-rs-b:hover{border-color:#9aa6b4}'
      + '.uxa-rs-q{font:inherit;padding:6px 10px;border:1px solid #cfd6df;border-radius:7px;width:230px}'
      + '.uxa-rs-q:focus{outline:none;border-color:#7ab51d;box-shadow:0 0 0 3px rgba(122,181,29,.15)}'
      + '.uxa-rs-ck{display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none;color:#445}.uxa-rs-ck[hidden]{display:none}'
      + '#uxa-rs .uxa-rs-ck input{appearance:auto;-webkit-appearance:checkbox;opacity:1;position:static;display:inline-block;width:14px;height:14px;margin:0;accent-color:#7ab51d}'
      + '.uxa-rs-sp{flex:1 1 auto}'
      + '.uxa-rs-bar2{flex:0 0 auto;display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:8px 18px;border-bottom:1px solid #e3e6ea;background:#fafbfc}'
      + '.uxa-rs-fwrap{position:relative}'
      + '.uxa-rs-fbtn.on{border-color:#7ab51d;color:#3f6d12;background:#eef6e6}.uxa-rs-fbtn b{display:inline-block;min-width:16px;padding:1px 4px;margin-left:3px;border-radius:8px;background:#7ab51d;color:#fff;font-size:11px;text-align:center}'
      + '.uxa-rs-fpop{position:absolute;left:0;top:calc(100% + 6px);z-index:6;width:300px;max-height:420px;display:flex;flex-direction:column;background:#fff;border:1px solid #d5dbe3;border-radius:10px;box-shadow:0 10px 30px rgba(20,30,50,.18);padding:6px}.uxa-rs-fpop[hidden]{display:none}'
      + '.uxa-rs-fpop hr{border:0;border-top:1px solid #eef0f3;margin:4px 0}'
      + '.uxa-rs-fi{display:flex;align-items:center;width:100%;font:inherit;text-align:left;padding:8px 10px;border:0;border-radius:6px;background:none;color:#243;cursor:pointer}.uxa-rs-fi:hover{background:#f2f5f8}.uxa-rs-fi span{flex:1 1 auto}.uxa-rs-fi em{font-style:normal;color:#7a8594;font-size:12px}.uxa-rs-fi.sel em{color:#3f6d12;font-weight:700}'
      + '.uxa-rs-fback{font-weight:600}'
      + '.uxa-rs-fq{font:inherit;margin:4px 4px 6px;padding:6px 9px;border:1px solid #cfd6df;border-radius:7px}'
      + '.uxa-rs-fopts{overflow:auto;min-height:0}'
      + '.uxa-rs-fo{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;cursor:pointer}.uxa-rs-fo:hover{background:#f2f5f8}.uxa-rs-fo span{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.uxa-rs-fo em{font-style:normal;color:#9aa1ab;font-size:11px}'
      + '#uxa-rs .uxa-rs-fo input{appearance:auto;-webkit-appearance:checkbox;opacity:1;position:static;display:inline-block;width:14px;height:14px;margin:0;flex:0 0 auto;accent-color:#7ab51d}'
      + '.uxa-rs-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.uxa-rs-chips[hidden]{display:none}'
      + '.uxa-rs-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 4px 3px 9px;border:1px solid #cfe3b4;border-radius:999px;background:#eef6e6;color:#3f6d12;font-size:12px;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.uxa-rs-chip button{font:inherit;border:0;background:none;color:#3f6d12;cursor:pointer;padding:0 5px;font-size:14px;line-height:1}'
      + '.uxa-rs-clr{font:inherit;font-size:12px;border:0;background:none;color:#2b6cb0;cursor:pointer;text-decoration:underline}'
      + '#uxa-rs .uxa-rs-sel{font:inherit;display:inline-block;width:auto;flex:0 0 auto;height:auto;margin:0;padding:5px 8px;border:1px solid #cfd6df;border-radius:7px;background:#fff;color:#334;appearance:auto;-webkit-appearance:menulist}'
      + '.uxa-rs-note{font-size:14px;color:#8a93a0;cursor:help;white-space:nowrap}'
      + '.uxa-rs-body{flex:1 1 auto;overflow:auto}'
      + '.uxa-rs-head{display:flex;position:sticky;top:0;z-index:3;background:#fff;border-bottom:1px solid #e3e6ea}'
      + '.uxa-rs-who{flex:0 0 220px;padding:8px 12px;border-right:1px solid #e3e6ea}'
      + '.uxa-rs-days{flex:1 1 auto;display:flex;min-width:0}'
      + '.uxa-rs-dh{flex:1 1 0;text-align:center;padding:8px 2px;color:#667;border-left:1px solid #eef0f3;font-size:12px}'
      + '.uxa-rs-dh:first-child,.uxa-rs-cap:first-child{border-left:0}'
      + '.uxa-rs-dh b{color:#243}.uxa-rs-dh.we{background:#fafbfc;color:#9aa1ab}.uxa-rs-dh.td{background:rgba(122,181,29,.10);color:#3f6d12}'
      + '.uxa-rs-lane{display:flex;border-bottom:1px solid #e9ecef}'
      + '.uxa-rs-lane .uxa-rs-who{cursor:pointer}'
      + '.uxa-rs-lane .uxa-rs-who:hover{background:#fafbfc}'
      + '.uxa-rs-name{font-weight:600;color:#1f2d3d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.uxa-rs-name i{display:inline-block;width:12px;font-style:normal;color:#8a93a0;font-size:10px}'
      + '.uxa-rs-sub{font-size:11px;color:#667;margin:3px 0 5px 12px}'
      + '.uxa-rs-sub .over{color:#c53030;font-weight:600}.uxa-rs-sub .avail{color:#2f855a;font-weight:600}'
      + '.uxa-rs-util{height:5px;border-radius:3px;background:#e3e6ea;overflow:hidden;margin-left:12px}'
      + '.uxa-rs-util span{display:block;height:100%;border-radius:3px}'
      + '.uxa-rs-main{flex:1 1 auto;min-width:0}'
      + '.uxa-rs-caps{display:flex;border-bottom:1px solid #f0f2f4}'
      + '.uxa-rs-cap{flex:1 1 0;text-align:center;padding:5px 2px;border-left:1px solid #eef0f3;font-size:12px;font-weight:600}'
      + '.uxa-rs-cap small{font-weight:400;color:#8a93a0;font-size:10px}'
      + '.uxa-rs-cap.ok{background:#e9f6ee;color:#22663f}.uxa-rs-cap.warn{background:#fdf1dc;color:#8a5a00}.uxa-rs-cap.over{background:#fde5e5;color:#b42323}.uxa-rs-cap.off{background:#fafbfc;color:#b3b9c2}'
      + '.uxa-rs-cap.lg{font-style:italic}'
      + '.uxa-rs-track{position:relative}'
      + '.uxa-rs-col{position:absolute;top:0;bottom:0;border-left:1px solid #eef0f3}'
      + '.uxa-rs-col.we{background:#fafbfc}.uxa-rs-col.td{background:rgba(122,181,29,.06)}'
      + '.uxa-rs-bar{position:absolute;height:' + RS_BAR + 'px;border-radius:5px;display:flex;align-items:center;padding:0 7px;font-size:11px;font-weight:600;text-decoration:none;box-shadow:inset 0 0 0 1px rgba(0,0,0,.10);overflow:hidden}'
      + '#uxa-rs .uxa-rs-bar:hover{filter:brightness(.94);box-shadow:inset 0 0 0 1px rgba(0,0,0,.25);text-decoration:none}'
      + '.uxa-rs-bar span{display:flex;flex-direction:column;justify-content:center;min-width:0;line-height:1.25}'
      + '.uxa-rs-bar b,.uxa-rs-bar small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.uxa-rs-bar b{font-weight:600;font-size:12px}.uxa-rs-bar small{font-weight:400;font-size:10px;opacity:.85}'
      + '.uxa-rs-dh.wk,.uxa-rs-cap.wk,.uxa-rs-col.wk{border-left:2px solid #aab4c2}'
      + '.uxa-rs-bar em{font-style:normal;font-weight:700;margin-left:auto;padding-left:8px;white-space:nowrap;opacity:.9}'
      + '.uxa-rs-bar.zero{opacity:.5}'
      + '.uxa-rs-track{min-height:' + (RS_BAR + 2 * RS_GAP) + 'px}'
      + '.uxa-rs-none{position:absolute;left:10px;top:0;bottom:0;display:flex;align-items:center;color:#aeb4bf;font-size:12px;font-style:italic;pointer-events:none}'
      + '#uxa-rs .uxa-rs-h{position:absolute;top:0;bottom:0;width:8px;cursor:ew-resize;z-index:1;pointer-events:auto;display:block}.uxa-rs-h.l{left:0}.uxa-rs-h.r{right:0}.uxa-rs-h:hover{background:rgba(0,0,0,.18)}'
      + '.uxa-rs-undo{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);z-index:7;display:flex;align-items:center;gap:12px;max-width:80%;padding:10px 10px 10px 16px;border-radius:10px;background:#1f2d3d;color:#fff;font-size:13px;box-shadow:0 10px 30px rgba(20,30,50,.35)}'
      + '.uxa-rs-undo span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.uxa-rs-undo button{font:inherit;cursor:pointer;border:0;border-radius:6px;padding:6px 12px;background:#7ab51d;color:#fff;font-weight:700}.uxa-rs-undo button[data-act="undoX"]{background:none;color:#b8c2cf;padding:6px 8px;font-size:16px;line-height:1}.uxa-rs-undo button[disabled]{opacity:.6;cursor:default}'
      + '.uxa-rs-track.alloc{cursor:cell}.uxa-rs-bar.drag{cursor:grab}.uxa-rs-bar.dragging{cursor:grabbing;opacity:.85;z-index:2;box-shadow:0 6px 16px rgba(20,30,50,.3)}'
      + '.uxa-rs-dlgbg{position:absolute;inset:0;z-index:8;background:rgba(20,20,20,.4);display:flex;align-items:flex-start;justify-content:center;padding:9vh 16px}'
      + '.uxa-rs-dlg{width:520px;max-width:100%;background:#fff;border-radius:12px;box-shadow:0 20px 50px rgba(20,30,50,.3);padding:20px 22px}'
      + '.uxa-rs-dlg h3{margin:0 0 14px;font-size:17px;font-weight:700;color:#1f2d3d}'
      + '.uxa-rs-dlg label{display:block;font-size:12px;color:#667;margin:0 0 12px}'
      + '#uxa-rs .uxa-rs-dlg input,#uxa-rs .uxa-rs-dlg select{display:block;width:100%;height:auto;margin:4px 0 0;font:inherit;font-size:13px;color:#243;padding:7px 9px;border:1px solid #cfd6df;border-radius:7px;background:#fff;appearance:auto;-webkit-appearance:auto;opacity:1;position:static}'
      + '.uxa-rs-frow{display:flex;gap:10px}.uxa-rs-frow label{flex:1 1 0}'
      + '#uxa-rs .uxa-rs-dlg select.uxa-rs-plist{height:150px;padding:4px;overflow:auto}.uxa-rs-plist optgroup{font-weight:700;color:#445;font-style:normal}.uxa-rs-plist option{font-weight:400;color:#243;padding:3px 6px}'
      + '.uxa-rs-dsum{margin:-4px 0 12px;font-size:12px;color:#3f6d12;font-weight:600}'
      + '.uxa-rs-sel-box{position:absolute;top:2px;bottom:2px;border-radius:5px;background:rgba(122,181,29,.22);box-shadow:inset 0 0 0 1.5px #7ab51d;pointer-events:none;z-index:1}'
      + '.uxa-rs-newtask[hidden],.uxa-rs-dmsg[hidden]{display:none}'
      + '.uxa-rs-dmsg{margin:0 0 12px;padding:8px 10px;border-radius:7px;background:#fdecec;color:#a12222;font-size:12px}.uxa-rs-dmsg.info{background:#eef3f8;color:#445}'
      + '.uxa-rs-dbtns{display:flex;gap:8px}.uxa-rs-primary{background:#5d8f12;border-color:#5d8f12;color:#fff;font-weight:600}.uxa-rs-primary:hover{background:#4f7a0f;border-color:#4f7a0f}.uxa-rs-b[disabled]{opacity:.55;cursor:default}'
      + '.uxa-rs-dnote{margin:12px 0 0;font-size:11px;color:#8a93a0}'
      + '.uxa-rs-msg{padding:6px 12px;color:#8a93a0;font-size:12px;font-style:italic}'
      + '.uxa-rs-empty{padding:28px;color:#8a93a0}';
    (document.head || document.documentElement).appendChild(s);
  }
  function rsDraw() {
    const root = document.getElementById('uxa-rs'); if (!root || !rs.open) return;
    if (rs.drag) { rs.redraw = true; return; }   // don't pull a bar out from under the pointer; redraw when the drag ends
    // One or two weeks side by side (the second is the "glimpse into next week"). Each week is its own record per
    // person — Workamajig allocates hours per week — so capacity cells come week by week, while an assignment that
    // runs across both weeks is drawn as ONE bar.
    const weeks = rsWeeks(), today = rsToday();
    const wdays = weeks.map(w => Array.from({ length: 7 }, (_, i) => rsAdd(w, i)));   // all 7 days of each week
    const vis = wdays.map(a => rs.weekends ? a : a.slice(0, 5)), per = vis[0].length;
    const days = [].concat(...vis), n = days.length, wk0 = rsIso(weeks[0]), all = wdays[0], canAlloc = rsCanAlloc();
    rs.vdays = days;
    const end = wdays[wdays.length - 1][6], mo = d => d.toLocaleDateString('en-US', { month: 'short' });
    root.querySelector('.uxa-rs-week').textContent = mo(rs.week) + ' ' + rs.week.getDate() + ' – ' + (end.getMonth() !== rs.week.getMonth() ? mo(end) + ' ' : '') + end.getDate() + ', ' + end.getFullYear();
    const allBtn = root.querySelector('.uxa-rs-all');
    if (allBtn) allBtn.textContent = rsPeople().some(u => !rs.collapsed.has(u.UserKey)) ? 'Collapse all' : 'Expand all';
    const body = root.querySelector('.uxa-rs-body');
    if (!rs.staff) { body.innerHTML = '<div class="uxa-rs-empty">Loading the team…</div>'; return; }
    if (!rs.staff.length) { body.innerHTML = '<div class="uxa-rs-empty">' + (rs.staffErr ? 'Couldn’t load the staff list from Workamajig. Try Refresh.' : 'No staff to show. Resource scheduling may not be available for your Workamajig login.') + '</div>'; return; }
    const dcls = (d, i) => (d.getDay() === 0 || d.getDay() === 6 ? ' we' : '') + (+d === +today ? ' td' : '') + (i && i % per === 0 ? ' wk' : '');
    let html = '<div class="uxa-rs-head"><div class="uxa-rs-who"></div><div class="uxa-rs-days">'
      + days.map((d, i) => `<div class="uxa-rs-dh${dcls(d, i)}">${esc(d.toLocaleDateString('en-US', { weekday: 'short' }))} <b>${d.getDate()}</b></div>`).join('') + '</div></div>';
    const cols = days.map((d, i) => `<div class="uxa-rs-col${dcls(d, i)}" style="left:${(i / n * 100).toFixed(4)}%;width:${(100 / n).toFixed(4)}%"></div>`).join('');
    const q = rs.q, fOn = rsFTasksOn(), me = rs.f.me ? rsMe() : 0; let shown = 0;
    const rowH = RS_BAR + RS_GAP;
    rsDrawChips();
    // People in the chosen order (by the first week's numbers); anyone still loading sorts last until their week arrives.
    const ppl = rsPeople().map(u => { const rec = rs.data.get(wk0 + '|' + u.UserKey); let tot = 0, cap = 0; if (rec) rsUserDays(rec, all).forEach(x => { tot += x.hrs; cap += x.cap; }); return { u, rec, tot, cap }; });
    if (rs.sort !== 'name') {
      const val = x => rs.sort === 'util' ? (x.cap ? x.tot / x.cap : (x.tot ? 99 : 0)) : (rs.sort === 'avail' ? x.cap - x.tot : x.tot);
      ppl.sort((a, b) => (!a.rec - !b.rec) || (val(b) - val(a)) || String(a.u.UserName).localeCompare(String(b.u.UserName)));
    }
    for (const { u, rec, tot, cap } of ppl) {
      if (me && u.UserKey !== me) continue;
      const nameHit = !q || String(u.UserName).toLowerCase().indexOf(q) >= 0;
      const recs = weeks.map(w => rs.data.get(rsIso(w) + '|' + u.UserKey));
      // Assignments across the shown weeks, merged per assignment: first/last visible day index + hours allocated.
      const byKey = new Map();
      recs.forEach((r, wi) => {
        if (!r) return;
        for (const t of r.tasks) {
          if (fOn && !rsFPass(t)) continue;
          if (q && !nameHit && [t.ProjectNumber, t.ProjectName, t.TaskName, t.CompanyName].join(' ').toLowerCase().indexOf(q) < 0) continue;
          let first = -1, last = -1;
          vis[wi].forEach((d, i) => { if (rsActive(t, d)) { if (first < 0) first = wi * per + i; last = wi * per + i; } });
          if (first < 0) continue;
          const k = t.TaskUserKey || ('t' + t.TaskKey), e = byKey.get(k);
          if (e) { e.first = Math.min(e.first, first); e.last = Math.max(e.last, last); e.dh += +t.DisplayHours || 0; }
          else byKey.set(k, { t, first, last, dh: +t.DisplayHours || 0 });
        }
      });
      let tasks = [...byKey.values()];
      if (rs.plannedOnly) tasks = tasks.filter(x => x.dh > 0);
      // work with hours left first, then by where it starts on the timeline
      tasks.sort((a, b) => ((b.dh > 0) - (a.dh > 0)) || (a.first - b.first) || (b.last - a.last));
      if ((q && !nameHit && !tasks.length) || (fOn && rec && !tasks.length)) continue;
      shown++;
      const open = !rs.collapsed.has(u.UserKey);
      let sub = 'Loading…', util = '';
      if (rec) {
        const diff = tot - cap;
        sub = rsNum(tot) + ' / ' + rsNum(cap) + ' h · ' + (diff > 0.05 ? `<span class="over">${rsNum(diff)} over</span>` : `<span class="avail">${rsNum(-diff)} available</span>`);
        const lv = rsLevel(tot, cap), colr = lv === 'over' ? '#e53e3e' : (lv === 'warn' ? '#dd8800' : '#38a169');
        util = `<div class="uxa-rs-util"><span style="width:${Math.min(100, cap ? tot / cap * 100 : (tot ? 100 : 0)).toFixed(1)}%;background:${colr}"></span></div>`;
        if (fOn) sub += ' · ' + rsNum(tasks.reduce((a, x) => a + x.dh, 0)) + ' h in filter';
        if (rs.meetings && !Array.isArray(rec.cal)) sub += ' · meetings loading…';
        if (rec.err) sub = 'Couldn’t load — try Refresh';
      }
      const caps = recs.map((r, wi) => !r ? vis[wi].map((d, i) => `<div class="uxa-rs-cap off${wi && !i ? ' wk' : ''}">·</div>`).join('')
        : rsUserDays(r, wdays[wi]).slice(0, per).map((x, i) => `<div class="uxa-rs-cap ${rsLevel(x.hrs, x.cap)}${x.logged ? ' lg' : ''}${wi && !i ? ' wk' : ''}" title="${x.logged ? 'Time logged' : 'Planned hours' + (x.mt ? ' + ' + rsNum(x.mt) + ' h meetings' : '')}: ${rsNum(x.hrs)} h · capacity ${rsNum(x.cap)} h">${rsNum(x.hrs)} <small>/ ${rsNum(x.cap)}</small></div>`).join('')).join('');
      let track = '';
      if (open) {
        let bars = '';
        tasks.forEach((x, i) => {
          const t = x.t, st = rs.status.get(t.TaskUserStatusKey) || { color: '#7a8aa0', name: '' }, dh = x.dh >= 0.05 ? x.dh : 0;
          const proj = (t.ProjectNumber ? t.ProjectNumber + ' · ' : '') + (t.ProjectName || '');
          // Any assignment can be dragged sideways to shift it (even one that runs off the edge of the weeks shown);
          // an end that is on screen also gets a handle to stretch or shorten the assignment from that side.
          const rsd = rsDate(t.APlanStart || t.PlanStart), red = rsDate(t.APlanComplete || t.PlanComplete);
          const drag = canAlloc && Number(t.TaskUserKey) > 0 && rsd && red;
          const hl = drag && rsd >= days[0], hr = drag && red <= days[n - 1];
          const tip = (t.TaskName || '') + '\n' + (t.ProjectFullName || proj) + (st.name ? '\nStatus: ' + st.name : '')
            + '\n' + String(t.APlanStart || t.PlanStart || '').slice(0, 10) + ' → ' + String(t.APlanComplete || t.PlanComplete || '').slice(0, 10)
            + '\nPlanned ' + rsNum(+t.Hours || 0) + ' h · logged ' + rsNum(+t.ActualHours || 0) + ' h · ' + (+t.PercComp || 0) + '% complete' + (dh ? '\n' + rsNum(dh) + ' h allocated in the weeks shown' : '');
          bars += `<a class="uxa-rs-bar${dh ? '' : ' zero'}${drag ? ' drag' : ''}"${drag ? ` data-drag="1" data-first="${x.first}" data-last="${x.last}" data-s="${rsYmd(rsd)}" data-e="${rsYmd(red)}"` : ''} draggable="false" data-pk="${Number(t.ProjectKey) || 0}" data-task="${Number(t.TaskKey) || 0}" data-tuk="${Number(t.TaskUserKey) || 0}" data-u="${u.UserKey}" href="${esc(urls.assignment(t.TaskUserKey))}" target="_blank" rel="noopener" title="${esc(tip)}" style="left:calc(${(x.first / n * 100).toFixed(4)}% + 2px);width:calc(${((x.last - x.first + 1) / n * 100).toFixed(4)}% - 4px);top:${i * rowH + RS_GAP}px;background:${esc(st.color)};color:${rsInk(st.color)}">${hl ? '<i class="uxa-rs-h l" data-h="l"></i>' : ''}<span><b>${esc(t.TaskName || 'Task')}</b><small>${esc(proj)}</small></span>${dh ? '<em>' + rsNum(dh) + 'h</em>' : ''}${hr ? '<i class="uxa-rs-h r" data-h="r"></i>' : ''}</a>`;
        });
        const none = recs.every(r => r) && !tasks.length ? '<div class="uxa-rs-none">No assignments' + (q || rs.plannedOnly || fOn ? ' match' : (weeks.length > 1 ? ' in these weeks' : ' this week')) + (canAlloc ? ' \u2014 click a day to allocate' : '') + '</div>' : '';
        track = `<div class="uxa-rs-track${canAlloc ? ' alloc' : ''}" data-u="${u.UserKey}"${canAlloc ? ' title="Click a blank day to allocate"' : ''} style="height:${Math.max(tasks.length, 1) * rowH + RS_GAP}px">${cols}${bars}${none}</div>`;
      }
      html += `<div class="uxa-rs-lane"><div class="uxa-rs-who" data-act="toggle" data-u="${u.UserKey}"><div class="uxa-rs-name"><i>${open ? '▾' : '▸'}</i>${esc(u.UserName)}</div><div class="uxa-rs-sub">${sub}</div>${util}</div>`
        + `<div class="uxa-rs-main"><div class="uxa-rs-caps">${caps}</div>${track}</div></div>`;
    }
    if (!shown) html += '<div class="uxa-rs-empty">Nobody matches the current search and filters.</div>';
    body.innerHTML = html;
  }
  // ---- allocate: click a blank day in someone's lane to assign them to a task ----
  // Workamajig has no free-standing "allocation": hours always live on an assignment to a task in a project. So the
  // form asks for a project (any that appears in the weeks loaded so far) and a task on it (an open one, or a new one).
  function rsAllocProjects() {   // [{ client, items: [{ k, l }] }] sorted by client then project
    const m = new Map();
    rs.data.forEach(rec => { if (rec) for (const t of rec.tasks) if (Number(t.ProjectKey) > 0 && !m.has(t.ProjectKey)) m.set(t.ProjectKey, { k: t.ProjectKey, l: (t.ProjectNumber ? t.ProjectNumber + ' · ' : '') + (t.ProjectName || ''), c: String(t.CompanyName || '').trim() || 'No client' }); });
    const by = new Map();
    [...m.values()].sort((x, y) => x.l.localeCompare(y.l)).forEach(o => { if (!by.has(o.c)) by.set(o.c, []); by.get(o.c).push(o); });
    return [...by.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([client, items]) => ({ client, items }));
  }
  function rsAllocClose() { rs.alloc = null; const d = document.querySelector('#uxa-rs .uxa-rs-dlgbg'); if (d) d.remove(); }
  function rsAllocOpen(u, startYmd, endYmd) {
    const root = document.getElementById('uxa-rs'); if (!root || !rsCanAlloc()) return;
    rsAllocClose();
    rs.alloc = { userKey: u.UserKey, userName: u.UserName, busy: false };
    const d = document.createElement('div'); d.className = 'uxa-rs-dlgbg';
    d.innerHTML = `<div class="uxa-rs-dlg" role="dialog" aria-modal="true"><h3>Allocate ${esc(u.UserName)}</h3>`
      + `<div class="uxa-rs-frow"><label>Start<input type="date" data-al="start" value="${startYmd}"></label><label>End<input type="date" data-al="end" value="${endYmd || startYmd}"></label></div>`
      + '<div class="uxa-rs-frow"><label>Hours<select data-al="mode"><option value="day">Hours per day</option><option value="total">Total hours</option></select></label>'
      + '<label>&nbsp;<input type="number" data-al="hours" min="0" step="0.25" value="1" aria-label="Hours"></label></div>'
      + '<div class="uxa-rs-dsum"></div>'
      + '<label>Project<input type="search" class="uxa-rs-pq" placeholder="Search projects or clients" aria-label="Search projects or clients">'
      + `<select data-al="pk" size="7" class="uxa-rs-plist">${rsAllocProjects().map(g => `<optgroup label="${esc(g.client)}">${g.items.map(o => `<option value="${o.k}">${esc(o.l)}</option>`).join('')}</optgroup>`).join('')}</select></label>`
      + '<div class="uxa-rs-frow"><label style="flex:2 1 0">Task<select data-al="task" disabled><option value="">Choose a project first</option></select></label>'
      + '<label>Status<select data-al="status" disabled><option value="">Project default</option></select></label></div>'
      + '<label class="uxa-rs-newtask" hidden>New task name<input type="text" data-al="name" maxlength="200" placeholder="e.g. Planning"></label>'
      + '<div class="uxa-rs-dmsg" hidden></div>'
      + '<div class="uxa-rs-dbtns"><button type="button" class="uxa-rs-b uxa-rs-primary" data-act="allocSave">Create assignment</button><button type="button" class="uxa-rs-b" data-act="allocCancel">Cancel</button></div>'
      + '<p class="uxa-rs-dnote">This creates a real assignment in Workamajig. If the dates fall outside the task’s own dates, the task is extended to fit. The project list shows projects that appear in the weeks loaded so far.</p></div>';
    root.appendChild(d);
    rsAllocSum();
    d.querySelector('.uxa-rs-pq').focus();
  }
  // The total this form will book: hours per day × working days (Mon–Fri) in the span, or the total as typed.
  function rsAllocTotal() {
    const root = document.getElementById('uxa-rs'), v = k => { const el = root && root.querySelector('[data-al="' + k + '"]'); return el ? String(el.value || '').trim() : ''; };
    const s = v('start'), e = v('end'), h = v('hours'), ok = /^\d{4}-\d{2}-\d{2}$/.test(s) && /^\d{4}-\d{2}-\d{2}$/.test(e) && e >= s;
    const days = ok ? schedWorkDays(s, e) : 0, num = h !== '' && isFinite(Number(h)) && Number(h) >= 0 ? Number(h) : null;
    return { ok, days, perDay: v('mode') !== 'total', num, total: num == null ? null : (v('mode') !== 'total' ? num * days : num) };
  }
  function rsAllocSum() {
    const el = document.querySelector('#uxa-rs .uxa-rs-dsum'); if (!el) return;
    const t = rsAllocTotal();
    if (!t.ok) { el.textContent = 'Pick a start date and an end date on or after it.'; return; }
    const d = t.days + (t.days === 1 ? ' working day' : ' working days');
    el.textContent = t.total == null ? d : d + ' · ' + (t.perDay ? rsNum(t.total) + ' h total' : rsNum(t.days ? t.total / t.days : 0) + ' h per day');
  }
  // Fill the Task and Status pick-lists for the chosen project: its open leaf tasks plus "New task…", and its statuses.
  async function rsAllocTasks(pk) {
    const root = document.getElementById('uxa-rs'), sel = root && root.querySelector('[data-al="task"]'); if (!sel) return;
    const stSel = root.querySelector('[data-al="status"]'), newBox = root.querySelector('.uxa-rs-newtask'); newBox.hidden = true;
    stSel.disabled = true; stSel.innerHTML = '<option value="">Project default</option>';
    if (!(Number(pk) > 0)) { sel.disabled = true; sel.innerHTML = '<option value="">Choose a project first</option>'; return; }
    sel.disabled = true; sel.innerHTML = '<option value="">Loading tasks…</option>';
    let sched = null;
    try { sched = await schedRead(Number(pk)); } catch (e) {}
    const cur = root.querySelector('[data-al="pk"]'); if (!rs.alloc || !cur || cur.value !== String(pk)) return;   // changed meanwhile
    if (!sched) { sel.innerHTML = '<option value="">Could not load this project’s tasks</option>'; return; }
    const tasks = sched.tasks || [], parents = new Set(tasks.map(t => t.SummaryTaskKey).filter(Boolean));
    const open = tasks.filter(t => !parents.has(t.TaskKey) && !(+t.PercComp >= 100));
    sel.innerHTML = '<option value="">Choose a task…</option><option value="new">＋ New task…</option>'
      + open.map(t => `<option value="${t.TaskKey}">${esc((t.TaskID ? t.TaskID + '  ' : '') + (t.TaskName || ''))}</option>`).join('');
    sel.disabled = false;
    const sts = sched.taskUserStatus || [];
    if (sts.length) { stSel.innerHTML = sts.map(x => `<option value="${x.k}"${x.IsDefault ? ' selected' : ''}>${esc(x.l || '')}</option>`).join(''); stSel.disabled = false; }
  }
  async function rsAllocSave() {
    const root = document.getElementById('uxa-rs'), a = rs.alloc; if (!root || !a || a.busy) return;
    const v = k => { const el = root.querySelector('[data-al="' + k + '"]'); return el ? String(el.value || '').trim() : ''; };
    const msg = root.querySelector('.uxa-rs-dmsg'), say = (t, info) => { msg.textContent = t; msg.hidden = !t; msg.classList.toggle('info', !!info); };
    const taskVal = v('task'), tot = rsAllocTotal();
    if (!tot.ok) { say('Pick a start date and an end date on or after it.'); return; }
    if (tot.total == null) { say('Enter the hours (0 or more).'); return; }
    if (!v('pk')) { say('Pick a project.'); return; }
    if (!taskVal) { say('Pick a task, or choose New task.'); return; }
    if (taskVal === 'new' && !v('name')) { say('Enter a name for the new task.'); return; }
    a.busy = true; root.querySelectorAll('.uxa-rs-dbtns button').forEach(b => { b.disabled = true; }); say('Saving to Workamajig…', true);
    try {
      await addAssignment(v('pk'), taskVal === 'new' ? { name: v('name') } : { taskKey: Number(taskVal) }, a.userKey, a.userName, Math.round(tot.total * 100) / 100, v('start'), v('end'), v('status'));
      rsAllocClose(); toast('Assignment created for ' + a.userName); rsReloadUser(a.userKey);
    } catch (e) {
      a.busy = false; root.querySelectorAll('.uxa-rs-dbtns button').forEach(b => { b.disabled = false; });
      say('Could not create the assignment: ' + ((e && e.message) || e));
    }
  }
  // ---- click or drag across blank days in a lane to pick the dates to allocate ----
  function rsSelStart(e) {
    const tr = e.target.closest && e.target.closest('.uxa-rs-track.alloc');
    if (!tr || e.button !== 0 || rs.drag || rs.alloc || e.target.closest('.uxa-rs-bar') || !rs.vdays.length) return;
    const u = (rs.staff || []).find(x => x.UserKey === Number(tr.dataset.u)); if (!u) return;
    const n = rs.vdays.length, r = tr.getBoundingClientRect(), idx = x => Math.max(0, Math.min(n - 1, Math.floor((x - r.left) / r.width * n)));
    const i0 = idx(e.clientX); let i1 = i0;
    const box = document.createElement('div'); box.className = 'uxa-rs-sel-box'; tr.appendChild(box);
    const paint = () => { const a = Math.min(i0, i1), b = Math.max(i0, i1); box.style.left = (a / n * 100) + '%'; box.style.width = ((b - a + 1) / n * 100) + '%'; };
    paint(); rs.drag = { sel: true };
    e.preventDefault();   // no text selection while sweeping
    const move = ev => { i1 = idx(ev.clientX); paint(); };
    const up = () => {
      document.removeEventListener('mousemove', move, true); document.removeEventListener('mouseup', up, true);
      rs.drag = null; box.remove();
      if (rs.redraw) { rs.redraw = false; rsDrawSoon(); }
      rsAllocOpen(u, rsYmd(rs.vdays[Math.min(i0, i1)]), rsYmd(rs.vdays[Math.max(i0, i1)]));
    };
    document.addEventListener('mousemove', move, true); document.addEventListener('mouseup', up, true);
  }
  // ---- drag a bar to reschedule that assignment (snaps to day columns) ----
  // Drag the body to shift the whole assignment by that many days; drag an end handle to move just that end. With
  // weekends hidden a column is a working day, so a shift skips Saturdays and Sundays.
  function rsShiftYmd(ymd, k) {
    const d = rsDate(ymd), step = k < 0 ? -1 : 1;
    for (let left = Math.abs(k); left > 0;) { d.setDate(d.getDate() + step); if (rs.weekends || (d.getDay() !== 0 && d.getDay() !== 6)) left--; }
    return rsYmd(d);
  }
  function rsDragStart(e) {
    const bar = e.target.closest && e.target.closest('.uxa-rs-bar[data-drag]');
    if (!bar || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rs.drag) return;
    const n = rs.vdays.length, colW = bar.parentElement.getBoundingClientRect().width / n;
    const first = Number(bar.dataset.first), last = Number(bar.dataset.last);
    const hEl = e.target.closest('.uxa-rs-h'), mode = hEl ? hEl.dataset.h : 'm';   // 'm' move, 'l' start, 'r' end
    const w0 = bar.getBoundingClientRect().width;
    const d = rs.drag = { x0: e.clientX, delta: 0, moved: false };
    e.preventDefault();
    const move = ev => {
      const dx = ev.clientX - d.x0;
      if (!d.moved && Math.abs(dx) < 5) return;
      d.moved = true;
      let k = Math.round(dx / colW);
      if (mode === 'l') k = Math.max(-first, Math.min(last - first, k));          // start stays on screen and on/before the end
      else if (mode === 'r') k = Math.max(first - last, Math.min(n - 1 - last, k)); // end stays on screen and on/after the start
      else k = Math.max(-n, Math.min(n, k));
      d.delta = k; bar.classList.add('dragging');
      if (mode === 'm') bar.style.transform = 'translateX(' + (k * colW) + 'px)';
      else if (mode === 'r') bar.style.width = Math.max(colW - 4, w0 + k * colW) + 'px';
      else { bar.style.transform = 'translateX(' + (k * colW) + 'px)'; bar.style.width = Math.max(colW - 4, w0 - k * colW) + 'px'; }
    };
    const up = () => {
      document.removeEventListener('mousemove', move, true); document.removeEventListener('mouseup', up, true);
      rs.drag = null; bar.classList.remove('dragging');
      if (d.moved) { rs.justDragged = true; setTimeout(() => { rs.justDragged = false; }, 80); }   // swallow the click that follows
      if (d.moved && d.delta) {
        const k = d.delta;
        const ns = mode === 'r' ? bar.dataset.s : (mode === 'l' ? rsYmd(rs.vdays[first + k]) : rsShiftYmd(bar.dataset.s, k));
        const ne = mode === 'l' ? bar.dataset.e : (mode === 'r' ? rsYmd(rs.vdays[last + k]) : rsShiftYmd(bar.dataset.e, k));
        rsDragSave(bar, ns, ne);
      } else { bar.style.transform = ''; bar.style.width = ''; if (rs.redraw) { rs.redraw = false; rsDrawSoon(); } rsDraw(); }
    };
    document.addEventListener('mousemove', move, true); document.addEventListener('mouseup', up, true);
  }
  async function rsDragSave(bar, startYmd, endYmd) {
    const userKey = Number(bar.dataset.u), pk = bar.dataset.pk, tuk = bar.dataset.tuk;
    const name = ((bar.querySelector('b') || {}).textContent || 'Assignment').trim();
    const nice = y => rsDate(y).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    rsUndoHide(); toast('Saving…');
    try {
      const before = await saveAssignmentDates(pk, tuk, startYmd, endYmd);
      rsUndoShow({ pk, tuk, userKey, before }, '“' + name + '” is now ' + nice(startYmd) + (endYmd !== startYmd ? ' – ' + nice(endYmd) : ''));
    } catch (e) { toast('Could not move it: ' + ((e && e.message) || e)); }
    rs.redraw = false;
    await rsReloadUser(userKey);
    rsDraw();
  }
  // After a drag: a bar at the bottom of the view with Undo, for 15 seconds (or until the next drag / closing the view).
  function rsUndoHide() { clearTimeout(rs.undoTimer); rs.undo = null; const el = document.querySelector('#uxa-rs .uxa-rs-undo'); if (el) el.remove(); }
  function rsUndoShow(u, text) {
    const root = document.getElementById('uxa-rs'); if (!root) return;
    rsUndoHide(); rs.undo = u;
    const el = document.createElement('div'); el.className = 'uxa-rs-undo'; el.setAttribute('role', 'status');
    el.innerHTML = '<span></span><button type="button" data-act="undo">Undo</button><button type="button" data-act="undoX" title="Dismiss" aria-label="Dismiss">×</button>';
    el.firstChild.textContent = text;
    root.appendChild(el);
    rs.undoTimer = setTimeout(rsUndoHide, 15000);
  }
  async function rsUndoRun() {
    const u = rs.undo; if (!u || u.busy) return;
    u.busy = true; clearTimeout(rs.undoTimer);
    const el = document.querySelector('#uxa-rs .uxa-rs-undo'); if (el) { el.firstChild.textContent = 'Undoing…'; el.querySelectorAll('button').forEach(b => { b.disabled = true; }); }
    try { await restoreAssignmentDates(u.pk, u.tuk, u.before); rsUndoHide(); toast('Move undone'); }
    catch (e) { rsUndoHide(); toast('Could not undo: ' + ((e && e.message) || e)); }
    await rsReloadUser(u.userKey);
    rsDraw();
  }
  function rsSetWeek(d) { rs.week = rsMonday(d); rs.gen++; rsQueue(); rsDraw(); }
  function rsKey(e) { if (e.key === 'Escape' && rs.open) { e.stopPropagation(); if (rs.alloc) { if (!rs.alloc.busy) rsAllocClose(); } else if (rs.fmenu) { rs.fmenu = null; rsDrawPop(); } else rsClose(); } }
  function rsOpen() {
    if (rs.open) return;
    ensureRsStyle();
    rs.open = true; rs.gen++; rs.aid = aid();
    if (!rs.week) rs.week = rsMonday(new Date());
    const root = document.createElement('div'); root.id = 'uxa-rs';
    root.innerHTML = '<div class="uxa-rs-top"><span class="uxa-rs-title">Resource Schedule</span>'
      + '<button type="button" class="uxa-rs-b" data-act="prev" title="Previous week">‹</button><button type="button" class="uxa-rs-b" data-act="today">This week</button><button type="button" class="uxa-rs-b" data-act="next" title="Next week">›</button>'
      + '<span class="uxa-rs-week"></span>'
      + '<span class="uxa-rs-sp"></span><span class="uxa-rs-note" title="Each day shows hours against capacity (your Scheduling max hours per weekday). Past days show the time logged that day; today onward shows planned hours per day, the same way Workamajig’s staff tiles count them.">ⓘ</span>'
      + '<button type="button" class="uxa-rs-b uxa-rs-all" data-act="all" title="Collapse or expand every person\'s assignments">Collapse all</button>'
      + '<button type="button" class="uxa-rs-b" data-act="refresh" title="Reload this week">Refresh</button><button type="button" class="uxa-rs-b" data-act="close" title="Close (Esc)">✕ Close</button></div>'
      + '<div class="uxa-rs-bar2">'
      + '<input type="search" class="uxa-rs-q" placeholder="Search person, project or client" aria-label="Search person, project or client">'
      + '<span class="uxa-rs-fwrap"><button type="button" class="uxa-rs-b uxa-rs-fbtn" data-act="fopen" title="Filter by me, client, project, project owner, role or status">Filter</button><div class="uxa-rs-fpop" hidden></div></span>'
      + '<select class="uxa-rs-sel" data-sel="sort" aria-label="Sort people" title="Sort people"><option value="name">Sort: Name</option><option value="util">Sort: Most utilized</option><option value="avail">Sort: Most available</option><option value="hours">Sort: Most hours</option></select>'
      + '<select class="uxa-rs-sel" data-sel="span" aria-label="Weeks shown" title="Weeks shown side by side"><option value="2">2 weeks</option><option value="1">1 week</option></select>'
      + '<label class="uxa-rs-ck"><input type="checkbox" data-opt="plannedOnly">Planned hours only</label>'
      + '<label class="uxa-rs-ck"><input type="checkbox" data-opt="weekends">Weekends</label>'
      + '<label class="uxa-rs-ck" title="Add calendar meetings to today and future days. Workamajig answers this slowly (up to a minute per person), so it fills in gradually."><input type="checkbox" data-opt="meetings">Include meetings</label>'
      + '<label class="uxa-rs-ck uxa-rs-filter" title="Show only the people in your saved Scheduling Users filter"' + (rs.filterKeys ? '' : ' hidden') + '><input type="checkbox" data-opt="useFilter">My Scheduling filter</label>'
      + '<div class="uxa-rs-chips" hidden></div></div>'
      + '<div class="uxa-rs-body"></div>';
    root.querySelector('.uxa-rs-q').value = rs.q;
    root.querySelector('.uxa-rs-sel[data-sel="sort"]').value = rs.sort;
    root.querySelector('.uxa-rs-sel[data-sel="span"]').value = String(rs.span);
    root.querySelectorAll('input[data-opt]').forEach(c => { c.checked = !!rs[c.dataset.opt]; });
    root.addEventListener('click', e => {
      // A bar opens the task's card details right here (the same modal as the board); Cmd/Ctrl-click still opens the
      // assignment in a new tab.
      if (rs.justDragged) { rs.justDragged = false; e.preventDefault(); return; }   // the click that ends a drag
      const bar = e.target.closest('.uxa-rs-bar');
      if (bar) { if (plainClick(e) && Number(bar.dataset.pk) > 0 && Number(bar.dataset.task) > 0) { e.preventDefault(); openTaskModalDetached(bar.dataset.pk, bar.dataset.task, bar.dataset.tuk, bar.dataset.u); } return; }
      const el = e.target.closest('[data-act]');
      if (rs.fmenu && !e.target.closest('.uxa-rs-fwrap')) { rs.fmenu = null; rsDrawPop(); }   // click outside closes the menu
      if (!el) {
        return;
      }
      const act = el.dataset.act;
      if (act === 'close') rsClose();
      else if (act === 'undo') rsUndoRun();
      else if (act === 'undoX') rsUndoHide();
      else if (act === 'allocSave') rsAllocSave();
      else if (act === 'allocCancel') rsAllocClose();
      else if (act === 'fopen') { rs.fmenu = rs.fmenu ? null : 'root'; rsDrawPop(); }
      else if (act === 'fcat') { rs.fmenu = el.dataset.cat; rsDrawPop(); }
      else if (act === 'fback') { rs.fmenu = 'root'; rsDrawPop(); }
      else if (act === 'fme') { rs.f.me = !rs.f.me; rsDrawPop(); rsDraw(); }
      else if (act === 'fdel') { rs.f[el.dataset.cat].delete(el.dataset.val); rsDrawPop(); rsDraw(); }
      else if (act === 'fclear') { rs.f.me = false; RS_FCATS.forEach(c => rs.f[c[0]].clear()); rsDrawPop(); rsDraw(); }
      else if (act === 'all') { const ppl = rsPeople(), anyOpen = ppl.some(u => !rs.collapsed.has(u.UserKey)); ppl.forEach(u => { if (anyOpen) rs.collapsed.add(u.UserKey); else rs.collapsed.delete(u.UserKey); }); rsDraw(); }
      else if (act === 'prev') rsSetWeek(rsAdd(rs.week, -7));
      else if (act === 'next') rsSetWeek(rsAdd(rs.week, 7));
      else if (act === 'today') rsSetWeek(new Date());
      else if (act === 'refresh') { const wks = rsWeeks().map(w => rsIso(w) + '|'); for (const k of [...rs.data.keys()]) if (wks.some(p => k.indexOf(p) === 0)) rs.data.delete(k); rs.gen++; if (rs.staff && rs.staff.length) { rsQueue(); rsDraw(); } else { rs.staff = null; rsDraw(); rsLoadStaff(); } }
      else if (act === 'toggle') { const k = Number(el.dataset.u); if (rs.collapsed.has(k)) rs.collapsed.delete(k); else rs.collapsed.add(k); rsDraw(); }
    });
    root.addEventListener('input', e => {
      if (e.target.classList.contains('uxa-rs-q')) { rs.q = e.target.value.trim().toLowerCase(); rsDraw(); }
      else if (e.target.dataset && (e.target.dataset.al === 'hours' || e.target.dataset.al === 'start' || e.target.dataset.al === 'end')) rsAllocSum();
      else if (e.target.classList.contains('uxa-rs-pq')) {   // narrow the project list; a client name matches all its projects
        const v = e.target.value.trim().toLowerCase();
        root.querySelectorAll('.uxa-rs-plist optgroup').forEach(g => { const gHit = !v || g.label.toLowerCase().indexOf(v) >= 0; let any = false; [...g.children].forEach(o => { const show = gHit || o.textContent.toLowerCase().indexOf(v) >= 0; o.hidden = !show; if (show) any = true; }); g.hidden = !any; });
      }
      else if (e.target.classList.contains('uxa-rs-fq')) { const v = e.target.value.trim().toLowerCase(); root.querySelectorAll('.uxa-rs-fo').forEach(l => { l.style.display = !v || l.textContent.toLowerCase().indexOf(v) >= 0 ? '' : 'none'; }); }
    });
    root.addEventListener('change', e => {
      const ds = e.target.dataset || {};
      if (ds.al === 'pk') { rsAllocTasks(e.target.value); return; }
      if (ds.al === 'start' || ds.al === 'end' || ds.al === 'mode' || ds.al === 'hours') { rsAllocSum(); return; }
      if (ds.al === 'task') { const nb = root.querySelector('.uxa-rs-newtask'); nb.hidden = e.target.value !== 'new'; if (!nb.hidden) nb.querySelector('input').focus(); return; }
      if (ds.al) return;
      if (ds.fcat) { const set = rs.f[ds.fcat]; if (e.target.checked) { set.add(ds.fval); rs.fl[ds.fcat + '|' + ds.fval] = ds.flab; } else set.delete(ds.fval); rsDraw(); return; }   // (popover stays as is: keeps its scroll + search)
      if (ds.sel === 'sort') { rs.sort = e.target.value; rsDraw(); return; }
      if (ds.sel === 'span') { rs.span = e.target.value === '1' ? 1 : 2; rs.gen++; rsQueue(); rsDraw(); return; }
      const o = ds.opt; if (o) { rs[o] = e.target.checked; if (o === 'useFilter') rsQueue(); if (o === 'meetings') rsQueueCal(); rsDraw(); } });
    root.addEventListener('mousedown', e => { rsDragStart(e); if (!rs.drag) rsSelStart(e); });
    root.addEventListener('dragstart', e => { if (e.target.closest && e.target.closest('.uxa-rs-bar')) e.preventDefault(); });
    document.body.appendChild(root);
    document.addEventListener('keydown', rsKey, true);
    rsDraw();
    if (rs.staff && rs.staff.length) rsQueue(); else { rs.staff = null; rsLoadStaff(); }
  }
  function rsClose() {
    rs.open = false; rs.gen++; rs.alloc = null; rs.drag = null; clearTimeout(rs.undoTimer); rs.undo = null;
    if (board.detached) boardDetachEnd();
    document.removeEventListener('keydown', rsKey, true);
    const root = document.getElementById('uxa-rs'); if (root) root.remove();
  }
  // The Scheduling page's own header row (title, week picker, "+" / "…", then a spacer): our launcher sits at its
  // right-hand end, after the spacer.
  function rsHeader() {
    for (const pg of document.querySelectorAll('page.open')) {
      const h = pg.querySelector(':scope > header');
      if (h && h.querySelector('hgroup h1')) return h;
    }
    return null;
  }
  const RS_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1" y="2.5" width="9" height="2.3" rx="1.1" fill="currentColor"/><rect x="4" y="6.9" width="11" height="2.3" rx="1.1" fill="currentColor"/><rect x="1" y="11.3" width="7" height="2.3" rx="1.1" fill="currentColor"/></svg>';
  function resourceScheduleTick() {
    let btn = document.getElementById('uxa-rs-btn');
    if (!resourceScheduleOn()) { if (btn) btn.remove(); if (rs.open) rsClose(); return; }
    if (rs.open && (!document.getElementById('uxa-rs') || aid() !== rs.aid)) rsClose();   // removed from under us, or the user navigated away
    const tb = aid() === RS_AID ? rsHeader() : null;
    if (!tb) { if (btn) btn.remove(); return; }
    if (btn && tb.contains(btn)) return;
    if (btn) btn.remove();                                           // re-attach after a native header re-render
    ensureRsStyle();
    btn = document.createElement('button'); btn.id = 'uxa-rs-btn'; btn.type = 'button';
    btn.title = 'Open the team’s week as a timeline with capacity';
    btn.innerHTML = RS_ICON + '<span>Resource Schedule</span>';
    btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); rsOpen(); });
    const sp = tb.querySelector(':scope > .spacer');
    if (sp) sp.insertAdjacentElement('afterend', btn); else tb.appendChild(btn);
  }

  function tick() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      if (menu) closeMenu();
      if (btn) btn.style.display = 'none';
      handlePendingTask();
      handlePendingModal();
      if (aid() === 'projects.diary.add') handlePendingPost();
      if (aid() === 'projects.diary.reply') handlePendingReply();
      if (aid() === ASSIGN_AID) asg.reload = true;
    }
    assignmentPage();
    boardTick();
    panelDimTick();
    searchTick();
    timersTick();
    listStrikeTick();
    frozenShadowTick();
    nativeDescTick();
    ntaTick();
    gridCurrencyTick();
    budgetBarTick();
    timeStatusTick();
    editorStatusTick();
    expandAllTick();
    creativeFilterTick();
    noteBreaksTick();
    timeGroupTick();
    resourceScheduleTick();
  }
  function start() {
    if (window.__uxaT) return; // another instance is already handling this page; don't double-run
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('click', onNativeMenuClick, true);
    document.addEventListener('scroll', () => { if (btn && !menu) btn.style.display = 'none'; }, true);
    setInterval(tick, 500);
    tick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
