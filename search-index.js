/**
 * Purge a deleted Session from the derived full-text search index.
 *
 * `@deepseek-ai/dsh-session-query-sqlite` is a *derived* read model: it
 * reconciles against session persistence, so a deleted source normally stops
 * being returned on the next search. Two things still justify this module:
 *
 * 1. **Deleting a log does not shrink a SQLite file.** Even after the rows are
 *    gone, the bytes stay in the freelist, so "delete the conversation and get
 *    the disk back" is not true until the file is compacted (`VACUUM`).
 * 2. **A stale row can outlive its log** until the next reconciliation pass, and
 *    a search that runs before then would still surface it.
 *
 * This profile composes the engine `path: ':memory:'`, so there is usually no
 * file at all and this is a no-op. The module therefore *discovers* the index
 * rather than assuming a path: it looks for a SQLite file carrying the engine's
 * own `application_id`, which is exactly the guard the engine uses to refuse a
 * database that belongs to something else.
 *
 * Only databases with that application id are ever opened, and only the engine's
 * own derived tables are touched.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { sizeOf } from './reclaim.js'

/** `SESSION_QUERY_SQLITE_APPLICATION_ID` from the engine's schema module. */
export const SEARCH_INDEX_APPLICATION_ID = 1146308689

/** The derived tables the engine owns; anything else means "not our file". */
const DERIVED_TABLES = new Set([
  'search_state',
  'persisted_sessions',
  'persisted_docs',
  'persisted_docs_data',
  'persisted_docs_idx',
  'persisted_docs_content',
  'persisted_docs_docsize',
  'persisted_docs_config',
  'live_sessions',
  'live_docs',
  'live_docs_data',
  'live_docs_idx',
  'live_docs_content',
  'live_docs_docsize',
  'live_docs_config',
])

/**
 * Directories worth searching for the index, most specific first.
 * The engine's default is a launcher-owned path, so it can be anywhere under the
 * Harness home; `cache/` is its documented home and the others cover overrides.
 * @param {string} home - the Harness home.
 * @returns {string[]} the directories.
 */
function searchRoots(home) {
  return [join(home, 'cache'), join(home, 'storages'), home]
}

/**
 * Find SQLite databases that carry the search engine's application id.
 *
 * The application id is written into the file header, so this needs no SQL: the
 * 4 bytes at offset 68 are the big-endian application id, which makes discovery
 * a cheap header read rather than opening every stray database.
 * @param {string} home - the Harness home.
 * @param {number} maxDepth - how deep to walk below each root.
 * @returns {string[]} absolute paths of matching databases.
 */
export function findSearchIndexes(home, maxDepth = 4) {
  const found = []
  const seen = new Set()
  const visit = (directory, depth) => {
    if (depth > maxDepth || seen.has(directory)) return
    seen.add(directory)
    let names
    try {
      names = readdirSync(directory)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(directory, name)
      let st
      try {
        st = statSync(path)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (name === 'node_modules' || name.startsWith('.')) continue
        visit(path, depth + 1)
        continue
      }
      if (!st.isFile() || st.size < 100) continue
      if (applicationIdOf(path) === SEARCH_INDEX_APPLICATION_ID) found.push(path)
    }
  }
  for (const root of searchRoots(home)) {
    if (existsSync(root)) visit(root, 0)
  }
  return found
}

/**
 * The SQLite `application_id` from a file's header, without opening a database.
 * @param {string} path - the candidate file.
 * @returns {number|undefined} the application id, or undefined when not SQLite.
 */
function applicationIdOf(path) {
  let header
  let fd
  try {
    fd = openSync(path, 'r')
    header = Buffer.alloc(72)
    const read = readSync(fd, header, 0, 72, 0)
    if (read < 72) return undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
  if (header.subarray(0, 15).toString('latin1') !== 'SQLite format 3') return undefined
  // Offset 68: 4-byte big-endian application id.
  return header.readUInt32BE(68)
}

/**
 * The engine's derived tables that actually exist in a database.
 * @param {import('node:sqlite').DatabaseSync} db - an open database.
 * @returns {string[]} the table names.
 */
function derivedTables(db) {
  const names = []
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    for (const row of rows) {
      const name = String(row.name ?? '')
      if (name === 'sqlite_sequence') continue
      if (DERIVED_TABLES.has(name)) names.push(name)
    }
  } catch {
    return []
  }
  return names
}

/**
 * Drop the removed Sessions from every discovered search index and compact it.
 *
 * A database that cannot be identified as the engine's own is left alone, and a
 * locked or unreadable one is reported rather than thrown: the index is derived
 * and will reconcile on its own, so failing to purge it must never fail a delete.
 * @param {string} home - the Harness home.
 * @param {Set<string>} removed - the Session ids to purge.
 * @returns {Promise<{ indexes: number, rows: number, compacted: number, bytes: number, warnings: string[] }>}
 */
export async function purgeSearchIndexes(home, removed) {
  const report = { indexes: 0, rows: 0, compacted: 0, bytes: 0, warnings: [] }
  if (removed.size === 0) return report
  const paths = findSearchIndexes(home)
  if (paths.length === 0) return report

  let DatabaseSync
  try {
    // `node:sqlite` is present on the Node the Harness ships; a build without it
    // simply has no index to purge.
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch (error) {
    report.warnings.push(`node:sqlite unavailable, the search index was not purged: ${message(error)}`)
    return report
  }

  for (const path of paths) {
    const before = sizeOf(path)
    let db
    try {
      db = new DatabaseSync(path)
    } catch (error) {
      report.warnings.push(`could not open the search index at ${relative(home, path)}: ${message(error)}`)
      continue
    }
    try {
      const tables = derivedTables(db)
      if (tables.length === 0) continue
      report.indexes += 1
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const id of removed) {
          // `persisted_docs` is an FTS5 table whose `session_id` column is
          // UNINDEXED, so it is matched by a plain scan; `persisted_sessions`
          // and any live mirror are ordinary tables keyed by id.
          for (const [table, column] of [
            ['persisted_docs', 'session_id'],
            ['live_docs', 'session_id'],
            ['persisted_sessions', 'id'],
            ['live_sessions', 'id'],
          ]) {
            if (!tables.includes(table)) continue
            try {
              const result = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(id)
              report.rows += Number(result.changes ?? 0)
            } catch {
              // A table without that column is simply not this relation.
            }
          }
        }
        db.exec('COMMIT')
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {}
        report.warnings.push(`purging the search index failed: ${message(error)}`)
      }
      // Compaction is what actually returns the bytes: without it the freed
      // pages stay in the file's freelist.
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {}
      try {
        db.exec('VACUUM')
        report.compacted += 1
      } catch (error) {
        report.warnings.push(`compacting the search index failed: ${message(error)}`)
      }
    } finally {
      try {
        db.close()
      } catch {}
    }
    const after = sizeOf(path)
    report.bytes += Math.max(0, before - after)
  }
  return report
}

/** One error's text. */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}
