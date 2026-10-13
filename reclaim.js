/**
 * Reclaim the disk a deleted Session leaves behind.
 *
 * Local fork of Lzcdebear/better-dsh-session-deletetool. The code through 0.5.2 is
 * his; the changes from 0.6.0 on are local, and this file carries no claim to his
 * authorship. It is installed as a `link:` local-path dependency, and DSH's plugin
 * manager has no update action, so a newer upstream release never lands here.
 *
 * The shipped delete removes three things: the artifact directory, the Workspace
 * account, and the projection checkpoint. What it does not touch is everything
 * that is *shared* or *derived*:
 *
 * - **Attachment objects** — `~/.dsh/attachments/v1/**` is content-addressed and
 *   deduplicated, with no index and no reference counting anywhere
 *   (`@deepseek-ai/dsh-attachment-local`: "nothing collects unreferenced
 *   objects"). A blob may only be unlinked when no *surviving* Session log
 *   references it, so this counts references first.
 * - **The provider upload cache** — `~/.dsh/llm-deepseek/files-v3.json` maps an
 *   attachment to a DeepSeek-side file id. It is not Session-keyed, so it is
 *   pruned by expiry and by now-unreferenced attachment id, never by Session.
 * - **Derived directories** — a deleted Session's parent keeps advertising it in
 *   its projection checkpoint, and its children are Session directories that no
 *   Workspace record lists, so nothing else would ever remove them.
 * - **The search index** — `dsh-session-query-sqlite` is a derived read model.
 *   This profile composes it `path: ':memory:'`, so there is usually no file;
 *   where a deployment configured a durable path, the rows are dropped and the
 *   file is compacted, because deleting a log does not shrink a SQLite file.
 *
 * Reference counting is structural. A blob hash also appears verbatim inside
 * message text and tool output (this very plugin's own investigation output is a
 * worked example), so a byte-grep for a hash reports references that do not
 * exist. Only parsed `attachmentId` fields count.
 *
 * Everything here is a *reclaim*: it is asked to clean up after removals that
 * already happened, and it reports bytes rather than throwing, because a Session
 * whose log is already gone must still be counted as deleted.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** The zstd frame magic; a DSH log is a sequence of independently framed chunks. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** `sha256:<64 lowercase hex>` — the store's own opaque reference format. */
const ATTACHMENT_REFERENCE = /^sha256:([a-f0-9]{64})$/

/**
 * The Harness home, resolved the way `@deepseek-ai/dsh-home-paths` does:
 * an explicit override, then `$DSH_HOME`, then `~/.dsh`.
 * @param {string} [configured] - an explicit home, highest precedence.
 * @returns {string} the absolute home path.
 */
export function homePath(configured) {
  const env = process.env.DSH_HOME
  const raw = configured ?? (env !== undefined && env.trim() !== '' ? env : join(homedir(), '.dsh'))
  return raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
}

/**
 * Every zstd frame in a DSH log, decompressed and concatenated.
 *
 * A DSH log is not one stream: it is a sequence of self-contained frames, one
 * per flush, so decompressing the whole file as a single stream yields only the
 * first frame. A truncated trailing frame is normal for a log being appended to
 * and is skipped.
 * @param {string} path - the log path.
 * @returns {string} the concatenated UTF-8 text, or '' when unreadable.
 */
export function readLogText(path) {
  let buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return ''
  }
  const offsets = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) offsets.push(i)
  }
  const parts = []
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      // A half-written tail frame: the bytes it would have carried are not yet durable.
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * The attachment digests one Session log structurally references.
 *
 * The walk collects only `attachmentId` fields whose value matches the store's
 * own pattern. A hash quoted inside message text is not a field and is never
 * collected — which is the whole point: grepping the same bytes reports
 * references that do not exist.
 * @param {string} logPath - the log path.
 * @returns {Set<string>} the bare sha256 digests.
 */
export function attachmentDigestsOf(logPath) {
  const digests = new Set()
  const text = readLogText(logPath)
  if (text === '') return digests
  for (const line of text.split('\n')) {
    if (line.indexOf('attachmentId') === -1) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const seen = new Set()
    const walk = (value) => {
      if (value === null || typeof value !== 'object' || seen.has(value)) return
      seen.add(value)
      if (Array.isArray(value)) {
        for (const item of value) walk(item)
        return
      }
      for (const [key, item] of Object.entries(value)) {
        if (key === 'attachmentId' && typeof item === 'string') {
          const match = ATTACHMENT_REFERENCE.exec(item)
          if (match) digests.add(match[1])
        }
        walk(item)
      }
    }
    walk(event)
  }
  return digests
}

/**
 * Every stored log under a Harness home's sessions root.
 * @param {string} home - the Harness home.
 * @returns {Array<{ sessionId: string, path: string }>} the logs found.
 */
export function listSessionLogs(home) {
  const root = join(home, 'sessions')
  const found = []
  if (!existsSync(root)) return found
  let scopes
  try {
    scopes = readdirSync(root)
  } catch {
    return found
  }
  for (const scope of scopes) {
    const scopeDir = join(root, scope)
    let entries
    try {
      if (!statSync(scopeDir).isDirectory()) continue
      entries = readdirSync(scopeDir)
    } catch {
      continue
    }
    for (const sessionId of entries) {
      const directory = join(scopeDir, sessionId)
      let names
      try {
        if (!statSync(directory).isDirectory()) continue
        names = readdirSync(directory)
      } catch {
        continue
      }
      for (const name of names) {
        if (name.endsWith('.jsonl.zstd')) found.push({ sessionId, path: join(directory, name) })
      }
    }
  }
  return found
}

/** Recursively total the bytes under a path; a missing path is 0 bytes. */
export function sizeOf(path) {
  let total = 0
  const walk = (target) => {
    let st
    try {
      st = statSync(target)
    } catch {
      return
    }
    if (st.isDirectory()) {
      let names
      try {
        names = readdirSync(target)
      } catch {
        return
      }
      for (const name of names) walk(join(target, name))
      return
    }
    total += st.size
  }
  walk(path)
  return total
}

/**
 * The attachment digests every *surviving* Session references.
 *
 * `removed` names the Session ids whose logs are being deleted (whether or not
 * their directory is gone yet): their own references must not count, or nothing
 * would ever become collectable.
 * @param {string} home - the Harness home.
 * @param {Set<string>} removed - Session ids being deleted.
 * @returns {Map<string, Set<string>>} digest → the surviving Session ids using it.
 */
export function survivingAttachmentRefs(home, removed) {
  const refs = new Map()
  for (const { sessionId, path } of listSessionLogs(home)) {
    if (removed.has(sessionId)) continue
    for (const digest of attachmentDigestsOf(path)) {
      if (!refs.has(digest)) refs.set(digest, new Set())
      refs.get(digest).add(sessionId)
    }
  }
  return refs
}

/**
 * One stored attachment object: its path, its digest, and its byte size.
 * @typedef {{ lane: string, path: string, digest: string, bytes: number }} StoredBlob
 */

/**
 * Every content-addressed object under the attachment root.
 *
 * Three reference-counted lanes, all `<lane>/<2-hex>/<sha256>`: `objects`
 * (normalized images), `file-objects` (a generic file's canonical bytes), and
 * `files` (a hard-link alias per display name, so one digest can own several
 * paths).
 *
 * The store's fourth lane, `request-images`, is deliberately NOT included: it is
 * keyed by a *request* hash rather than an attachment digest, so a session's log
 * cannot attribute an entry to itself. It is a regenerable cache and is handled
 * separately by {@link requestImageCache}.
 * @param {string} home - the Harness home.
 * @returns {StoredBlob[]} the objects found.
 */
export function listStoredAttachments(home) {
  const root = join(home, 'attachments', 'v1')
  const blobs = []
  const record = (lane, path, digest) => {
    let bytes = 0
    try {
      const st = statSync(path)
      if (!st.isFile()) return
      bytes = st.size
    } catch {
      return
    }
    blobs.push({ lane, path, digest, bytes })
  }
  for (const lane of ['objects', 'file-objects']) {
    const laneDir = join(root, lane)
    if (!existsSync(laneDir)) continue
    let prefixes
    try {
      prefixes = readdirSync(laneDir)
    } catch {
      continue
    }
    for (const prefix of prefixes) {
      const prefixDir = join(laneDir, prefix)
      let digests
      try {
        digests = readdirSync(prefixDir)
      } catch {
        continue
      }
      for (const digest of digests) record(lane, join(prefixDir, digest), digest)
    }
  }
  // `files/<2>/<sha256>/<name>`: the digest is a directory holding the aliases.
  const filesDir = join(root, 'files')
  if (existsSync(filesDir)) {
    let prefixes
    try {
      prefixes = readdirSync(filesDir)
    } catch {
      prefixes = []
    }
    for (const prefix of prefixes) {
      const prefixDir = join(filesDir, prefix)
      let digests
      try {
        digests = readdirSync(prefixDir)
      } catch {
        continue
      }
      for (const digest of digests) {
        const digestDir = join(prefixDir, digest)
        let names
        try {
          names = readdirSync(digestDir)
        } catch {
          continue
        }
        for (const name of names) record('files', join(digestDir, name), digest)
      }
    }
  }
  return blobs
}

/**
 * The `request-images` lane: a regenerable cache of per-request normalized
 * variants, keyed by request hash rather than by attachment digest.
 *
 * Because the key is not a digest, no session log can claim an entry, and because
 * the bytes are derived on demand, an entry is safe to drop whenever it is stale:
 * the next request that needs it regenerates it. Only entries older than
 * `olderThanMs` are reported, so an in-flight request is never disturbed.
 * @param {string} home - the Harness home.
 * @param {number} olderThanMs - only report entries at least this old.
 * @returns {StoredBlob[]} the stale cache entries.
 */
export function requestImageCache(home, olderThanMs = 7 * 24 * 60 * 60 * 1000) {
  const root = join(home, 'attachments', 'v1', 'request-images')
  const stale = []
  if (!existsSync(root)) return stale
  let prefixes
  try {
    prefixes = readdirSync(root)
  } catch {
    return stale
  }
  const cutoff = Date.now() - olderThanMs
  for (const prefix of prefixes) {
    const prefixDir = join(root, prefix)
    let names
    try {
      names = readdirSync(prefixDir)
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(prefixDir, name)
      try {
        const st = statSync(path)
        if (!st.isFile() || st.mtimeMs > cutoff) continue
        stale.push({ lane: 'request-images', path, digest: name, bytes: st.size })
      } catch {
        // Vanished underneath us: already gone.
      }
    }
  }
  return stale
}

/**
 * The attachment objects no surviving Session references.
 * @param {string} home - the Harness home.
 * @param {Map<string, Set<string>>} refs - surviving references by digest.
 * @returns {StoredBlob[]} the collectable objects.
 */
export function orphanedAttachments(home, refs) {
  return listStoredAttachments(home).filter((blob) => !refs.has(blob.digest))
}

/**
 * Crash-orphaned staging files under `attachments/v1/tmp`.
 *
 * Publication stages bytes in `tmp` and renames them into place, so a file still
 * sitting there belongs to no object. Only stale entries are reported: a
 * publication in flight is not garbage.
 * @param {string} home - the Harness home.
 * @param {number} olderThanMs - only report entries at least this old.
 * @returns {StoredBlob[]} the staged files.
 */
export function staleStagingFiles(home, olderThanMs = 60 * 60 * 1000) {
  const staging = join(home, 'attachments', 'v1', 'tmp')
  const stale = []
  if (!existsSync(staging)) return stale
  let names
  try {
    names = readdirSync(staging)
  } catch {
    return stale
  }
  const cutoff = Date.now() - olderThanMs
  for (const name of names) {
    const path = join(staging, name)
    try {
      const st = statSync(path)
      if (!st.isFile() || st.mtimeMs > cutoff) continue
      stale.push({ lane: 'tmp', path, digest: '', bytes: st.size })
    } catch {
      // A file that vanished underneath us is already gone.
    }
  }
  return stale
}

/**
 * Prune the DeepSeek provider upload cache.
 *
 * `files-v3.json` is a per-attachment cache of uploads to the provider's file
 * API, keyed by account scope. Its real shape is
 * `{ formatVersion: 3, records: [ { scope, attachmentId, variantId, fileId, bytes,
 * createdAt, expiresAt }, … ] }` — a flat array, so the array itself is filtered
 * rather than indexed into. It is NOT keyed by Session, so a Session delete may
 * never drop the whole file: a record goes only when its attachment is gone from
 * the local store, or (when allowed) when the provider has expired it anyway.
 * @param {string} home - the Harness home.
 * @param {Set<string>} goneDigests - digests no longer present on disk.
 * @param {boolean} pruneExpired - whether expired records may go too.
 * @returns {{ removed: number, bytes: number, kept: number }} the removal count.
 */
export function pruneUploadCache(home, goneDigests, pruneExpired) {
  const path = join(home, 'llm-deepseek', 'files-v3.json')
  if (!existsSync(path)) return { removed: 0, bytes: 0, kept: 0 }
  const before = sizeOf(path)
  let cache
  try {
    cache = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { removed: 0, bytes: 0, kept: 0 }
  }
  if (cache === null || typeof cache !== 'object') return { removed: 0, bytes: 0, kept: 0 }

  const now = Date.now()
  let removed = 0
  let kept = 0

  /**
   * Whether one cache record is collectable. A record with no readable
   * attachment reference is never collectable by digest; only expiry can take it.
   */
  const collectable = (record) => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return false
    const reference = typeof record.attachmentId === 'string' ? record.attachmentId : ''
    const match = ATTACHMENT_REFERENCE.exec(reference)
    const digest = match === null ? undefined : match[1]
    const dangling = digest !== undefined && goneDigests.has(digest)
    const expired = typeof record.expiresAt === 'number' && record.expiresAt <= now
    return dangling || (pruneExpired && expired)
  }

  const tally = (record) => {
    if (collectable(record)) {
      removed += 1
      return false
    }
    kept += 1
    return true
  }

  // The shipped shape: a flat `records` array.
  if (Array.isArray(cache.records)) {
    cache.records = cache.records.filter(tally)
  } else if (Array.isArray(cache)) {
    cache = cache.filter(tally)
  } else {
    // A durable map keyed by attachment id: drop the collectable keys in place.
    for (const [key, record] of Object.entries(cache)) {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
      if (collectable(record)) {
        delete cache[key]
        removed += 1
      } else {
        kept += 1
      }
    }
  }

  if (removed > 0) {
    writeFileSync(path, JSON.stringify(cache))
    return { removed, bytes: Math.max(0, before - sizeOf(path)), kept }
  }
  return { removed, bytes: 0, kept }
}

/**
 * Read a JSON file, returning undefined when it is missing or malformed.
 * @param {string} path - the file path.
 * @returns {any} the parsed value, or undefined.
 */
export function readJson(path) {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * The Session ids a Workspace record still accounts for.
 * @param {string} home - the Harness home.
 * @returns {Set<string>} every id named by `workspace.json`.
 */
export function workspaceAccountedIds(home) {
  const ids = new Set()
  const document = readJson(join(home, 'storages', 'workspace.json'))
  if (document === undefined) return ids
  for (const workspace of Object.values(document?.tables?.workspaces ?? {})) {
    for (const id of workspace?.sessionIds ?? []) ids.add(String(id))
  }
  for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
    for (const id of document?.global?.[key] ?? []) ids.add(String(id))
  }
  return ids
}

/**
 * Session directories that no Workspace accounts for and whose logs are gone,
 * plus directories of Sessions that no longer exist at all.
 *
 * This is how a deleted *parent* leaves its children behind: a subagent Session
 * is a real directory of its own but is not listed in any Workspace record, so
 * removing the parent's row removes the only thing that named them.
 * @param {string} home - the Harness home.
 * @returns {Array<{ sessionId: string, path: string, bytes: number }>} the orphans.
 */
export function orphanedSessionDirectories(home) {
  const accounted = workspaceAccountedIds(home)
  const root = join(home, 'sessions')
  const orphans = []
  if (!existsSync(root)) return orphans
  let scopes
  try {
    scopes = readdirSync(root)
  } catch {
    return orphans
  }
  for (const scope of scopes) {
    const scopeDir = join(root, scope)
    let entries
    try {
      if (!statSync(scopeDir).isDirectory()) continue
      entries = readdirSync(scopeDir)
    } catch {
      continue
    }
    for (const sessionId of entries) {
      const directory = join(scopeDir, sessionId)
      try {
        if (!statSync(directory).isDirectory()) continue
      } catch {
        continue
      }
      if (accounted.has(sessionId)) continue
      // A Session whose Workspace row is gone is normally a subagent or a fork:
      // they are legitimate, so they are only reported, never removed here. What
      // makes one collectable is that its own *parent* is being deleted, which
      // the caller knows and this function does not.
      orphans.push({ sessionId, path: directory, bytes: sizeOf(directory) })
    }
  }
  return orphans
}

/**
 * The projection checkpoints under the `session_projcache` domain.
 * @param {string} home - the Harness home.
 * @returns {Map<string, { path: string, bytes: number }>} session id → checkpoint.
 */
export function projectionCheckpoints(home) {
  const directory = join(home, 'storages', 'session_projcache', 'sessions')
  const found = new Map()
  if (!existsSync(directory)) return found
  let names
  try {
    names = readdirSync(directory)
  } catch {
    return found
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(directory, name)
    found.set(name.slice(0, -'.json'.length), { path, bytes: sizeOf(path) })
  }
  return found
}

/**
 * Checkpoints that still name a Session that no longer has a log.
 *
 * A parent's checkpoint embeds its children's ids, so deleting a child leaves
 * the parent advertising a Session that cannot be opened.
 * @param {string} home - the Harness home.
 * @param {Set<string>} gone - Session ids with no log left.
 * @returns {Array<{ sessionId: string, path: string, references: number }>} the stale ones.
 */
export function checkpointsNamingGoneSessions(home, gone) {
  const stale = []
  if (gone.size === 0) return stale
  for (const [sessionId, entry] of projectionCheckpoints(home)) {
    let text
    try {
      text = readFileSync(entry.path, 'utf8')
    } catch {
      continue
    }
    let references = 0
    for (const id of gone) {
      if (id === sessionId) continue
      let at = text.indexOf(id)
      while (at !== -1) {
        references += 1
        at = text.indexOf(id, at + id.length)
      }
    }
    if (references > 0) stale.push({ sessionId, path: entry.path, references })
  }
  return stale
}

/**
 * The bytes a set of paths occupies, summed.
 * @param {string[]} paths - the paths.
 * @returns {number} the byte total.
 */
export function bytesOf(paths) {
  let total = 0
  for (const path of paths) total += sizeOf(path)
  return total
}

/**
 * The basename of a Session's artifact directory, for reporting.
 * @param {string} directory - the artifact directory.
 * @returns {string} its final segment.
 */
export function directoryName(directory) {
  return basename(directory)
}

/**
 * The parent directory of a Session's artifact directory.
 * @param {string} directory - the artifact directory.
 * @returns {string} its parent.
 */
export function parentOf(directory) {
  return dirname(directory)
}
