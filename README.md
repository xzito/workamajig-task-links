# Workamajig Task Links

Userscript that gives Workamajig Platinum the per-task / per-assignment links it does not expose.

## What it does
Hover a task anywhere it appears and a 🔗 button shows up. Clicking it opens a small menu of links to copy. Works on:

| Page | What you hover | How it resolves |
|---|---|---|
| Project **Schedule** (`projects.schedule.edit2`) | the row's own **⋯** menu (v0.8: our items are added to Workamajig's menu, no separate button) | row `data-key` is the TaskKey; project from the URL |
| **My Tasks** / Today - Creatives (`today.creative`), grid or card view | grid row (hover button), or the card's own **⋯** menu (v0.9: our items are added under New Time Entry / Start a Timer / Add Meeting) | key is the TaskUserKey; `loadAssignment` gives project + task |
| **My Time** day view (`user.timeEntry.edit`) | time entry row | row key is the TimeKey; `loadTime` for the page's date gives project + task |
| Any other card the app navigates from (`data-target` + `data-key`) | card | assignment cards resolve fully; other targets get a plain "Copy link" |

Menu items:

- **Copy task link** – `…?aid=projects.schedule.edit2&k=<ProjectKey>#task=<TaskKey>`. Opens the schedule, scrolls to the row and spotlights it: the rest of the page dims like a modal backdrop and the row gets an outline, until you click, scroll or 4 s pass. The highlight needs the script installed; without it the link still opens the right project schedule.
- **Copy project link** – `…?aid=dashboards.project.dash&k=<ProjectKey>` (not shown on the project Schedule page itself, where it is redundant).
- **Copy assignment link · <person>** – one per assignment slot: `…?aid=projects.production.assignment&k=<TaskUserKey>`. These are native Workamajig URLs and work for anyone with rights to the project (verified as a PM/admin opening another person's assignment).
- **Copy all assignment links** – all slots, one per line with names (when a task has more than one).

Tasks with no assignment slots only get the task link; add an assignment to get an assignment URL.

### Project board on the Schedule (v0.10)

A **List / Board** switch in the Schedule toolbar (next to the Gantt toggle) shows the project as a kanban board. The choice is remembered.

- **One card per assignment**, because Workamajig keeps status on each person's assignment, not on the task. Columns are the company statuses (Backlog, Ready, In Progress, Ready for Review/Blocked, Completed) in their Workamajig colors, plus "No status" when present and "Not assigned" for open tasks with nobody on them.
- **Cards** show task ID and group, task name, due date with overdue / due-today badges, percent complete, assignee and service, and hours logged / planned. Click opens the assignment; ⋯ offers Open assignment, Show in list (spotlights the row), Copy task link, Copy assignment link.
- **Filters:** a chip per person with open-assignment counts, a search box, and Show completed (starts from the page's Hide Completed Tasks setting; Completed stays a collapsed drop target otherwise).
- **Drag a card to another column** to change its status. It uses the same single-assignment call as the Today board (`WJAPP.Modules.Project.Traffic.updateAssignmentStatus`), so Workamajig applies the status's default percent complete just as it does there. Switching back to List reloads the grid so it shows the new statuses.
- Drawn as an overlay over the grid in a Shadow DOM; the grid itself is never modified.

### Assignment page extras (v0.4)

On an assignment page (`projects.production.assignment`) the script also:

- **Widens the page** to the same width as other screens. Long task titles wrap at a slightly smaller size and the header grows to fit, instead of being cut off with "…".
- **Shows hours** under the due date as a small table (Logged / Planned / Left) with one row for the whole task (all assignees) and one for this assignment. Workamajig's native "Hours Remaining" donut only appears when the assignment has planned hours, so this fills the gap. Task totals come from the project schedule data; if you lack rights to read the schedule, only the assignment line shows.
- **Flags a missing task description** (v0.5) at the top of the Description of Work tab. **Request details in a conversation** opens Workamajig's New Post screen for this task with everything prefilled (v0.7): the subject ("Task description needed: <task>"), a short request with the task and assignment links, and the project manager as the only recipient (resolved from the project record and the project team; if there is no match the default recipients stay). You review and press Save. Users with the edit-tasks right also get **Add a description** (v0.6, redesigned in v0.8.1): an inline editor with an optional outline (Goal / Scope / Inputs and links / Done when), Cmd/Ctrl+Enter to save and Esc to cancel. It saves straight to the task, then shows the saved text in place. The notice and editor render in a Shadow DOM so Workamajig's page CSS cannot reshape them. There is also a link to edit it in the Schedule instead.

  How the inline save works: it is the same server call the Schedule page's Save button makes (`updateScheduleDM`), sent with a fresh copy of the task row from `getSchedule` in which only `Description` is changed, plus the project row from `initSchedule`. Verified side by side with a native save: both write the description and bump `DateUpdated` on the project's tasks, and nothing else changes. The script refuses to save when the schedule is locked or when a description appeared in the meantime, and it never overwrites an existing description.

## How it works
- Grids are `<grid-row data-key>`; cards are `<li data-target="<screen id>" data-key>`. The script never edits that DOM; the button and menu are fixed-position overlays.
- Server calls reuse the app's own `data.aspx?<Class>.<method>` endpoints with the session request token (`System.user.rt`):
  - `Modules.Projects.Schedule.getSchedule {projectKey}` → `tasks[]` (TaskKey, TaskID, TaskName) and `projectTaskUserData[]` (TaskKey → TaskUserKey, UserKey, UserName). Cached per project.
  - `Modules.Projects.Production.loadAssignment {TaskUserKey}` → ProjectKey, TaskKey, UserKey.
  - `WJAPP.Modules.User.Today.loadTime {workDate}` → TimeKey → ProjectKey, TaskKey, UserKey.
- It never modifies the grid's own DOM (doing so makes the grid re-render in a loop); the button and menu are fixed-position overlays.
- Workamajig rewrites the URL on load and drops the `#task=` hash, so the script runs at `document-start`, stashes the hash in `sessionStorage`, and applies it once the grid renders.

## Install – recommended (auto-updating, no re-paste)
Uses the free Chrome extension **User JavaScript and CSS** plus the small `loader.js` in this repo. On every page load the loader fetches the current script straight from this repo on GitHub (raw content, 5-minute cache), so anything pushed to `main` reaches everyone within minutes with nothing to do. If GitHub is unreachable it falls back to the jsDelivr CDN copy.

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
- Still seeing an old version after a push: wait five minutes and reload. (Earlier loader versions used jsDelivr's `@main` URL, whose branch cache proved unreliable and even served stale versions after a purge; if your rule still contains `cdn.jsdelivr.net` as the main source, paste the current `loader.js` again.)

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
