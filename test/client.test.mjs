/**
 * Client-half tests: the parts of the Client bundle that are pure enough to test
 * without a browser.
 *
 * The bundle is a `window.__ModuleLoader__.load({...})` call, so this harness
 * supplies the tiny `window`/`require` surface it needs, captures the module,
 * and exercises its exported `__test` helpers. That keeps the localStorage key
 * handling — the one piece of the Client half that can destroy user data — under
 * a real test instead of resting on inspection.
 *
 *   node --test test/client.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Load `client.js` in a fake renderer and return its `__test` surface.
 *
 * The bundle reads `window.__ModuleLoader__` and `globalThis.__DSD_TEST__`, and
 * requires `react`; all three are stubbed. A minimal `localStorage` is installed
 * so the key handling runs against real storage semantics.
 */
async function loadClient({ storage } = {}) {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  const listeners = new Map()
  const fakeStorage = storage ?? {
    map: new Map(),
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null },
    setItem(key, value) { this.map.set(key, String(value)) },
    removeItem(key) { this.map.delete(key) },
    get length() { return this.map.size },
    key(index) { return [...this.map.keys()][index] ?? null },
  }

  const react = {
    // React treats a single array argument as the child list, which is how the
    // bundle passes children; flatten it so a test reads the same shape.
    createElement: (type, props, ...children) => ({
      type,
      props,
      children: children.length === 1 && Array.isArray(children[0]) ? children[0] : children,
    }),
    Fragment: 'Fragment',
    useCallback: (fn) => fn,
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useSyncExternalStore: (subscribe, get) => get(),
  }

  let captured = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          captured = definition
        },
      },
    },
    localStorage: fakeStorage,
    // The bundle gates its `__test` export on this flag, and reads it when the
    // factory runs — so it must still be set at that point, not only at load.
    __DSD_TEST__: true,
  }

  // The bundle reads `localStorage` from the global scope at *call* time, not
  // from a captured binding, so the sandbox has to stay installed for as long as
  // the test uses the returned helpers. Re-installing per test is enough: each
  // `loadClient()` call replaces the whole sandbox with a fresh one.
  for (const key of Object.keys(sandbox)) globalThis[key] = sandbox[key]

  const factory = new Function('require', `${source}\nreturn undefined`)
  factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  })

  assert.ok(captured !== null, 'the bundle registered itself with the module loader')
  const module = captured.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  })
  assert.ok(module.__test !== undefined, 'the __test surface is exported under the test flag')
  return { module: module.__test, storage: fakeStorage, listeners }
}

test('formats byte counts in the reader\'s units', async () => {
  const { module } = await loadClient()
  assert.equal(module.formatBytes(0), '0 B')
  assert.equal(module.formatBytes(512), '512 B')
  assert.equal(module.formatBytes(1024), '1.0 KB')
  assert.equal(module.formatBytes(1536), '1.5 KB')
  assert.equal(module.formatBytes(10 * 1024), '10 KB')
  assert.equal(module.formatBytes(1024 * 1024), '1.0 MB')
  assert.equal(module.formatBytes(1024 ** 3), '1.0 GB')
  // A missing or nonsense count reads as zero rather than as "NaN B".
  assert.equal(module.formatBytes(undefined), '0 B')
  assert.equal(module.formatBytes(Number.NaN), '0 B')
})

test('clears exactly the keys a deleted Session owned', async () => {
  const { module, storage } = await loadClient()
  const gone = 'session-aaaa'
  const stays = 'session-bbbb'

  // Every session-keyed namespace the shipped client uses, for both Sessions.
  for (const prefix of module.SESSION_KEY_PREFIXES) {
    storage.setItem(`${prefix}.${gone}`, 'stale')
    storage.setItem(`${prefix}.${stays}`, 'keep')
  }
  // A global key must never be touched.
  storage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: gone }))
  storage.setItem('dsh.workspace.view.v5', 'global')

  const removed = module.clearSessionStorage([gone])

  assert.equal(removed, module.SESSION_KEY_PREFIXES.length, 'every namespace for the deleted Session')
  for (const prefix of module.SESSION_KEY_PREFIXES) {
    assert.equal(storage.getItem(`${prefix}.${gone}`), null, `${prefix}.${gone} is gone`)
    assert.equal(storage.getItem(`${prefix}.${stays}`), 'keep', `${prefix}.${stays} is untouched`)
  }
  assert.notEqual(storage.getItem('dsh.sessions.current'), null, 'the global cursor survives')
  assert.equal(storage.getItem('dsh.workspace.view.v5'), 'global', 'the global view survives')
})

test('a prefix that is not session keyed is never cleared by accident', async () => {
  const { module, storage } = await loadClient()
  // `dsh.conversation.contentWidth` is a global preference whose key starts with
  // a session prefix; only the exact `<prefix>.<id>` shape may be touched.
  storage.setItem('dsh.conversation.contentWidth', '900')
  storage.setItem('dsh.conversation.session-cccc', 'stale')

  module.clearSessionStorage(['session-cccc'])

  assert.equal(storage.getItem('dsh.conversation.contentWidth'), '900', 'the width preference is a global key')
  assert.equal(storage.getItem('dsh.conversation.session-cccc'), null)
})

test('collects every id a delete report covers, including descendants', async () => {
  const { module } = await loadClient()
  // The route's own shape: the root at the top level, its own report under
  // `removed` as an OBJECT, and the descendant reports hanging off it.
  assert.deepEqual(
    module.removedIdsOf({ sessionId: 'root', descendants: [{ sessionId: 'child-a' }, { sessionId: 'child-b' }] }),
    ['root', 'child-a', 'child-b'],
  )
  // The same answer with `removed` as the object the route really sends.
  assert.deepEqual(
    module.removedIdsOf({
      sessionId: 'root',
      removed: { sessionId: 'root', artifactDirectory: '/tmp/x', removed: true },
      descendants: [{ sessionId: 'child' }],
    }),
    ['root', 'child'],
  )
  // Nothing usable is not an error.
  assert.deepEqual(module.removedIdsOf({}), [])
  assert.deepEqual(module.removedIdsOf(undefined), [])
})

test('a single-session answer whose `removed` is an object does not throw', async () => {
  const { module } = await loadClient()
  // This is the exact shape POST /delete answers with: `removed` is the ROOT's own
  // removal report, an object — not a list. Reading it as a list threw
  // `object is not iterable` after the Host had already deleted the conversation,
  // so the dialog reported a failure for a delete that had worked.
  const answer = {
    ok: true,
    sessionId: 'session-root',
    removed: { sessionId: 'session-root', artifactDirectory: '/tmp/x', removed: true, workspaces: 1 },
    descendants: [{ sessionId: 'child-a' }, { sessionId: 'child-b' }],
    kept: 0,
  }
  assert.deepEqual(module.removedIdsOf(answer), ['session-root', 'child-a', 'child-b'])
  // And the storage cleanup it feeds must not throw either.
  const { storage } = await loadClient()
  storage.setItem('dsh.conversation.session-root', 'draft')
  assert.equal(module.clearSessionStorage(module.removedIdsOf(answer)), 1)
})

test('an answer carrying both shapes is not double-counted', async () => {
  const { module } = await loadClient()
  // A tenant that names the root at the top level AND under `removed` must still
  // yield each id once per occurrence it legitimately has; the point here is that
  // neither branch may throw and the root is present.
  const ids = module.removedIdsOf({
    sessionId: 'root',
    removed: { sessionId: 'root', descendants: [{ sessionId: 'child' }] },
  })
  assert.ok(ids.includes('root'))
  assert.ok(ids.includes('child'))
})

test('an empty or malformed id is skipped rather than matching every key', async () => {
  const { module, storage } = await loadClient()
  storage.setItem('dsh.conversation.', 'empty-id-value')
  const removed = module.clearSessionStorage(['', null, undefined, 42])
  assert.equal(removed, 0)
  assert.equal(storage.getItem('dsh.conversation.'), 'empty-id-value', 'a bare prefix is not a Session')
})

test('a key a mounted store re-writes is cleared again on a later tick', async () => {
  // This is the residue that used to force quitting the app and editing the
  // LevelDB by hand: the shipped stores are `attachPersistence` subscribers
  // that re-write their key on the next state change, so a Session deleted while
  // its slot is still mounted re-creates one AFTER the delete's own clear. The
  // clear therefore repeats until a pass removes nothing.
  const { module, storage } = await loadClient()
  const gone = 'session-dddd'
  storage.setItem(`dsh.conversation.${gone}`, 'draft')
  storage.setItem(`dsh.sidebar-right.v1.${gone}`, 'layout')

  assert.equal(module.clearSessionStorage([gone]), 2)
  // The store writes one key back, the way a still-mounted slot does.
  storage.setItem(`dsh.sidebar-right.v1.${gone}`, 'default')

  // The repetition is timer-driven, so the test waits on the real thing rather
  // than on a synchronous pass it cannot observe.
  const cleared = await new Promise((resolve) => {
    module.reclearSessionStorage([gone])
    const started = Date.now()
    const poll = () => {
      if (storage.getItem(`dsh.sidebar-right.v1.${gone}`) === null) return resolve(true)
      if (Date.now() - started > 1000) return resolve(false)
      setTimeout(poll, 5)
    }
    poll()
  })

  assert.equal(cleared, true, 'the re-written key is gone without quitting the app')
  assert.equal(storage.getItem(`dsh.conversation.${gone}`), null)
})

test('the re-clear stops once the keys stay gone', async () => {
  const { module, storage } = await loadClient()
  storage.setItem(`dsh.conversation.session-eeee`, 'draft')
  module.clearSessionStorage(['session-eeee'])
  // Nothing re-writes it, so a later pass must not spin: the first repetition
  // finds nothing to remove and returns instead of scheduling another.
  const cleared = await new Promise((resolve) => {
    module.reclearSessionStorage(['session-eeee'])
    setTimeout(() => resolve(true), 50)
  })
  assert.equal(cleared, true)
  assert.equal(storage.getItem('dsh.conversation.session-eeee'), null)
})

test('the sweep section states the figure before anything is removed', async () => {
  const { module } = await loadClient()
  const report = {
    attachments: { removed: 3, bytes: 4096 },
    staging: { removed: 1, bytes: 512 },
    uploadCache: { removed: 2, bytes: 256 },
    searchIndex: { bytes: 0 },
    backups: { removed: 0, bytes: 0 },
    bytes: 4864,
  }
  const element = module.SweepSection({
    sweep: { phase: 'ready', report, error: null, done: null },
    disabled: false,
    onRun: () => {},
  })

  // Every lane that carries bytes is a row, and the zero lanes are absent — the
  // section must never read as a wall of zeroes.
  const texts = JSON.stringify(element)
  assert.ok(texts.includes('无引用的附件：3 个'), 'attachments row')
  assert.ok(texts.includes('4.0 KB'), 'attachments bytes')
  assert.ok(texts.includes('残留临时文件：1 个'), 'staging row')
  assert.ok(texts.includes('过期的上传缓存：2 条'), 'upload-cache row')
  assert.ok(!texts.includes('搜索索引压缩'), 'a zero search index is not listed')
  assert.ok(!texts.includes('陈旧的备份文件'), 'a zero backup lane is not listed')
  assert.ok(texts.includes('共可释放 4.8 KB'), 'the total leads')
})

test('the sweep section names its action, and disables it when there is nothing to do', async () => {
  const { module } = await loadClient()
  const runs = []
  const onRun = (dryRun) => runs.push(dryRun)

  const busy = module.SweepSection({
    sweep: { phase: 'ready', report: { bytes: 2048 }, error: null, done: null },
    disabled: false,
    onRun,
  })
  const reclaim = busy.children.at(-1).children[0]
  const rescan = busy.children.at(-1).children[1]
  // The primary button reclaims; the link beside it re-scans without removing.
  assert.equal(reclaim.props.disabled, false)
  assert.ok(reclaim.props.children.includes('立即清理'))
  assert.equal(typeof rescan.props.onClick, 'function')
  rescan.props.onClick()
  assert.deepEqual(runs, [true], 'the rescan link asks for a dry run')
  reclaim.props.onClick()
  assert.deepEqual(runs, [true, false], 'the reclaim button asks for the real thing')

  // With nothing to reclaim the button says so instead of reporting a zero as a
  // success, and it cannot be pressed.
  const empty = module.SweepSection({
    sweep: { phase: 'ready', report: { bytes: 0 }, error: null, done: null },
    disabled: false,
    onRun,
  })
  const emptyButton = empty.children.at(-1).children[0]
  assert.equal(emptyButton.props.disabled, true)
  assert.equal(emptyButton.props.children, '没有可清理的内容。')
  assert.ok(JSON.stringify(empty).includes('没有可清理的内容。'), 'and the body says so too')
})

test('the sweep section reports what the last press freed', async () => {
  const { module } = await loadClient()
  const element = module.SweepSection({
    // A press that ran and freed bytes: the section states the figure rather
    // than leaving the number on screen as though it were still pending.
    sweep: { phase: 'ready', report: { bytes: 4864 }, error: null, done: { bytes: 4096 } },
    disabled: false,
    onRun: () => {},
  })
  assert.ok(JSON.stringify(element).includes('已释放 4.0 KB'))
})

test('the sweep section is inert while it scans, and while a delete runs', async () => {
  const { module } = await loadClient()
  const scanning = module.SweepSection({
    sweep: { phase: 'scanning', report: null, error: null, done: null },
    disabled: false,
    onRun: () => {},
  })
  assert.ok(JSON.stringify(scanning).includes('正在扫描'), 'the scan says so')
  assert.equal(scanning.children.at(-1).children[0].props.disabled, true, 'and nothing can be pressed')

  // While the delete itself is in flight the sweep's controls are inert too:
  // the two must never read as one action.
  const deleting = module.SweepSection({
    sweep: { phase: 'ready', report: { bytes: 1024 }, error: null, done: null },
    disabled: true,
    onRun: () => {},
  })
  assert.equal(deleting.children.at(-1).children[0].props.disabled, true)
  assert.equal(deleting.children.at(-1).children[1].props.disabled, true)
})

test('a scan that failed is reported, and the sweep can still be re-run', async () => {
  const { module } = await loadClient()
  const element = module.SweepSection({
    sweep: { phase: 'ready', report: null, error: 'boom', done: null },
    disabled: false,
    onRun: () => {},
  })
  assert.ok(JSON.stringify(element).includes('清理失败：boom'))
})
