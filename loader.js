// Workamajig Task Links – loader for "User JavaScript and CSS" (or any extension that runs page JS).
// Pulls the current script from GitHub via jsDelivr on every page load, so updates need no re-paste.
// Rule URL pattern: https://app20.workamajig.com/*   Run at: document-start if the extension offers it.
(function () {
  // Keep the #task= deep link: Workamajig strips the hash before the remote script arrives.
  var m = /[#&]task=(\d+)/.exec(location.hash);
  if (m) try { sessionStorage.setItem('wjl.pendingTask', m[1]); } catch (e) {}
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/gh/xzito/workamajig-task-links@main/workamajig-task-links.user.js?d=' + Math.floor(Date.now() / 36e5);
  (document.head || document.documentElement).appendChild(s);
})();
