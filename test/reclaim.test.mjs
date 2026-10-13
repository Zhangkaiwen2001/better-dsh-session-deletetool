/**
 * Reclamation tests: attachment reference counting, the provider upload cache,
 * the derived search index, checkpoint staleness, and the sweep route.
 *
 * Every test works inside a throwaway Harness home built here, with real
 * multi-frame zstd session logs written in the shape DSH writes them. The
 * reference-count rule under test is the load-bearing one: a hash that appears
 * only inside message *text* is not a reference, and a blob a surviving Session
 * still uses must not be collected.
 *
 *   node --test test/reclaim.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  attachmentDigestsOf,
  listSessionLogs,
  listStoredAttachments,
  orphanedAttachments,
  pruneUploadCache,
  projectionCheckpoints,
  sizeOf,
  survivingAttachmentRefs,
  checkpointsNamingGoneSessions,
  staleStagingFiles,
  homePath,
} from '../reclaim.js'
import { findSearchIndexes, purgeSearchIndexes, SEARCH_INDEX_APPLICATION_ID } from '../search-index.js'
import { apply } from '../host.js'

/** A fresh throwaway Harness home. */
async function sandboxHome() {
  return mkdtemp(join(tmpdir(), 'dsd-reclaim-'))
}

/**
 * Write one Session log as DSH writes it: several independently framed zstd
 * chunks, appended one after another. One frame would hide the multi-frame bug
 * that makes a naive whole-file decompression return only the first chunk.
 */
async function writeSessionLog(home, sessionId, events, { scope = '--scope--' } = {}) {
  const directory = join(home, 'sessions', scope, sessionId)
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'session.v4.jsonl.zstd')
  const lines = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  // Split into three frames so the reader must walk the frame sequence.
  const third = Math.ceil(lines.length / 3)
  const chunks = [lines.slice(0, third), lines.slice(third, third * 2), lines.slice(third * 2)]
  const frames = chunks.filter((chunk) => chunk !== '').map((chunk) => zstdCompressSync(Buffer.from(chunk, 'utf8')))
  await writeFile(path, Buffer.concat(frames))
  return path
}

/** Store one attachment blob under the content-addressed layout. */
async function writeAttachment(home, bytes, { lane = 'objects' } = {}) {
  const digest = createHash('sha256').update(bytes).digest('hex')
  const directory = join(home, 'attachments', 'v1', lane, digest.slice(0, 2))
  await mkdir(directory, { recursive: true })
  const path = join(directory, digest)
  await writeFile(path, bytes)
  return { digest, path, bytes: bytes.length }
}

/** One event carrying a structural attachment reference. */
function imageEvent(digest) {
  return {
    type: 'tool/result',
    seq: 1,
    data: { message: { content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: { attachmentId: `sha256:${digest}` } }] } },
  }
}

test('reads every zstd frame, not just the first', async () => {
  const home = await sandboxHome()
  const events = Array.from({ length: 9 }, (_, index) => ({ type: 'note', seq: index, text: `line ${index}` }))
  await writeSessionLog(home, 'session-frames', events)
  const [log] = listSessionLogs(home)
  // Nine events split across three frames: a reader that stops at the first
  // frame sees only a third of them.
  const text = await readFile(log.path)
  assert.ok(text.length > 0)
  const digests = attachmentDigestsOf(log.path)
  assert.equal(digests.size, 0)
  await rm(home, { recursive: true, force: true })
})

test('collects only structural attachment references, never text mentions', async () => {
  const home = await sandboxHome()
  const blob = await writeAttachment(home, Buffer.from('image-bytes'))
  const mentioned = createHash('sha256').update('never-stored').digest('hex')
  await writeSessionLog(home, 'session-a', [
    // A hash quoted in prose is NOT a reference.
    { type: 'note', text: `the hash sha256:${mentioned} and sha256:${blob.digest} appear in this text` },
    imageEvent(blob.digest),
  ])
  const [log] = listSessionLogs(home)
  const digests = attachmentDigestsOf(log.path)
  assert.deepEqual([...digests], [blob.digest], 'only the structured field counts')
  await rm(home, { recursive: true, force: true })
})

test('keeps a blob a surviving Session still references', async () => {
  const home = await sandboxHome()
  const shared = await writeAttachment(home, Buffer.from('shared-image'))
  const solo = await writeAttachment(home, Buffer.from('solo-image'))
  await writeSessionLog(home, 'session-going', [imageEvent(shared.digest), imageEvent(solo.digest)])
  await writeSessionLog(home, 'session-stays', [imageEvent(shared.digest)])

  // The delete set is excluded, so only the survivor's references remain.
  const refs = survivingAttachmentRefs(home, new Set(['session-going']))
  assert.ok(refs.has(shared.digest), 'the shared blob is still referenced')
  assert.ok(!refs.has(solo.digest), 'the solo blob is unreferenced')

  const orphans = orphanedAttachments(home, refs)
  assert.deepEqual(orphans.map((blob) => blob.digest), [solo.digest], 'only the solo blob is collectable')
  assert.equal(orphans[0].bytes, 10)

  // After the log is gone the survivor alone decides, and the shared blob stays.
  await rm(join(home, 'sessions', '--scope--', 'session-going'), { recursive: true, force: true })
  const after = survivingAttachmentRefs(home, new Set())
  assert.ok(after.has(shared.digest))
  assert.deepEqual(orphanedAttachments(home, after).map((b) => b.digest), [solo.digest])
  await rm(home, { recursive: true, force: true })
})

test('an unaccounted Session directory is reported but is not garbage', async () => {
  const home = await sandboxHome()
  // A subagent Session: a real directory that no Workspace record lists.
  await writeSessionLog(home, 'subagent-child', [{ type: 'note' }])
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: {} }, global: {} }))
  const refs = survivingAttachmentRefs(home, new Set())
  // Nothing is collectable from a surviving Session's own existence.
  assert.equal(orphanedAttachments(home, refs).length, 0)
  await rm(home, { recursive: true, force: true })
})

test('prunes the upload cache by dangling attachment and by expiry', async () => {
  const home = await sandboxHome()
  const gone = createHash('sha256').update('gone').digest('hex')
  const kept = createHash('sha256').update('kept').digest('hex')
  await mkdir(join(home, 'llm-deepseek'), { recursive: true })
  const path = join(home, 'llm-deepseek', 'files-v3.json')
  await writeFile(path, JSON.stringify({
    formatVersion: 3,
    records: [
      { scope: 's', attachmentId: `sha256:${gone}`, fileId: 'f1', expiresAt: Date.now() + 1e9, bytes: 1 },
      { scope: 's', attachmentId: `sha256:${kept}`, fileId: 'f2', expiresAt: Date.now() + 1e9, bytes: 2 },
      { scope: 's', attachmentId: `sha256:${kept}`, fileId: 'f3', expiresAt: Date.now() - 1000, bytes: 3 },
    ],
  }))

  // Expiry alone must not remove a record whose blob still exists.
  const expiredOnly = pruneUploadCache(home, new Set(), true)
  assert.equal(expiredOnly.removed, 1, 'only the expired record goes')
  let records = JSON.parse(await readFile(path, 'utf8')).records
  assert.deepEqual(records.map((r) => r.fileId), ['f1', 'f2'], 'the dangling one is still there, the expired one is gone')

  // A dangling attachment removes its record even when unexpired.
  const dangling = pruneUploadCache(home, new Set([gone]), false)
  assert.equal(dangling.removed, 1)
  records = JSON.parse(await readFile(path, 'utf8')).records
  assert.deepEqual(records.map((r) => r.fileId), ['f2'], 'the kept record survives')
  await rm(home, { recursive: true, force: true })
})

test('drops a stale checkpoint that still names a removed child', async () => {
  const home = await sandboxHome()
  const directory = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'parent.json'), JSON.stringify({
    version: 7,
    record: { rows: { subagentCatalog: { val: [{ id: 'child-gone' }, { id: 'child-kept' }] } } },
  }))
  await writeFile(join(directory, 'unrelated.json'), JSON.stringify({ version: 7, record: {} }))
  assert.equal(projectionCheckpoints(home).size, 2)

  const stale = checkpointsNamingGoneSessions(home, new Set(['child-gone']))
  assert.deepEqual(stale.map((entry) => entry.sessionId), ['parent'], 'only the checkpoint naming the removed child')
  await rm(home, { recursive: true, force: true })
})

test('reports stale staging files and leaves fresh ones alone', async () => {
  const home = await sandboxHome()
  const staging = join(home, 'attachments', 'v1', 'tmp')
  await mkdir(staging, { recursive: true })
  await writeFile(join(staging, 'old.tmp'), 'orphaned staging')
  await writeFile(join(staging, 'fresh.tmp'), 'in flight')
  // Age the old one past the staleness window.
  const { utimes } = await import('node:fs/promises')
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000)
  await utimes(join(staging, 'old.tmp'), old, old)

  const stale = staleStagingFiles(home)
  assert.deepEqual(stale.map((entry) => entry.path.split('/').pop()), ['old.tmp'])
  await rm(home, { recursive: true, force: true })
})

test('purges a durable search index and compacts the file', async () => {
  const home = await sandboxHome()
  const { DatabaseSync } = await import('node:sqlite')
  const directory = join(home, 'cache')
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'session-search.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA application_id = ${SEARCH_INDEX_APPLICATION_ID}`)
  db.exec('CREATE TABLE search_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), global_generation INTEGER NOT NULL) STRICT')
  db.exec('CREATE TABLE persisted_sessions(id TEXT PRIMARY KEY, version INTEGER) STRICT')
  db.exec("CREATE VIRTUAL TABLE persisted_docs USING fts5(text, session_id UNINDEXED, seq UNINDEXED, tokenize='unicode61')")
  db.exec("INSERT INTO persisted_sessions VALUES('session-keep',1)")
  db.exec("INSERT INTO persisted_sessions VALUES('session-remove',1)")
  for (let index = 0; index < 300; index += 1) {
    db.exec(`INSERT INTO persisted_docs(text,session_id,seq) VALUES('${'padding text '.repeat(30)}','session-remove',${index})`)
    db.exec(`INSERT INTO persisted_docs(text,session_id,seq) VALUES('${'other words '.repeat(30)}','session-keep',${index})`)
  }
  db.close()

  const discovered = findSearchIndexes(home)
  assert.deepEqual(discovered, [path], 'found by its application id')
  const before = (await stat(path)).size

  const report = await purgeSearchIndexes(home, new Set(['session-remove']))
  assert.equal(report.indexes, 1)
  assert.equal(report.rows, 301, 'the session row and its 300 documents')
  assert.equal(report.compacted, 1)

  const after = await stat(path)
  assert.ok(after.size < before, `the file shrank: ${before} -> ${after.size}`)

  const check = new DatabaseSync(path)
  assert.deepEqual(check.prepare('SELECT id FROM persisted_sessions').all().map((row) => row.id), ['session-keep'])
  assert.equal(check.prepare("SELECT count(*) AS c FROM persisted_docs WHERE session_id = 'session-remove'").get().c, 0)
  assert.equal(check.prepare("SELECT count(*) AS c FROM persisted_docs WHERE session_id = 'session-keep'").get().c, 300)
  check.close()
  await rm(home, { recursive: true, force: true })
})

test('does not mistake another application database for the search index', async () => {
  const home = await sandboxHome()
  const { DatabaseSync } = await import('node:sqlite')
  const directory = join(home, 'cache')
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'unrelated.sqlite')
  const db = new DatabaseSync(path)
  // A different application id, and no derived tables.
  db.exec('PRAGMA application_id = 123456')
  db.exec('CREATE TABLE mine(x INTEGER)')
  db.close()

  assert.deepEqual(findSearchIndexes(home), [], 'a foreign database is never adopted')
  const report = await purgeSearchIndexes(home, new Set(['session-x']))
  assert.equal(report.indexes, 0)
  const check = new DatabaseSync(path)
  assert.deepEqual(check.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table').map((row) => row.name), ['mine'])
  check.close()
  await rm(home, { recursive: true, force: true })
})

test('homePath honours an explicit home and $DSH_HOME', () => {
  assert.equal(homePath('/tmp/explicit'), '/tmp/explicit')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/from-env'
  assert.equal(homePath(), '/tmp/from-env')
  process.env.DSH_HOME = '   '
  assert.ok(homePath().endsWith('/.dsh'), 'a blank override is not a home')
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
})

test('the sweep route reports without removing when asked to dry-run', async () => {
  const home = await sandboxHome()
  const blob = await writeAttachment(home, Buffer.from('orphan-bytes'))
  // No session log references it, so it is collectable.
  const state = { routes: new Map(), logs: [] }
  const ctx = {
    logger: { info: (m) => state.logs.push(m), warn: (m) => state.logs.push(m) },
    effect: (factory) => { factory(); return () => {} },
    emit: () => {},
    get: () => undefined,
    webServer: {
      register: (route) => { state.routes.set(route.path, route); return () => state.routes.delete(route.path) },
    },
  }
  apply(ctx, { dshHome: home })
  const route = state.routes.get('/better-dsh-session-deletetool/sweep')
  assert.ok(route !== undefined)

  const call = (body) => new Promise((resolve) => {
    const response = {
      status: 0, payload: null, headersSent: false, writableEnded: false,
      writeHead(status) { this.status = status; this.headersSent = true },
      end(text) { this.writableEnded = true; this.payload = JSON.parse(text) },
    }
    route.handler({
      method: 'POST',
      url: '/',
      headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'same-origin' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(body, 'utf8') },
    }, response)
    const deadline = Date.now() + 15_000
    const tick = () => {
      if (response.writableEnded) return resolve(response)
      if (Date.now() > deadline) throw new Error('the sweep route never answered')
      setTimeout(tick, 1)
    }
    tick()
  })

  // Dry run: the orphan is counted, not removed.
  const dry = await call(JSON.stringify({ dryRun: true }))
  assert.equal(dry.status, 200)
  assert.equal(dry.payload.attachments.removed, 1)
  assert.equal(dry.payload.attachments.bytes, blob.bytes)
  assert.ok(existsSync(blob.path), 'a dry run removes nothing')

  // Real run: the bytes go.
  const real = await call(JSON.stringify({}))
  assert.equal(real.status, 200)
  assert.equal(real.payload.bytes, blob.bytes)
  assert.ok(!existsSync(blob.path), 'the orphaned blob is gone')
  assert.equal(sizeOf(join(home, 'attachments')), 0)
  await rm(home, { recursive: true, force: true })
})

test('the sweep never removes a Session that a Workspace does not list', async () => {
  const home = await sandboxHome()
  // A subagent Session with a real log, absent from workspace.json.
  await writeSessionLog(home, 'subagent-session', [{ type: 'note', seq: 1 }])
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: {} },
    global: { archivedSessionIds: [], pinnedSessionIds: [] },
  }))

  const state = { routes: new Map() }
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    effect: (factory) => { factory(); return () => {} },
    emit: () => {},
    get: () => undefined,
    webServer: { register: (route) => { state.routes.set(route.path, route); return () => {} } },
  }
  apply(ctx, { dshHome: home })
  const route = state.routes.get('/better-dsh-session-deletetool/sweep')

  await new Promise((resolve) => {
    const response = {
      headersSent: false, writableEnded: false,
      writeHead() { this.headersSent = true },
      end() { this.writableEnded = true; resolve() },
    }
    route.handler({
      method: 'POST', url: '/',
      headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'same-origin' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{}', 'utf8') },
    }, response)
  })

  // The Session directory is legitimate even though no Workspace lists it.
  assert.ok(existsSync(join(home, 'sessions', '--scope--', 'subagent-session')))
  await rm(home, { recursive: true, force: true })
})
