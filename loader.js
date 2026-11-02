(function () {
  var m = /[#&]task=(\d+)/.exec(location.hash);
  if (m) try { sessionStorage.setItem('wjl.pendingTask', m[1]); } catch (e) {}
  var RAW = 'https://raw.githubusercontent.com/xzito/workamajig-task-links/main/workamajig-task-links.user.js';
  var CDN = 'https://cdn.jsdelivr.net/gh/xzito/workamajig-task-links@main/workamajig-task-links.user.js';
  function run(code) { var s = document.createElement('script'); s.textContent = code; (document.head || document.documentElement).appendChild(s); }
  function cdn() { var s = document.createElement('script'); s.src = CDN + '?d=' + Math.floor(Date.now() / 36e5); (document.head || document.documentElement).appendChild(s); }
  fetch(RAW + '?t=' + Math.floor(Date.now() / 3e5), { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then(run)
    .catch(cdn);
})();
