# Workamajig Task Links

Userscript that gives Workamajig Platinum the per-task / per-assignment links it does not expose.

## What it does
Hover a task anywhere it appears and a 🔗 button shows up. Clicking it opens a small menu of links to copy. Works on:

| Page | What you hover | How it resolves |
|---|---|---|
| Project **Schedule** (`projects.schedule.edit2`) | grid row | row `data-key` is the TaskKey; project from the URL |
| **My Tasks** / Today - Creatives (`today.creative`), grid or card view | grid row or card | key is the TaskUserKey; `loadAssignment` gives project + task |
| **My Time** day view (`user.timeEntry.edit`) | time entry row | row key is the TimeKey; `loadTime` for the page's date gives project + task |
| Any other card the app navigates from (`data-target` + `data-key`) | card | assignment cards resolve fully; other targets get a plain "Copy link" |

Menu items:

- **Copy task link** – `…?aid=projects.schedule.edit2&k=<ProjectKey>#task=<TaskKey>`. Opens the schedule, scrolls to the row and highlights it for 5 s. The highlight needs the script installed; without it the link still opens the right project schedule.
- **Copy project link** – `…?aid=dashboards.project.dash&k=<ProjectKey>`.
- **Copy assignment link · <person>** – one per assignment slot: `…?aid=projects.production.assignment&k=<TaskUserKey>`. These are native Workamajig URLs and work for anyone with rights to the project (verified as a PM/admin opening another person's assignment).
- **Copy all assignment links** – all slots, one per line with names (when a task has more than one).

Tasks with no assignment slots only get the task link; add an assignment to get an assignment URL.

## How it works
- Grids are `<grid-row data-key>`; cards are `<li data-target="<screen id>" data-key>`. The script never edits that DOM; the button and menu are fixed-position overlays.
- Server calls reuse the app's own `data.aspx?<Class>.<method>` endpoints with the session request token (`System.user.rt`):
  - `Modules.Projects.Schedule.getSchedule {projectKey}` → `tasks[]` (TaskKey, TaskID, TaskName) and `projectTaskUserData[]` (TaskKey → TaskUserKey, UserKey, UserName). Cached per project.
  - `Modules.Projects.Production.loadAssignment {TaskUserKey}` → ProjectKey, TaskKey, UserKey.
  - `WJAPP.Modules.User.Today.loadTime {workDate}` → TimeKey → ProjectKey, TaskKey, UserKey.
- It never modifies the grid's own DOM (doing so makes the grid re-render in a loop); the button and menu are fixed-position overlays.
- Workamajig rewrites the URL on load and drops the `#task=` hash, so the script runs at `document-start`, stashes the hash in `sessionStorage`, and applies it once the grid renders.

## Install – recommended (auto-updating, no re-paste)
Uses the free Chrome extension **User JavaScript and CSS** plus the 11-line `loader.js` in this repo. The loader fetches the current script from jsDelivr on every page load, so updates pushed to `main` reach you within about 12 hours with nothing to do.

1. Install [User JavaScript and CSS](https://chromewebstore.google.com/detail/user-javascript-and-css/nbhcbdghjpllgmfilhnhkllmkecfmpld) from the Chrome Web Store.
2. Open Workamajig (`https://app20.workamajig.com/platinum/`), click the extension's toolbar icon, then **New rule**.
3. Fill in the rule:
   - **Rule name:** `Workamajig Task Links`
   - **URL pattern:** `https://app20.workamajig.com/*`
   - **JavaScript pane (left):** paste the full contents of [`loader.js`](loader.js)
   - **CSS pane (right):** leave empty
4. In the rule's options (gear icon), set **Run at** to `document-start` if the option exists. This keeps the task deep link's scroll-and-highlight working; everything else works at any timing.
5. Save, reload a project Schedule page, and hover a task row. A 🔗 button should appear at the end of the task name.

Troubleshooting:
- No button: check the rule is enabled for `app20.workamajig.com` (the toggle in the extension popup) and that the URL pattern matches.
- Button but "No assignment slots" on every task: the extension is sandboxing the script. Make sure it injects into the page context (default), not an isolated one.
- Need a change immediately rather than within 12 hours: open `https://purge.jsdelivr.net/gh/xzito/workamajig-task-links@main/workamajig-task-links.user.js` once to clear the CDN cache, or use the Tampermonkey install below.

## Install – alternative (Tampermonkey / Violentmonkey)
1. Install Tampermonkey in Chrome.
2. Open `workamajig-task-links.user.js` in the browser (or Tampermonkey → Create new script → paste) and save.
3. Reload any Workamajig schedule page.

To distribute to the team, install from the raw GitHub URL below. Tampermonkey auto-updates from the `@updateURL`/`@downloadURL` headers.

Install link: https://raw.githubusercontent.com/xzito/workamajig-task-links/main/workamajig-task-links.user.js.

## Known limits
- My Time week view and other grids (conversations, deliverables, to-dos) are not mapped yet; add an adapter keyed by the page's `aid`.
- Task deep links depend on the script for the scroll/highlight part.
- `getSchedule` is an internal endpoint; if Workamajig changes it, assignment links stop appearing but task links still work.
- Verified Oct 30 2026 on app20 release 26.10.18 (Schedule, My Tasks grid + cards, My Time day view).
