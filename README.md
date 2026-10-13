# better-dsh-session-deletetool

> **Local fork.** The upstream original is [Lzcdebear/better-dsh-session-deletetool](https://github.com/Lzcdebear/better-dsh-session-deletetool)
> (the same name on npm); this directory is a fork of it. Changelog entries up to 0.5.2 belong to
> upstream, 0.6.0 onward are local changes. The author field keeps the original author's credit; the
> local changes do not carry his name.
>
> It is installed as the profile's `link:` local-path dependency, and DSH's plugin manager has **no
> update action at all** (only list / set / install / remove) — so **this version cannot be
> overwritten**. The one thing that would replace it is reinstalling this plugin with a spec naming
> the npm package of the same name. Don't do that.

**Delete a conversation from DeepSeek Harness — DSH ships archive only.**

[中文说明](README.zh-CN.md)

---

## Why this exists

DSH can only *archive* a conversation. Archiving hides the row from the sidebar and keeps every
artifact: the log, the workspace account, the projection checkpoint all stay on disk, and the
conversation can be restored at any time. The persistence seam has no deletion API at all —
`@deepseek-ai/dsh-session-persistence-jsonl` states it plainly:

> **Nothing deletes session files** — logs accumulate under `root` until removed externally; the
> seam has no deletion API.

So a long-lived profile accumulates conversations forever. This plugin adds the missing step: a
**Delete conversation** row in each session's `⋯` menu that really removes the data — and the dialog
it opens is also the one place that shows a conversation's whole family before you touch it.

**One entry point, and only one.** There is no sidebar control and no bulk-delete entry: the `⋯` row
is the whole surface, and the dialog it opens carries both the delete and the disk-space control. A
bulk delete existed and was then removed — it could not delete a conversation the Host still held,
so it only took effect once DeepSeek was quit, with the row sitting in the list until then. Having to
quit the app to make it work was the signal that it was not solving the problem. One conversation at
a time, each one deleted cleanly.

## What it deletes

For the chosen session, the Host half:

1. **removes the session's artifact directory** — the current log, every retained historical format
   generation, and any session-local file in it (`ctx.sessionPersistence.locate(header)` gives the
   path);
2. **removes the descendants you selected** — child sessions are sessions of their own with their own
   logs. DSH records every child in its parent's header (`SessionHeader.parentSession`), and writes
   that field for every relation it creates: the Subagent runtime sets it with `origin: 'subagent'`,
   a fork sets it with `isSeeded`, and Agent Teams resolves its roster through the same field. The
   plugin walks that lineage breadth-first and unions it with the durable `subagentCatalog`
   projection (`ctx.subagents.listDescendants`), so a child whose own header no longer reads is still
   named. Descendants are deleted **deepest first**, gathered *before* anything is removed, and only
   the ticked ones go — up to 200 per request;
3. **drops the workspace account** — the id leaves every Workspace record's `sessionIds`
   (`Workspace.detachSession`) and the registry-global archive and pin sets;
4. **drops the projection checkpoint** — the `session_projcache` domain record and its `<id>.json`
   file;
5. **closes the shells the session owned** — `ctx.terminals` are part of no admission family, and the
   service only reaps them when the Agent is released, which can be long after the log is gone;
6. **tells connected pages** — one `api-session/removed` per removed id, the same event the shipped
   Session controller emits when a Session is disposed, so the rows leave the sidebar immediately;
7. **clears the page's own leftovers** — the Client half removes the drafts and panel layouts the
   shipped client keys by session id (`dsh.conversation.<id>`, `dsh.sidebar-right.v1.<id>`,
   `dsh.sidebar-browser.v1.<id>`, `dsh.user-questions.drafts.v1.<id>`,
   `dsh.schedule.task-tab.v1.<id>`). Only the page can reach `localStorage`, so this is the half that
   does it; a global key like `dsh.sessions.current` is never touched.

### Reclaiming the disk space, not just the row

Removing the log was never the whole story, because the expensive bytes are *shared* and *derived*.
After the removals above, the Host half reclaims:

8. **attachment objects nothing else references** — `~/.dsh/attachments/v1/**` is content-addressed and
   deduplicated, with no index and no reference counting anywhere; the shipped package states that
   nothing collects unreferenced objects. This plugin builds the count itself: it reads every session
   log, collects the `attachmentId` fields **structurally**, and unlinks a blob only when no *surviving*
   log names it. A blob two conversations shared is kept, and reported as kept. Reading references
   structurally is not an optimisation: a blob hash also appears verbatim inside message text and tool
   output, so grepping for one reports references that do not exist. Logs are also a *sequence* of zstd
   frames, so the reader walks the frame offsets — decompressing the file as one stream returns only
   the first frame;
9. **the provider upload cache** — `~/.dsh/llm-deepseek/files-v3.json` maps an attachment to a
   DeepSeek-side file id. It is not session-keyed, so it is pruned by dangling attachment and by
   expiry, never by conversation;
10. **the derived search index** — rows for the removed sessions are dropped, then the file is
    compacted. Deleting rows does not shrink a SQLite file; the bytes stay in the freelist until
    `VACUUM`. The index is located by the engine's own `application_id`, so a database belonging to
    anything else is never opened. (This profile composes the engine `path: ':memory:'`, so there is
    usually no file at all — the step exists for deployments that configure a durable path.);
11. **a surviving conversation's stale checkpoint** — a parent's projection cache embeds its children's
    ids, so deleting a child leaves the parent advertising a session that can no longer be opened;
12. **crash-orphaned staging files** (`attachments/v1/tmp`) and **stale Workspace backups** — the
    atomic-publish backups under `~/.dsh/storages/` still name removed sessions, which is exactly the
    residue "delete it completely" is about.

The confirmation dialog states the figure **before** you confirm, and after the delete succeeds the same
dialog reports what it actually reclaimed, in bytes.

### Reclaiming the disk space: the lower half of the same dialog

A delete only takes the bytes the deleted Sessions **alone** referenced: one image pasted into two
conversations is one blob on disk, so deleting one of them keeps it (reported as *kept*) and deleting
the last one frees it. What an *earlier* delete left behind, or what a crash did — attachment objects
no surviving log names, staging files from a failed publication, expired provider upload records,
backups still naming removed sessions — is invisible to any single delete. So the confirmation dialog's
lower half is the **disk-space control**:

- it scans as the dialog opens (`dryRun`), stating the figure **before** anything is removed — the same
  honesty rule the delete preview follows;
- each lane that carries bytes is one row — unreferenced attachments, leftover staging files, expired
  upload-cache records, a compactable search index, stale backups — and **a lane with nothing in it is
  not listed**, so the section never reads as a wall of zeroes;
- **Reclaim now** is the only button that removes anything, and it reports what it freed afterwards;
  **Scan again** reports without touching anything;
- it **never deletes a conversation** — a subagent or a fork is a legitimate Session no Workspace
  record lists, so only a delete knows which lineage is going away;
- while the delete itself is in flight its controls are disabled, so the two never read as one action.

That is also why the plugin has no sidebar control of its own: one row in one menu, one dialog, both
jobs.

### Seeing the family, and choosing what goes with it

The sidebar lists a subagent session and a derived conversation as rows of their own, and nothing there
says which conversation spawned them; DSH itself never draws that relation. This dialog is the one
place it is drawn: the session's whole family as **one tree**, the branches below the branches
included.

- row 1 is this conversation, carrying the whole family's checkbox and named as the sidebar names it;
- row 2 is one collapsible **Subagents (n)** branch holding the subagents this conversation spawned;
- row 3 is one collapsible **Forked conversations (n)** branch, and each fork inside it keeps *its own*
  Subagents branch — so a fork of a fork is drawn inside its parent's block, one step further in,
  instead of being listed beside it. A subagent that spawned a conversation keeps that conversation
  inside the subagent's own block for the same reason;
- every row has a checkbox, its name and the tail of its id, and is badged when it is open or has
  unfinished work. Names follow the sidebar's own rule — the durable title, else the final segment of
  the project directory, else the id — so nothing reads as *untitled*;
- the nesting is the **indentation** alone, one step per level: a parent is followed immediately by the
  children it draws, so a level-3 row reads as hanging off the level-2 row above it rather than merely
  as "somewhere deeper".

A row's checkbox covers **its own subtree**: ticked when everything below it is ticked, mixed when only
part of it is, and pressing it takes or clears that whole subtree. A block's checkbox covers the rows
the block lists. The delete set is one set of ids, with no second "excluded rows" state beside it, so
the picture and the footer's count cannot drift apart.

Leads that could not be read are reported above the list (a branch whose directory would not open, for
example) instead of quietly costing rows: a missing row and a conversation that genuinely has no
children used to look exactly alike.

Confirming posts exactly the ticked ids and the button states how many conversations will go.
Unticked descendants survive as conversation roots. The selection is validated against the Host's own
walk, so a request can only ever name Sessions in that lineage. A fork is a conversation in its own
right, which is exactly why it is listed with a checkbox instead of being taken silently.

### What blocks a delete, and what does not

**Running work blocks it — being open does not.** The gate is DSH's own archive admission, the
`workspace/session-activity` waterfall: the Agent registry reports a running turn, the job registry
reports background jobs, the Subagent runtime reports running descendants, Schedule reports active
reminders. The question is asked **once per Session in the delete set**, because the admission answers
per Session: a descendant's running turn or background job is not reported when only the target is
asked. The dialog names what is still running — on each row and in the summary — and offers
**Stop and delete**, which dispatches `workspace/session-stop` for every busy Session first, exactly
what `archiveSession(id, { stopActivity: true })` does.

A session the Host still holds open (`ctx.sessions` / `ctx.agents`) is deleted anyway. Measured on
Windows: `rm` succeeds while the append handle is open, the directory entry disappears at once, and
later appends land in the unlinked file instead of resurrecting it. An earlier version refused such
sessions with "switch away first", which wrongly blocked conversations that were not on screen.

### Known limits

- **A blob is only reclaimed when no surviving log references it.** That is the correct rule, not a
  limitation: uploads are content-addressed, so the same image pasted into two conversations is one
  blob on disk. Deleting one of them keeps the blob and reports it as *kept*; deleting the last one
  frees it. A blob nothing references is reclaimed by the disk-space half of the same dialog.
- **The reclamation is best-effort by design.** It runs after the conversations are already gone, so a
  failure there is reported in `warnings` and never fails the delete — the remaining bytes are wasted
  space, not lost data.
- **A held-open session may leave one inert cache record.** If the Host still owns the session when
  it is deleted, its disposal can write one more projection checkpoint. That record is never read
  (no log means no session) — a few tens of KB of dead file, and the sweep clears it.
- **A page's own draft may need one more clear.** Deleting a conversation while its slot is still
  mounted lets a store re-write its key *after* the delete's own clear, because such a store keeps
  writing until the slot is disposed — which happens only once `api-session/removed` has propagated,
  after the delete returns. So the clear repeats on later ticks until a pass removes nothing. That
  repetition is what used to require quitting DeepSeek and editing the LevelDB by hand.
- **Plugin code changes need a DSH restart.** Host bundles are composed at boot: a profile whose HMR
  watches the manifest re-reconciles patches, but a newly *added* Host bundle is not mounted into an
  already-running backend. Restart the app to load this plugin's Host half. The client half appears
  after a page refresh.
- **The `request-images` lane is a regenerable cache.** It is keyed by a *request* hash rather than an
  attachment digest, so no log can attribute an entry to itself. It is swept by age (entries older
  than a week), never by conversation, and the bytes regenerate on demand.

## Install

Everything below goes through DSH's own plugin manager, which accepts an install spec
(`@deepseek-ai/dsh-plugin-manager`): a registry name, a git host shorthand, a repository URL, a
tarball, or an absolute local path. The npm route also works with a plain `npm install`, into the
profile directory. Pick whichever route your network allows.

### 1. From npm (published as `better-dsh-session-deletetool`)

The registry route, and the only one that does not need github.com:

```
npm install better-dsh-session-deletetool
```

DSH's own plugin manager takes the registry name directly, which is the better route inside the app:
it records the dependency in the profile and reloads it.

- **In the app:** Settings → Plugins → the install entry, paste `better-dsh-session-deletetool`.
- **Through an agent session:** `plugin_manager { action: "install_bundle", target: "better-dsh-session-deletetool" }`.

Pin a version the way npm writes it: `better-dsh-session-deletetool@0.4.0`.

### 2. Straight from GitHub (needs github.com reachable)

Spec:

```
github:Lzcdebear/better-dsh-session-deletetool
```

or, equivalently:

```
https://github.com/Lzcdebear/better-dsh-session-deletetool
```

Give it to DSH:

- **In the app:** Settings → Plugins → the install entry, paste the spec. (The Plugin Manager UI and
  the `plugin_manager` tool take exactly the same spec string.)
- **Through an agent session:** ask the agent to install it — the tool call is `plugin_manager` with
  `action: "install_bundle"` and `target: "github:Lzcdebear/better-dsh-session-deletetool"`.

Pin a ref with `#`: `github:Lzcdebear/better-dsh-session-deletetool#v0.1.0`.

If the connection check fails, DSH reports a bounded log path. On a network where github.com is not
reachable, use route 1, 3 or 4 — or point git at your proxy first
(`git config --global http.proxy http://127.0.0.1:7890`).

### 3. From a local copy (works offline)

Download the repository (ZIP or `git clone`), unpack it anywhere, then install the **absolute
directory**:

```
plugin_manager { action: "install_bundle", target: "D:\\plugins\\better-dsh-session-deletetool" }
```

DSH records a `link:` dependency and reloads the profile. This is the route used to develop the
plugin, and the one to use behind a restrictive network.

### 4. From the release tarball

```
https://github.com/Lzcdebear/better-dsh-session-deletetool/archive/refs/heads/main.tar.gz
```

Same install entry as route 2; useful when git is unavailable but HTTPS is not.

### After installing

The Host half loads with the profile. The Client half appears after the page is refreshed. The row
shows up in the session `⋯` menu as **删除会话 / Delete conversation**. The sidebar foot gains nothing
— this plugin adds no control of its own there.

To remove the plugin again, use the same manager:
`plugin_manager { action: "remove_bundle", target: "better-dsh-session-deletetool" }` (the bundle key is the
package name).

## Usage

1. Open the `⋯` menu on any session row and pick **Delete conversation**.
2. The dialog asks the Host for the session's real state and states it: what will be deleted,
   whether the Harness still holds it open, and what is still running.
3. It then draws the whole family as a tree to choose from: this conversation on its own row, then its
   **Subagents (n)** and **Forked conversations (n)** blocks, each derived conversation carrying its own
   level inside its block, and a checkbox on every row (title, id tail, state badge). Untick whatever
   you want to keep.
4. Confirm. The button states how many conversations will go; if work is running it reads
   **Stop and delete** and stops that work first.
5. The rows leave the sidebar at once, the data is gone from disk, and the dialog states how many
   bytes that freed.
6. To also reclaim what an earlier delete left behind, press **Reclaim now** in the same dialog's
   lower half: it states the figure first and reports what it freed afterwards. It never deletes a
   conversation.

## HTTP surface

The Client half reaches the Host over three same-origin `exact` routes on `ctx.webServer`. A
build-free plain-JavaScript bundle cannot declare a typed `ctx.remote` namespace (that needs
generated Typert descriptors), so this uses the same transport the community plugin `dshmarket`
uses.

| Route | Method | Purpose |
|---|---|---|
| `/better-dsh-session-deletetool/inspect?sessionId=…` | GET | `stored` / `open` / `agent` / `running` / `activity` / `artifactDirectory` / `warnings` (the leads that could not be read, so a missing branch is never mistaken for a childless one), `reclaim` = the bytes a delete would free, and `descendants` = `{ count, subagents, derived, truncated, maxDeletable, items[] }` where each item carries `id`, `kind`, `depth`, `parentId`, `title`, `open`, `agent`, `running` and its own `activity` |
| `/better-dsh-session-deletetool/delete` | POST | body `{ sessionId, stop?, descendants? }` — `descendants` omitted means the whole family, an empty array means the session alone; returns `removed`, `descendants` (each with its `kind`), `kept`, `stoppedActivity`, `terminalsKilled`, `warnings`, `runtime`, `activity`, and `reclaimed` = `{ attachments, staging, uploadCache, searchIndex, checkpoints, backups, bytes, warnings }`. A name outside the family is refused with `400 unknown-descendant` before anything is removed |
| `/better-dsh-session-deletetool/sweep` | POST | body `{ dryRun?, pruneExpiredCache?, pruneBackups? }` — reclaims bytes no conversation references any more: unreferenced attachment objects, stale staging files, expired provider upload-cache records, a compacted search index, and stale Workspace backups. `dryRun: true` reports without removing. Returns the same `reclaimed` shape as a delete. **No conversation is ever removed by a sweep** — a subagent or fork is a legitimate session that no Workspace record lists, so only a delete knows which lineage is going away |

All three routes carry their own same-origin gate: `Host` must be loopback, `sec-fetch-site` must not
be `cross-site`, and a present `Origin` must match `Host`. Another site's page cannot reach them.

## Layout

| File | Role |
|---|---|
| `host.js` | Host half: the three routes, artifact/accounting/cache removal, and the subagent subtree |
| `client.js` | Client half: the `sidebar.workspaces.session.menu.item` row (order 500), one `shell.overlay` dialog carrying both the delete and the disk-space control, and the page's own `localStorage` cleanup |
| `reclaim.js` | The on-disk layout: multi-frame zstd logs, structural attachment references, the content-addressed object lanes, the provider upload cache, checkpoints, and backups |
| `reclaim-host.js` | Reclamation orchestration: the before/after reference count, the delete-time reclaim, and the standalone orphan sweep |
| `search-index.js` | The derived SQLite index: locate it by the engine's `application_id`, purge a session's rows, and compact the file |
| `cordis.patch.yml` | Inserts the Host row into the profile's layer stack |
| `test/host.test.mjs` | Route tests over real temporary directories |
| `test/reclaim.test.mjs` | Reclamation tests: reference counting, shared blobs, the upload cache, the search index, and the sweep |
| `test/client.test.mjs` | Client-half tests: byte formatting, the sweep section, the exact `localStorage` keys a delete may touch, and how a re-written key is cleared again |
| `icon.svg` | Plugin artwork |

Styles use only host theme tokens (`--dsw-alias-*`), so light and dark both read; the UI is
localized (English / 简体中文) through the Client locale service.

## Tests

```sh
node --test test/host.test.mjs test/reclaim.test.mjs test/client.test.mjs
```

Every test is pinned to a throwaway Harness home created inside the test, so a run can never read or
modify the live `~/.dsh`. The reclamation tests write real multi-frame zstd logs in the shape the
backend writes them, and the client tests load the real bundle with a stubbed `window` and a real
`localStorage` implementation.

## Development

```sh
node --test test/host.test.mjs
```

The tests drive the real `apply()` registration against fake Host services and real temporary
directories: deletion, the running-work gate and its stop path, the subagent subtree, the inspect
report, that the sweep never removes a conversation, and the refusal paths (bad id, bad body, wrong
method, cross-site origin).

## License

[MIT](LICENSE) — inherited from upstream; copyright belongs to the original author.

## Author

**Upstream original:** 陆知辰 (Lzcdebear) — [GitHub](https://github.com/Lzcdebear/better-dsh-session-deletetool),
[Bilibili](https://space.bilibili.com/220996778)

**Local fork:** local modifications on top of upstream 0.5.2, recorded from CHANGELOG 0.6.0 onward.
It carries no claim to the original author's credit or standing. File upstream issues on his
repository; local changes are yours to handle.
