# Workamajig Task Links

Userscript that gives Workamajig Platinum the per-task / per-assignment links it does not expose.

## What it does
On any project **Schedule** page (`?aid=projects.schedule.edit2&k=<ProjectKey>`), hover a task row and a 🔗 button appears at the end of the task name. Clicking it opens a small menu:

- **Copy task link** – `…?aid=projects.schedule.edit2&k=<ProjectKey>#task=<TaskKey>`. Opens the schedule, scrolls to the row and highlights it for 5 s. The highlight needs the script installed; without it the link still opens the right project schedule.
- **Copy assignment link · <person>** – one per assignment slot: `…?aid=projects.production.assignment&k=<TaskUserKey>`. These are native Workamajig URLs and work for anyone with rights to the project (verified as a PM/admin opening another person's assignment).
- **Copy all assignment links** – all slots, one per line with names (when a task has more than one).

Tasks with no assignment slots only get the task link; add an assignment to get an assignment URL.

## How it works
- Each grid row carries `data-key="<TaskKey>"`.
- The script calls the same server method the page uses (`Modules.Projects.Schedule.getSchedule`) with the session's request token (`System.user.rt`) and reads `projectTaskUserData` to map TaskKey → TaskUserKey(s).
- It never modifies the grid's own DOM (doing so makes the grid re-render in a loop); the button and menu are fixed-position overlays.
- Workamajig rewrites the URL on load and drops the `#task=` hash, so the script runs at `document-start`, stashes the hash in `sessionStorage`, and applies it once the grid renders.

## Install (Tampermonkey / Violentmonkey)
1. Install Tampermonkey in Chrome.
2. Open `workamajig-task-links.user.js` in the browser (or Tampermonkey → Create new script → paste) and save.
3. Reload any Workamajig schedule page.

To distribute to the team, install from the raw GitHub URL below. Tampermonkey auto-updates from the `@updateURL`/`@downloadURL` headers.

Install link: https://raw.githubusercontent.com/xzito/workamajig-task-links/main/workamajig-task-links.user.js (private repo: open it while signed in to GitHub, or use the Tampermonkey paste method).

## Known limits
- Only the Schedule grid is decorated. The Today / My Tasks views could be added the same way.
- Task deep links depend on the script for the scroll/highlight part.
- `getSchedule` is an internal endpoint; if Workamajig changes it, assignment links stop appearing but task links still work.
- Verified Oct 30 2026 on app20 release 26.10.18.
