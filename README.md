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
- **Open assignment in new tab · <person>** (v0.31) – one per assignment slot, at the bottom of the menu.

Tasks with no assignment slots only get the task link; add an assignment to get an assignment URL.

### Project board on the Schedule (v0.10)

A **List / Board** switch at the top right of the Schedule page (next to Workamajig's "saved" indicator, since v0.21) shows the project as a kanban board. The choice is remembered.

- **One card per assignment**, because Workamajig keeps status on each person's assignment, not on the task. Columns are the company statuses (Backlog, Ready, In Progress, Ready for Review/Blocked, Completed) in their Workamajig colors, plus "No status" when present and "Not assigned" for open tasks with nobody on them.
- **Cards** show task ID and group, task name, due date with overdue / due-today badges, percent complete, assignee and service, and hours logged / planned. ⋯ offers Open assignment, Show in list (spotlights the row), Copy task link, Copy assignment link.
- **Click a card for a details modal** (v0.11): status dropdown (same call as dragging), assignee, due and planned dates, hours, the task description (with links), and everyone else on the task. Missing descriptions can be added right there and existing ones edited (edit-tasks right), or details requested in a prefilled conversation. Saves are conflict-safe: if someone else changed the description while you were editing, the save is refused and your draft is kept. Footer: Open full assignment (opens the assignment in a new tab, the whole button since v0.31), Show in list, and Copy task link / Copy assignment link (with copy icons). The card's ⋯ menu also has **Open assignment in new tab**. Esc closes. Since v0.29 the modal also shows the task's **conversations** under the description (the same section as the assignment page: full threads, reply boxes that prefill Workamajig's reply screen, New conversation). After replying or starting a conversation, Back returns to the board and reopens the same card scrolled to its conversations. Clicking a card's conversations badge opens the modal straight at them.
  **To-dos** (v0.17) sit in a right-hand panel: open to-dos with assignee, due date and status, completed ones behind "Show N completed". Tick to complete or reopen, type in the box and press Enter to add one, and hover for × to delete (asks first; needs the delete-to-dos right). Uses the Schedule page's own to-do calls (`loadScheduleToDos`, `updateToDo`, `deleteToDo`). Cmd/Ctrl-click a card still opens the assignment in a new tab.
- **Assign people** (edit-tasks right): from a "Not assigned" card's modal, or **Manage assignees** on any card, the board steps aside and opens Workamajig's own assignment panel for that task. When the panel closes the board comes back and reloads, re-checking for a few seconds so new assignments appear once autosave lands.
- **Assignment panel backdrop** (v0.13): whenever Workamajig's assignment panel is open (from the board or the list), the rest of the page is dimmed; clicking the dimmed area closes the panel through its own × button.
- **Filters:** a chip per person, Workamajig's own **Search** box at the top left (since v0.22 it filters the board as well as the list, so both views share one search), Show completed, and **Has open to-dos** (v0.23). Cards also carry a to-do badge (v0.23): "N open to-dos" in blue, or "To-dos done" in green when every to-do is ticked; cards whose task has no to-dos show nothing. Badges come from one project-wide to-do call per board load and update as you change to-dos in the card modal. Person counts follow the other active filters (search, No description), and whenever any filter is on a "Filtered: …" line shows exactly what is applied, with **Clear filters**.
- **Project hygiene** (v0.16): a **Hygiene** menu in the board toolbar lists open work with problems, with a count for each: **No description**, **Overdue**, **Over budget** (more hours logged than planned), **No hours planned**, **Not assigned** (tasks with nobody on them, or empty assignment slots). Tick one or more to show only matching cards (any of the ticked issues); "Any issue" ticks all. Cards with no description always carry a badge; Over budget / No hours planned badges appear while those checks are on. Finished work is never counted.
- **Hygiene in List view** (v0.19, filtering since v0.26): the same **Hygiene** button sits next to the List / Board switch while the list is showing. Click an issue to filter the schedule list to just those tasks. Group headings stay for context, but only when at least one matching task under them is visible (since v0.27.2, a heading whose matches are all hidden by Hide Completed Tasks is hidden too). A chip such as "Overdue · 9 +2 hidden" shows what is filtered, with **Clear**; "+2 hidden" means more tasks match but Hide Completed Tasks keeps them out. Click the active issue again, or Clear, to show everything. The filter combines with Workamajig's Search box, and opening the board clears it.

  How it works: the list's data source already has a filter function (the one that handles Search and Hide Completed Tasks). The script wraps it so a row must also be one of the chosen tasks or their parent groups, then asks the data source to refresh. Workamajig redraws the list itself, the grid's markup is never touched, and nothing is saved (the save indicator stays on "saved").
- **Conversations** (v0.25): one project-wide call (`getConversations`) counts threads per task. On the board each card shows a purple badge ("2 conversations", solid when some posts are unread) and there is a **Has conversations** filter. In List view a **Conversations** button next to Hygiene shows how many tasks have conversations and how many have unread posts; its menu filters the list to tasks **With conversations** or **With unread posts**, the same way as Hygiene.
- **List-only controls** (v0.18, v0.21): Workamajig's Gantt, Templates and Task Detail toggles and the column-set picker (for example "PM Advance View") are hidden while the board is open and come back in List view.
- **Columns collapse:** the ‹ / › button on any column header collapses or expands it (a collapsed column is still a drop target, and clicking it expands it). Collapse all / Expand all sit in the toolbar. Choices are remembered per column name; Completed starts collapsed, and Show completed is the same switch as expanding Completed.
- **Drag a card to another column** to change its status. It uses the same single-assignment call as the Today board (`WJAPP.Modules.Project.Traffic.updateAssignmentStatus`), so Workamajig applies the status's default percent complete just as it does there. Switching back to List reloads the grid so it shows the new statuses.
- Drawn as an overlay over the grid in a Shadow DOM; the grid itself is never modified. It sits below Workamajig's header and sidebar fly-out menus, and rises above them only while a card modal is open.

### Tasks in Global Search (v0.31)

Workamajig's Global Search (the magnifier in the header) has no task category. The script adds a **Tasks** section above its results: press Search and it lists the tasks whose name or ID matches, with the project, parent task and a chip per assignee. Click a task to open its project schedule with the row spotlighted (if that schedule is already open under Search, it just closes Search and spotlights). Click an assignee chip to open that assignment. Cmd/Ctrl-click either for a new tab. Completed tasks sit behind "Show N completed", and tasks that only matched on project name or assignee sit behind "N more in matching projects or people". Workamajig's "Sorry, we were not able to find anything" note is hidden while tasks match. Reopening Search shows the last task results again.

How it works: the Assignments views (Search → Views → Assignments) already have a server-side search over Project Number/Name, Task ID, Task Name and Assigned User Name for **active projects only**. The script loads one Assignments view's definition (`ReportingManager.getViews` + `loadReport`), drops its conditions and groups, and runs it with the search text (`ReportingManager.runListing`). It is read-only and saves nothing; summary tasks with no assignments don't appear.

### Assignment page extras (v0.4)

On an assignment page (`projects.production.assignment`) the script also:

- **New layout** (v0.20): the task description and its conversations share the middle column, Workamajig's own side column (due date, hours, team, Project Details) stays on the left, and a separate rail on the right holds the to-dos (v0.27; v0.20 moved the side column to the right). The side column's donut charts are hidden, since the hours table shows the same numbers, and the To Do List and Conversations tabs are hidden because both now show inline. **Classic layout** in the link row switches back (remembered per browser), and **New layout** switches it on again.
  - **Conversations** load with the same calls as Workamajig's own screens (`getConversations` for the task, then `loadThread` for each thread), so every reply shows, oldest first, with avatars, times and an Unread tag. Long posts collapse with Show more, threads with more than four posts show the first and last two, and post HTML is cleaned down to simple formatting and links. **Open thread** goes to the native thread screen, and **New conversation** opens the native New Post screen linked to this task.
  - **Reply box** under each thread: type and press **Reply** to open Workamajig's reply screen with your text already in the editor and the usual recipients. Nothing is posted until you press **Post Reply** there.
  - **To-dos** in the rail work like the board modal: tick to complete, type and press Enter to add, hover × to delete (asks first; needs the delete right).
- **Status dropdown** (v0.15) at the start of the link row: changes the assignment's status with the same call as the boards, then shows the percent complete Workamajig actually saved.
- **Task links under the title** (v0.12): **Open in schedule** (opens the project schedule and spotlights this task; Cmd/Ctrl-click for a new tab), **Copy task link**, **Copy assignment link**.

- **Widens the page** to the same width as other screens. Long task titles wrap at a slightly smaller size and the header grows to fit, instead of being cut off with "…".
- **Shows hours** under the due date as a small table (Logged / Planned / Left) with one row for the whole task (all assignees) and one for this assignment. Workamajig's native "Hours Remaining" donut only appears when the assignment has planned hours, so this fills the gap. Task totals come from the project schedule data; if you lack rights to read the schedule, only the assignment line shows.
- **Flags a missing task description** (v0.5) at the top of the Description of Work tab. **Request details in a conversation** opens Workamajig's New Post screen for this task with everything prefilled (v0.7): the subject ("Task description needed: <task>"), a short request with the task and assignment links, and the project manager as the only recipient (resolved from the project record and the project team; if there is no match the default recipients stay). You review and press Save. Users with the edit-tasks right also get **Add a description** (v0.6, redesigned in v0.8.1): an inline editor with an optional outline (Goal / Scope / Inputs and links / Done when), Cmd/Ctrl+Enter to save and Esc to cancel. It saves straight to the task, then shows the saved text in place. The notice and editor render in a Shadow DOM so Workamajig's page CSS cannot reshape them. There is also a link to edit it in the Schedule instead.

  How the inline save works: it is the same server call the Schedule page's Save button makes (`updateScheduleDM`), sent with a fresh copy of the task row from `getSchedule` in which only `Description` is changed, plus the project row from `initSchedule`. Verified side by side with a native save: both write the description and bump `DateUpdated` on the project's tasks, and nothing else changes. The script refuses to save when the schedule is locked or when a description appeared in the meantime, and it never overwrites an existing description.

## How it works

- **Panels squeeze the assignment page** (v0.30): when a screen such as New Post or Reply slides in from the right on top of an assignment page, the assignment page shrinks to the space left of it (and hides the to-do rail) instead of sitting under it. It goes back to full width when the panel closes. On narrow windows (under about 1450px) a little overlap remains.
- **In-app navigation** (v0.24): every button or link the script adds that opens another screen (Open full assignment, Open assignment, Open in schedule, Open thread, New conversation, Reply, Request details) opens it the way Workamajig's own buttons do (`Views.openPage`). Workamajig keeps its own stack of open screens and makes the browser Back button close the top one; full page loads skipped that stack, so Back used to land on an unrelated screen. Cmd/Ctrl/Shift-click still opens a new tab.
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
