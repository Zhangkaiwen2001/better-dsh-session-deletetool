/**
 * better-dsh-session-deletetool — Host half.
 *
 * Local fork of Lzcdebear/better-dsh-session-deletetool. The code through 0.5.2 is
 * his; the changes from 0.6.0 on are local, and this file carries no claim to his
 * authorship. It is installed as a `link:` local-path dependency, and DSH's plugin
 * manager has no update action, so a newer upstream release never lands here.
 *
 * DSH can only archive a conversation: `ctx.workspaceRegistry.archiveSession()`
 * hides a Session from the sidebar and keeps every artifact. The persistence
 * seam has no deletion API either — `@deepseek-ai/dsh-session-persistence-jsonl`
 * documents "Nothing deletes session files — logs accumulate under `root` until
 * removed externally; the seam has no deletion API".
 *
 * This plugin adds the missing delete. For one session id it removes:
 *   1. the Session's own artifact directory (every format generation in it),
 *   2. its account in every Workspace record, plus archive and pin membership,
 *   3. its projection-cache checkpoint record,
 * then emits `api-session/removed` so connected Clients drop the row — the same
 * event the shipped Session controller emits when a Session is disposed.
 *
 * Descendants are selected, not assumed, and the family is read from both durable
 * relations because neither one alone is complete:
 *
 * - **The subagent catalog** — each Session's own `subagentCatalog` projection,
 *   the parent-owned record of the Sessions it spawned — walked from the target
 *   downwards, so a subagent is listed under the Session that spawned it rather
 *   than under the target. (The service's `subagents.listDescendants` is asked as
 *   well; it needs the live Session store, so it can fail wholesale, which is
 *   exactly the case the per-parent walk survives.)
 * - **The header lineage** (`SessionHeader.parentSession`) — the relation the
 *   catalog has no row for at all, which is what a forked conversation is, plus
 *   its own view of subagent Sessions and the project directory each child's
 *   header carries for display naming.
 *
 * `GET /inspect` returns that family as a list — id, kind, depth, parent, title,
 * whether it is open, and what it is running — and `POST /delete` takes the ids
 * the user ticked. The selection is validated against the Host's own walk, so a
 * crafted request can only ever name Sessions in this lineage. Descendants are
 * removed deepest first, and the family is gathered before anything is removed.
 *
 * `POST /sweep` is the disk-space control, and it lives in the same dialog as
 * the delete: it reclaims what no surviving Session references any more —
 * unreferenced attachment objects, staging files a crashed publication left
 * behind, expired provider upload records, and stale Workspace backups — and it
 * never removes a Session, because only a delete knows which lineage is going
 * away.
 *
 * What may block a delete is RUNNING WORK, never mere residency, and the question
 * is asked once per Session in the delete set: the shipped admission answers for
 * the Session it is asked about, so a descendant's running turn or background job
 * would be invisible if only the target were asked. A Session the Host still holds
 * open (`ctx.sessions` / `ctx.agents`) is deleted anyway: measured on this
 * platform, `rm` succeeds while the append handle is open, the directory entry
 * disappears at once, and later appends land in the unlinked file instead of
 * resurrecting it. The gate itself is DSH's own archive admission — the
 * `workspace/session-activity` waterfall the shipped archive uses, answered by the
 * Agent registry (a running turn), the job registry, the Subagent runtime, and
 * Schedule. Pass `stop: true` to stop that work first, exactly as
 * `archiveSession(id, { stopActivity: true })` does. Each deleted Session's own
 * shells are closed too: terminals belong to no admission family, and the service
 * only reaps them once the Agent is released.
 *
 * The Client half reaches this half over three same-origin HTTP routes on
 * `ctx.webServer`, the transport the installed community plugin `dshmarket`
 * uses for its own UI→Host calls: a build-free plain-JavaScript bundle cannot
 * declare a typed `ctx.remote` namespace, because those need generated Typert
 * descriptors.
 */
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import { previewReclaim, reclaimAfterDelete, sweepOrphans, usedDigests } from './reclaim-host.js'
import { homePath } from './reclaim.js'

/** Services activation waits for; everything else is looked up per request. */
export const inject = ['webServer']

/**
 * The pure halves of the routes, exported only for a test run.
 *
 * The Loader reads `apply` and `inject`; a test imports this module directly and
 * sets `globalThis.__DSD_TEST__` before it does.
 */
export const __test = globalThis.__DSD_TEST__ === true
  ? { selectDescendants, describeActivity, sameOrigin }
  : undefined

const DELETE_PATH = '/better-dsh-session-deletetool/delete'
const INSPECT_PATH = '/better-dsh-session-deletetool/inspect'
const SWEEP_PATH = '/better-dsh-session-deletetool/sweep'

/** Session ids are opaque strings, but never paths: keep them to safe segments. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

/**
 * Request-body ceiling. The delete body carries the ticked descendant ids, and
 * the cap it is validated against is MAX_DESCENDANTS, so this has to hold a few
 * hundred of them.
 */
const MAX_BODY_BYTES = 65536

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/** The families `workspace/session-activity` can report, in the reader's words. */
const ACTIVITY_LABELS = {
  turn: '进行中的回合',
  subagent: '运行中的子智能体',
  job: '运行中的后台任务',
  schedule: '生效中的定时提醒',
}

/** How many descendant Sessions one delete request may carry before it aborts. */
const MAX_DESCENDANTS = 200

/** How many descendants the state report lists for selection; beyond this only the count is shown. */
const MAX_LISTED_DESCENDANTS = 300

/** How deep the lineage walk may go; a guard against a hand-edited header cycle. */
const MAX_LINEAGE_DEPTH = 64

/** A refusal carrying the HTTP status, stable code, and details the Client reports. */
class DeleteRefusal extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'DeleteRefusal'
    this.status = status
    this.code = code
    this.details = details ?? {}
  }
}

/**
 * Register the delete, inspect and sweep routes.
 * @param {object} ctx - Host Cordis context.
 */
export function apply(ctx, config) {
  // The Harness home is where every reclaimed artifact lives. The plugin's own
  // config carries an optional `dshHome`; without it the resolution falls through
  // to `$DSH_HOME`, then `~/.dsh`, in `homePath()`. Tests pass a temporary home
  // here so a run can never touch the live profile.
  //
  // `ctx.config` is deliberately not consulted: Cordis gates that property behind
  // an `inject` declaration and reading it without one throws at activation,
  // which would take the whole profile row down.
  const configuredHome = typeof config?.dshHome === 'string' && config.dshHome !== ''
    ? config.dshHome
    : undefined
  const onDelete = (request, response) => {
    void serveDelete(ctx, request, response, configuredHome).catch((error) => {
      ctx.logger?.warn?.(`[better-dsh-session-deletetool] route failure: ${messageOf(error)}`)
      send(response, 500, { ok: false, code: 'internal', message: messageOf(error) })
    })
  }
  const onInspect = (request, response) => {
    void serveInspect(ctx, request, response, configuredHome).catch((error) => {
      ctx.logger?.warn?.(`[better-dsh-session-deletetool] route failure: ${messageOf(error)}`)
      send(response, 500, { ok: false, code: 'internal', message: messageOf(error) })
    })
  }
  const onSweep = (request, response) => {
    void serveSweep(ctx, request, response, configuredHome).catch((error) => {
      ctx.logger?.warn?.(`[better-dsh-session-deletetool] route failure: ${messageOf(error)}`)
      send(response, 500, { ok: false, code: 'internal', message: messageOf(error) })
    })
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: DELETE_PATH, handler: onDelete }),
    'better-dsh-session-deletetool: delete route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: INSPECT_PATH, handler: onInspect }),
    'better-dsh-session-deletetool: inspect route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: SWEEP_PATH, handler: onSweep }),
    'better-dsh-session-deletetool: sweep route',
  )
  ctx.logger?.info?.(
    `[better-dsh-session-deletetool] routes mounted at ${DELETE_PATH}, ${INSPECT_PATH} and ${SWEEP_PATH}`,
  )
}

/**
 * Own one reclamation sweep: return the bytes nothing references any more.
 *
 * This is the control for garbage a *previous* delete left behind — attachment
 * objects orphaned before the plugin knew about them, staging files from a
 * crashed publication, expired provider uploads, and Workspace backups naming
 * Sessions that no longer exist. It never removes a Session: only a delete knows
 * which lineages are going away, because a subagent or fork is a legitimate
 * Session that no Workspace record lists.
 *
 * `POST` with `{ dryRun: true }` reports without touching anything, which is what
 * the dialog asks for first.
 * @param {object} ctx - Host Cordis context.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {import('node:http').ServerResponse} response - the response.
 */
async function serveSweep(ctx, request, response, configuredHome) {
  if (request.method !== 'POST') {
    send(response, 405, { ok: false, code: 'method-not-allowed', message: 'only POST is accepted' })
    return
  }
  if (!sameOrigin(request)) {
    send(response, 403, { ok: false, code: 'untrusted-origin', message: 'the request did not come from this Harness page' })
    return
  }
  let body
  try {
    body = JSON.parse((await readBody(request)) || '{}')
  } catch (error) {
    send(response, 400, { ok: false, code: 'bad-request', message: messageOf(error) })
    return
  }
  try {
    const report = await sweepOrphans(ctx, {
      configuredHome,
      dryRun: body?.dryRun === true,
      pruneExpiredCache: body?.pruneExpiredCache !== false,
      pruneBackups: body?.pruneBackups !== false,
    })
    send(response, 200, { ok: true, ...report })
  } catch (error) {
    answer(ctx, response, error, 'sweep')
  }
}

/**
 * Own one delete request end to end.
 * @param {object} ctx - Host Cordis context.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {import('node:http').ServerResponse} response - the response.
 */
async function serveDelete(ctx, request, response, configuredHome) {
  if (request.method !== 'POST') {
    send(response, 405, { ok: false, code: 'method-not-allowed', message: 'only POST is accepted' })
    return
  }
  if (!sameOrigin(request)) {
    send(response, 403, { ok: false, code: 'untrusted-origin', message: 'the request did not come from this Harness page' })
    return
  }
  let body
  try {
    body = JSON.parse(await readBody(request))
  } catch (error) {
    send(response, 400, { ok: false, code: 'bad-request', message: messageOf(error) })
    return
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  if (!SESSION_ID.test(sessionId)) {
    send(response, 400, { ok: false, code: 'bad-request', message: 'sessionId is missing or malformed' })
    return
  }
  try {
    send(response, 200, await deleteSession(ctx, sessionId, {
      stop: body?.stop === true,
      descendants: body?.descendants,
      configuredHome,
    }))
  } catch (error) {
    answer(ctx, response, error, sessionId)
  }
}

/**
 * Own one inspect request: report what the page cannot see by itself.
 * @param {object} ctx - Host Cordis context.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {import('node:http').ServerResponse} response - the response.
 */
async function serveInspect(ctx, request, response, configuredHome) {
  if (request.method !== 'GET') {
    send(response, 405, { ok: false, code: 'method-not-allowed', message: 'only GET is accepted' })
    return
  }
  if (!sameOrigin(request)) {
    send(response, 403, { ok: false, code: 'untrusted-origin', message: 'the request did not come from this Harness page' })
    return
  }
  let sessionId = ''
  try {
    sessionId = (new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId') ?? '').trim()
  } catch {
    // A malformed request URL is reported as a malformed id below.
  }
  if (!SESSION_ID.test(sessionId)) {
    send(response, 400, { ok: false, code: 'bad-request', message: 'sessionId is missing or malformed' })
    return
  }
  try {
    send(response, 200, await inspectSession(ctx, sessionId, configuredHome))
  } catch (error) {
    answer(ctx, response, error, sessionId)
  }
}

/**
 * Delete the Session the user acted on, the descendants they selected, and
 * everything keyed by those ids.
 * @param {object} ctx - Host Cordis context.
 * @param {string} sessionId - the Session the user acted on.
 * @param {{ stop: boolean, descendants?: string[] }} options - whether to stop
 *   running work first, and which descendants to take; omitting `descendants`
 *   means every one of them.
 * @returns {Promise<object>} the removal report.
 */
async function deleteSession(ctx, sessionId, options) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || typeof persistence.stat !== 'function') {
    throw new DeleteRefusal(503, 'persistence-unavailable', 'sessionPersistence is not mounted in this profile')
  }

  const snapshot = await persistence.stat(sessionId)
  const header = snapshot?.header
  if (header === undefined) {
    throw new DeleteRefusal(404, 'session-not-found', `找不到会话 ${sessionId} 的持久化记录。`)
  }

  const artifactDirectory = locateDirectory(persistence, header)
  if (artifactDirectory === undefined) {
    throw new DeleteRefusal(501, 'no-artifact', '当前持久化后端不提供会话工件路径，无法删除文件。')
  }

  const runtime = runtimeOf(ctx, sessionId)
  const removal = { stoppedActivity: false, warnings: [], terminalsKilled: 0 }

  // The family is gathered first and the caller's selection is validated against
  // it, so a crafted request can never name a Session outside this lineage.
  const gathered = await gatherDescendants(ctx, sessionId, removal.warnings)
  const selected = selectDescendants(gathered, options.descendants)
  if (selected.length > MAX_DESCENDANTS) {
    throw new DeleteRefusal(
      409,
      'too-many-descendants',
      `一次最多删除 ${MAX_DESCENDANTS} 个子会话，当前选中 ${selected.length} 个，请分批删除。`,
    )
  }

  // Every Session in the set is asked about its own work. The shipped admission
  // answers for the Session it is asked about, so a descendant's running turn or
  // background job would be invisible if only the target were asked.
  const targets = [sessionId, ...selected.map((entry) => entry.id)]
  const busy = await gatherActivities(ctx, targets)
  if (busy.size > 0 && options.stop !== true) {
    const busyList = [...busy.entries()].map(([id, activity]) => ({ sessionId: id, activity }))
    const labels = [...new Set(busyList.flatMap((entry) => entry.activity.map((item) => item.label)))].join('、')
    throw new DeleteRefusal(
      409,
      'session-active',
      busy.size === 1 && busy.has(sessionId)
        ? `这个会话还有未结束的工作（${labels}）。确认后会先停掉它们再删除。`
        : `选中的会话里还有未结束的工作（${labels}，共 ${busy.size} 个会话）。确认后会先停掉它们再删除。`,
      { activity: busy.get(sessionId) ?? [], activeSessions: busyList },
    )
  }

  // Running work goes first, the way the shipped archive's stopActivity does.
  if (busy.size > 0) {
    for (const id of busy.keys()) await stopSessionActivity(ctx, id, removal)
    removal.stoppedActivity = true
  }

  // A deleted Session's shells go with it. Terminals are not part of the shipped
  // archive admission, and the service's own owner cleanup only fires once the
  // Agent is released, which can be long after the log is gone.
  for (const id of targets) removal.terminalsKilled += await killOwnedTerminals(ctx, id, removal)

  // The attachment digests these Sessions reference, read WHILE their logs still
  // exist. Once the logs are gone a blob on disk can no longer be attributed to
  // anyone, so this set is what lets the reclamation pass tell a blob it just
  // orphaned from one that was already unreferenced before it ran.
  const targetIds = new Set([sessionId, ...selected.map((entry) => entry.id)])
  let used
  try {
    used = usedDigests(homeFor(options), targetIds)
  } catch (error) {
    removal.warnings.push(`无法读取附件引用，共享判断可能不准：${messageOf(error)}`)
  }

  // Descendants are Sessions of their own with their own logs: deepest first, so
  // no child outlives its parent by more than one call.
  const removedDescendants = []
  for (const child of selected) {
    const report = await removeSession(ctx, child.id)
    report.kind = child.kind
    removedDescendants.push(report)
  }

  const removed = await removeSession(ctx, sessionId, { artifactDirectory })

  // Everything the removals above left behind: the attachment objects only these
  // Sessions referenced, the provider upload records that pointed at them, the
  // search-index rows, a surviving parent's checkpoint still naming a child, and
  // the stale Workspace backups. This runs AFTER the logs are gone so the
  // reference count it computes is the one that actually holds.
  const reclaimed = await reclaimAfterDelete(ctx, targetIds, {
    configuredHome: options.configuredHome,
    pruneExpiredCache: true,
    pruneBackups: true,
    ...(used === undefined ? {} : { usedDigests: used }),
  })
  for (const warning of reclaimed.warnings) removal.warnings.push(warning)

  return {
    ok: true,
    sessionId,
    removed,
    descendants: removedDescendants,
    kept: gathered.length - selected.length,
    stoppedActivity: removal.stoppedActivity,
    terminalsKilled: removal.terminalsKilled,
    warnings: removal.warnings,
    runtime,
    activity: busy.get(sessionId) ?? [],
    reclaimed,
  }
}

/**
 * Remove one Session's artifacts, workspace account and projection checkpoint,
 * then tell connected Clients to drop its row.
 * @param {object} ctx - Host Cordis context.
 * @param {string} sessionId - the Session to remove.
 * @param {{ artifactDirectory?: string }} known - an already-resolved artifact path.
 * @returns {Promise<object>} the per-Session removal report.
 */
async function removeSession(ctx, sessionId, known = {}) {
  const report = {
    sessionId,
    artifactDirectory: null,
    removed: false,
    workspaces: 0,
    projectionCheckpoint: false,
    warnings: [],
  }

  let directory = known.artifactDirectory
  if (directory === undefined) {
    const persistence = ctx.get('sessionPersistence')
    const snapshot = persistence === undefined || typeof persistence.stat !== 'function'
      ? undefined
      : await persistence.stat(sessionId)
    const header = snapshot?.header
    if (header === undefined) report.warnings.push('没有持久化记录，可能已经被删除')
    else directory = locateDirectory(persistence, header)
  }

  // The Session's own directory: the current log, every retained historical
  // generation, and any future session-local artifact live in it.
  if (directory !== undefined) {
    report.artifactDirectory = directory
    await rm(directory, { recursive: true, force: true })
    report.removed = true
  }

  // Workspace accounting: the sidebar groups Sessions by Workspace records, and
  // the registry-global archive/pin sets are Session id arrays.
  await detachFromWorkspaces(ctx, sessionId, report)

  // The projection checkpoint is a fold shortcut and disposable; leaving it
  // would keep a record for a Session that no longer exists.
  report.projectionCheckpoint = await dropProjectionCheckpoint(ctx, sessionId, report)

  // Connected Clients drop the row from their session list, exactly as they do
  // when the Session controller reports a disposed Session.
  ctx.emit('api-session/removed', sessionId)

  return report
}

/**
 * The kind labels a descendant can carry into the report and the dialog.
 * `subagent` is a Session the Subagent runtime spawned (`origin: 'subagent'`);
 * `derived` is any other child on the lineage, a conversation forked off this
 * one, which DSH records as `parentSession` plus `isSeeded`.
 */
const DESCENDANT_KINDS = { subagent: 'subagent', derived: 'derived' }

/**
 * Turn a caller's selection into the descendant entries to delete.
 *
 * The selection is validated against the lineage the Host itself gathered, so a
 * crafted request can only ever name Sessions in this family. An omitted field
 * means "all of them"; an empty array means "only the Session itself".
 * @param {Array<{ id: string, depth: number, kind: string }>} gathered - the family.
 * @param {unknown} requested - the ids the Client sent, when it sent any.
 * @returns {Array<{ id: string, depth: number, kind: string }>} deepest first.
 */
function selectDescendants(gathered, requested) {
  if (requested === undefined || requested === null) return gathered
  if (!Array.isArray(requested)) {
    throw new DeleteRefusal(400, 'bad-request', 'descendants 必须是会话 id 数组。')
  }
  const byId = new Map(gathered.map((entry) => [entry.id, entry]))
  const seen = new Set()
  const selected = []
  for (const raw of requested) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id === '' || seen.has(id)) continue
    const entry = byId.get(id)
    if (entry === undefined) {
      throw new DeleteRefusal(
        400,
        'unknown-descendant',
        `${id} 不是这个会话的子会话，已中止，没有删除任何东西。`,
        { sessionId: id },
      )
    }
    seen.add(id)
    selected.push(entry)
  }
  selected.sort((left, right) => right.depth - left.depth || left.id.localeCompare(right.id))
  return selected
}

/**
 * Ask every Session in a delete set about its own running work.
 *
 * The shipped admission answers per Session, so this must be one call per id: a
 * descendant's running turn or background job is not reported when the target is
 * asked.
 * @param {object} ctx - Host Cordis context.
 * @param {string[]} ids - the Sessions in the delete set.
 * @returns {Promise<Map<string, object[]>>} only the busy ones, described.
 */
async function gatherActivities(ctx, ids) {
  const busy = new Map()
  for (const id of ids) {
    const activity = describeActivity(await sessionActivity(ctx, id))
    if (activity.length > 0) busy.set(id, activity)
  }
  return busy
}

/**
 * Read the descendant set without applying the delete cap, for the state report.
 *
 * Two durable sources, merged by the closest depth:
 *
 * 1. **The subagent catalog**, read per parent through the parent Session's own
 *    `subagentCatalog` projection, walked from the target downwards. This is the
 *    relation that carries no header field: every row is a Session the parent
 *    spawned, and walking it is what puts a subagent under the child that
 *    spawned it rather than under the target. The service's own
 *    `subagents.listDescendants` is asked as well, as a second opinion, because
 *    this walk reads sessions one at a time and a single unreadable parent must
 *    not take its whole branch with it.
 * 2. **The header lineage** (`SessionHeader.parentSession`), which covers forked
 *    conversations — the relation that never appears in any catalog — plus its
 *    own view of subagent sessions, and the project directory each child's header
 *    carries for display naming.
 *
 * The result is the reachable family: a child is included when the lineage or a
 * catalog links it to the target, or to another child that is already included.
 * A Session whose parent header names an id outside the corpus is not reachable
 * this way, yet it can still be a live fork of the target, so it is included too
 * — deleting it is no worse than deleting it through the fork's own row.
 * @param {object} ctx - Host Cordis context.
 * @param {string} sessionId - the Session whose descendants are wanted.
 * @param {string[]} warnings - collector for recoverable failures.
 * @returns {Promise<Array<{ id: string, depth: number, kind: string }>>} deepest first.
 */
async function gatherDescendants(ctx, sessionId, warnings) {
  const collected = new Map()
  /** The header lineage, indexed by parent, for the reachability pass. */
  const childrenByParent = new Map()

  /**
   * One discovered child, keyed by id. The closest depth wins, a subagent label
   * outranks a derived one, and the first parent that named it is kept for
   * indentation. The project directory comes only from the lineage walk, which
   * reads it off the child's own header; the catalog carries no path, so a child
   * known only through the catalog falls back to its title and then its id.
   */
  const add = (rawId, depth, kind, parentId, cwd) => {
    if (typeof rawId !== 'string' || rawId === sessionId || !SESSION_ID.test(rawId)) return
    const parent = typeof parentId === 'string' && SESSION_ID.test(parentId) ? parentId : undefined
    const path = typeof cwd === 'string' && cwd !== '' ? cwd : undefined
    const existing = collected.get(rawId)
    if (existing === undefined) {
      collected.set(rawId, {
        id: rawId,
        depth,
        kind,
        ...(parent === undefined ? {} : { parentId: parent }),
        ...(path === undefined ? {} : { cwd: path }),
      })
      return
    }
    existing.depth = Math.min(existing.depth, depth)
    if (kind === DESCENDANT_KINDS.subagent) existing.kind = DESCENDANT_KINDS.subagent
    if (existing.parentId === undefined && parent !== undefined) existing.parentId = parent
    if (existing.cwd === undefined && path !== undefined) existing.cwd = path
  }

  // 1. The header lineage every Session records, indexed by parent.
  const query = ctx.get('sessionQuery')
  const known = new Set([sessionId])
  if (query === undefined || typeof query.listSessions !== 'function') {
    warnings.push('sessionQuery 服务不可用，派生对话与子智能体的血缘没有读到')
  } else {
    try {
      for (const record of await query.listSessions()) {
        const header = record?.header
        if (header === undefined || typeof header.id !== 'string' || !SESSION_ID.test(header.id)) continue
        known.add(header.id)
        const parent = typeof header.parentSession === 'string' ? header.parentSession : undefined
        if (parent === undefined) continue
        if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
        childrenByParent.get(parent).push(header)
      }
    } catch (error) {
      warnings.push(`读取会话血缘失败，派生对话与子智能体的血缘没有读到：${messageOf(error)}`)
    }
  }

  // 2. The subagent catalog, walked from the target down through each parent's own
  //    direct children, so every subagent hangs under the Session that spawned it.
  const walk = await walkSubagentCatalog(ctx, sessionId, warnings)
  for (const node of walk) {
    add(node.id, node.depth, DESCENDANT_KINDS.subagent, node.parentId, node.cwd)
  }

  // 3. The catalog service's own descendant list, merged for depth and coverage:
  //    it reaches children the per-parent walk could not read, and it cannot
  //    invent an id this family has never seen.
  const subagents = ctx.get('subagents')
  if (subagents === undefined || typeof subagents.listDescendants !== 'function') {
    warnings.push('subagents 服务不可用，子智能体名册没有读到')
  } else {
    try {
      const entries = await subagents.listDescendants(sessionId)
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          add(
            entry?.id,
            typeof entry?.depth === 'number' ? entry.depth : 1,
            DESCENDANT_KINDS.subagent,
            typeof entry?.parentId === 'string' ? entry.parentId : undefined,
          )
        }
      }
    } catch (error) {
      warnings.push(`读取子智能体名册失败：${messageOf(error)}`)
    }
  }

  // 4. The lineage's own children of every reachable Session: subagent Sessions
  //    whose catalog row is gone, and forked conversations, which have no row at
  //    all. Breadth-first, so each child's depth is its distance from the target.
  const reachable = new Set([sessionId])
  let frontier = [sessionId]
  for (let depth = 1; frontier.length > 0 && depth <= MAX_LINEAGE_DEPTH; depth += 1) {
    const next = []
    for (const parentId of frontier) {
      for (const header of childrenByParent.get(parentId) ?? []) {
        if (reachable.has(header.id)) continue
        reachable.add(header.id)
        const knownChild = collected.get(header.id)
        add(
          header.id,
          depth,
          header.origin === 'subagent' ? DESCENDANT_KINDS.subagent : DESCENDANT_KINDS.derived,
          parentId,
          header.cwd,
        )
        // The lineage found this child where the catalog did not, so the catalog
        // walk never descended through it: queue it so its own subagents follow.
        if (knownChild === undefined) next.push(header.id)
      }
    }
    frontier = next
  }

  // 5. A fork whose parent header names an id the corpus no longer holds, yet
  //    which carries the target's own project directory: unreachable by structure,
  //    still part of this family in practice.
  try {
    const root = ctx.get('sessionPersistence')
    const rootHeader = root === undefined || typeof root.stat !== 'function'
      ? undefined
      : (await root.stat(sessionId))?.header
    const rootCwd = typeof rootHeader?.cwd === 'string' ? rootHeader.cwd : undefined
    if (rootCwd !== undefined) {
      for (const [, list] of childrenByParent) {
        for (const header of list) {
          if (reachable.has(header.id) || header.cwd !== rootCwd) continue
          const parent = typeof header.parentSession === 'string' ? header.parentSession : ''
          if (known.has(parent)) continue
          reachable.add(header.id)
          add(header.id, 1, DESCENDANT_KINDS.derived, undefined, header.cwd)
        }
      }
    }
  } catch {
    // An unreadable root header only costs the orphan fork, which is optional.
  }

  const list = [...collected.values()]
  list.sort((left, right) => right.depth - left.depth || left.id.localeCompare(right.id))
  return attachTitles(ctx, list)
}

/**
 * Walk the durable subagent catalog from one root, deepest structure preserved.
 *
 * Each level is read from the parent Session's own `subagentCatalog` projection —
 * the parent-owned record of the Sessions it spawned — so a subagent is placed
 * under the Session that actually spawned it. The walk is iterative and
 * cycle-guarded: a hand-edited catalog cannot make it loop, and one unreadable
 * parent costs that parent's branch rather than the whole walk.
 * @param {object} ctx - Host Cordis context.
 * @param {string} rootId - the Session whose descendants are wanted.
 * @param {string[]} warnings - collector for recoverable failures.
 * @returns {Promise<Array<{ id: string, depth: number, parentId: string }>>} the rows.
 */
async function walkSubagentCatalog(ctx, rootId, warnings) {
  const query = ctx.get('sessionQuery')
  if (query === undefined || typeof query.observeSession !== 'function') {
    warnings.push('sessionQuery 服务不可用，子智能体目录没有读到')
    return []
  }

  const rows = []
  const visited = new Set([rootId])
  let frontier = [{ id: rootId, depth: 0 }]
  while (frontier.length > 0) {
    const next = []
    for (const parent of frontier) {
      let observation
      try {
        observation = await query.observeSession(parent.id)
      } catch (error) {
        warnings.push(`读取会话 ${parent.id} 的子智能体目录失败：${messageOf(error)}`)
        continue
      }
      let entries
      try {
        entries = observation?.projections?.values?.subagentCatalog
      } finally {
        // A lease pins its cached preparation until it is disposed, and the only
        // disposer is `Symbol.dispose` — the observation carries no `release()`.
        // Calling it in a `finally` keeps the walk from pinning every parent it
        // read; without the symbol (an older backend) there is nothing to free.
        const release = observation?.[Symbol.dispose]
        if (typeof release === 'function') {
          try {
            release.call(observation)
          } catch {
            // A lease that refuses to free is the Host's business, not ours.
          }
        }
      }
      if (!Array.isArray(entries)) {
        warnings.push(`会话 ${parent.id} 的子智能体目录没有读到`)
        continue
      }
      for (const entry of entries) {
        const id = typeof entry?.id === 'string' ? entry.id : ''
        if (!SESSION_ID.test(id) || visited.has(id)) continue
        visited.add(id)
        const depth = parent.depth + 1
        if (depth > MAX_LINEAGE_DEPTH) continue
        rows.push({ id, depth, parentId: parent.id })
        next.push({ id, depth })
      }
    }
    frontier = next
  }
  return rows
}

/**
 * The final non-empty segment of a directory path, POSIX or Windows.
 *
 * The same reading the shipped client's `workspaceTitleOf` uses, kept in step
 * with it so a Session's display name here matches the sidebar's.
 * @param {string|undefined} path - the directory path.
 * @returns {string} the final segment, or an empty string.
 */
function workspaceTitleOf(path) {
  if (typeof path !== 'string') return ''
  const trimmed = path.replace(/[/\\]+$/, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(separator + 1)
}

/**
 * Fill in each entry's title, so the dialogs list names instead of ids.
 *
 * Two sources, in the order the sidebar itself uses: the durable title the
 * Session log carries, then the final segment of its project directory, then the
 * raw id. The folded snapshot is `{ session, title: { title, … } }`, and the
 * query service reports a Session with no title event as fulfilled with no
 * `title`, so a Session that was never renamed still reads as its directory
 * rather than as "untitled".
 * @param {object} ctx - Host Cordis context.
 * @param {Array<object>} entries - the gathered entries, each with `id` and
 *   optionally `cwd`.
 * @returns {Promise<Array<object>>} the same entries, with `title` where known.
 */
async function attachTitles(ctx, entries) {
  if (entries.length === 0) return entries
  const titled = new Map()
  const query = ctx.get('sessionQuery')
  if (query !== undefined && typeof query.readTitleSnapshots === 'function') {
    try {
      const results = await query.readTitleSnapshots(entries.map((entry) => entry.id))
      if (Array.isArray(results)) {
        for (const result of results) {
          if (result?.status !== 'fulfilled') continue
          const id = result.value?.session?.id
          // The snapshot nests the folded title one level down; a Session whose
          // log holds no title event reports fulfilled without it.
          const title = result.value?.title?.title
          if (typeof id === 'string' && typeof title === 'string' && title.trim() !== '') titled.set(id, title)
        }
      }
    } catch {
      // Titles are optional: the directory and the id still name the row.
    }
  }
  for (const entry of entries) {
    const title = titled.get(entry.id)
    if (title !== undefined) {
      entry.title = title
      continue
    }
    const directory = workspaceTitleOf(entry.cwd)
    if (directory !== '') entry.title = directory
  }
  return entries
}

/**
 * Read one Session's state without changing anything.
 * @param {object} ctx - Host Cordis context.
 * @param {string} sessionId - the Session to inspect.
 * @returns {Promise<object>} the state the Client dialog reports.
 */
async function inspectSession(ctx, sessionId, configuredHome) {
  const persistence = ctx.get('sessionPersistence')
  const snapshot = persistence === undefined || typeof persistence.stat !== 'function'
    ? undefined
    : await persistence.stat(sessionId)
  const header = snapshot?.header
  // Why a branch may be missing is carried back to the dialog: the family is read
  // from two sources, and one of them failing silently is indistinguishable from a
  // Session that genuinely has no children.
  const warnings = []
  const descendants = await gatherDescendants(ctx, sessionId, warnings)
  const listed = descendants.slice(0, MAX_LISTED_DESCENDANTS)
  // Only the Sessions the dialog can show are asked about their work: each answer
  // costs one admission walk, and beyond the listing nothing can be selected.
  const busy = await gatherActivities(ctx, [sessionId, ...listed.map((entry) => entry.id)])
  const subagents = descendants.filter((entry) => entry.kind === DESCENDANT_KINDS.subagent).length
  // What the delete would free, computed before anything is touched. Every
  // descendant is assumed to go, which is the dialog's default selection; the
  // figure is a prediction and the delete reports what it actually reclaimed.
  let reclaim
  try {
    reclaim = await previewReclaim(ctx, new Set([sessionId, ...descendants.map((entry) => entry.id)]), configuredHome)
  } catch (error) {
    warnings.push(`无法预估可释放的磁盘空间：${messageOf(error)}`)
  }
  return {
    ok: true,
    sessionId,
    stored: header !== undefined,
    artifactDirectory: header === undefined ? undefined : locateDirectory(persistence, header),
    ...runtimeOf(ctx, sessionId),
    activity: busy.get(sessionId) ?? [],
    warnings,
    ...(reclaim === undefined ? {} : { reclaim }),
    descendants: {
      count: descendants.length,
      subagents,
      derived: descendants.length - subagents,
      truncated: descendants.length > listed.length,
      maxDeletable: MAX_DESCENDANTS,
      items: listed.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        depth: entry.depth,
        ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
        ...(entry.title === undefined ? {} : { title: entry.title }),
        ...runtimeOf(ctx, entry.id),
        activity: busy.get(entry.id) ?? [],
      })),
    },
  }
}

/**
 * Close the terminals a Session owns.
 *
 * Terminals are part of no shipped admission family, and the service's own owner
 * cleanup fires when the Agent is released, which can be long after the log is
 * gone; a shell left running for a deleted conversation helps nobody.
 * @param {object} ctx - Host Cordis context.
 * @param {string} sessionId - the Session whose shells close.
 * @param {object} removal - report being filled in.
 * @returns {Promise<number>} how many terminals were closed.
 */
async function killOwnedTerminals(ctx, sessionId, removal) {
  const terminals = ctx.get('terminals')
  if (terminals === undefined || typeof terminals.list !== 'function' || typeof terminals.kill !== 'function') return 0

  let owner
  try {
    const agents = ctx.get('agents')
    owner = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  } catch {
    owner = undefined
  }
  // `list` matches the exact owner object, and a cold Session owns no terminal.
  if (owner === undefined) return 0

  let killed = 0
  try {
    for (const snapshot of terminals.list(owner) ?? []) {
      const id = typeof snapshot?.sessionId === 'string' ? snapshot.sessionId : ''
      if (id === '') continue
      try {
        if (await terminals.kill(owner, id, 'session deleted')) killed += 1
      } catch (error) {
        removal.warnings.push(`关闭终端 ${id} 失败：${messageOf(error)}`)
      }
    }
  } catch (error) {
    removal.warnings.push(`读取终端列表失败：${messageOf(error)}`)
  }
  return killed
}

/**
 * Whether the Host still holds the Session open, and whether its Agent runs.
 * Residency never blocks a delete; it is reported so the dialog can say so.
 * @param {object} ctx - Host Cordis context.
 * @param {string} sessionId - the Session to describe.
 * @returns {{ open: boolean, agent: boolean, running: boolean }} the runtime facts.
 */
function runtimeOf(ctx, sessionId) {
  let open = false
  let agent = false
  let running = false
  try {
    const sessions = ctx.get('sessions')
    if (typeof sessions?.get === 'function') open = sessions.get(sessionId) !== undefined
  } catch {
    // A service that cannot answer leaves the fact false.
  }
  try {
    const agents = ctx.get('agents')
    if (typeof agents?.get === 'function') {
      const live = agents.get(sessionId)
      agent = live !== undefined
      running = live?.status === 'running'
    }
  } catch {
    // Same here.
  }
  return { open, agent, running }
}

/**
 * Ask the composed providers what still runs for this Session, through DSH's own
 * archive-admission waterfall.
 * @param {object} ctx - Host Cordis context.
 * @param {string} sessionId - the Session to ask about.
 * @returns {Promise<object[]>} the reported families, in listener order.
 */
async function sessionActivity(ctx, sessionId) {
  if (typeof ctx.waterfall !== 'function') return []
  const value = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
  return Array.isArray(value) ? value : []
}

/**
 * Stop this Session's running work the way the user's own stop actions do.
 * @param {object} ctx - Host Cordis context.
 * @param {string} sessionId - the Session whose work stops.
 * @param {object} removal - report being filled in.
 * @returns {Promise<void>} resolution once every provider was asked.
 */
async function stopSessionActivity(ctx, sessionId, removal) {
  if (typeof ctx.parallel !== 'function') {
    removal.warnings.push('ctx.parallel is unavailable; running work was not stopped')
    return
  }
  try {
    await ctx.parallel('workspace/session-stop', { sessionId })
  } catch (error) {
    removal.warnings.push(`stopping running work failed: ${messageOf(error)}`)
  }
}

/**
 * Project the activity entries into lossless JSON for the Client.
 * @param {object[]} entries - raw `workspace/session-activity` entries.
 * @returns {object[]} `{ kind, label, items }` rows.
 */
function describeActivity(entries) {
  return entries.map((entry) => {
    const kind = typeof entry?.kind === 'string' && entry.kind !== '' ? entry.kind : 'unknown'
    const items = Array.isArray(entry?.items) ? entry.items : []
    return {
      kind,
      label: ACTIVITY_LABELS[kind] ?? kind,
      items: items.slice(0, 20).map((item) => ({
        id: item?.id === undefined ? '' : String(item.id),
        label: typeof item?.label === 'string' ? item.label : '',
      })),
    }
  })
}

/**
 * The Session's own directory, through the persistence backend's artifact hook.
 * @param {object} persistence - the mounted sessionPersistence service.
 * @param {object} header - the stored Session header.
 * @returns {string|undefined} the directory, or undefined without that hook.
 */
function locateDirectory(persistence, header) {
  if (typeof persistence.locate !== 'function') return undefined
  try {
    const location = persistence.locate(header)
    if (location !== undefined && typeof location.path === 'string' && location.path !== '') {
      return dirname(location.path)
    }
  } catch {
    // A backend that refuses to locate is a backend whose files stay untouched.
  }
  return undefined
}

/**
 * Drop the id from every Workspace account and from the registry-wide sets.
 * @param {object} ctx - Host Cordis context.
 * @param {string} sessionId - the Session to forget.
 * @param {object} removal - report being filled in.
 * @returns {Promise<void>} resolution after the durable writes.
 */
async function detachFromWorkspaces(ctx, sessionId, removal) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) {
    removal.warnings.push('workspaceRegistry is not mounted; the Workspace record was left untouched')
    return
  }
  try {
    if (typeof registry.list === 'function') {
      for (const workspace of registry.list()) {
        if (typeof workspace?.detachSession !== 'function') continue
        await workspace.detachSession(sessionId)
        removal.workspaces += 1
      }
    }
    if (typeof registry.unarchiveSession === 'function') await registry.unarchiveSession(sessionId)
    if (typeof registry.unpinSession === 'function') await registry.unpinSession(sessionId)
  } catch (error) {
    removal.warnings.push(`workspace cleanup failed: ${messageOf(error)}`)
  }
}

/**
 * Delete the projection-cache record for one Session.
 * @param {object} ctx - Host Cordis context.
 * @param {string} sessionId - the Session whose checkpoint goes away.
 * @param {object} removal - report being filled in.
 * @returns {Promise<boolean>} whether a record was dropped.
 */
async function dropProjectionCheckpoint(ctx, sessionId, removal) {
  const storageDomain = ctx.get('storageDomain')
  if (typeof storageDomain?.get !== 'function') {
    removal.warnings.push('storageDomain is not mounted; the projection checkpoint was left untouched')
    return false
  }
  try {
    const domain = storageDomain.get('session_projcache')
    const table = typeof domain?.table === 'function' ? domain.table('sessions') : undefined
    if (typeof table?.delete !== 'function') return false
    return (await table.delete(sessionId)) === true
  } catch (error) {
    removal.warnings.push(`projection-cache cleanup failed: ${messageOf(error)}`)
    return false
  }
}

/**
 * Report one failure with its status, code, and details.
 * @param {object} ctx - Host Cordis context.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {unknown} error - the caught value.
 * @param {string} sessionId - the Session the request named.
 */
function answer(ctx, response, error, sessionId) {
  const refusal = error instanceof DeleteRefusal
    ? error
    : new DeleteRefusal(500, 'delete-failed', messageOf(error))
  ctx.logger?.warn?.(`[better-dsh-session-deletetool] ${sessionId}: ${refusal.code}: ${refusal.message}`)
  send(response, refusal.status, { ok: false, code: refusal.code, message: refusal.message, ...refusal.details })
}

/**
 * Whether the request came from this Harness page rather than another site.
 *
 * The rebinding defence is the `Host` header: a page on `evil.com` aimed at
 * 127.0.0.1 sends a matching Origin/Host pair, so only `Host` can tell the
 * attack apart. An absent `Host` or `Origin` is not a cross-site request — the
 * Desktop build's proxy strips both, and only a non-page client omits them.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {boolean} whether the request may proceed.
 */
function sameOrigin(request) {
  const host = request.headers.host
  if (host !== undefined && !loopbackAuthority(host)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Whether a `Host` header names a loopback authority.
 * @param {string} host - the request's Host header.
 * @returns {boolean} whether it is loopback.
 */
function loopbackAuthority(host) {
  const lower = host.toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/**
 * Read a size-capped JSON request body.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {Promise<string>} the decoded body.
 */
async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - HTTP status.
 * @param {object} payload - JSON body.
 */
function send(response, status, payload) {
  if (response.headersSent || response.writableEnded) return
  const body = JSON.stringify(payload)
  response.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

/**
 * Read one error's text.
 * @param {unknown} error - the caught value.
 * @returns {string} its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The Harness home a delete is operating on.
 *
 * Resolution lives in `reclaim.js` (`$DSH_HOME`, then `~/.dsh`); this is the
 * local shorthand so the delete path can name it without threading the value
 * through every helper.
 * @param {{ configuredHome?: string }} options - the delete options.
 * @returns {string} the absolute home path.
 */
function homeFor(options) {
  return homePath(options?.configuredHome)
}
