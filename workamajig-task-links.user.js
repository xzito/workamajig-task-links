// ==UserScript==
// @name         Workamajig Task Links
// @namespace    https://xzito.com/
// @version      0.10.0
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
  const VERSION = '0.10.0';
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


  function handlePendingTask() {
    let tk = null; try { tk = sessionStorage.getItem(SS_KEY); } catch (e) {}
    if (!tk || aid() !== 'projects.schedule.edit2') return;
    let tries = 0;
    const t = setInterval(() => {
      const row = findTaskRow(tk);
      if (row) {
        clearInterval(t); try { sessionStorage.removeItem(SS_KEY); } catch (e) {}
        row.scrollIntoView({ block: 'center' });
        setTimeout(() => spotlight(row), 400);
        // The app can still shift or reset scroll while it finishes loading; re-center if the row drifted out of view.
        [800, 1600].forEach(ms => setTimeout(() => {
          const el = findTaskRow(tk);
          if (!el) return;
          const r = el.getBoundingClientRect();
          if (r.top < 80 || r.bottom > innerHeight - 40) el.scrollIntoView({ block: 'center' });
        }, ms));
      } else if (++tries > 60) { clearInterval(t); try { sessionStorage.removeItem(SS_KEY); } catch (e) {} }
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
      location.assign(`${BASE}?aid=projects.diary.add&k=${a.projectKey}&io=${encodeURIComponent(JSON.stringify({ taskKey: a.taskKey }))}`);
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
  const boardPref = () => { try { return localStorage.getItem(BOARD_PREF) === '1'; } catch (e) { return false; } };
  const setBoardPref = v => { try { localStorage.setItem(BOARD_PREF, v ? '1' : '0'); } catch (e) {} };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const schedulePage = () => document.querySelector('page.open[data-aid="projects.schedule.edit2"]');

  function boardTick() {
    if (aid() !== 'projects.schedule.edit2') {
      if (board.on || board.host) closeBoard(true);
      return;
    }
    ensureBoardToggle();
    const pk = qs().get('k');
    if (board.on && board.projectKey !== pk) { closeBoard(true); }
    let pending = null; try { pending = sessionStorage.getItem(SS_KEY); } catch (e) {}
    if (!board.on && boardPref() && !pending && document.querySelector('page.open #grdProjectSchedule grid-row[data-key]')) openBoard();
  }

  function ensureBoardToggle() {
    if (board.toggle && board.toggle.isConnected) return;
    const anchor = document.querySelector('page.open[data-aid="projects.schedule.edit2"] button[data-action="toggleGantt"]');
    if (!anchor) return;
    const host = document.createElement('span');
    host.id = 'wjl-board-toggle';
    host.style.cssText = 'display:inline-flex;vertical-align:middle;margin-right:10px';
    const r = host.attachShadow({ mode: 'open' });
    r.innerHTML = `<style>
      :host { all: initial; font-family: inherit; color-scheme: light; }
      * { box-sizing: border-box; font-family: inherit; }
      .seg { display: inline-flex; border: 1px solid #cfcfcf; border-radius: 8px; overflow: hidden; background: #fff; }
      button { font: inherit; font-size: 12px; padding: 7px 12px; border: 0; background: #fff; color: #444; cursor: pointer; line-height: 1; }
      button + button { border-left: 1px solid #cfcfcf; }
      button.on { background: #333; color: #fff; font-weight: 600; }
    </style><div class="seg" title="Switch between the schedule list and a status board"><button type="button" class="list">List</button><button type="button" class="board">Board</button></div>`;
    r.querySelector('.list').addEventListener('click', () => { setBoardPref(false); closeBoard(); });
    r.querySelector('.board').addEventListener('click', () => { setBoardPref(true); openBoard(); });
    ['click', 'mousedown', 'keydown'].forEach(t => host.addEventListener(t, e => e.stopPropagation()));
    anchor.parentElement.insertBefore(host, anchor);
    board.toggle = host;
    syncToggle();
  }
  function syncToggle() {
    if (!board.toggle) return;
    const r = board.toggle.shadowRoot;
    r.querySelector('.list').classList.toggle('on', !board.on);
    r.querySelector('.board').classList.toggle('on', board.on);
  }

  function openBoard() {
    const pg = schedulePage();
    if (!pg) return;
    const pk = qs().get('k');
    if (board.projectKey !== pk) {
      board.user = 0; board.search = '';
      const hc = pg.querySelector('input[name="hideCompleted"]');
      board.showCompleted = hc ? !hc.checked : false;
    }
    board.on = true; board.projectKey = pk;
    syncToggle();
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
    clearInterval(board.timer);
    if (board.host) board.host.style.display = 'none';
    closeCardMenu();
    syncToggle();
    if (leaving) { board.projectKey = null; board.data = null; }
    // The list underneath still shows statuses from before; let the app reload them.
    if (wasOn && board.dirty && !leaving) {
      board.dirty = false;
      const rb = document.querySelector('page.open[data-aid="projects.schedule.edit2"] button[data-action="refreshData"]');
      if (rb) rb.click();
    }
  }

  function positionBoard() {
    if (!board.host) return;
    const grid = document.querySelector('page.open[data-aid="projects.schedule.edit2"] #grdProjectSchedule');
    const r = grid && grid.getBoundingClientRect();
    // Hide while another page or panel sits on top of the schedule.
    const pages = [...document.querySelectorAll('page.open')];
    const covered = pages.length > 1 && pages[pages.length - 1] !== schedulePage();
    if (!r || !r.width || covered) { board.host.style.visibility = 'hidden'; return; }
    board.host.style.visibility = 'visible';
    const h = r.height > 150 ? r.height : innerHeight - r.top - 8;
    Object.assign(board.host.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: Math.max(220, h) + 'px' });
  }

  function buildBoardHost() {
    const host = document.createElement('div');
    host.id = 'wjl-board';
    host.style.cssText = 'position:fixed;z-index:30;display:none';
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
      .icon { border: 1px solid #ddd; background: #fff; border-radius: 6px; padding: 5px 9px; cursor: pointer; font-size: 13px; color: #555; }
      .cols { flex: 1; display: flex; gap: 12px; overflow-x: auto; overflow-y: hidden; padding: 12px 2px 4px; }
      .col { flex: 0 0 280px; display: flex; flex-direction: column; border-radius: 10px; background: color-mix(in srgb, var(--c) 12%, #fff); min-height: 0; border: 2px solid transparent; transition: border-color .12s; }
      .col.collapsed { flex-basis: 52px; cursor: pointer; }
      .col.drop { border-color: var(--c); }
      .head { display: flex; align-items: center; gap: 6px; padding: 10px 10px 8px; border-bottom: 2px solid var(--c); }
      .pill { background: var(--c); color: #111; font-weight: 600; font-size: 12px; padding: 4px 12px; border-radius: 999px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .count { font-size: 11px; color: #666; background: rgba(0,0,0,.06); border-radius: 999px; padding: 1px 7px; }
      .hrs { margin-left: auto; font-size: 11px; color: #777; white-space: nowrap; }
      .col.collapsed .head { flex-direction: column; border-bottom: 0; height: 100%; padding: 10px 6px; }
      .col.collapsed .pill { writing-mode: vertical-rl; transform: rotate(180deg); padding: 12px 4px; }
      .col.collapsed .hrs, .col.collapsed .list { display: none; }
      .list { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
      .empty { color: #aaa; font-size: 12px; text-align: center; padding: 18px 6px; border: 1px dashed #d6d6d6; border-radius: 8px; }
      .card { display: block; text-decoration: none; color: inherit; background: #fff; border: 1px solid #e3e3e3; border-left: 4px solid var(--c); border-radius: 8px; padding: 10px 10px 8px; box-shadow: 0 1px 2px rgba(0,0,0,.05); cursor: grab; position: relative; }
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
      .who { min-width: 0; font-size: 12px; color: #444; line-height: 1.2; }
      .who small { display: block; color: #999; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .h { margin-left: auto; font-size: 11px; color: #666; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .h.over { color: #b3261e; }
      .more { position: absolute; top: 6px; right: 6px; border: 0; background: transparent; color: #999; cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 5px; border-radius: 5px; }
      .more:hover { background: #f0f0f0; color: #333; }
      .menu { position: fixed; z-index: 5; background: #fff; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.15); padding: 4px 0; min-width: 220px; }
      .menu button { display: block; width: 100%; text-align: left; background: none; border: 0; padding: 8px 14px; font: inherit; font-size: 13px; color: #333; cursor: pointer; }
      .menu button:hover { background: #f4f4f4; }
      .msg { padding: 30px; color: #888; text-align: center; }
      .msg.err { color: #b3261e; }
    </style><div class="wrap"><div class="bar"></div><div class="cols"><div class="msg">Loading board…</div></div></div>`;
    ['keydown', 'keyup', 'keypress'].forEach(t => root.addEventListener(t, e => e.stopPropagation()));
    root.addEventListener('click', onBoardClick);
    // Avatar images that fail to load fall back to initials.
    root.addEventListener('error', e => {
      const img = e.target;
      if (img.tagName !== 'IMG' || !img.classList.contains('av')) return;
      const sp = document.createElement('span'); sp.className = 'av'; sp.style.background = '#8a9bab'; sp.textContent = img.dataset.ini || '?';
      img.replaceWith(sp);
    }, true);
    root.addEventListener('input', e => { if (e.target.classList.contains('search')) { board.search = e.target.value; renderColumns(); } });
    root.addEventListener('change', e => { if (e.target.classList.contains('showc')) { board.showCompleted = e.target.checked; renderBoard(); } });
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
      renderBoard();
    } catch (e) {
      board.root.querySelector('.cols').innerHTML = `<div class="msg err">Could not load the schedule: ${esc(e && e.message || e)}</div>`;
    }
  }

  // Model: columns + cards from the raw getSchedule payload.
  function boardModel() {
    const raw = board.data;
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
        pc: +tu.PercComp || 0, due, days, taskId: t.TaskID || '', taskName: t.TaskName || '(task)', group: t.SummaryTaskName || '', order: t.ProjectOrder || 0 };
    });
    const assigned = new Set(tus.map(tu => tu.TaskKey));
    const unassigned = (raw.tasks || []).filter(t => !parents.has(t.TaskKey) && !assigned.has(t.TaskKey) && +t.PercComp < 100)
      .map(t => ({ taskKey: t.TaskKey, taskId: t.TaskID || '', taskName: t.TaskName || '(task)', group: t.SummaryTaskName || '', order: t.ProjectOrder || 0,
        due: t.PlanComplete ? new Date(String(t.PlanComplete).slice(0, 10) + 'T00:00:00') : null }));
    return { statuses, cards, unassigned };
  }

  function renderBoard() {
    if (!board.root || !board.data) return;
    const m = boardModel();
    // Toolbar: people chips (open work only), search, show completed, refresh.
    const people = new Map();
    m.cards.filter(c => !c.done).forEach(c => { const k = c.userKey; const p = people.get(k) || { key: k, name: c.user || 'Unassigned', initials: c.initials, n: 0 }; p.n++; people.set(k, p); });
    const open = m.cards.filter(c => !c.done).length;
    const chips = [`<button type="button" class="chip all ${board.user ? '' : 'on'}" data-user="0">Everyone <span class="n">${open}</span></button>`]
      .concat([...people.values()].sort((a, b) => b.n - a.n).map(p =>
        `<button type="button" class="chip ${board.user === p.key ? 'on' : ''}" data-user="${p.key}">${avatarHtml(p.key, p.name, p.initials)}${esc(p.name.split(' ')[0])} <span class="n">${p.n}</span></button>`));
    const bar = board.root.querySelector('.bar');
    const hadFocus = board.root.activeElement && board.root.activeElement.classList.contains('search');
    bar.innerHTML = `<div class="chips">${chips.join('')}</div>
      <label class="chk"><input type="checkbox" class="showc" ${board.showCompleted ? 'checked' : ''}> Show completed</label>
      <input class="search" type="search" placeholder="Filter tasks…" value="${esc(board.search)}">
      <button type="button" class="icon refresh" title="Reload from Workamajig">↻</button>`;
    if (hadFocus) { const s = bar.querySelector('.search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    board.model = m;
    renderColumns();
  }

  function renderColumns() {
    const m = board.model; if (!m) return;
    const q = board.search.trim().toLowerCase();
    const match = c => (!board.user || c.userKey === board.user) &&
      (!q || [c.taskId, c.taskName, c.group, c.user, c.service].some(v => String(v || '').toLowerCase().includes(q)));
    const sortCards = (a, b) => ((a.days == null) - (b.days == null)) || ((a.days ?? 0) - (b.days ?? 0)) || (a.order - b.order);
    const cols = [];
    const noStatus = m.cards.filter(c => !c.status && !c.done && match(c));
    if (noStatus.length) cols.push({ key: 0, name: 'No status', color: '#d6d6d6', cards: noStatus, drop: false });
    m.statuses.forEach(st => {
      const isDone = st.key === COMPLETED_KEY;
      const cards = m.cards.filter(c => c.status === st.key && match(c) && (isDone || !c.done || board.showCompleted));
      cols.push({ key: st.key, name: st.name, color: st.color, cards, drop: true, collapsed: isDone && !board.showCompleted, total: isDone ? m.cards.filter(c => c.status === st.key && match(c)).length : null });
    });
    if (!board.user) {
      const un = m.unassigned.filter(t => !q || [t.taskId, t.taskName, t.group].some(v => String(v).toLowerCase().includes(q)));
      if (un.length) cols.push({ key: -2, name: 'Not assigned', color: '#9b9b9b', cards: un, drop: false, unassigned: true });
    }
    const html = cols.map(col => {
      const list = col.collapsed ? '' : (col.cards.slice().sort(sortCards).map(c => col.unassigned ? unassignedCard(c) : cardHtml(c, col)).join('') || '<div class="empty">Drop a card here</div>');
      const hrs = col.unassigned ? '' : col.cards.reduce((s, c) => s + Math.max(0, c.planned - c.actual), 0);
      const n = col.collapsed ? col.total : col.cards.length;
      return `<section class="col ${col.collapsed ? 'collapsed' : ''}" style="--c:${col.color}" data-status="${col.key}" data-drop="${col.drop ? 1 : 0}" ${col.collapsed ? 'title="Show completed"' : ''}>
        <div class="head"><span class="pill">${esc(col.name)}</span><span class="count">${n}</span>${hrs !== '' && !col.collapsed ? `<span class="hrs" title="Planned hours not yet logged">${fmtH(hrs)} left</span>` : ''}</div>
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
      <div class="badges">${dueBadge(c)}${c.pc ? `<span class="b">${c.pc}%</span>` : ''}</div>
      ${c.pc ? `<div class="prog"><i style="width:${Math.min(100, c.pc)}%"></i></div>` : ''}
      <div class="foot">${avatarHtml(c.userKey, c.user, c.initials)}<span class="who">${esc(c.user || 'Unassigned slot')}<small>${esc(c.service)}</small></span>
      <span class="h ${overHrs ? 'over' : ''}" title="Logged / planned hours">${fmtH(c.actual)} / ${fmtH(c.planned)}</span></div></a>`;
  }
  function unassignedCard(t) {
    const label = t.due ? t.due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    return `<div class="card static" data-task="${t.taskKey}" style="--c:#9b9b9b" title="No one is assigned to this task">
      <div class="top"><span class="id">${esc(t.taskId)}</span><span class="grp">${esc(t.group)}</span></div>
      <button type="button" class="more" title="More">⋯</button>
      <div class="name">${esc(t.taskName)}</div>
      <div class="badges">${label ? `<span class="b">Due ${label}</span>` : ''}<span class="b">No assignee</span></div></div>`;
  }

  function onBoardClick(e) {
    const t = e.target;
    if (board.justDragged) { e.preventDefault(); e.stopPropagation(); board.justDragged = false; return; }
    if (t.classList.contains('chip')) { board.user = Number(t.dataset.user); renderBoard(); return; }
    if (t.closest && t.closest('.chip')) { board.user = Number(t.closest('.chip').dataset.user); renderBoard(); return; }
    if (t.classList.contains('refresh')) { loadBoard(); return; }
    const col = t.closest && t.closest('.col.collapsed');
    if (col) { board.showCompleted = true; renderBoard(); return; }
    if (t.classList.contains('more')) { e.preventDefault(); e.stopPropagation(); openCardMenu(t); return; }
    if (t.closest && t.closest('.menu')) return;
    closeCardMenu();
    const card = t.closest && t.closest('.card');
    if (card && card.classList.contains('static')) { e.preventDefault(); showInList(Number(card.dataset.task)); }
  }

  function openCardMenu(btnEl) {
    closeCardMenu();
    const card = btnEl.closest('.card');
    const taskKey = Number(card.dataset.task), tuk = Number(card.dataset.tuk) || 0;
    const pk = board.projectKey;
    const m = document.createElement('div');
    m.className = 'menu';
    const items = [];
    if (tuk) items.push(['Open assignment', () => location.assign(urls.assignment(tuk))]);
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
      if (res.data && res.data.PercComp != null) tu.PercComp = res.data.PercComp;
      board.dirty = true;
      renderBoard();
      toast(`Moved to ${st.l}`);
    } catch (err) {
      Object.assign(tu, prev);
      renderBoard();
      toast('Could not change the status: ' + (err && err.message || err));
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
    boardTick();
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
