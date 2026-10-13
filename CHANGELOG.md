# Changelog

> **这是本地派生版。** 上游原版是 [Lzcdebear/better-dsh-session-deletetool](https://github.com/Lzcdebear/better-dsh-session-deletetool)
> （npm 同名包），本目录是它的一个 fork：0.5.2 之前的条目属于上游，0.6.0 起是本地改动。
> 本仓库：[Zhangkaiwen2001/better-dsh-session-deletetool](https://github.com/Zhangkaiwen2001/better-dsh-session-deletetool)。
> 装法是 profile 的 `link:` 本地路径依赖，DSH 的插件管理没有任何更新动作，所以**这个版本不会被覆盖**。

## 0.6.0

**The bulk delete is gone, and the disk-space control moved into the delete dialog.**

Bulk delete was the wrong shape, and the way it failed said so. It could not delete a conversation the
Host still held: the files went, the row stayed, and the sidebar only caught up once DeepSeek was quit
— which meant the feature needed the app to be closed to do its job. There was also no honest way to
say which of two families a subagent belonged to when the list showed every conversation at once, and
the second entry point competed with the `⋯` menu for a job that menu already does properly, one
conversation at a time.

So the batch surface is removed entirely, and what it was for is carried by the single path:

- **No sidebar control of the plugin's own.** The trash icon in the sidebar foot, the bulk dialog, the
  `/catalog` route and the `/delete-batch` route are all gone. The `⋯` menu row is the whole entry
  surface, and its dialog now carries both jobs.
- **The disk-space control is the lower half of that dialog.** It scans when the dialog opens
  (`dryRun`), lists each lane that carries bytes — unreferenced attachments, leftover staging files,
  expired upload-cache records, a compactable search index, stale backups — and a lane with nothing
  in it is not listed, so the section never reads as a wall of zeroes. **Reclaim now** removes and
  reports what it freed; **Scan again** reports without touching anything. It still never deletes a
  conversation, and while the delete itself is in flight its controls are disabled, so the two never
  read as one action.
- **The dialog states what the delete freed.** It used to close the moment the Host answered; now it
  switches to a result line naming the reclaimed bytes, with the sweep half still live underneath —
  the bytes an *earlier* delete left behind are not this delete's business.

**A delete no longer needs the app to be quit to clean up after itself.** The shipped stores are
`attachPersistence` subscribers that re-write their key on the next state change, and a slot is
disposed only once `api-session/removed` has propagated — which is after the delete returns. So
deleting a conversation that is open right now let a store re-create its key *after* the clear, and
that key survived the whole session: the row's draft came back, and the only way out was an external
LevelDB edit with the app closed. The clear now repeats on later ticks until a pass removes nothing,
which is the signal that the slot has been disposed and its store has stopped writing. Bounded, so a
store that never settles cannot keep the page busy.

Regression cover: the sweep section's rendering (figure before action, zero lanes absent, the empty
case saying so rather than reporting a zero as a success, inert while a delete runs, a failed scan
still re-runnable), a key a mounted store re-writes being cleared again on a later tick, the re-clear
stopping once the keys stay gone, that no bulk route is mounted any more, that a delete reports the
bytes it reclaimed, and that the sweep route never removes a Session whatever the body asks.

Counts, measured against a real profile: 46 tests.

## 0.5.2

**A single-conversation delete no longer reports a failure after succeeding.** The two delete routes
answer with **different** `removed` shapes, and the Client half read both as a list:

- `POST /delete` answers with the root's own removal report as an **object**
  (`{ sessionId, artifactDirectory, removed, workspaces, projectionCheckpoint, warnings }`);
- `POST /delete-batch` answers with an **array** of those reports, one per root.

Iterating the object threw `object is not iterable` — and because `removed` was only read *after* the
Host had already deleted the conversation, the dialog showed a failure for a delete that had actually
worked. It looked cosmetic; it was not, because the throw happened **before** the page cleared its own
`localStorage`, so the deleted conversation's drafts and panel layouts stayed behind.

`removed` is now normalised to a list (accepting an object, an array, or neither) and the ids are
deduplicated, because the single-session answer names the root both at the top level and again as its
own report. Verified against a real booted profile: the live `POST /delete` answer carries
`removed` as an object, and the fixed client consumes that exact payload, throwing nothing and clearing
two storage keys.

Regression cover: two tests over the real answer shapes — the object form must not throw, and an answer
naming the root twice must not double-count.

## 0.5.1

**The two maintenance controls moved out of the workspace header.** They were mounted into the
browsing region's search cell — a fixed 28px box holding exactly one icon — and widened it with a
`:has()` override, which overlapped the **view options** and **add workspace** buttons beside it. The
cell was the wrong seat: the shell renders actions of this kind in `sidebar.footer.action`, a `list`
slot that lays out full-width rows above the settings control and passes each registrant the current
`wide` flag.

The controls are now ordinary registrants of that slot: labelled rows in the wide sidebar, 36px circles
in the 56px rail, matching the shipped footer controls and the plugin panel. The portal, the
`MutationObserver` and the `!important` override are gone, so nothing in the client half reaches into
the shipped layout any more. Two defects the new tests caught while making the change: a label passed
as a `children` prop was silently dropped (React lets explicit children win), and the rail variant had
to drop the label to stay a circle.

Regression cover: three tests over the rendered component — the footer row shape, the rail collapse,
and that each control contains its click.

## 0.5.0

**A delete now frees the disk space it used to leave behind.** Removing a conversation's log was never
the whole story: the shipped store is content-addressed and shared, so the bytes a conversation brought
in stayed on disk. Four new modules close that gap.

- **`reclaim.js`** — the on-disk layout. It reads a session log the way the backend writes it (a DSH log
  is a *sequence* of zstd frames, so decompressing the file as one stream yields only the first frame)
  and collects attachment references **structurally**, from parsed `attachmentId` fields. A hash quoted
  inside message text is not a reference; grepping for one reports references that do not exist, which
  this plugin's own investigation output demonstrates.
- **`reclaim-host.js`** — the orchestration. The load-bearing rule is that a blob may only be unlinked
  when **no surviving session log references it**, so the reference count is read *before* the logs are
  removed and confirmed *after*. A blob shared with a kept descendant survives and is reported as kept.
- **`search-index.js`** — the derived full-text index. Deleting rows does not shrink a SQLite file, so a
  purge ends in `VACUUM`; the file is found by the engine's own `application_id`, which is the same guard
  the engine uses to refuse a database that belongs to something else.
- **Client half** — `dsh.conversation.<id>`, `dsh.sidebar-right.v1.<id>`, `dsh.sidebar-browser.v1.<id>`,
  `dsh.user-questions.drafts.v1.<id>` and `dsh.schedule.task-tab.v1.<id>` are removed by the page, which
  is the only half that can reach `localStorage`.

The delete response now carries a `reclaimed` report — attachment, staging, upload-cache, search-index,
checkpoint and backup bytes — and the confirmation dialog states the figure before anything is removed.
A fifth route, `POST /sweep` (with `dryRun`), reclaims what an *earlier* delete left behind without
touching any conversation; it has its own control beside the bulk one.

Two real defects were found and fixed while building this, both caught by running the plugin against a
live profile rather than by reading it:

- `ctx.config` is gated behind a Cordis `inject` declaration, so reading it without one threw at
  activation and took the whole profile row down. The home now comes from the plugin's own config or
  `$DSH_HOME`/`~/.dsh`.
- The upload cache's real shape is `{ formatVersion, records: [...] }`; the first cut walked it as a
  nested map and would have left every record behind.

Counts, measured against a real profile: 37 tests, a delete of one conversation with five subagents that
returned 2 attachments (129,825 B), 2 upload-cache records and 1 stale backup, and reduced
`~/.dsh/sessions` from 8,428 KB to 3,088 KB with the surviving conversation untouched.

## 0.4.1

**The package is on npm, and the READMEs say how to install it.** `better-dsh-session-deletetool@0.4.0`
is published, so the npm route is now the first install section: `npm install
better-dsh-session-deletetool`, or the plugin manager's install entry with the same registry name. The
GitHub, local-copy and tarball routes moved down one number each. Nothing about the plugin changed.

## 0.4.0

**The package is `better-dsh-session-deletetool` now.** Every name that pointed at the old identity was
renamed in one pass, so nothing resolves the old spelling any more:

- the npm package name, the GitHub repository (`Lzcdebear/better-dsh-session-deletetool`), and the
  `repository` / `homepage` / `bugs` URLs plus every install target in the READMEs;
- the four Host routes: `/better-dsh-session-deletetool/inspect`, `/delete`, `/catalog` and
  `/delete-batch`;
- the client module id, the locale namespace, the sidebar menu row, both `shell.overlay` seats and the
  bulk anchor's registration ids, the `data-dsh-plugin` marker, and the React display name;
- the Host loader row in `cordis.patch.yml` — both the row `id` and the module `name` the profile
  imports;
- the Host's `[better-dsh-session-deletetool]` log prefix and its effect labels.

**The family view is written down now.** The dialogs have drawn a conversation's subagents and derived
conversations as one tree for several releases, but neither README said so out loud. Both now open that
section by saying that the sidebar cannot show the relation and the dialog is the one place it is
drawn, and the npm description says it too.

A profile that had the old name linked has to link the new one: the bundle key in
`dsh.profile.bundles` and the dependency key in the profile's own `package.json` both change.

## 0.3.9

**Both dialogs now draw the same family tree.** The single conversation's dialog and the bulk one share
one renderer: a row per Session, and under every row a collapsible **子智能体 (n)** block followed by
a collapsible **派生对话 (n)** block holding that row's own direct children. A derived conversation
keeps its own subagents *and* its own derived conversations inside its own block, one step further in,
so a fork of a fork is nested where it belongs instead of appearing in a second list that only shares
a heading with its parent.

**The duplicated rows are gone.** 0.3.7 drew each family twice over, once per relation, each pass
walking the whole forest: a subagent hanging under a fork was listed both flat in the root's 子智能体
branch and again inside its real parent. One forest is now built once (`buildForest`) and drawn once
(`FamilyTree`), so every row is drawn by exactly one parent — which is what makes the shape readable.

**Every row's checkbox means its own subtree.** A row is ticked when everything below it is ticked,
mixed when only part of it is, and pressing it takes or clears that whole subtree; a block's checkbox
covers the rows the block lists. The old "selected roots plus excluded children" pair is gone: the
delete set is one set of ids, so the picture and the count can no longer drift apart.

**In the bulk dialog a child can now be ticked on its own.** Every ticked row whose parent is not
ticked is sent as a delete root of its own, carrying the ticked rows below it — so ticking a single
subagent deletes just that subagent, and ticking a parent takes its selected family with it.

**Each row carries its kind's glyph**: a document for a conversation, a robot head for the 子智能体
block and a person for a subagent, a chain for the 派生对话 block and a chat bubble for a derived
conversation — 16px outline paths, `fill: none`, `stroke: currentColor`, matching the icon set they
sit beside. Nothing else changed: the nesting is still the indentation alone, one step per level, with
no connectors and no guide lines.

## 0.3.7

**The connector lines are gone.** The tree's nesting is the indentation alone: one step per level, the
same reading the rest of the sidebar uses. A drawn guide line under every parent added nothing the
indent did not already say, and it made the rows busier than the list they sit in.

Everything else from 0.3.6 stands: row 1 is this conversation, row 2 is its own subagent branch, row 3
is the forked conversations with each fork's subagents inside it and a fork of a fork nested in its
parent's block.

## 0.3.6

**The picker is the family tree now, drawn as one.** 0.2.1's two flat lists could not say what the
reference layout says, so the dialog is drawn that way from the top down:

- row 1 is this conversation, carrying the whole family's checkbox and named as the sidebar names it;
- row 2 is one collapsible **子智能体 (n)** branch holding this conversation's own subagents;
- row 3 is one collapsible **派生对话 (n)** branch, and each fork inside it keeps *its own* subagent
  branch — so a fork of a fork is drawn inside its parent's block, indented one more step, instead of
  being listed beside it. A subagent that spawned a conversation keeps that conversation inside the
  subagent's own block for the same reason.
- Guide lines drop from each parent to the children it draws, and indent tracks the tree, so a level-3
  row reads as hanging off the level-2 row above it and not merely as "somewhere deeper".

**The layout came from the sketch, not the data model.** The Host still answers one deepest-first
list; the client arranges it into a tree and draws each branch as a *view* of that tree, indented from
the nearest ancestor the branch actually draws. Nothing is ever indented under a row that is not on
screen.

**Ticks are derived, not stored twice.** A row is in the delete set when it is a selected root or sits
beneath one. A subagent is a Session of its own, so a fork's checkbox reports the subagents under it
without claiming them for a second delete — which is what kept the footer's count honest.

## 0.3.5

**A group now shows its own nesting.** 0.3.4 arranged the family as one tree but then filtered it into
the two groups, and filtering flattened the tree: a level-2 child stayed indented under a level-1
parent the group did not draw, so nothing on screen said which level-1 child it belonged to.
`groupNodes` walks the arranged family in pre-order and counts each group's indent from the nearest
ancestor *that group draws*, so a parent is followed by its own children, one step in, and the next
family starts at the top of the column again. A group's checkbox, its root rows and the delete payload
are unchanged: a picked row still answers to the same root it did before.

**The family's read failures are reported, not swallowed.** The descendant list comes from two durable
sources, and either one failing used to be invisible — the dialog simply drew fewer rows, which is
indistinguishable from a conversation that genuinely has no children. `/inspect` now carries the
warnings it collected (a catalog that would not open, a branch that could not be read), and the
per-Session dialog prints them above the list.

## 0.3.4

**The per-Session picker is 0.2.1's layout again, with the lineage fixed.** 0.3.2 removed the two
collapsible groups to fix a nesting bug; that threw away a shape that was doing its job, so the groups
are back: one master row, then *subagent conversations* and *forked conversations*, each with its own
count, its own checkbox and its own disclosure caret, and every row keeps its title, its id tail and
its state badges.

**What actually changed is where a row's position comes from.** Both 0.2.1 and 0.3.2 drew rows in the
order the Host sent them, and the Host sends the family deepest-first because that is the order its
own delete walk wants. Splitting that into groups put a grandchild in one group and its parent in
another, where the grandchild became a top-level row and drew indented above the row it hangs under.
The whole family is now arranged once — every row follows the row it hangs under, with the depth
counted from the nearest row the picker actually draws — and only then split by relation, so each
group keeps its own order without ever inverting a parent and its child.

**Indentation is one step per level.** Rows are indented by the arranged depth alone (16px a level, the
same step the bulk dialog uses), where 0.2.1 added a fixed extra level for every row: a
one-level-deep child read as though it hung off something that was not there.

## 0.3.3

**Missing subagents in the per-Session dialog, fixed at the source.** The family was read from two
places, and the subagent half leaned on `ctx.subagents.listDescendants`, which walks that service's
own session store: when that lookup is unavailable, the call throws and *every* subagent disappears
from the dialog at once, leaving only the forked conversations the header lineage names. The catalog
is now read the way the Subagent runtime itself reads it — per parent, from that parent's own
`subagentCatalog` projection through `sessionQuery.observeSession` — and walked from the target
downwards. The service call is still made, merged by closest depth, so neither source is a single
point of failure. Observation leases are freed through `Symbol.dispose` in a `finally`: the lease has
no `release()`, and a walk that never disposed would pin every parent it read in the query cache.

**Nesting now comes from the right parent.** Because the walk descends through each parent's own
catalog, a subagent a *child conversation* spawned is listed under that child rather than under the
target, and the header lineage now descends through children the catalog did not produce too. So the
dialog draws one family per level:

```
母会话
  子代理
  子会话
    子会话 1 的子代理
  子会话 2
    子会话 2 的子代理
```

## 0.3.2

**The 子 / 母 label is gone.** The nesting reads from indentation alone, as it does in the rest of the
sidebar. A family shows its shape: one step of indent per level, parents above their own children.
The catalog still reports `hasChildren` and the family counts, so nothing else had to change.

**The per-Session picker draws the family as one tree.** It used to split the descendants into two
collapsible groups by relation — *subagent conversations* and *forked conversations* — and arrange
each group on its own. A grandchild whose parent landed in the other group was therefore drawn as a
top-level row, indented, above the row it actually hangs under. The family is now arranged as a whole
with the same rule the bulk view uses, so every row follows the row it hangs under and the
indentation is the nesting. The per-kind groups and their collapse controls went with it: the list is
one tree, and the master checkbox still clears or takes the whole family.

## 0.3.1

Four fixes to the bulk view, three of them visible on first use.

**The glyph's colour now matches its neighbours.** The control was drawn as the source SVG is
authored — a filled glyph — while the shipped product icon set is outline-only (`fill: none`,
`stroke: currentColor`, `strokeWidth: 1` on a 16px box). A filled path painting a 32-unit outline
shape rendered as a blob at 16px, so the button looked empty beside the search icon. The glyph is now
stroked in the icon set's own convention, with the stroke scaled for the halved viewBox.

**Every row carries its 子 / 母 mark.** A conversation with no children of its own in the list left
the mark blank. A row that is not a child now reads as 母 by default, so the three states are 母,
子, and 子母 for a child that has children of its own. The mark's cell is sized for two characters, so
子母 no longer shifts the title along.

**Names come from the Session, not from "untitled".** The title read was wrong: the folded snapshot
is `{ session, title: { title, … } }`, and the code read `value.title` — an object, which failed its
own string check, so every Session reported no title and both dialogs fell back to *untitled*. Rows
now resolve a display name the way the sidebar does: the durable title when the log carries one, else
the final segment of the project directory, else the id. That fixes the bulk list and the 0.2.1
per-Session dialog together, the latter including its subagent and forked children, which now read as
the project directory rather than *untitled* when they were never renamed.

**Lineage children can carry their own directory.** The descendant walk now passes each child's
`cwd` from its header, so a descendant that was never named falls back to its project directory
before falling back to its id.

## 0.3.0

One control beside the workspace search icon deletes many conversations at once.

**A bulk entry beside the search icon.** The sidebar's workspace header gains a trash control, drawn
from `deleting icon.svg`, immediately left of the search icon. It opens one dialog for every
conversation the Host knows.

**The list is grouped by Workspace and keeps lineages together.** Rows are sectioned by the Workspace
that owns the conversation's directory, in the registry's own order, with one "未归类" section for
conversations no Workspace owns. Inside a section, parents lead their children, indented by lineage
depth. Every row leads with the blue **子** / **母** mark: `母` for a conversation with children in
this list, `子` for one spawned as a subagent or forked off another, `子母` for both.

**Selection follows the family, per row.** Ticking a parent takes its whole family with it; ticking a
child selects it on its own. A child can be taken back off a ticked family without untick-ing the
parent, and the footer always states how many conversations the press will delete. The dialog carries
the same "stop unfinished work first" choice the single-Session dialog offers.

**API.** `GET /catalog` answers
`{ ok, workspaces: [{ key, workspaceId, title, path, sessions[] }], totals }`, and each session row
carries `id`, `kind` (`root` / `subagent` / `derived`), `depth`, `parentId`, `hasChildren`, `family`,
`subagents`, `derived`, `title`, `cwd`, `open`, `agent`, `running` and `activity`.
`POST /delete-batch` takes `{ roots: [{ sessionId, descendants? }], stop? }` and answers
`{ ok, roots, removed[], failed[] }` — one entry per root, so a failing root is reported without
aborting the rest.

**Where the control is mounted, and why.** `sidebar.workspaces` is a `single` slot, so a second
registrant would shadow the shipped browser instead of sitting beside it. The plugin therefore
registers in `sidebar.footer.action` (which renders nothing itself) and mounts its control into the
browsing region's own search slot through a portal and one `MutationObserver`, re-creating the
control whenever React re-renders that header. The insertion carries no authority: it only opens the
dialog, and the two Host routes above do all the work. If a future harness renames that slot's CSS
class, the control stops appearing and nothing else changes.

**Unchanged.** The per-Session "⋯" menu entry and its descendant picker behave exactly as in 0.2.1;
the bulk path calls the same delete for each selected conversation.

## 0.2.1

Deleting a conversation is a choice now, not a take-it-all.

**Pick what goes with it.** The confirmation dialog lists the session's whole family and lets you
choose:

- one **delete all** checkbox, with an indeterminate state when the selection is partial;
- one collapsible group per relation — *subagent conversations* and *forked conversations*;
- one checkbox per descendant, indented by lineage depth, labelled with its title and the tail of its
  id, and badged when it is open or still has work running.

Confirming posts exactly the ticked ids, and the button states how many conversations will go.
Unticked descendants survive as conversation roots.

**The family is complete and the selection is validated.** Descendants come from the header lineage
every Session carries (`SessionHeader.parentSession`) — which covers subagent sessions, forked
conversations, and the child Sessions Agent Teams provisions — unioned with the durable
`subagentCatalog` projection for children whose own header no longer reads. The Host validates the
client's selection against its own walk, so a request can only ever name Sessions in that lineage
(`400 unknown-descendant` otherwise). Omitting the field still means "all of them".

**A gate bug, fixed.** Running work was only checked for the target Session, but DSH's archive
admission answers per Session: a descendant's running turn or background job was invisible, so a child
could be deleted mid-run. Every Session in the delete set is now asked, the refusal names each busy
Session (`activeSessions` in the details, badges on the rows), and `stop: true` dispatches
`workspace/session-stop` for all of them.

**Shells no longer outlive their conversation.** Terminals belong to no admission family, and the
service only reaps them when the Agent is released — which can be long after the log is gone. Each
deleted Session's terminals are now closed, reported as `terminalsKilled`.

**API.** `GET /inspect` answers with `descendants: { count, subagents, derived, truncated,
maxDeletable, items[] }`, each item carrying `id`, `kind`, `depth`, `parentId`, `title`, `open`,
`agent`, `running` and its own `activity`. `POST /delete` takes `{ sessionId, stop?, descendants? }`
and answers with `kept`, `terminalsKilled` and `warnings` beside the per-Session reports. The
request-body ceiling is 64 KiB so a few hundred ids fit, and the 200-per-request cap applies to the
selection rather than to the whole family.

**Audited, deliberately unchanged.** Attachment blobs stay (content-addressed and shared; the service
has no reference counting), and the derived search index keeps reconciling itself.

## 0.2.0

- **Forked conversations are deleted with their source.** A descendant is now read from the header
  lineage every Session carries (`SessionHeader.parentSession`), which DSH writes for both
  relations: the Subagent runtime sets it with `origin: 'subagent'`, and a fork sets it with
  `isSeeded`. 0.1.0 walked only the subagent catalog, so a conversation forked off the deleted one
  survived.
- The confirmation dialog names what goes with the delete by kind — *N subagent conversations* and
  *N conversations forked off it* — so deleting a family is never silent.
- `/inspect` reports `descendants: { count, subagents, derived, ids, capped }`.
- Each descendant report in the delete response carries its `kind` (`subagent` / `derived`).
- The lineage walk is breadth-first with a visited set and a depth cap: DSH's own lineage traversal
  has no guard against a hand-edited `parentSession` cycle.

## 0.1.0

First release.

- Adds a **Delete conversation** row (order 500) to every session's `⋯` menu, with a confirmation
  dialog that states the session's real state before committing.
- Removes the session's artifact directory (every retained format generation), its workspace
  account, its archive/pin membership, and its projection-cache record, then emits
  `api-session/removed` so connected pages drop the row at once.
- Removes subagent descendants too, deepest first, collected before anything is deleted and capped
  at 200 sessions per delete.
- Gates on running work only (DSH's own `workspace/session-activity` admission), with a
  **Stop and delete** path that dispatches `workspace/session-stop` first.
- Deletes sessions the Host still holds open, instead of refusing them: measured on Windows, `rm`
  succeeds with the append handle open and later appends do not resurrect the file.
