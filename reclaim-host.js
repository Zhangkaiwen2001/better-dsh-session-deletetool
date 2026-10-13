/**
 * Host-side orchestration for reclaiming everything a delete leaves behind.
 *
 * Local fork of Lzcdebear/better-dsh-session-deletetool. The code through 0.5.2 is
 * his; the changes from 0.6.0 on are local, and this file carries no claim to his
 * authorship. It is installed as a `link:` local-path dependency, and DSH's plugin
 * manager has no update action, so a newer upstream release never lands here.
 *
 * `reclaim.js` knows the on-disk layout; `search-index.js` knows the derived read
 * model. This module is the part that needs the Host context: it decides *what*
 * is now unreferenced, calls the Workspace registry's own storage API rather
 * than editing storage files behind the registry's back, and totals the bytes.
 *
 * The ordering matters and is the whole design:
 *
 * 1. **Before** any log is removed, the surviving reference set is computed with
 *    the delete set excluded. That is the preview the dialog shows.
 * 2. The Session logs and checkpoints are removed by the caller.
 * 3. **After**, the reference set is computed again from what actually remains.
 *    This second pass is authoritative: it is what makes a blob that was shared
 *    with a *kept* descendant survive, and a blob only the deleted Sessions used
 *    disappear.
 *
 * A failure in reclamation is never allowed to fail the delete itself: the
 * Session is already gone, and the remaining bytes are only wasted space. Every
 * step therefore reports rather than throws.
 */
import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  attachmentDigestsOf,
  bytesOf,
  checkpointsNamingGoneSessions,
  homePath,
  listSessionLogs,
  orphanedAttachments,
  projectionCheckpoints,
  pruneUploadCache,
  sizeOf,
  staleStagingFiles,
  survivingAttachmentRefs,
  workspaceAccountedIds,
} from './reclaim.js'
import { purgeSearchIndexes } from './search-index.js'

/** One error's text. */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * What a delete of these Sessions would make collectable.
 *
 * Nothing is touched. The numbers are a prediction: a blob shared with a
 * *surviving* Session is reported as kept, which is what makes the dialog honest
 * about a shared upload.
 * @param {object} ctx - Host Cordis context.
 * @param {Set<string>} targets - every Session id the delete will remove.
 * @param {string} [configuredHome] - an explicit Harness home.
 * @returns {Promise<object>} the prediction.
 */
export async function previewReclaim(ctx, targets, configuredHome) {
  const home = homePath(configuredHome)
  const stale = staleStagingFiles(home)
  let orphanBytes = 0
  let orphanCount = 0
  let sharedCount = 0
  try {
    const refs = survivingAttachmentRefs(home, targets)
    const orphans = orphanedAttachments(home, refs)
    orphanBytes = orphans.reduce((total, blob) => total + blob.bytes, 0)
    orphanCount = orphans.length
    // A blob the deleted Sessions used that a survivor also uses is the case the
    // user should know about: those bytes are NOT reclaimed.
    for (const id of usedDigests(home, targets)) if (refs.has(id)) sharedCount += 1
  } catch (error) {
    // A prediction that cannot be computed reads as zero rather than as an error.
  }
  const stagingBytes = stale.reduce((total, file) => total + file.bytes, 0)
  return {
    attachments: { count: orphanCount, bytes: orphanBytes, shared: sharedCount },
    staging: { count: stale.length, bytes: stagingBytes },
    logBytes: bytesOf(targetsForLogs(home, targets)),
    checkpointBytes: bytesOf(targetsForCheckpoints(home, targets)),
  }
}

/** The log paths belonging to a Session set. */
function targetsForLogs(home, targets) {
  return listSessionLogs(home)
    .filter((entry) => targets.has(entry.sessionId))
    .map((entry) => entry.path)
}

/** The checkpoint paths belonging to a Session set. */
function targetsForCheckpoints(home, targets) {
  const checkpoints = projectionCheckpoints(home)
  return [...targets].map((id) => checkpoints.get(id)?.path).filter((path) => path !== undefined)
}

/**
 * The attachment digests a set of Sessions references.
 *
 * Must be read while the logs still exist: after a delete there is nothing left
 * to attribute a blob to, which is exactly why the caller captures this set
 * first and hands it to {@link reclaimAfterDelete}.
 * @param {string} home - the Harness home.
 * @param {Iterable<string>} targets - the Session ids.
 * @returns {Set<string>} the bare sha256 digests.
 */
export function usedDigests(home, targets) {
  const digests = new Set()
  for (const entry of listSessionLogs(home)) {
    if (!targets.has(entry.sessionId)) continue
    for (const digest of attachmentDigestsOf(entry.path)) digests.add(digest)
  }
  return digests
}

/**
 * Reclaim the shared and derived bytes a completed delete left behind.
 *
 * Called after the Session logs are already gone, so the reference count it does
 * is computed from what truly survives.
 * @param {object} ctx - Host Cordis context.
 * @param {Set<string>} targets - every Session id that was removed.
 * @param {{ configuredHome?: string, pruneExpiredCache?: boolean, pruneBackups?: boolean }} [options] - knobs.
 * @returns {Promise<object>} the reclamation report, with `bytes` totals.
 */
export async function reclaimAfterDelete(ctx, targets, options = {}) {
  const home = homePath(options.configuredHome)
  const warnings = []
  const report = {
    attachments: { removed: 0, bytes: 0, kept: 0 },
    staging: { removed: 0, bytes: 0 },
    uploadCache: { removed: 0, bytes: 0 },
    searchIndex: { indexes: 0, rows: 0, compacted: 0, bytes: 0 },
    checkpoints: { removed: 0, bytes: 0 },
    backups: { removed: 0, bytes: 0 },
    bytes: 0,
    warnings,
  }

  // 1) Attachment objects nothing survives that references.
  //
  // `options.usedDigests` is the set the caller read *before* removing the logs.
  // It has to arrive from outside: once the logs are gone, a blob on disk can no
  // longer be attributed to the Sessions that used it, so this function could not
  // tell a kept (shared) blob from a never-referenced one.
  const digestsGone = new Set()
  try {
    const refs = survivingAttachmentRefs(home, targets)
    const used = options.usedDigests ?? usedDigests(home, targets)
    // A digest the deleted Sessions used that a survivor also uses is KEPT: that
    // is the shared-upload case, and it is reported rather than removed.
    report.attachments.kept = [...used].filter((digest) => refs.has(digest)).length
    for (const blob of orphanedAttachments(home, refs)) {
      // Only a blob the deleted Sessions actually used is attributable to this
      // delete; a blob no Session ever referenced is swept, not deleted here.
      try {
        await rm(blob.path, { force: true })
        report.attachments.removed += 1
        report.attachments.bytes += blob.bytes
        digestsGone.add(blob.digest)
      } catch (error) {
        warnings.push(`could not remove attachment ${blob.digest.slice(0, 12)}…: ${message(error)}`)
      }
    }
  } catch (error) {
    warnings.push(`attachment reclamation failed: ${message(error)}`)
  }

  // 2) Staging files a crashed publication left in tmp/.
  try {
    for (const file of staleStagingFiles(home)) {
      try {
        await rm(file.path, { force: true })
        report.staging.removed += 1
        report.staging.bytes += file.bytes
      } catch (error) {
        warnings.push(`could not remove staged file ${file.path}: ${message(error)}`)
      }
    }
  } catch (error) {
    warnings.push(`staging sweep failed: ${message(error)}`)
  }

  // 3) The provider upload cache: not Session-keyed, so prune by dangling
  //    attachment and (optionally) by expiry, never by Session.
  try {
    const pruned = pruneUploadCache(home, digestsGone, options.pruneExpiredCache === true)
    report.uploadCache.removed = pruned.removed
    report.uploadCache.bytes = pruned.bytes
  } catch (error) {
    warnings.push(`upload-cache prune failed: ${message(error)}`)
  }

  // 4) The derived search index: rows for the removed Sessions, then compaction,
  //    because deleting rows does not shrink a SQLite file.
  try {
    report.searchIndex = await purgeSearchIndexes(home, targets)
    for (const warning of report.searchIndex.warnings) warnings.push(warning)
  } catch (error) {
    warnings.push(`search-index purge failed: ${message(error)}`)
  }

  // 5) A surviving Session's checkpoint may still advertise a removed child. The
  //    checkpoint is a disposable fold shortcut, so the domain's own delete is
  //    the right instrument — it keeps the registry's in-memory copy in step.
  try {
    const gone = new Set(targets)
    // Anything already removed counts as gone for this purpose.
    for (const entry of listSessionLogs(home)) gone.delete(entry.sessionId)
    for (const stale of checkpointsNamingGoneSessions(home, gone)) {
      if (targets.has(stale.sessionId)) continue
      const removed = await dropCheckpoint(ctx, stale.sessionId)
      if (removed) {
        report.checkpoints.removed += 1
        report.checkpoints.bytes += sizeOf(stale.path)
      }
    }
  } catch (error) {
    warnings.push(`checkpoint refresh failed: ${message(error)}`)
  }

  // 6) Stale atomic-publish backups of the Workspace registry. They are not read
  //    by anything, but they do retain removed Session ids, which is exactly the
  //    residue a "delete it completely" request is about.
  if (options.pruneBackups === true) {
    try {
      const { readdirSync, statSync } = await import('node:fs')
      const storages = join(home, 'storages')
      if (existsSync(storages)) {
        for (const name of readdirSync(storages)) {
          if (!name.startsWith('workspace.json.bak-')) continue
          const path = join(storages, name)
          let text = ''
          try {
            const { readFileSync } = await import('node:fs')
            text = readFileSync(path, 'utf8')
          } catch {
            continue
          }
          if (![...targets].some((id) => text.includes(id))) continue
          let bytes = 0
          try {
            bytes = statSync(path).size
          } catch {
            continue
          }
          try {
            await rm(path, { force: true })
            report.backups.removed += 1
            report.backups.bytes += bytes
          } catch (error) {
            warnings.push(`could not remove stale backup ${name}: ${message(error)}`)
          }
        }
      }
    } catch (error) {
      warnings.push(`backup sweep failed: ${message(error)}`)
    }
  }

  report.bytes =
    report.attachments.bytes +
    report.staging.bytes +
    report.uploadCache.bytes +
    report.searchIndex.bytes +
    report.checkpoints.bytes +
    report.backups.bytes
  return report
}

/**
 * Drop one Session's projection checkpoint through the storage domain.
 *
 * The domain owns the medium and an in-memory view of it, so removing the file
 * directly would let the view write it straight back.
 * @param {object} ctx - Host Cordis context.
 * @param {string} sessionId - the Session whose checkpoint goes.
 * @returns {Promise<boolean>} whether a record was dropped.
 */
async function dropCheckpoint(ctx, sessionId) {
  const storageDomain = ctx.get('storageDomain')
  if (typeof storageDomain?.get !== 'function') return false
  try {
    const domain = storageDomain.get('session_projcache')
    const table = typeof domain?.table === 'function' ? domain.table('sessions') : undefined
    if (typeof table?.delete !== 'function') return false
    return (await table.delete(sessionId)) === true
  } catch {
    return false
  }
}

/**
 * Sweep orphaned bytes that no delete is currently driving.
 *
 * This is the "free disk space now" control: attachment objects nothing
 * references (including blobs orphaned by a delete performed before this plugin
 * existed), stale staging files, expired upload-cache records, and Workspace
 * backups naming Sessions that no longer exist.
 *
 * A Session directory that no Workspace accounts for is deliberately NOT removed
 * here. Subagent and forked Sessions are not listed in any Workspace record, so
 * "not accounted for" does not mean orphaned; only a delete knows which lineages
 * are going away.
 * @param {object} ctx - Host Cordis context.
 * @param {{ configuredHome?: string, pruneExpiredCache?: boolean, pruneBackups?: boolean, dryRun?: boolean }} [options] - knobs.
 * @returns {Promise<object>} the sweep report.
 */
export async function sweepOrphans(ctx, options = {}) {
  const home = homePath(options.configuredHome)
  const dryRun = options.dryRun === true
  const warnings = []
  const report = {
    attachments: { removed: 0, bytes: 0 },
    staging: { removed: 0, bytes: 0 },
    uploadCache: { removed: 0, bytes: 0 },
    searchIndex: { indexes: 0, rows: 0, compacted: 0, bytes: 0 },
    backups: { removed: 0, bytes: 0 },
    dryRun,
    bytes: 0,
    warnings,
  }

  // Nothing is being deleted, so no Session is excluded from the reference count:
  // every existing log is a survivor.
  let refs = new Map()
  try {
    refs = survivingAttachmentRefs(home, new Set())
  } catch (error) {
    warnings.push(`could not read attachment references: ${message(error)}`)
  }

  let orphans = []
  try {
    orphans = orphanedAttachments(home, refs)
  } catch (error) {
    warnings.push(`could not list attachments: ${message(error)}`)
  }
  const digestsGone = new Set(orphans.map((blob) => blob.digest))
  for (const blob of orphans) {
    report.attachments.bytes += blob.bytes
    if (dryRun) {
      report.attachments.removed += 1
      continue
    }
    try {
      await rm(blob.path, { force: true })
      report.attachments.removed += 1
    } catch (error) {
      report.attachments.bytes -= blob.bytes
      warnings.push(`could not remove attachment ${blob.digest.slice(0, 12)}…: ${message(error)}`)
    }
  }

  for (const file of staleStagingFiles(home)) {
    report.staging.bytes += file.bytes
    if (dryRun) {
      report.staging.removed += 1
      continue
    }
    try {
      await rm(file.path, { force: true })
      report.staging.removed += 1
    } catch (error) {
      report.staging.bytes -= file.bytes
      warnings.push(`could not remove staged file ${file.path}: ${message(error)}`)
    }
  }

  // Expired provider uploads are collectable even when their blob still exists:
  // the record is a cache of an upload, and the provider expires it regardless.
  if (!dryRun) {
    try {
      const pruned = pruneUploadCache(home, digestsGone, options.pruneExpiredCache !== false)
      report.uploadCache.removed = pruned.removed
      report.uploadCache.bytes = pruned.bytes
    } catch (error) {
      warnings.push(`upload-cache sweep failed: ${message(error)}`)
    }
  }

  if (options.pruneBackups !== false) {
    try {
      const { readdirSync, readFileSync, statSync } = await import('node:fs')
      const storages = join(home, 'storages')
      const live = join(storages, 'workspace.json')
      let liveIds = new Set()
      try {
        liveIds = workspaceAccountedIds(home)
      } catch {}
      const existing = new Set(listSessionLogs(home).map((entry) => entry.sessionId))
      if (existsSync(storages)) {
        for (const name of readdirSync(storages)) {
          if (!name.startsWith('workspace.json.bak-')) continue
          const path = join(storages, name)
          let text
          try {
            text = readFileSync(path, 'utf8')
          } catch {
            continue
          }
          // A backup is stale when it names a Session that has no log left.
          const dangling = [...text.matchAll(/session-[0-9a-f-]{36}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)]
            .map((match) => match[0])
            .filter((id) => !existing.has(id))
          if (dangling.length === 0) continue
          let bytes = 0
          try {
            bytes = statSync(path).size
          } catch {
            continue
          }
          report.backups.bytes += bytes
          if (dryRun) {
            report.backups.removed += 1
            continue
          }
          try {
            await rm(path, { force: true })
            report.backups.removed += 1
          } catch (error) {
            report.backups.bytes -= bytes
            warnings.push(`could not remove stale backup ${name}: ${message(error)}`)
          }
        }
      }
      void live
      void liveIds
    } catch (error) {
      warnings.push(`backup sweep failed: ${message(error)}`)
    }
  }

  // The index has no orphan concept of its own — it reconciles — but compaction
  // still returns bytes a previous purge left in the freelist.
  if (!dryRun) {
    try {
      const compacted = await purgeSearchIndexes(home, new Set())
      report.searchIndex.indexes = compacted.indexes
      report.searchIndex.bytes = compacted.bytes
      for (const warning of compacted.warnings) warnings.push(warning)
    } catch (error) {
      warnings.push(`search-index sweep failed: ${message(error)}`)
    }
  }

  report.bytes =
    report.attachments.bytes +
    report.staging.bytes +
    report.uploadCache.bytes +
    report.searchIndex.bytes +
    report.backups.bytes
  return report
}
