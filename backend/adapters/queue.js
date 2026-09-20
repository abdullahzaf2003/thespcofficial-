import { run, all, get } from '../db/sqlite.js';

/**
 * Job queue adapter.
 *
 * Contract:
 *   register(kind, handler)                     — handler(payload) -> Promise
 *   schedule({ kind, runAt, payload, dedupeKey }) -> Promise<{ id }>
 *   cancel(dedupeKey)
 *   start() / stop()
 *
 * The shipped implementation polls a `jobs` table from the API process. It is
 * durable (a restart does not lose a pending reminder) but single-node. To
 * move to BullMQ, reimplement this class against Redis and keep the method
 * names — domain code only touches `queue.schedule` and `queue.register`.
 */

const MAX_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 15_000;

class InProcessJobQueue {
  constructor() {
    this.handlers = new Map();
    this.timer = null;
    this.draining = false;
  }

  register(kind, handler) {
    this.handlers.set(kind, handler);
  }

  async schedule({ kind, runAt, payload = {}, dedupeKey = null }) {
    const runAtIso = runAt instanceof Date ? runAt.toISOString() : String(runAt);

    if (dedupeKey) {
      const existing = await get("SELECT id FROM jobs WHERE dedupe_key = ? AND status = 'pending'", [dedupeKey]);
      if (existing) {
        await run('UPDATE jobs SET run_at = ?, payload = ? WHERE id = ?', [
          runAtIso,
          JSON.stringify(payload),
          existing.id,
        ]);
        return { id: existing.id };
      }
    }

    const { id } = await run(
      "INSERT INTO jobs (kind, dedupe_key, run_at, payload, status) VALUES (?, ?, ?, ?, 'pending')",
      [kind, dedupeKey, runAtIso, JSON.stringify(payload)],
    );
    return { id };
  }

  async cancel(dedupeKey) {
    if (!dedupeKey) return;
    await run("UPDATE jobs SET status = 'cancelled', completed_at = ? WHERE dedupe_key = ? AND status = 'pending'", [
      new Date().toISOString(),
      dedupeKey,
    ]);
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;

    try {
      const due = await all("SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC LIMIT 25", [
        new Date().toISOString(),
      ]);

      for (const job of due) {
        const handler = this.handlers.get(job.kind);
        if (!handler) {
          await this.fail(job, `No handler registered for job kind "${job.kind}"`);
          continue;
        }

        // Claim the row before running so a second drain cannot pick it up.
        const claim = await run("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ? AND status = 'pending'", [
          job.id,
        ]);
        if (claim.changes === 0) continue;

        try {
          await handler(JSON.parse(job.payload || '{}'), job);
          await run("UPDATE jobs SET status = 'done', completed_at = ? WHERE id = ?", [
            new Date().toISOString(),
            job.id,
          ]);
        } catch (error) {
          await this.fail({ ...job, attempts: job.attempts + 1 }, String(error.message));
        }
      }
    } catch (error) {
      console.error('[queue] drain failed:', error.message);
    } finally {
      this.draining = false;
    }
  }

  async fail(job, message) {
    const exhausted = (job.attempts || 0) >= MAX_ATTEMPTS;
    await run('UPDATE jobs SET status = ?, last_error = ?, completed_at = ? WHERE id = ?', [
      exhausted ? 'failed' : 'pending',
      message,
      exhausted ? new Date().toISOString() : null,
      job.id,
    ]);
    if (exhausted) console.error(`[queue] job ${job.id} (${job.kind}) permanently failed: ${message}`);
  }

  start() {
    if (this.timer) return;
    void this.drain();
    this.timer = setInterval(() => void this.drain(), POLL_INTERVAL_MS);
    this.timer.unref?.();
    console.log(`[queue] in-process worker started (poll ${POLL_INTERVAL_MS / 1000}s)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const queue = new InProcessJobQueue();

export const JOB_SEND_MEETING_LINK = 'send_meeting_link';
export const JOB_RELEASE_EXPIRED_HOLDS = 'release_expired_holds';
export const JOB_SEND_REVIEW_INVITE = 'send_review_invite';
export const JOB_PURGE_EXPIRED_TOKENS = 'purge_expired_tokens';
