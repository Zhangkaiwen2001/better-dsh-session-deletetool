/**
 * better-dsh-session-deletetool — Client half.
 *
 * Local fork of Lzcdebear/better-dsh-session-deletetool. The code through 0.5.2 is
 * his; the changes from 0.6.0 on are local, and this file carries no claim to his
 * authorship. It is installed as a `link:` local-path dependency, and DSH's plugin
 * manager has no update action, so a newer upstream release never lands here.
 *
 * Adds one row, "删除会话", to a Session's "⋯" menu at order 500 (after the
 * shipped pin 100 / rename 200 / fork 300 / archive 400), plus the confirmation
 * dialog that row opens. Confirming POSTs to the Host half and waits: the row
 * leaves the sidebar when the Host's `api-session/removed` event arrives, the
 * same event the shipped Session controller emits for a disposed Session.
 *
 * Opening the dialog first asks the Host what the Session's state actually is,
 * because the page cannot see it: behind a row that is not the one on screen
 * there can still be a held-open Session, or a running turn, subagent,
 * background job or reminder. The dialog says so in words instead of refusing
 * blindly — being open never blocks the delete, and running work is stopped on
 * the user's confirmation.
 *
 * The same dialog also carries the disk-space control. A delete only frees what
 * the deleted Sessions alone referenced, so the bytes an *earlier* delete or a
 * crash left behind — attachment objects no surviving log names, staging files,
 * expired provider upload records, stale Workspace backups — are reclaimed by a
 * separate sweep that runs in the same place and never removes a Session. The
 * plugin therefore has no sidebar control of its own: one row in one menu, one
 * dialog, both jobs.
 *
 * The package imports no Harness Client package: the menu row and the dialog
 * are local markup styled from theme tokens, matching the shipped rows' shape
 * (`role="menuitem"` button inside the list, errors in
 * `--dsw-alias-state-error-primary`) so the menu's own keyboard walk and focus
 * return keep working over the added row.
 */
window.__ModuleLoader__.load({
  id: 'better-dsh-session-deletetool',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    const NS = 'better-dsh-session-deletetool'
    const DELETE_PATH = '/better-dsh-session-deletetool/delete'
    const INSPECT_PATH = '/better-dsh-session-deletetool/inspect'
    const SWEEP_PATH = '/better-dsh-session-deletetool/sweep'

    const DICT = {
      zh: {
        'menu.delete': '删除会话',
        'sweep.title': '清理磁盘占用',
        'sweep.desc': '找出已经没有会话引用的附件、过期缓存、临时文件与陈旧备份，并释放它们占用的空间。不会删除任何会话。',
        'sweep.scanning': '正在扫描…',
        'sweep.empty': '没有可清理的内容。',
        'sweep.total': '共可释放 {size}',
        'sweep.attachments': '无引用的附件：{n} 个，{size}',
        'sweep.staging': '残留临时文件：{n} 个，{size}',
        'sweep.uploadCache': '过期的上传缓存：{n} 条，{size}',
        'sweep.searchIndex': '搜索索引压缩：{size}',
        'sweep.backups': '陈旧的备份文件：{n} 个，{size}',
        'sweep.run': '立即清理',
        'sweep.running': '正在清理…',
        'sweep.rescan': '重新扫描',
        'sweep.done': '已释放 {size}',
        'sweep.doneNone': '没有可释放的内容',
        'sweep.failed': '清理失败',
        'sweep.hint': '删除只会带走这个会话独占的附件；更早的删除留下的东西由这里回收。',
        'dialog.title': '删除会话',
        'dialog.desc': '将永久删除“{title}”：会话日志、工程记录与投影缓存都会被移除，无法撤销。',
        'dialog.untitled': '未命名会话',
        'dialog.cancel': '取消',
        'dialog.checking': '检查中…',
        'dialog.deleting': '正在删除…',
        'dialog.failed': '删除失败',
        'dialog.running': '这个会话还有未结束的工作：',
        'dialog.runningHint': '确认后会先停掉这些工作，再删除这个会话。',
        'dialog.open': '它当前仍被 Harness 占用（可能开在某个窗口或标签里）。删除后它会立刻从列表消失。',
        'dialog.unknown': '读不到它的当前状态，仍可直接删除。',
        'dialog.descendants': '会连同它一起删除：{list}。',
        'dialog.descendants.subagents': '{n} 个子智能体会话',
        'dialog.descendants.derived': '{n} 个由它派生（fork）出来的对话',
        'dialog.listSeparator': '、',
        'dialog.group.subagents': '子智能体',
        'dialog.group.derived': '派生对话',
        'dialog.group.subagentsCount': '子智能体（{n}）',
        'dialog.group.derivedCount': '派生对话（{n}）',
        'dialog.header.subagents': '子智能体',
        'dialog.mainRow': '本对话：{title}',
        'dialog.selectAll': '删除全部（共 {n} 个）',
        'dialog.selectPartial': '已选 {m} / {n} 个',
        'dialog.expandHint': '点分组标题可折叠',
        'dialog.truncated': '共 {n} 个，下面只列出前 {shown} 个。',
        'dialog.maxDeletable': '一次最多删除 {max} 个，请分批选择。',
        'dialog.itemRunning': '运行中',
        'dialog.itemActive': '有未结束的工作',
        'dialog.itemOpen': '已打开',
        'dialog.warnings': '下面这些线索没读到，家族可能不完整：',
        'dialog.untitledItem': '未命名',
        'dialog.confirmCount': '删除 {n} 个会话',
        'dialog.confirmStopCount': '停止并删除 {n} 个会话',
        'dialog.reclaim.title': '将释放约 {size} 磁盘空间',
        'dialog.reclaim.none': '这个会话不占额外磁盘空间',
        'dialog.reclaim.logs': '会话日志 {size}',
        'dialog.reclaim.cache': '投影缓存 {size}',
        'dialog.reclaim.attachments': '附件 {n} 个（{size}）',
        'dialog.reclaim.shared': '另有 {n} 个附件被其它会话共用，会保留。',
        'dialog.reclaim.done': '本次删除已释放 {size}',
        'dialog.close': '关闭',
      },
      en: {
        'menu.delete': 'Delete conversation',
        'sweep.title': 'Reclaim disk space',
        'sweep.desc': 'Find attachments no conversation references any more, expired caches, leftover staging files and stale backups, and free what they occupy. No conversation is ever deleted.',
        'sweep.scanning': 'Scanning…',
        'sweep.empty': 'Nothing to reclaim.',
        'sweep.total': '{size} reclaimable',
        'sweep.attachments': 'Unreferenced attachments: {n}, {size}',
        'sweep.staging': 'Leftover staging files: {n}, {size}',
        'sweep.uploadCache': 'Expired upload-cache records: {n}, {size}',
        'sweep.searchIndex': 'Search-index compaction: {size}',
        'sweep.backups': 'Stale backups: {n}, {size}',
        'sweep.run': 'Reclaim now',
        'sweep.running': 'Reclaiming…',
        'sweep.rescan': 'Scan again',
        'sweep.done': 'Freed {size}',
        'sweep.doneNone': 'Nothing was reclaimable',
        'sweep.failed': 'Reclaim failed',
        'sweep.hint': 'A delete only takes what this conversation alone referenced; whatever an earlier delete left behind is reclaimed here.',
        'dialog.title': 'Delete conversation',
        'dialog.desc': '“{title}” will be deleted permanently: its session log, workspace account and projection cache are removed. This cannot be undone.',
        'dialog.untitled': 'Untitled conversation',
        'dialog.cancel': 'Cancel',
        'dialog.checking': 'Checking…',
        'dialog.deleting': 'Deleting…',
        'dialog.failed': 'Delete failed',
        'dialog.running': 'This conversation still has unfinished work:',
        'dialog.runningHint': 'Confirming stops that work first, then deletes the conversation.',
        'dialog.open': 'The Harness still holds it open (it may be showing in a window or tab). Deleting removes it from the list at once.',
        'dialog.unknown': 'Its current state could not be read; deleting is still possible.',
        'dialog.descendants': 'Deleted together with it: {list}.',
        'dialog.descendants.subagents': '{n} subagent conversation(s)',
        'dialog.descendants.derived': '{n} conversation(s) forked off it',
        'dialog.listSeparator': ', ',
        'dialog.group.subagents': 'Subagents',
        'dialog.group.derived': 'Forked conversations',
        'dialog.group.subagentsCount': 'Subagents ({n})',
        'dialog.group.derivedCount': 'Forked conversations ({n})',
        'dialog.header.subagents': 'Subagents',
        'dialog.mainRow': 'This conversation: {title}',
        'dialog.selectAll': 'Delete all ({n})',
        'dialog.selectPartial': '{m} of {n} selected',
        'dialog.expandHint': 'Click a group title to collapse it',
        'dialog.truncated': 'There are {n}; only the first {shown} are listed.',
        'dialog.maxDeletable': 'At most {max} can be deleted at once — select in batches.',
        'dialog.itemRunning': 'running',
        'dialog.itemActive': 'has unfinished work',
        'dialog.itemOpen': 'open',
        'dialog.warnings': 'These leads could not be read, so the family may be incomplete:',
        'dialog.untitledItem': 'Untitled',
        'dialog.confirmCount': 'Delete {n} conversations',
        'dialog.confirmStopCount': 'Stop and delete {n} conversations',
        'dialog.reclaim.title': 'Frees about {size} of disk space',
        'dialog.reclaim.none': 'This conversation takes up no extra disk space',
        'dialog.reclaim.logs': 'session log {size}',
        'dialog.reclaim.cache': 'projection cache {size}',
        'dialog.reclaim.attachments': '{n} attachment(s) ({size})',
        'dialog.reclaim.shared': '{n} more attachment(s) are shared with other conversations and will be kept.',
        'dialog.reclaim.done': 'This delete freed {size}',
        'dialog.close': 'Close',
      },
    }

    /** Fill one `{name}` placeholder set in a dictionary string. */
    function interpolate(text, params) {
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /** Translate through the registered locale when there is one, else the zh table. */
    let translate = null
    function t(key, params) {
      if (translate !== null) {
        try {
          const value = translate(key, params)
          if (typeof value === 'string' && value !== '') return value
        } catch {
          // A missing key falls through to the local table below.
        }
      }
      const fallback = DICT.zh[key]
      return typeof fallback === 'string' ? interpolate(fallback, params) : key
    }

    // ---- the pending confirmation, shared by the row and the dialog ----------
    let pending = null
    const listeners = new Set()
    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    function getPending() {
      return pending
    }
    function openConfirm(request) {
      pending = request
      for (const listener of [...listeners]) listener()
    }
    function settle() {
      pending = null
      for (const listener of [...listeners]) listener()
    }

    /** One failed Host answer, carrying its stable code and details. */
    function failureOf(payload, response) {
      const error = new Error(payload?.message ?? `HTTP ${response.status}`)
      error.code = payload?.code
      error.activity = Array.isArray(payload?.activity) ? payload.activity : null
      return error
    }

    /**
     * The client-side keys a Session owns.
     *
     * Every one is built by the shipped client as `<namespace>.<sessionId>`: a
     * `defineStore` with a session scope appends the scope key
     * (`dsh-client-store`: `` `${decl.persist}.${scopeKey}` ``), and the two
     * hand-rolled stores build the same shape themselves. Listed explicitly rather
     * than discovered by scanning `localStorage`, so a future key cannot be caught
     * by accident and deleted from an unrelated Session.
     */
    const SESSION_KEY_PREFIXES = [
      'dsh.conversation',
      'dsh.sidebar-right.v1',
      'dsh.sidebar-browser.v1',
      'dsh.user-questions.drafts.v1',
      'dsh.schedule.task-tab.v1',
    ]

    /**
     * Drop the localStorage a deleted Session owned.
     *
     * The Host cannot reach the renderer's storage, so this is the half of the
     * cleanup only the page can do. It is best-effort and never throws: the rows
     * are already gone on the Host, and a stale draft is a cosmetic leftover, not a
     * reason to report a failed delete.
     * @param {string[]} sessionIds - every Session id that was deleted.
     * @returns {number} how many keys were removed.
     */
    function clearSessionStorage(sessionIds) {
      if (typeof localStorage === 'undefined') return 0
      let removed = 0
      for (const sessionId of sessionIds) {
        if (typeof sessionId !== 'string' || sessionId === '') continue
        for (const prefix of SESSION_KEY_PREFIXES) {
          const key = `${prefix}.${sessionId}`
          try {
            if (localStorage.getItem(key) === null) continue
            localStorage.removeItem(key)
            removed += 1
          } catch {
            // Storage disabled or full: nothing to do about a cache key.
          }
        }
      }
      return removed
    }

    /**
     * Re-clear a deleted Session's keys until they stay gone.
     *
     * This is the part that used to need the app to be quit. The shipped stores
     * are `attachPersistence` subscribers that re-write their key on the next
     * state change, so a Session deleted while its slot is still mounted
     * re-creates one or two keys *after* the delete's own clear has run — and a
     * slot is disposed only once `api-session/removed` has propagated, which is
     * after the delete returns. The key that comes back holds nothing but
     * default state, yet it survives the whole session and is what made the row
     * reappear and forced an external LevelDB edit with the app closed.
     *
     * So the clear is repeated on later ticks rather than assumed final: each
     * pass re-reads storage, and the loop stops as soon as a pass removes
     * nothing, which is the signal that the slot has been disposed and its store
     * has stopped re-writing. The number of passes is bounded, because a store
     * that never settles must not keep the page busy.
     * @param {string[]} sessionIds - the ids whose keys were dropped.
     * @param {number} [attempts] - how many further passes to try.
     * @returns {void} nothing; the work is best-effort by design.
     */
    function reclearSessionStorage(sessionIds, attempts = 8) {
      if (attempts <= 0 || typeof localStorage === 'undefined') return
      const timer = setTimeout(() => {
        try {
          // A pass that removes nothing means the keys stayed gone: the stores
          // have been disposed, and another pass would only waste a tick.
          if (clearSessionStorage(sessionIds) === 0) return
          reclearSessionStorage(sessionIds, attempts - 1)
        } catch {
          // A storage that refuses to answer is the end of the matter.
        }
      }, 0)
      // A Node-side import (the tests) has no `unref`, and a page's pending
      // timeout must not hold the renderer open either.
      if (typeof timer?.unref === 'function') timer.unref()
    }

    /**
     * Every Session id a delete report covers, root and descendants alike.
     *
     * The route answers with the root's own removal report as an **object**
     * (`{ sessionId, artifactDirectory, removed, workspaces, … }`) and the
     * descendant reports hanging off it, so both places are read. Reading
     * `removed` as a list unconditionally is what once made a single-session
     * delete throw `object is not iterable` *after* the Host had already
     * succeeded — the delete itself worked and the dialog still reported a
     * failure.
     * @param {object|undefined} payload - the route's JSON answer.
     * @returns {string[]} the ids whose `localStorage` this page should drop.
     */
    function removedIdsOf(payload) {
      // A Set, because an answer can legitimately name the same id twice: the
      // single-session route puts the root at the top level *and* repeats it as
      // the root's own report under `removed`. Removing a key twice is harmless,
      // but a deduplicated list is what the caller's count should reflect.
      const ids = new Set()
      const add = (value) => {
        if (typeof value?.sessionId === 'string' && value.sessionId !== '') ids.add(value.sessionId)
        // Descendant reports hang off whichever shape carried them.
        for (const child of Array.isArray(value?.descendants) ? value.descendants : []) {
          if (typeof child?.sessionId === 'string' && child.sessionId !== '') ids.add(child.sessionId)
        }
      }
      // The route names the root at the top level and repeats it as its own
      // report under `removed`, so both places are read.
      add(payload)
      const reports = Array.isArray(payload?.removed)
        ? payload.removed
        : payload?.removed === undefined
          ? []
          : [payload.removed]
      for (const report of reports) add(report)
      return [...ids]
    }

    /**
     * A byte count in the reader's units.
     *
     * Binary units, one decimal below a gigabyte: the numbers here are disk
     * occupancy, and a bare count of digits is unreadable in a dialog.
     * @param {number} bytes - the count.
     * @returns {string} the formatted size.
     */
    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
      if (value < 1024) return `${value} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let scaled = value / 1024
      let unit = 0
      while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024
        unit += 1
      }
      return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)} ${units[unit]}`
    }

    /**
     * What the delete frees, as a line in the dialog.
     *
     * Only the parts that carry bytes are named, so the line never reads as a
     * wall of zeroes. The figure is the Host's prediction: it counts the Session
     * logs, the checkpoints, and the attachment objects that no surviving Session
     * references.
     * @param {object|undefined} reclaim - the Host's preview.
     * @returns {object|null} the note, or null when there is nothing to say.
     */
    function reclaimNote(reclaim) {
      if (reclaim === undefined || reclaim === null) return null
      const parts = []
      const logs = typeof reclaim.logBytes === 'number' ? reclaim.logBytes : 0
      const checkpoints = typeof reclaim.checkpointBytes === 'number' ? reclaim.checkpointBytes : 0
      const attachments = typeof reclaim.attachments?.bytes === 'number' ? reclaim.attachments.bytes : 0
      if (logs > 0) parts.push(t('dialog.reclaim.logs', { size: formatBytes(logs) }))
      if (checkpoints > 0) parts.push(t('dialog.reclaim.cache', { size: formatBytes(checkpoints) }))
      if (attachments > 0) {
        parts.push(t('dialog.reclaim.attachments', { n: reclaim.attachments.count ?? 0, size: formatBytes(attachments) }))
      }
      const total = logs + checkpoints + attachments
      const shared = typeof reclaim.attachments?.shared === 'number' ? reclaim.attachments.shared : 0
      const children = [
        h('p', {
          className: 'dsd-noteTitle',
          key: 'head',
          children: total > 0
            ? t('dialog.reclaim.title', { size: formatBytes(total) })
            : t('dialog.reclaim.none'),
        }),
      ]
      if (parts.length > 0) {
        children.push(h('p', { className: 'dsd-noteHint', key: 'parts', children: parts.join(' · ') }))
      }
      if (shared > 0) {
        children.push(h('p', { className: 'dsd-noteHint', key: 'shared', children: t('dialog.reclaim.shared', { n: shared }) }))
      }
      return h('div', { className: 'dsd-note dsd-reclaim', key: 'reclaim' }, children)
    }

    /** Ask the Host what this Session's state is before committing to anything. */
    async function inspectSession(sessionId) {
      const response = await fetch(`${INSPECT_PATH}?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) throw failureOf(payload, response)
      return payload
    }

    /**
     * Ask the Host half to delete one Session.
     * @param sessionId - the Session the user acted on.
     * @param stop - whether running work may be stopped first.
     * @param descendants - the descendant ids the user ticked; always sent, so
     *   the Host deletes exactly what the dialog showed.
     */
    async function deleteSession(sessionId, stop, descendants) {
      const response = await fetch(DELETE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, stop: stop === true, descendants }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) throw failureOf(payload, response)
      // The Host is done with the files; the drafts and panel layouts for these
      // Sessions live only in this page's storage. A Session deleted while its
      // slot is still mounted re-creates one key after this pass, so the clear
      // is repeated on later ticks until the keys stay gone — that repetition is
      // what used to require quitting the app and editing the LevelDB by hand.
      const ids = removedIdsOf(payload)
      payload.clientKeysRemoved = clearSessionStorage(ids)
      reclearSessionStorage(ids)
      return payload
    }

    /** The activity families reported for one Session, or an empty list. */
    function activityOf(entity) {
      return Array.isArray(entity?.activity) ? entity.activity : []
    }

    /**
     * Ask the Host to sweep unreferenced bytes, or to report them first.
     * @param {boolean} dryRun - report without removing anything.
     * @returns {Promise<object>} the Host's sweep report.
     */
    async function sweepStorage(dryRun) {
      const response = await fetch(SWEEP_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: dryRun === true }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) throw failureOf(payload, response)
      return payload
    }

    /** The tail of an id, so two same-titled Sessions stay distinguishable. */
    function shortId(id) {
      return typeof id === 'string' && id.length > 6 ? `…${id.slice(-6)}` : id
    }

    /**
     * Fold the per-Session activity a refusal reported back into the state the
     * dialog is showing, so the rows that are busy say so on the next render.
     */
    function mergeActivity(info, activeSessions) {
      if (info === null || info === undefined) return info
      const byId = new Map()
      for (const entry of activeSessions) {
        if (typeof entry?.sessionId !== 'string') continue
        byId.set(entry.sessionId, Array.isArray(entry.activity) ? entry.activity : [])
      }
      const descendants = info.descendants === undefined
        ? undefined
        : {
          ...info.descendants,
          items: Array.isArray(info.descendants.items)
            ? info.descendants.items.map((item) => (byId.has(item.id) ? { ...item, activity: byId.get(item.id) } : item))
            : info.descendants.items,
        }
      return {
        ...info,
        activity: byId.get(info.sessionId) ?? activityOf(info),
        ...(descendants === undefined ? {} : { descendants }),
      }
    }

    // ---- the menu row -------------------------------------------------------
    /** One "⋯" menu row (order 500): ask to delete this Session. */
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState } = props
      const menuOpenState = typeof useMenuOpenState === 'function' ? useMenuOpenState : null
      const setMenuOpen = menuOpenState === null ? null : menuOpenState()[1]
      const onSelect = useCallback(() => {
        if (setMenuOpen !== null) setMenuOpen(false)
        openConfirm({ sessionId, title: displayTitle })
      }, [sessionId, displayTitle, setMenuOpen])
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dsd-item dsd-danger',
        onClick: onSelect,
        children: [
          h('span', { className: 'dsd-itemIcon', key: 'icon', children: trashIcon() }),
          h('span', { className: 'dsd-itemLabel', key: 'label', children: t('menu.delete') }),
        ],
      })
    }

    /** One 14px trash glyph, drawn in the menu icon's colour. */
    function trashIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M3 4.5h10M6.5 4.5V3.25A.75.75 0 0 1 7.25 2.5h1.5a.75.75 0 0 1 .75.75V4.5M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }
    // ---- the confirmation dialog -------------------------------------------
    const IDLE = { phase: 'idle', info: null, error: null, stop: false, busy: false }
    /**
     * The sweep half of the dialog: what is collectable, and what was freed.
     *
     * `done` carries the report of the last press that actually ran, so the
     * section can state the figure it freed rather than leaving the number on
     * screen as though it were still pending.
     */
    const SWEEP_IDLE = { phase: 'idle', report: null, error: null, done: null }
    /** The phase after a delete succeeded: the rows are gone, only the sum remains. */
    const DELETED = { phase: 'done', info: null, error: null, stop: false, busy: false, freed: 0 }

    /** The `shell.overlay` seat: one confirmation while a delete is pending. */
    function DeleteSessionDialog() {
      const request = useSyncExternalStore(subscribe, getPending)
      const [state, setState] = useState(IDLE)
      const [selected, setSelected] = useState(null)
      const [collapsed, setCollapsed] = useState({})
      const [sweep, setSweep] = useState(SWEEP_IDLE)
      const dialog = useRef(null)
      // The sweep half's phase, read where it is needed: the close guard has to
      // know whether a reclamation is still running before the first render
      // derives it, and the buttons need it below.
      const sweepPhase = sweep.phase
      const sweepRunning = sweepPhase === 'running'
      // A delete that succeeded leaves the dialog in `done`: the rows are gone
      // from the sidebar, so the only thing left to say is what it freed.
      const done = state.phase === 'done'

      const close = useCallback(() => {
        setState((previous) => {
          if (previous.busy || sweepRunning) return previous
          settle()
          return IDLE
        })
        setSelected(null)
        setSweep(SWEEP_IDLE)
      }, [sweepRunning])

      // Every open re-reads the Host's state: the answer is only true for the
      // moment the dialog opened, and a Session can start working in between.
      // Nobody is selected until that answer arrives, so a Session whose family
      // is still being walked can never be deleted by accident.
      useEffect(() => {
        if (request === null) {
          setState(IDLE)
          setSelected(null)
          setSweep(SWEEP_IDLE)
          return undefined
        }
        let cancelled = false
        setState({ phase: 'checking', info: null, error: null, stop: false, busy: false })
        setSelected(null)
        // The sweep half scans on its own: what an *earlier* delete left behind is
        // a separate question from this one, and its answer is only true for the
        // moment it was read.
        setSweep({ phase: 'scanning', report: null, error: null, done: null })
        inspectSession(request.sessionId).then(
          (info) => {
            if (cancelled) return
            const items = Array.isArray(info?.descendants?.items) ? info.descendants.items : []
            setSelected(new Set(items.map((item) => item.id)))
            setState({
              phase: 'ready',
              info,
              error: null,
              // Default to stopping work, but only when something is running.
              stop: activityOf(info).length > 0 || items.some((item) => activityOf(item).length > 0),
              busy: false,
            })
          },
          () => {
            if (!cancelled) setState({ phase: 'ready', info: null, error: null, stop: false, busy: false })
          },
        )
        sweepStorage(true).then(
          (report) => {
            if (!cancelled) setSweep({ phase: 'ready', report, error: null, done: null })
          },
          (reason) => {
            if (!cancelled) {
              setSweep({
                phase: 'ready',
                report: null,
                error: reason instanceof Error ? reason.message : String(reason),
                done: null,
              })
            }
          },
        )
        return () => {
          cancelled = true
        }
      }, [request])

      useEffect(() => {
        if (request === null) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [request, close])

      useEffect(() => {
        if (request !== null) dialog.current?.focus()
      }, [request])

      if (request === null) return null

      const info = state.info
      const items = Array.isArray(info?.descendants?.items) ? info.descendants.items : []
      const picked = selected ?? new Set(items.map((item) => item.id))
      const selectedCount = items.filter((item) => picked.has(item.id)).length

      const toggleMany = (ids, on) => {
        setSelected(() => {
          const next = new Set(picked)
          for (const id of ids) {
            if (on) next.add(id)
            else next.delete(id)
          }
          return next
        })
      }

      const confirm = () => {
        if (state.busy || state.phase !== 'ready') return
        const chosen = items.filter((item) => picked.has(item.id)).map((item) => item.id)
        setState((previous) => ({ ...previous, busy: true, error: null }))
        deleteSession(request.sessionId, state.stop, chosen).then(
          (payload) => {
            // The Host is done with the files and the rows have left the
            // sidebar; what the delete actually freed is the last thing to
            // report, and the sweep half beside it still applies — the bytes an
            // *earlier* delete left behind are untouched by this one.
            const freed = typeof payload?.reclaimed?.bytes === 'number' ? payload.reclaimed.bytes : 0
            setSelected(null)
            setState({ ...DELETED, freed })
          },
          (reason) => {
            // A Session that started working between the check and the write
            // answers with its activity, so the next press stops it and the rows
            // that are busy say so.
            const active = Array.isArray(reason?.activeSessions) ? reason.activeSessions : null
            setState((previous) => ({
              ...previous,
              busy: false,
              error: reason instanceof Error ? reason.message : String(reason),
              stop: previous.stop || reason?.code === 'session-active' || active !== null,
              info: active === null ? previous.info : mergeActivity(previous.info, active),
            }))
          },
        )
      }

      /**
       * Run the sweep, or report it first.
       * @param {boolean} dryRun - report without removing anything.
       */
      const runSweep = (dryRun) => {
        if (sweepRunning || state.busy) return
        setSweep((previous) => ({ ...previous, phase: 'running', error: null }))
        sweepStorage(dryRun).then(
          (report) => setSweep({ phase: 'ready', report, error: null, done: report }),
          (reason) => setSweep((previous) => ({
            ...previous,
            phase: 'ready',
            error: reason instanceof Error ? reason.message : String(reason),
          })),
        )
      }

      const title = request.title === undefined || request.title === '' ? t('dialog.untitled') : request.title
      const activity = activityOf(info)
      const checking = state.phase === 'checking'
      const deletedCount = selectedCount + 1
      const confirmLabel = state.busy || checking
        ? (checking ? t('dialog.checking') : t('dialog.deleting'))
        : state.stop
          ? t('dialog.confirmStopCount', { n: deletedCount })
          : t('dialog.confirmCount', { n: deletedCount })
      // The delete-half body only makes sense while there is something left to
      // choose: once the rows are gone the dialog states the result instead.
      const showDeleteBody = !done

      return h('div', {
        className: 'dsd-overlay',
        role: 'presentation',
        onKeyDownCapture: (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            close()
          }
        },
      }, [
        h('div', { className: 'dsd-mask', key: 'mask', 'aria-hidden': true, onClick: close }),
        h('div', {
          className: 'dsd-dialog',
          key: 'dialog',
          ref: dialog,
          tabIndex: -1,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('dialog.title'),
        }, [
          h('h2', { className: 'dsd-title', key: 'title', children: t('dialog.title') }),
          done
            ? h('p', {
              className: 'dsd-note dsd-done',
              key: 'done',
              children: t('dialog.reclaim.done', { size: formatBytes(state.freed) }),
            })
            : h('p', { className: 'dsd-desc', key: 'desc', children: t('dialog.desc', { title }) }),
          showDeleteBody && activity.length === 0
            ? null
            : h('div', { className: 'dsd-note dsd-warn', key: 'running' }, [
              h('p', { className: 'dsd-noteTitle', key: 'head', children: t('dialog.running') }),
              h('ul', { className: 'dsd-list', key: 'list' }, activity.map((entry, index) => {
                const names = Array.isArray(entry.items)
                  ? entry.items.map((item) => (item.label === '' ? item.id : item.label)).filter((name) => name !== '')
                  : []
                return h('li', { key: `${entry.kind}-${index}` }, names.length === 0 ? entry.label : `${entry.label}：${names.join('、')}`)
              })),
              h('p', { className: 'dsd-noteHint', key: 'hint', children: t('dialog.runningHint') }),
            ]),
          showDeleteBody && info !== null && info.open === true && activity.length === 0
            ? h('p', { className: 'dsd-note', key: 'open', children: t('dialog.open') })
            : null,
          showDeleteBody && state.phase === 'ready' && info === null
            ? h('p', { className: 'dsd-note', key: 'unknown', children: t('dialog.unknown') })
            : null,
          showDeleteBody ? reclaimNote(info?.reclaim) : null,
          showDeleteBody
            ? h(FamilyTree, {
              key: 'tree',
              items,
              implicitParent: request.sessionId,
              main: title,
              selected: picked,
              onToggle: toggleMany,
              collapsed,
              setCollapsed,
              disabled: state.busy,
              leafName: t('dialog.untitledItem'),
            })
            : null,
          showDeleteBody && info?.descendants?.truncated === true
            ? h('p', {
              className: 'dsd-note dsd-hint',
              key: 'truncated',
              children: t('dialog.truncated', { n: info.descendants.count, shown: items.length }),
            })
            : null,
          showDeleteBody && typeof info?.descendants?.maxDeletable === 'number' && info.descendants.count > info.descendants.maxDeletable
            ? h('p', {
              className: 'dsd-note dsd-hint',
              key: 'cap',
              children: t('dialog.maxDeletable', { max: info.descendants.maxDeletable }),
            })
            : null,
          // A source that failed leaves rows missing, which no row can say for
          // itself: this is where the family's own report of that lands.
          ...(showDeleteBody && Array.isArray(info?.warnings) && info.warnings.length > 0
            ? [h('div', { className: 'dsd-note dsd-warn', key: 'warnings' }, [
              h('p', { className: 'dsd-noteTitle', key: 'head', children: t('dialog.warnings') }),
              h('ul', { className: 'dsd-list', key: 'list' }, info.warnings.map((warning, index) => h('li', { key: index }, String(warning)))),
            ])]
            : []),
          h(SweepSection, {
            key: 'sweep',
            sweep,
            disabled: state.busy,
            onRun: runSweep,
          }),
          state.error === null
            ? null
            : h('p', { className: 'dsd-error', key: 'error', children: `${t('dialog.failed')}：${state.error}` }),
          h('div', { className: 'dsd-footer', key: 'footer' }, done
            ? h('button', {
              type: 'button',
              className: 'dsd-button dsd-outline',
              key: 'close',
              disabled: sweepRunning,
              onClick: close,
              children: t('dialog.close'),
            })
            : [
              h('button', {
                type: 'button',
                className: 'dsd-button dsd-outline',
                key: 'cancel',
                disabled: state.busy || sweepRunning,
                onClick: close,
                children: t('dialog.cancel'),
              }),
              h('button', {
                type: 'button',
                className: 'dsd-button dsd-outline dsd-dangerText',
                key: 'confirm',
                disabled: state.busy || checking || sweepRunning,
                onClick: confirm,
                children: confirmLabel,
              }),
            ]),
        ]),
      ])
    }

    /** The indent one tree level adds, in CSS pixels. */
    const INDENT = 18

    /**
     * The 16px outline glyphs the family tree draws, each as [tag, attributes]
     * pairs in the shipped icon set's own convention: fill none, stroke
     * currentColor, round joins, on a 16px box.
     */
    const TREE_GLYPHS = {
      // The conversation itself: a document with a folded corner.
      session: [
        ['path', { d: 'M3.5 2.5H9L12.5 6v7.5h-9z' }],
        ['path', { d: 'M9 2.5V6h3.5' }],
        ['path', { d: 'M5.75 8.75h4.5' }],
        ['path', { d: 'M5.75 11.25h2.75' }],
      ],
      // A spawned Session: a robot head. Marks the 子智能体 block.
      subagent: [
        ['path', { d: 'M4.5 6.5h7A1.5 1.5 0 0 1 13 8v3.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 11.5V8a1.5 1.5 0 0 1 1.5-1.5z' }],
        ['path', { d: 'M8 6.5V3.75' }],
        ['path', { d: 'M6.5 3.75h3' }],
        ['circle', { cx: 6.35, cy: 9.3, r: 0.7 }],
        ['circle', { cx: 9.65, cy: 9.3, r: 0.7 }],
      ],
      // One subagent Session's own row.
      member: [
        ['path', { d: 'M8 7.75A2.125 2.125 0 1 0 8 3.5a2.125 2.125 0 0 0 0 4.25z' }],
        ['path', { d: 'M3.75 13.5c0-2.35 1.9-3.75 4.25-3.75s4.25 1.4 4.25 3.75' }],
      ],
      // A derived conversation: a chat bubble. Marks the 派生对话 block.
      chat: [
        ['path', { d: 'M14 10a1.33 1.33 0 0 1-1.33 1.33H4.67L2 14V3.33A1.33 1.33 0 0 1 3.33 2h9.34A1.33 1.33 0 0 1 14 3.33z' }],
      ],
      // The relation a fork is: two links.
      linked: [
        ['path', { d: 'M6.67 8.67a3.33 3.33 0 0 0 5.03.36l2-2a3.33 3.33 0 0 0-4.71-4.71l-1.15 1.14' }],
        ['path', { d: 'M9.33 7.33a3.33 3.33 0 0 0-5.03-.36l-2 2a3.33 3.33 0 0 0 4.71 4.71l1.14-1.14' }],
      ],
    }

    /** One outline glyph, drawn at the given box size. */
    function treeGlyph(name, size) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block' },
      }, TREE_GLYPHS[name].map((entry, index) => h(entry[0], { key: index, ...entry[1] })))
    }

    /**
     * The family as a forest: one node per Session, its children hanging under it.
     *
     * A row whose parentId names another listed row hangs under that row. A row
     * whose parent is not listed — because it is the Session the single dialog is
     * about, because it belongs to another Workspace, or because its parent simply
     * is not in this list — is a root. A hand-edited header cycle is cut rather
     * than followed, so the drawing can never recurse forever.
     * @param {object[]} entries - the family rows, in the Host's order.
     * @param {string|null} implicitParent - the id whose children are the roots.
     * @returns {object[]} the roots, each { id, entry, children }.
     */
    function buildForest(entries, implicitParent) {
      const nodes = new Map()
      for (const entry of entries) {
        const id = entry === null || typeof entry !== 'object' ? null : entry.id
        if (typeof id !== 'string' || id === '' || nodes.has(id)) continue
        nodes.set(id, { id, entry, children: [] })
      }
      const parentOf = (node) => {
        const parentId = typeof node.entry.parentId === 'string' ? node.entry.parentId : null
        if (parentId === null || parentId === node.id) return undefined
        return nodes.get(parentId)
      }
      /** Whether hanging one node under another would close a loop. */
      const loops = (node, candidate) => {
        const guard = new Set([node.id])
        let current = candidate
        while (current !== undefined) {
          if (guard.has(current.id)) return true
          guard.add(current.id)
          current = parentOf(current)
        }
        return false
      }
      const roots = []
      for (const node of nodes.values()) {
        const parentId = typeof node.entry.parentId === 'string' ? node.entry.parentId : null
        const parent = parentId === implicitParent ? undefined : parentOf(node)
        if (parent === undefined || loops(node, parent)) roots.push(node)
        else parent.children.push(node)
      }
      return roots
    }

    /**
     * One node's whole subtree, itself first.
     * @param {object} node - a forest node.
     * @returns {string[]} the ids.
     */
    function subtreeIds(node) {
      const ids = []
      const walk = (current) => {
        ids.push(current.id)
        for (const child of current.children) walk(child)
      }
      walk(node)
      return ids
    }

    /**
     * The family tree both dialogs draw.
     *
     * One row per Session, and under every row two collapsible blocks: its direct
     * 子智能体, then its direct 派生对话. A derived conversation therefore holds
     * its own subagents, and its own derived conversations, inside its own block
     * one step further in, instead of in a second list that only shares a heading
     * with it. The nesting is expressed by the indentation alone: no connectors,
     * no guide lines, so a row's place is read from its indent.
     *
     * A row's checkbox covers that row's whole subtree, and a block's covers every
     * row the block lists. Both report the same two states: ticked when everything
     * below them is ticked, mixed when only part of it is.
     * @param {object} props - the family, the selection, and the drawing callbacks.
     */
    function FamilyTree(props) {
      const { items, implicitParent, main, selected, onToggle, collapsed, setCollapsed, disabled, leafName } = props
      const forest = buildForest(items, implicitParent === undefined ? null : implicitParent)

      /** A set of ids read as a checkbox state. */
      const stateOf = (ids) => {
        let on = ids.length > 0
        let some = false
        for (const id of ids) {
          if (selected.has(id)) some = true
          else on = false
        }
        return { on, partial: some && !on }
      }

      /** One checkbox: ticked when every id it covers is ticked, mixed when only some are. */
      const box = (ids) => {
        const state = stateOf(ids)
        return h('input', {
          type: 'checkbox',
          key: 'box',
          className: 'dsd-check',
          checked: state.on,
          disabled: disabled === true,
          ref: (input) => {
            if (input !== null) input.indeterminate = state.partial
          },
          onChange: () => onToggle(ids, !state.on),
        })
      }

      /** The caret of one row or block, or the empty column a leaf keeps. */
      const caret = (collapseKey, hasChildren, isCollapsed) => (hasChildren
        ? h('button', {
          type: 'button',
          key: 'caret',
          className: 'dsd-caret',
          'aria-expanded': !isCollapsed,
          onClick: () => setCollapsed((previous) => ({ ...previous, [collapseKey]: !isCollapsed })),
          children: isCollapsed ? '▸' : '▾',
        })
        : h('span', { className: 'dsd-caret dsd-caretLeaf', key: 'caret', 'aria-hidden': true }))

      /** The badges one row carries: what that Session is doing right now. */
      const badgesOf = (entry) => {
        const busy = activityOf(entry)
        return [
          ...busy.map((item) => item.label),
          ...(busy.length === 0 && entry.running === true ? [t('dialog.itemRunning')] : []),
          ...(entry.open === true ? [t('dialog.itemOpen')] : []),
        ]
      }

      /**
       * One collapsible block: the direct children of one row that share one kind.
       * @param {string} collapseKey - unique to this parent and kind.
       * @param {string} label - the block's text, already counted.
       * @param {string} glyphName - the glyph the heading carries.
       * @param {object[]} members - the child nodes the block lists.
       * @param {number} depth - the indent the heading sits at; members sit one deeper.
       */
      const drawBlock = (collapseKey, label, glyphName, members, depth) => {
        const isCollapsed = collapsed[collapseKey] === true
        const ids = members.flatMap((member) => subtreeIds(member))
        return h('div', { className: 'dsd-block', key: collapseKey }, [
          h('div', {
            className: 'dsd-node dsd-nodeBranch',
            key: 'head',
            style: { paddingInlineStart: (depth * INDENT) + 'px' },
          }, [
            caret(collapseKey, true, isCollapsed),
            h('label', { className: 'dsd-nodeLabel', key: 'label' }, [
              box(ids),
              h('span', { className: 'dsd-rowIcon', key: 'glyph', children: treeGlyph(glyphName, 14) }),
              h('span', { className: 'dsd-rowText', key: 'text' }, [
                h('span', { className: 'dsd-blockTitle', key: 'name', children: label }),
              ]),
            ]),
          ]),
          isCollapsed
            ? null
            : h('div', { className: 'dsd-children', key: 'rows' }, members.map((member) => drawNode(member, depth + 1, member.id))),
        ])
      }

      /** One Session row, then the blocks holding its own direct children. */
      const drawNode = (node, depth, key) => {
        const entry = node.entry
        const isCollapsed = collapsed[node.id] === true
        const subagents = node.children.filter((child) => child.entry.kind === 'subagent')
        const forks = node.children.filter((child) => child.entry.kind !== 'subagent')
        const hints = badgesOf(entry)
        const glyphName = entry.kind === 'subagent' ? 'member' : entry.kind === 'root' ? 'session' : 'chat'
        return h('div', { className: 'dsd-branch', key }, [
          h('div', {
            className: 'dsd-node',
            key: 'row',
            style: { paddingInlineStart: (depth * INDENT) + 'px' },
          }, [
            caret(node.id, node.children.length > 0, isCollapsed),
            h('label', { className: 'dsd-nodeLabel', key: 'label' }, [
              box(subtreeIds(node)),
              h('span', { className: 'dsd-rowIcon', key: 'glyph', children: treeGlyph(glyphName, 14) }),
              h('span', { className: 'dsd-rowText', key: 'text' }, [
                h('span', {
                  className: 'dsd-rowTitle',
                  key: 'name',
                  children: entry.title === undefined || entry.title === '' ? leafName : entry.title,
                }),
                h('span', { className: 'dsd-rowId', key: 'id', children: shortId(entry.id) }),
              ]),
            ]),
            hints.length === 0
              ? null
              : h('span', { className: 'dsd-badge', key: 'badge', children: hints.join(' · ') }),
          ]),
          isCollapsed || node.children.length === 0
            ? null
            : h('div', { className: 'dsd-children', key: 'children' }, [
              subagents.length === 0
                ? null
                : drawBlock('sub:' + node.id, t('dialog.group.subagentsCount', { n: subagents.length }), 'subagent', subagents, depth + 1),
              forks.length === 0
                ? null
                : drawBlock('fork:' + node.id, t('dialog.group.derivedCount', { n: forks.length }), 'linked', forks, depth + 1),
            ]),
        ])
      }

      const mainIds = items.map((entry) => entry.id)
      const hasMain = main !== null && main !== undefined
      const mainCollapsed = collapsed['__main__'] === true
      return h('div', { className: 'dsd-tree' }, [
        hasMain
          ? h('div', { className: 'dsd-node dsd-nodeMain', key: 'main' }, [
            caret('__main__', forest.length > 0, mainCollapsed),
            h('label', { className: 'dsd-nodeLabel', key: 'label' }, [
              box(mainIds),
              h('span', { className: 'dsd-rowIcon', key: 'glyph', children: treeGlyph('session', 14) }),
              h('span', { className: 'dsd-rowText', key: 'text' }, [
                h('span', {
                  className: 'dsd-rowTitle dsd-mainTitle',
                  key: 'name',
                  children: t('dialog.mainRow', { title: main }),
                }),
              ]),
            ]),
          ])
          : null,
        hasMain && mainCollapsed
          ? null
          : forest.map((node) => drawNode(node, hasMain ? 1 : 0, node.id)),
      ])
    }

    /**
     * The disk-space half of the delete dialog.
     *
     * It sits beside the delete rather than behind a second control, because the
     * two jobs answer each other: a delete only frees what the deleted Sessions
     * alone referenced — a blob a surviving conversation also uses stays, and is
     * reported as *kept* — so the bytes an *earlier* delete left behind, or a
     * crashed publication did, are a separate question this section answers. It
     * never removes a Session: only a delete knows which lineage is going away,
     * and a subagent or a fork is a legitimate Session no Workspace record lists.
     *
     * The figure is stated before anything is removed, the same honesty rule the
     * delete preview follows, so the dialog opens by scanning (`dryRun`) and the
     * button names the exact amount. A press that finds nothing to do says so
     * instead of reporting a zero as a success.
     * @param {object} props - the sweep state, the disabled flag, and `onRun`.
     */
    function SweepSection(props) {
      const { sweep, disabled, onRun } = props
      const phase = sweep?.phase ?? 'idle'
      const report = sweep?.report ?? null
      const busy = phase === 'scanning' || phase === 'running'
      const rows = []
      if (report !== null && !busy) {
        const add = (label, count, bytes) => {
          if (bytes > 0) rows.push([label, count === null ? formatBytes(bytes) : `${count} · ${formatBytes(bytes)}`])
        }
        add(t('sweep.attachments', { n: report.attachments?.removed ?? 0 }), report.attachments?.removed ?? 0, report.attachments?.bytes ?? 0)
        add(t('sweep.staging', { n: report.staging?.removed ?? 0 }), report.staging?.removed ?? 0, report.staging?.bytes ?? 0)
        add(t('sweep.uploadCache', { n: report.uploadCache?.removed ?? 0 }), report.uploadCache?.removed ?? 0, report.uploadCache?.bytes ?? 0)
        add(t('sweep.searchIndex'), null, report.searchIndex?.bytes ?? 0)
        add(t('sweep.backups', { n: report.backups?.removed ?? 0 }), report.backups?.removed ?? 0, report.backups?.bytes ?? 0)
      }
      const total = report?.bytes ?? 0

      return h('div', { className: 'dsd-reclaim', key: 'sweep' }, [
        h('p', { className: 'dsd-noteTitle', key: 'title', children: t('sweep.title') }),
        h('p', { className: 'dsd-noteHint', key: 'hint', children: t('sweep.hint') }),
        phase === 'scanning'
          ? h('p', { className: 'dsd-note', key: 'scanning', children: t('sweep.scanning') })
          : null,
        sweep?.error
          ? h('p', { className: 'dsd-error', key: 'error', children: `${t('sweep.failed')}：${sweep.error}` })
          : null,
        sweep?.done !== null && sweep?.done !== undefined
          ? h('p', {
            className: 'dsd-note',
            key: 'done',
            children: sweep.done.bytes > 0
              ? t('sweep.done', { size: formatBytes(sweep.done.bytes) })
              : t('sweep.doneNone'),
          })
          : null,
        report === null || busy
          ? null
          : rows.length === 0
            ? h('p', { className: 'dsd-note', key: 'empty', children: t('sweep.empty') })
            : h('div', { className: 'dsd-reclaimRows', key: 'rows' }, [
              h('p', { className: 'dsd-noteTitle', key: 'total', children: t('sweep.total', { size: formatBytes(total) }) }),
              ...rows.map(([label, value], index) => h('div', {
                className: 'dsd-reclaimRow',
                key: `${index}-${label}`,
              }, [
                h('span', { key: 'label', children: label }),
                h('span', { className: 'dsd-reclaimValue', key: 'value', children: value }),
              ])),
            ]),
        h('div', { className: 'dsd-sweepFoot', key: 'foot' }, [
          h('button', {
            type: 'button',
            className: 'dsd-button dsd-outline dsd-sweepRun',
            key: 'run',
            disabled: busy || disabled === true || total === 0,
            onClick: () => onRun(false),
            children: phase === 'running'
              ? t('sweep.running')
              : total === 0
                ? t('sweep.empty')
                : t('sweep.run'),
          }),
          h('button', {
            type: 'button',
            className: 'dsd-button dsd-link',
            key: 'rescan',
            disabled: busy || disabled === true,
            onClick: () => onRun(true),
            children: t('sweep.rescan'),
          }),
        ]),
      ])
    }

    /** The plugin's own styles: host tokens only, so light and dark both read. */
    const CSS = `
.dsd-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;cursor:pointer;font:inherit;font-size:13px;line-height:20px;text-align:left;color:var(--dsw-alias-state-error-primary,#e5484d)}
.dsd-item:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,72,77,.12))}
.dsd-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,72,77,.12));outline:none}
.dsd-itemIcon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center}
.dsd-itemLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsd-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto}
.dsd-mask{position:absolute;inset:0;background:rgba(0,0,0,.45)}
.dsd-dialog{position:relative;z-index:1;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:min(420px,100%);max-height:100%;overflow:auto;padding:22px 24px 20px;border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-2,#1b1d21);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.34))}
.dsd-dialog:focus{outline:none}
.dsd-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsd-desc{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary,#a8adb7);word-break:break-word}
.dsd-note{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#a8adb7);word-break:break-word}
.dsd-warn{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-state-warn-primary,#d9a03a);color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsd-noteTitle{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-warn-primary,#d9a03a)}
.dsd-noteHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#a8adb7)}
.dsd-list{margin:0;padding-inline-start:18px;font-size:13px;line-height:20px}
.dsd-tree{display:flex;flex-direction:column;gap:2px;padding:6px 0;border-block:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}
.dsd-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer}
.dsd-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsd-check{flex:none;width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-state-error-primary,#e5484d);cursor:pointer}
.dsd-rowText{flex:1;min-width:0;display:flex;align-items:baseline;gap:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsd-rowTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsd-rowId{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#a8adb7)}
.dsd-badge{flex:none;font-size:11px;line-height:16px;padding:1px 6px;border-radius:999px;border:.5px solid var(--dsw-alias-state-warn-primary,#d9a03a);color:var(--dsw-alias-state-warn-primary,#d9a03a)}
.dsd-caret{flex:none;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#a8adb7);cursor:pointer;font:inherit;font-size:11px;line-height:1}
.dsd-caret:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
/* The family tree: one row per Session, its children in collapsible blocks under
   it. The nesting is the indentation alone — no connectors, no guide lines. */
.dsd-branch{display:flex;flex-direction:column}
.dsd-node{position:relative;box-sizing:border-box;display:flex;align-items:center;gap:2px;min-height:28px}
.dsd-nodeLabel{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer}
.dsd-nodeLabel:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsd-nodeMain>.dsd-nodeLabel{font-weight:500}
.dsd-nodeBranch>.dsd-nodeLabel{color:var(--dsw-alias-label-secondary,#a8adb7);font-weight:500}
.dsd-rowIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-tertiary,#8b909a)}
.dsd-nodeMain .dsd-rowIcon{color:var(--dsw-alias-label-secondary,#a8adb7)}
.dsd-mainTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsd-blockTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsd-caretLeaf{cursor:default}
.dsd-caretLeaf:hover{background:transparent}
.dsd-children{display:flex;flex-direction:column}
.dsd-hint{margin:4px 0 0;font-size:12px;line-height:18px}
/* The post-delete result line: the rows are gone, this is what they freed. */
.dsd-done{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#e6e6e6)}
/* The reclaim estimate reads as information, not as a warning. */
.dsd-reclaim{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.32));color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsd-reclaim .dsd-noteTitle{color:var(--dsw-alias-label-secondary,#a8adb7)}
.dsd-reclaimRows{display:flex;flex-direction:column;gap:2px;padding:4px 0}
.dsd-reclaimRow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#a8adb7)}
.dsd-reclaimValue{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsd-error{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary,#e5484d);word-break:break-word}
.dsd-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:8px}
.dsd-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border-radius:var(--dsw-radius-md,8px);cursor:pointer;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#e6e6e6);background:transparent}
.dsd-button:disabled{cursor:not-allowed;opacity:.4}
.dsd-outline{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.32))}
.dsd-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsd-dangerText{color:var(--dsw-alias-state-error-primary,#e5484d)}
/* The sweep half's own row of controls: the reclaim button leads, the rescan
   link trails, both inside the section rather than in the dialog footer — the
   footer belongs to the delete, and the two must not read as one action. */
.dsd-sweepFoot{display:flex;align-items:center;gap:8px;margin-top:2px}
.dsd-sweepRun{height:30px;padding:0 12px;font-size:13px;line-height:20px}
`

    /** Mount the plugin's stylesheet with its components. */
    function Styles() {
      return h('style', { 'data-dsh-plugin': 'better-dsh-session-deletetool', children: CSS })
    }

    /** The menu row and its dialog, wrapped so the stylesheet travels with them. */
    function WithStyles(Component) {
      function StyledComponent(props) {
        return h(React.Fragment, null, h(Styles, { key: 'style' }), h(Component, { ...props, key: 'body' }))
      }
      StyledComponent.displayName = `BetterSessionDeletetool(${Component.name})`
      return StyledComponent
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale')
        if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          ctx.effect(() => locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'better-dsh-session-deletetool: locale')
          translate = locale.bind(NS)
        }
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'better-dsh-session-deletetool', order: 500, locale: NS },
            WithStyles(DeleteSessionMenuItem),
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'better-dsh-session-deletetool-dialog', order: 60, locale: NS },
            WithStyles(DeleteSessionDialog),
          ),
        )
        // One registration in total: the menu row and the one dialog it opens,
        // which carries both the delete and the disk-space control. There is
        // deliberately no sidebar control of the plugin's own — the sidebar's
        // browsing header is a `single` slot whose search cell holds exactly one
        // 28px icon, and a second control there overlapped the shipped
        // view-options and add-workspace buttons.
      },
      /**
       * The pure halves, reachable only from a test run.
       *
       * The harness loads this file in the page; nothing else can see these
       * functions, and the property costs one boolean check at load.
       */
      ...(globalThis.__DSD_TEST__ === true
        ? {
          __test: {
            buildForest,
            subtreeIds,
            SweepSection,
            DeleteSessionDialog,
            failureOf,
            formatBytes,
            clearSessionStorage,
            reclearSessionStorage,
            removedIdsOf,
            SESSION_KEY_PREFIXES,
          },
        }
        : {}),
    }
  },
})
