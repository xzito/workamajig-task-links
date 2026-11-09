// ==UserScript==
// @name         Workamajig Task Links
// @namespace    https://xzito.com/
// @version      0.17.0
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
  const VERSION = '0.27.1';
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

  // Open a screen the way Workamajig's own buttons do (Views.openPage), so it joins the app's page stack and the
  // browser Back button closes it again. Workamajig keeps its own stack and overrides Back to "close the top page";
  // a full page load (location.assign) bypasses that stack, and Back then lands on some other screen.
  function openApp(aidName, k, io) {
    try {
      if (window.Views && typeof Views.openPage === 'function' && typeof window.Action === 'function') {
        Views.openPage(io ? new Action(aidName, k, io) : new Action(aidName, k));
        return;
      }
    } catch (e) { console.warn('[wjl] openPage failed, falling back to a page load', e); }
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
  // The visible schedule row for a TaskKey (the page also has hidden template/gantt grids that reuse grid-row markup).
  function findTaskRow(tk) {
    const all = [...document.querySelectorAll(`grid-row.datarow[data-key="${tk}"]`)];
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return all.find(el => el.closest('#grdProjectSchedule') && vis(el)) || all.find(vis) || null;
  }

  function spotlight(row) {
    if (document.querySelector('.wjl-spot')) return;
    const mk = css => { const d = document.createElement('div'); d.className = 'wjl-spot'; d.style.cssText = 'position:fixed;z-index:99990;pointer-events:none;transition:opacity .4s;opacity:0;' + css; document.body.appendChild(d); return d; };
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
    m.querySelectorAll('.wjl-native').forEach(x => x.remove());
    const group = document.createElement('div');
    group.className = 'wjl-native';
    group.style.cssText = 'border-top:1px solid #e5e5e5;margin-top:4px;padding-top:8px';
    m.appendChild(group);
    // Match the menu's own button classes (spacing differs between menus), swapping in the link icon.
    const proto = m.querySelector('button:not(.wjl-native button)');
    const baseCls = proto ? [...proto.classList].filter(c => !/^i-/.test(c) && c !== 'bound').join(' ') : 'btn-std icon-l text';
    const dismiss = () => {
      const dlg = m.closest('dialog');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      setTimeout(() => { if (dlg && dlg.offsetParent) document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); }, 50);
    };
    const note = text => { const d = document.createElement('div'); d.style.cssText = 'font-size:11px;color:#999;padding:2px 0 6px 28px'; d.textContent = text; group.appendChild(d); return d; };
    const add = (label, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = baseCls + ' i-link';
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
        '#desktop > section > page.wide > header{min-height:90px;padding-top:18px;padding-bottom:8px;box-sizing:border-box}' +
        '#desktop > section > page.wide > header hgroup{min-width:0;flex:1 1 auto}' +
        '#desktop > section > page.wide > header h1{max-width:none !important;white-space:normal !important;font-size:2.4rem !important;line-height:1.2 !important;margin-top:0 !important;overflow:visible !important}' +
        '#desktop > section > page.wide > header h5{white-space:normal !important;overflow:visible !important;position:static !important;display:block !important;margin-top:2px !important}' +
        '#wjl-hours{border-collapse:collapse;margin:2px 0 10px;font-size:12px;color:#555}' +
        '#wjl-hours th{font-weight:400;color:#999;text-align:right;padding:0 0 2px 14px}' +
        '#wjl-hours th:first-child{text-align:left;padding-left:0}' +
        '#wjl-hours td{padding:1px 0 1px 14px;text-align:right;white-space:nowrap}' +
        '#wjl-hours td:first-child{text-align:left;padding-left:0;color:#333}';
    }
    if (on && !wideStyle.isConnected) document.head.appendChild(wideStyle);
    if (!on && wideStyle.isConnected) wideStyle.remove();
    asgLayoutStyle(on && asgLayoutOn());
    if (!on) { asg.tabFixed = false; return; }

    const key = qs().get('k');
    assignmentLinks(key);
    if (key && asgLayoutOn()) getAssignment(key).then(a => { if (a.taskKey && aid() === ASSIGN_AID && qs().get('k') === key) asgLayout(a); }).catch(() => {});
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

  // Small action row under the assignment title: open the task in its schedule, copy task / assignment links.
  function assignmentLinks(key) {
    const hg = document.querySelector('page.open[data-aid="projects.production.assignment"] > header hgroup');
    if (!key || !hg || hg.querySelector('#wjl-asglinks')) return;
    const host = document.createElement('div');
    host.id = 'wjl-asglinks';
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
        // Update the page's own model so its "% complete" button and anything bound to it refresh.
        const pc = await serverPercComp(tuk);
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
    if (!sec || sec.querySelector('#wjl-nodesc')) return;
    const anchor = sec.querySelector('div.pad-t-l') || sec.firstElementChild;
    const host = document.createElement('div');
    host.id = 'wjl-nodesc';
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
          <textarea placeholder="Goal, scope, inputs and links, and what done looks like…"></textarea>
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
    const card = $('.card'), ta = $('textarea'), save = $('.save'), cancel = $('.cancel'), msg = $('.msg'), ask = $('.ask'), add = $('.add');
    const show = editing => {
      card.classList.toggle('editing', editing);
      root.querySelectorAll('.view').forEach(e => (e.hidden = editing));
      root.querySelectorAll('.edit').forEach(e => (e.hidden = !editing));
      $('.title').textContent = editing ? 'Add a task description' : 'This task has no description';
    };
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, innerHeight * 0.5) + 'px'; };

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
    add.addEventListener('click', () => { show(true); msg.textContent = ''; grow(); ta.focus(); });
    cancel.addEventListener('click', () => { show(false); });
    $('.outline').addEventListener('click', () => {
      const outline = 'Goal:\n\nScope (in / out):\n\nInputs and links:\n\nDone when:\n';
      ta.value = ta.value.trim() ? ta.value.replace(/\s*$/, '\n\n') + outline : outline;
      grow(); ta.focus();
      const at = ta.value.lastIndexOf('Goal:\n') + 6; ta.setSelectionRange(at, at);
    });
    ta.addEventListener('input', grow);
    // Keep the app's own shortcuts from firing while typing here.
    ['keydown', 'keyup', 'keypress'].forEach(t => ta.addEventListener(t, e => {
      e.stopPropagation();
      if (t !== 'keydown') return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }
    }));
    save.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text) { msg.className = 'msg err'; msg.textContent = 'Type a description first.'; ta.focus(); return; }
      save.disabled = cancel.disabled = ta.disabled = true; save.textContent = 'Saving…'; msg.className = 'msg'; msg.textContent = '';
      try {
        await saveTaskDescription(a.projectKey, a.taskKey, text);
        host.remove();
        showDescription(sec, text);
        assignmentCache.delete(Number(a.taskUserKey));
        toast('Description saved');
      } catch (e) {
        save.disabled = cancel.disabled = ta.disabled = false; save.textContent = 'Save description';
        msg.className = 'msg err';
        msg.textContent = 'Could not save: ' + (e && e.message || e) + '. You can still add it in the Schedule.';
      }
    });
    anchor ? anchor.insertAdjacentElement('beforebegin', host) : sec.appendChild(host);
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
  async function saveTaskDescription(projectKey, taskKey, text, expected) {
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

  // ---------- Assignment page layout: description + conversation in the main column, to-dos in a right rail ----------
  // Workamajig's own side column moves to the right (CSS order only) and loses the donut charts; the To Do List and
  // Conversations tabs are hidden because both now show inline. Everything we add is a Shadow DOM host.
  // "Classic layout" in the action row turns it off (remembered per browser).
  const ASG_LAYOUT_PREF = 'wjl.asgLayout';
  const SS_REPLY = 'wjl.pendingReply';
  const asgLayoutOn = () => { try { return localStorage.getItem(ASG_LAYOUT_PREF) !== 'classic'; } catch (e) { return true; } };
  const setAsgLayout = on => { try { localStorage.setItem(ASG_LAYOUT_PREF, on ? 'new' : 'classic'); } catch (e) {} };
  const ASG = 'page.open[data-aid="projects.production.assignment"]';
  const asg = { reload: false };
  let asgStyle;
  function asgLayoutStyle(on) {
    if (!asgStyle) {
      asgStyle = document.createElement('style');
      asgStyle.id = 'wjl-asg2';
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
    pg.querySelectorAll('#wjl-asgtodo, #wjl-asgconv').forEach(h => { if (h.dataset.tk !== String(a.taskKey)) h.remove(); });
    // Workamajig's side column stays on the left; to-dos get their own rail on the right of the page.
    const body = pg.querySelector(':scope > section > page-body');
    let rail = pg.querySelector(':scope > section > #wjl-asgrail');
    if (body && !rail) {
      rail = document.createElement('aside');
      rail.id = 'wjl-asgrail';
      rail.style.cssText = 'display:block;flex:none;width:300px;box-sizing:border-box;border-left:1px solid #ececec;background:#fafafa;padding:20px 18px;overflow:auto';
      body.insertAdjacentElement('afterend', rail);
    }
    if (rail && !rail.querySelector('#wjl-asgtodo')) rail.appendChild(asgTodoHost(a));
    const sec = pg.querySelector('[data-bind-visible="dp@section == \'desc\'"]');
    let conv = sec && sec.querySelector('#wjl-asgconv');
    if (sec && !conv) {
      conv = asgConvHost(a);
      const pd = sec.querySelector(':scope > div.pad-t-l');
      pd ? pd.insertAdjacentElement('beforebegin', conv) : sec.appendChild(conv);
    } else if (conv && asg.reload) {
      // Back from a reply or new post: show it.
      conv.wjlLoad && conv.wjlLoad();
      const td = pg.querySelector('#wjl-asgtodo'); td && td.wjlLoad && td.wjlLoad();
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
    host.id = 'wjl-asgtodo';
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
    host.wjlLoad = load;
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
  function asgConvHost(a) {
    const host = document.createElement('div');
    host.id = 'wjl-asgconv';
    host.dataset.tk = String(a.taskKey);
    host.style.cssText = 'display:block;margin:8px 0 28px;max-width:920px';
    const root = host.attachShadow({ mode: 'open' });
    const st = { posts: null, err: '', open: new Set(), more: new Set(), drafts: {} };
    root.innerHTML = `<style>${SHADOW_BASE}
      :host { font-size: 13px; }
      .top { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; }
      .top h2 { font-size: 20px; font-weight: 500; color: #333; margin: 0; }
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
    };
    host.wjlLoad = load;

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
        return `<div class="thread"><div class="subj"><span class="s">${esc(t.subject)}</span>${t.items.length > 1 ? `<span class="count">${t.items.length}</span>` : ''}<a class="link open" data-rk="${t.rk}" href="${BASE}?aid=projects.diary.thread&k=${t.rk}">Open thread</a></div>
          ${msgHtml(items[0])}
          ${hidden ? `<div class="earlier"><button type="button" class="link moreb" data-rk="${t.rk}">Show ${hidden} earlier repl${hidden > 1 ? 'ies' : 'y'}</button></div>` : ''}
          ${items.slice(1).map(msgHtml).join('')}
          <div class="reply"><textarea rows="1" data-root="${t.rk}" placeholder="Write a reply"></textarea><button type="button" class="btn rbtn" data-rk="${t.rk}">Reply</button></div>
          <div class="hint">Opens Workamajig's reply screen with your text and the usual recipients; press Post Reply there.</div></div>`;
      }).join('');
      root.querySelectorAll('textarea[data-root]').forEach(t => { t.value = st.drafts[t.dataset.root] || ''; });
    };

    root.addEventListener('error', e => { if (e.target.tagName === 'IMG' && e.target.parentElement && e.target.parentElement.classList.contains('av')) e.target.remove(); }, true);
    root.addEventListener('input', e => {
      if (e.target.tagName === 'TEXTAREA') { const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 240) + 'px'; }
    });
    root.addEventListener('click', e => {
      const t = e.target;
      if (t.classList.contains('tog')) { const k = Number(t.dataset.k); st.open.has(k) ? st.open.delete(k) : st.open.add(k); return render(); }
      if (t.classList.contains('moreb')) { st.more.add(Number(t.dataset.rk)); return render(); }
      if (t.classList.contains('newpost')) { openApp('projects.diary.add', a.projectKey, { taskKey: a.taskKey }); return; }
      if (t.classList.contains('open') && t.dataset.rk && plainClick(e)) { e.preventDefault(); openApp('projects.diary.thread', Number(t.dataset.rk)); return; }
      if (t.classList.contains('rbtn')) {
        const rk = Number(t.dataset.rk);
        const ta = root.querySelector(`textarea[data-root="${rk}"]`);
        const text = (ta && ta.value || '').trim();
        if (text) { try { sessionStorage.setItem(SS_REPLY, JSON.stringify({ parent: rk, text, ts: Date.now() })); } catch (err) {} }
        st.drafts[rk] = '';
        openApp('projects.diary.reply', rk);
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
        toast('Reply prefilled. Check the recipients, then Post Reply');
      };
      setTimeout(put, 150);
    }, 250);
  }

  // ---------- Project board (kanban) on the Schedule ----------
  // One card per assignment (status lives on the assignment, not the task). Drawn as a fixed overlay over the
  // schedule grid inside a Shadow DOM; the grid itself is never touched. Status changes use the same single-row
  // call as the Today board (WJAPP.Modules.Project.Traffic.updateAssignmentStatus).
  const BOARD_PREF = 'wjl.boardMode';
  const COMPLETED_KEY = 1048;
  const STATUS_COLORS = { 'Backlog': '#C2C2C2', 'Ready': '#B3DC6C', 'In Progress': '#16A765', 'Ready for Review/Blocked': '#F83A22', 'Completed': '#A47AE2' };
  const FALLBACK_COLORS = ['#7aa7d9', '#e0a82e', '#d07ad9', '#5cc2c2', '#9b9b9b'];
  const board = { on: false, host: null, root: null, toggle: null, projectKey: null, data: null, user: 0, search: '',
    showCompleted: false, timer: null, dirty: false, drag: null, seq: 0 };
  const COLLAPSE_PREF = 'wjl.boardCollapsed';
  board.collapsed = (() => { try { return JSON.parse(localStorage.getItem(COLLAPSE_PREF) || '{}') || {}; } catch (e) { return {}; } })();
  const saveCollapsed = () => { try { localStorage.setItem(COLLAPSE_PREF, JSON.stringify(board.collapsed)); } catch (e) {} };
  // Completed starts collapsed; every other column starts open. Choices are remembered by column name.
  const isCollapsed = name => (name in board.collapsed ? !!board.collapsed[name] : name === 'Completed');
  const showDone = () => !isCollapsed('Completed');
  const boardPref = () => { try { return localStorage.getItem(BOARD_PREF) === '1'; } catch (e) { return false; } };
  const setBoardPref = v => { try { localStorage.setItem(BOARD_PREF, v ? '1' : '0'); } catch (e) {} };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Topmost Schedule page: "Open in schedule" from an assignment can stack a second copy on top of the first.
  const schedulePage = () => { const all = document.querySelectorAll('page.open[data-aid="projects.schedule.edit2"]'); return all[all.length - 1] || null; };
  const inSchedule = sel => { const pg = schedulePage(); return pg && pg.querySelector(sel); };

  function boardTick() {
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
    host.id = 'wjl-board-seg';
    host.style.cssText = 'display:inline-flex;align-self:center;vertical-align:middle;margin-right:12px;flex:none';
    const r = host.attachShadow({ mode: 'open' });
    r.innerHTML = `<style>
      :host { all: initial; font-family: inherit; color-scheme: light; }
      * { box-sizing: border-box; font-family: inherit; }
      .seg { display: inline-flex; border: 1px solid #cfcfcf; border-radius: 8px; overflow: hidden; background: #fff; }
      button { font: inherit; font-size: 12px; padding: 7px 14px; border: 0; background: #fff; color: #444; cursor: pointer; line-height: 1; }
      button + button { border-left: 1px solid #cfcfcf; }
      button.on { background: #333; color: #fff; font-weight: 600; }
    </style><div class="seg" title="Switch between the schedule list and a status board"><button type="button" class="list">List</button><button type="button" class="board">Board</button></div>`;
    r.querySelector('.list').addEventListener('click', () => { setBoardPref(false); closeBoard(); });
    r.querySelector('.board').addEventListener('click', () => { setBoardPref(true); closeListHygiene(); openBoard(); });
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
    host.id = 'wjl-board-toggle';
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
      .fchip { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; font-size: 12px; font-weight: 600; color: #0c447c; background: #e6f1fb; border: 1px solid #85b7eb; border-radius: 8px; padding: 0 0 0 10px; }
      .fchip .fh { font-weight: 400; color: #4a6f94; }
      .fchip .fx { border: 0; border-left: 1px solid #85b7eb; border-radius: 0 7px 7px 0; background: #fff; color: #0c447c; font-weight: 600; }
      .fchip .fx:hover { background: #f0f6fc; }
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
    r.querySelector('.fslot').addEventListener('click', e => { if (e.target.classList.contains('fx')) clearListFilter(); });
    r.querySelector('.conv').addEventListener('click', () => (listHyg.open === 'conv' ? closeListHygiene() : openListHygiene('conv')));
    // The menu lives in its own layer on <body>: inside the page, an ancestor turns position:fixed into
    // "relative to the page panel", which pushed the menu down and clipped it at the panel's right edge.
    if (board.hygMenu) board.hygMenu.remove();
    const mh = document.createElement('div');
    mh.id = 'wjl-hyg-menu';
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
      const rows = m.cards.filter(c => !c.done && h.card(c)).map(c => ({ taskKey: c.taskKey, taskId: c.taskId, taskName: c.taskName, group: c.group, order: c.order, who: c.userKey > 0 ? c.user : 'Empty assignment slot' }))
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
    menu.innerHTML = `<div class="htitle">Filter the list to open work that has…</div>` + HYGIENE.map(h => {
      const n = per[h.key].length;
      return `<button type="button" class="hrow ${act === h.key ? 'act' : ''}" data-k="${h.key}" ${n ? '' : 'disabled'}><span class="caret">${act === h.key ? '✓' : ''}</span><span class="hl">${h.label}<small>${h.hint}</small></span><span class="hc">${n}</span></button>`;
    }).join('') + `<div class="hfoot">${act ? '<button type="button" class="fx2">Clear filter</button>' : 'Click an issue to show only those tasks.'}</div>`;
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
    if (!fo.wjlWrap || fo.f !== fo.wjlWrap) {
      const orig = fo.f;
      fo.wjlOrig = orig;
      fo.wjlWrap = function (item, idx, src) {
        const ok = orig.call(this, item, idx, src);
        return ok && (!fo.wjlKeys || fo.wjlKeys.has(item.TaskKey));
      };
      fo.f = fo.wjlWrap;
    }
    return true;
  }
  function applyListFilter(kind, key, label, leafKeys) {
    const ds = scheduleDs();
    if (!ds || !installFilterWrap(ds)) { toast('Could not filter the list on this page'); return; }
    const src = ds.source || [];
    const byKey = new Map(src.map(t => [t.TaskKey, t]));
    const keys = new Set();
    leafKeys.forEach(k => { let x = byKey.get(k); while (x && !keys.has(x.TaskKey)) { keys.add(x.TaskKey); x = byKey.get(x.SummaryTaskKey); } });
    ds.options.filter.wjlKeys = keys;
    listFilter = { kind, key, label, leaf: new Set(leafKeys), ds };
    ds.refresh(true);
    closeListHygiene();
    renderListHygiene();
  }
  function clearListFilter() {
    const lf = listFilter; listFilter = null;
    if (lf && lf.ds && lf.ds.options && lf.ds.options.filter) { lf.ds.options.filter.wjlKeys = null; try { lf.ds.refresh(true); } catch (e) {} }
    renderListHygiene();
  }
  // Drop the filter if its page went away; re-wrap if the app rebuilt its filter (e.g. after a settings reload).
  function checkListFilter() {
    if (!listFilter) return;
    const ds = scheduleDs();
    if (!ds || ds !== listFilter.ds) { listFilter = null; renderListHygiene(); return; }
    const fo = ds.options && ds.options.filter;
    if (fo && fo.f !== fo.wjlWrap) { const keys = fo.wjlKeys; installFilterWrap(ds); fo.wjlKeys = keys || null; if (!fo.wjlKeys) { listFilter = null; renderListHygiene(); } else ds.refresh(true); }
  }
  // "Showing …" chip: how many matching tasks are visible, and how many Hide Completed Tasks keeps hidden.
  function listFilterSummary() {
    if (!listFilter) return '';
    const ds = listFilter.ds, pg = schedulePage();
    const m = pg && pg.view && pg.view.module && pg.view.module.model;
    const hide = !!(m && m.searchTasks && m.searchTasks.si && Number(m.searchTasks.si.hideCompleted) === 1);
    const byKey = new Map((ds.source || []).map(t => [t.TaskKey, t]));
    const leaf = [...listFilter.leaf].filter(k => byKey.has(k));
    const hidden = hide ? leaf.filter(k => +byKey.get(k).PercComp >= 100).length : 0;
    const shown = leaf.length - hidden;
    const tip = `Only these tasks are shown in the list.${hidden ? ` ${hidden} more match but are completed, and Hide Completed Tasks is on.` : ''}`;
    return `<span class="fchip" title="${esc(tip)}">${esc(listFilter.label)} · ${shown}${hidden ? ` <span class="fh">+${hidden} hidden</span>` : ''}<button type="button" class="fx" title="Show all tasks again">Clear</button></span>`;
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
      s.querySelector('.board').classList.toggle('on', board.on);
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
    let st = document.getElementById('wjl-board-hide');
    if (!st) {
      st = document.createElement('style');
      st.id = 'wjl-board-hide';
      document.head.appendChild(st);
    }
    st.textContent = hidden
      ? 'page.open[data-aid="projects.schedule.edit2"] button[data-action="toggleGantt"],page.open[data-aid="projects.schedule.edit2"] button[data-action="toggleTemplates"],page.open[data-aid="projects.schedule.edit2"] button[data-action="toggleSide"],page.open[data-aid="projects.schedule.edit2"] div.input-control.lookup:has(> input[data-source="colSets"]){display:none!important}'
      : '';
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
    const h = r.height > 150 ? r.height : innerHeight - r.top - 8;
    Object.assign(board.host.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: Math.max(220, h) + 'px' });
  }

  function buildBoardHost() {
    const host = document.createElement('div');
    host.id = 'wjl-board';
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
      .fsum { flex-basis: 100%; font-size: 12px; color: #6b4b00; background: #fff8e5; border: 1px solid #f0d9a0; border-radius: 6px; padding: 5px 10px; }
      .fsum .mlink { border: 0; background: none; padding: 0; margin-left: 8px; color: #1a8fbf; font: inherit; font-size: 12px; cursor: pointer; text-decoration: underline; }
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
      .b.cvb { background: #eeedfe; color: #3c3489; }
      .b.cvb.unread { background: #534ab7; color: #fff; }
      .icon { border: 1px solid #ddd; background: #fff; border-radius: 6px; padding: 5px 9px; cursor: pointer; font-size: 13px; color: #555; }
      .cols { flex: 1; display: flex; gap: 12px; overflow-x: auto; overflow-y: hidden; padding: 12px 2px 4px; }
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
      .mbtn { font: inherit; font-size: 13px; padding: 8px 14px; border-radius: 8px; border: 1px solid #d0d0d0; background: #fff; color: #333; cursor: pointer; }
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
      if (!board.modal) return;
      if (e.key === 'Enter' && e.target && e.target.classList && e.target.classList.contains('tdnew')) { e.preventDefault(); addTodo(); return; }
      if (e.key === 'Escape') { e.preventDefault(); if (board.modal.editing) { board.modal.editing = false; renderModal(); } else closeModal(); }
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
    root.addEventListener('change', e => { if (e.target.classList.contains('hchk')) { const k = e.target.dataset.k; if (e.target.checked) board.hyg.add(k); else board.hyg.delete(k); renderBoard(); return; } if (e.target.classList.contains('showc')) { board.collapsed['Completed'] = !e.target.checked; saveCollapsed(); renderBoard(); return; } if (e.target.classList.contains('onlytd')) { board.onlyTodos = e.target.checked; renderBoard(); return; } if (e.target.classList.contains('onlycv')) { board.onlyConv = e.target.checked; renderBoard(); } });
    // Mouse-driven drag (native HTML5 drag on links drags the URL instead, and is unreliable inside shadow roots).
    root.addEventListener('dragstart', e => e.preventDefault());
    root.addEventListener('mousedown', onCardMouseDown);
    document.body.appendChild(host);
    board.host = host; board.root = root;
  }

  async function loadBoard() {
    const pk = board.projectKey, seq = ++board.seq;
    if (!board.data) board.root.querySelector('.cols').innerHTML = '<div class="msg">Loading board…</div>';
    scheduleCache.delete(String(pk));
    try {
      const s = await getSchedule(pk);
      if (seq !== board.seq || pk !== board.projectKey) return;
      board.data = s.raw;
      board.todos = null; board.todosFor = null;
      renderBoard();
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
  // Counts over the whole project's open work: per issue, and items with at least one issue.
  function hygieneCounts(m) {
    const items = m.cards.filter(c => !c.done).map(c => issuesOf(c, false)).concat(m.unassigned.map(t => issuesOf(t, true)));
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
      const dueRaw = tu.APlanComplete || t.PlanComplete;
      const due = dueRaw ? new Date(String(dueRaw).slice(0, 10) + 'T00:00:00') : null;
      const days = due ? Math.round((due - today) / 864e5) : null;
      return { tuk: tu.TaskUserKey, taskKey: tu.TaskKey, status, done, user: (tu.UserName || '').trim(), userKey: tu.UserKey || -1,
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

  function renderBoard() {
    if (!board.root || !board.data) return;
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
      ${(() => { const hc = hygieneCounts(m); board.hygCounts = hc; return `<span class="hwrap"><button type="button" class="icon hyg ${board.hyg.size ? 'on' : ''}" title="Project hygiene: find open work with problems">Hygiene <span class="n">${hc.total}</span> ▾</button>${board.hygOpen ? `<div class="hmenu">
        <div class="htitle">Show open work that has…</div>
        ${HYGIENE.map(h => `<label class="hrow"><input type="checkbox" class="hchk" data-k="${h.key}" ${board.hyg.has(h.key) ? 'checked' : ''}><span class="hl">${h.label}<small>${h.hint}</small></span><span class="hc">${hc.per[h.key]}</span></label>`).join('')}
        <div class="hfoot"><button type="button" class="mlink hall">Any issue</button><button type="button" class="mlink hnone">Clear</button></div></div>` : ''}</span>`; })()}
      <button type="button" class="icon refresh" style="margin-left:auto" title="Reload from Workamajig">↻</button>
      ${(() => {
        const parts = [];
        if (board.user) { const p = people.get(board.user); parts.push(esc(p ? p.name : 'one person')); }
        if (board.hyg.size) parts.push(HYGIENE.filter(h => board.hyg.has(h.key)).map(h => h.label.toLowerCase()).join(' or '));
        if (q) parts.push('matching “' + esc(board.search.trim()) + '”');
        if (board.onlyTodos) parts.push('tasks with open to-dos');
        if (board.onlyConv) parts.push('tasks with conversations');
        return parts.length ? `<div class="fsum">Filtered: showing ${parts.join(' · ')} <button type="button" class="mlink fclear">Clear filters</button></div>` : '';
      })()}`;
    board.model = m;
    renderColumns();
    if (board.modal) renderModal();
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
    if (t.classList.contains('chip')) { board.user = Number(t.dataset.user); renderBoard(); return; }
    if (t.closest && t.closest('.chip')) { board.user = Number(t.closest('.chip').dataset.user); renderBoard(); return; }
    if (t.classList.contains('refresh')) { loadBoard(); return; }
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
  }

  // ---- card details modal ----
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && board.modal && board.on) { e.stopPropagation(); if (board.modal.editing) { board.modal.editing = false; renderModal(); } else closeModal(); } }, true);
  function openModal(ref) { board.modal = { ref, editing: false, draft: '', msg: '' }; board.host.style.zIndex = '40'; renderModal(); }
  function closeModal() { board.modal = null; if (board.host) board.host.style.zIndex = '10'; const bg = board.root && board.root.querySelector('.mbg'); if (bg) bg.remove(); }
  const linkify = txt => esc(txt).replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  const fmtDate = d => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  function renderModal() {
    const st = board.modal; if (!st || !board.data) return;
    const old = board.root.querySelector('.mbg');
    if (old) { const ta = old.querySelector('textarea.mta'); if (ta) st.draft = ta.value; const ti = old.querySelector('.tdnew'); if (ti) st.tdDraft = ti.value; }
    const raw = board.data, ref = st.ref;
    const t = (raw.tasks || []).find(x => x.TaskKey === ref.taskKey) || {};
    const tu = ref.tuk ? (raw.projectTaskUserData || []).find(x => x.TaskUserKey === ref.tuk) : null;
    const others = (raw.projectTaskUserData || []).filter(x => x.TaskKey === ref.taskKey && x.TaskUserKey !== ref.tuk);
    const statuses = raw.taskUserStatus || [];
    const color = tu ? (STATUS_COLORS[tu.StatusName] || '#d6d6d6') : '#9b9b9b';
    const desc = (t.Description || '').replace(/<[^>]*>/g, '').trim();
    const canEdit = !!(window.System && System.rights && System.rights.prjedittasks);
    const planned = tu ? +tu.Hours || 0 : 0, actual = tu ? +tu.ActualHours || 0 : 0;
    const statusSel = tu ? `<select class="mstatus" style="--c:${color}">${tu.TaskUserStatusKey > 0 ? '' : '<option value="0" selected>No status</option>'}${statuses.map(x => `<option value="${x.k}" ${x.k === tu.TaskUserStatusKey ? 'selected' : ''}>${esc(x.l)}</option>`).join('')}</select>` : '<span class="b">Not assigned</span>';
    const descHtml = st.editing
      ? `<textarea class="mta" placeholder="Goal, scope, inputs and links, and what done looks like…">${esc(st.draft)}</textarea>
         <div class="mrow"><button type="button" class="mbtn primary msave">Save description</button><button type="button" class="mbtn mcancel">Cancel</button><span class="mhint">⌘/Ctrl + Enter to save</span></div>`
      : desc ? `<div class="mdesc">${linkify(desc)}</div>${canEdit ? '<div class="mrow"><button type="button" class="mlink medit">Edit description</button></div>' : ''}`
      : `<div class="mnodesc">No description yet.${canEdit ? ' <button type="button" class="mlink madd">Add one</button>' : ''} <button type="button" class="mlink mask">Request details in a conversation</button></div>`;
    const todoHtml = renderTodoPanel(ref.taskKey, st);
    const people = others.map(o => `<div class="mp">${avatarHtml(o.UserKey || -1, o.UserName, o.Initials)}<span>${esc((o.UserName || 'Unassigned slot').trim())}<small>${esc(o.StatusName || 'No status')}</small></span></div>`).join('');
    const html = `<div class="mbg"><div class="modal" role="dialog" aria-modal="true" style="--c:${color}">
      <div class="mhead"><div class="mtop"><span class="id">${esc(t.TaskID || '')}</span><span class="grp">${esc(t.SummaryTaskName || '')}</span></div>
        <button type="button" class="mx" title="Close (Esc)">×</button>
        <h2 class="mtitle">${esc(t.TaskName || '(task)')}</h2>
        <div class="mstat">${statusSel}${tu && +tu.PercComp ? `<span class="b">${+tu.PercComp}% complete</span>` : ''}</div></div>
      <div class="mcols"><div class="mbody">
        <div class="mgrid">
          ${tu ? `<div><label>Assignee</label><div class="mp">${avatarHtml(tu.UserKey || -1, tu.UserName, tu.Initials)}<span>${esc((tu.UserName || 'Unassigned slot').trim())}<small>${esc(tu.ServiceDescription || '')}</small></span></div></div>` : ''}
          <div><label>Due</label><div>${fmtDate((tu && tu.APlanComplete) || t.PlanComplete)}</div></div>
          <div><label>Planned</label><div>${fmtDate(t.PlanStart)} → ${fmtDate(t.PlanComplete)}</div></div>
          ${tu ? `<div><label>Hours</label><div class="${planned && actual > planned ? 'over' : ''}">${fmtH(actual)} logged of ${fmtH(planned)} planned</div></div>` : ''}
        </div>
        <label>Task description</label>${descHtml}
        ${st.msg ? `<div class="mmsg">${esc(st.msg)}</div>` : ''}
        ${people ? `<label>Also on this task</label><div class="mpeople">${people}</div>` : ''}
      </div>${todoHtml}</div>
      <div class="mfoot">
        ${tu ? `<button type="button" class="mbtn primary mopen">Open full assignment</button>` : ''}
        ${canEdit ? `<button type="button" class="mbtn ${tu ? '' : 'primary'} massign">${tu ? 'Manage assignees' : 'Assign people'}</button>` : ''}
        <button type="button" class="mbtn mlist">Show in list</button>
        <span class="spacer"></span>
        <button type="button" class="mbtn mcopyt">Copy task link</button>
        ${tu ? `<button type="button" class="mbtn mcopya">Copy assignment link</button>` : ''}
      </div></div></div>`;
    if (old) old.outerHTML = html; else board.root.querySelector('.wrap').insertAdjacentHTML('beforeend', html);
    const ta = board.root.querySelector('.mta');
    if (ta && st.editing) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
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
    catch (e) { console.warn('[wjl] conversations', e); }
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
    const t = e.target, st = board.modal; if (!st) return;
    const ref = st.ref;
    if (t.classList.contains('mbg') || t.classList.contains('mx')) { closeModal(); return; }
    if (t.classList.contains('tdplus')) { addTodo(); return; }
    if (t.classList.contains('tddel')) { deleteTodo(Number(t.dataset.k)); return; }
    if (t.classList.contains('tdtoggle')) { st.showDoneTodos = !st.showDoneTodos; renderModal(); return; }
    if (t.classList.contains('tdchk')) { toggleTodo(Number(t.dataset.k), t.checked); return; }
    if (t.closest('a[href]')) return; // links in the description
    const tu = ref.tuk ? (board.data.projectTaskUserData || []).find(x => x.TaskUserKey === ref.tuk) : null;
    const task = (board.data.tasks || []).find(x => x.TaskKey === ref.taskKey) || {};
    if (t.classList.contains('mopen')) { closeModal(); openApp(ASSIGN_AID, ref.tuk); return; }
    if (t.classList.contains('mlist')) { closeModal(); showInList(ref.taskKey); return; }
    if (t.classList.contains('massign')) { closeModal(); openNativeAssign(ref.taskKey); return; }
    if (t.classList.contains('mcopyt')) { copy(urls.task(board.projectKey, ref.taskKey), 'task link'); return; }
    if (t.classList.contains('mcopya')) { copy(urls.assignment(ref.tuk), 'assignment link'); return; }
    if (t.classList.contains('madd')) { st.editing = true; st.draft = ''; st.base = ''; st.msg = ''; renderModal(); return; }
    if (t.classList.contains('medit')) { st.editing = true; st.base = task.Description || ''; st.draft = String(st.base).replace(/<[^>]*>/g, ''); st.msg = ''; renderModal(); return; }
    if (t.classList.contains('mcancel')) { st.editing = false; st.msg = ''; renderModal(); return; }
    if (t.classList.contains('mask')) {
      t.disabled = true; t.textContent = 'Opening a new post…';
      let pm = null; try { pm = await resolveProjectManager(board.projectKey); } catch (err) {}
      const req = { taskKey: ref.taskKey, projectKey: board.projectKey, taskName: task.TaskName || '', projectName: [task.ProjectName, task.CompanyName].filter(Boolean).join(' / '),
        taskUrl: urls.task(board.projectKey, ref.taskKey), assignmentUrl: ref.tuk ? urls.assignment(ref.tuk) : urls.task(board.projectKey, ref.taskKey), pm, ts: Date.now() };
      try { sessionStorage.setItem(SS_POST, JSON.stringify(req)); } catch (err) {}
      closeModal();
      openApp('projects.diary.add', Number(board.projectKey), { taskKey: ref.taskKey });
      return;
    }
    if (t.classList.contains('msave')) {
      const ta = board.root.querySelector('.mta'); const text = (ta && ta.value || '').trim();
      if (!text) { st.msg = 'Type a description first.'; st.draft = ''; renderModal(); return; }
      t.disabled = true; t.textContent = 'Saving…';
      try {
        await saveTaskDescription(board.projectKey, ref.taskKey, text, st.base || '');
        task.Description = text; st.editing = false; st.msg = ''; toast('Description saved');
      } catch (err) { st.msg = 'Could not save: ' + (err && err.message || err); st.draft = text; }
      renderBoard();
    }
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
    items.push(['Show in list', () => showInList(taskKey)]);
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
  function onCardMouseDown(e) {
    if (e.button !== 0) return;
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
      const pc = await serverPercComp(tuk); if (pc != null) tu.PercComp = pc;
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
      d.className = 'wjl-pdim';
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

  function tick() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      if (menu) closeMenu();
      if (btn) btn.style.display = 'none';
      handlePendingTask();
      if (aid() === 'projects.diary.add') handlePendingPost();
      if (aid() === 'projects.diary.reply') handlePendingReply();
      if (aid() === ASSIGN_AID) asg.reload = true;
    }
    assignmentPage();
    boardTick();
    panelDimTick();
  }
  function start() {
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('click', onNativeMenuClick, true);
    document.addEventListener('scroll', () => { if (btn && !menu) btn.style.display = 'none'; }, true);
    setInterval(tick, 500);
    tick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
