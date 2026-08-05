'use strict';

const { EventEmitter } = require('events');
const config = require('../config');
const logger = require('../logger');
const smsService = require('./smsService');
const notificationRepo = require('../repositories/notificationRepo');
const activationRepo = require('../repositories/activationRepo');

/**
 * Which table a delivery outcome is written back to.
 *
 * Both kinds of message share this queue - the same gateway, the same
 * concurrency limit, the same per-subscriber serialisation - but they live in
 * different tables with different keys. The job carries its kind so the worker
 * records the result in the right place.
 */
const REPOS = {
  threshold: notificationRepo,
  activation: activationRepo,
};

function repoFor(job) {
  return REPOS[job.kind] || notificationRepo;
}

/**
 * Delivery queue for threshold alerts.
 *
 * The polling cycle must not block on the SMS gateway. A single delivery can
 * take up to FLOODWAVE_TIMEOUT_MS x FLOODWAVE_MAX_ATTEMPTS; with several
 * subscribers crossing at once, sending inline would stall the poller for
 * minutes and delay detection for everyone else. The cycle now claims the
 * MySQL slot (which is what prevents duplicates) and hands the job here.
 *
 * Ordering is FIFO and workers are bounded by SMS_QUEUE_CONCURRENCY, so the
 * gateway is never hit with an unbounded burst.
 */

const events = new EventEmitter();
events.setMaxListeners(0);

const queue = [];
// Jobs currently being delivered, keyed the same way as the MySQL unique key.
const inFlight = new Set();

let active = 0;
let draining = false;

// Per-subscriber delivery chain and last-send time. Workers run concurrently
// across subscribers, but never for the same one: two alerts for one person
// would otherwise be sent in parallel and arrive together, however far apart
// the thresholds were detected.
const subscriberChain = new Map();
const lastSentTo = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs fn after any previous delivery to this subscriber has finished, and
 * after at least SMS_MIN_GAP_MS has passed since their last message.
 */
function serializePerSubscriber(msisdn, fn) {
  const previous = subscriberChain.get(msisdn) || Promise.resolve();

  const next = previous.then(async () => {
    const gap = config.sms.minGapMs;
    const last = lastSentTo.get(msisdn);
    if (gap > 0 && last) {
      const wait = gap - (Date.now() - last);
      if (wait > 0) {
        logger.info(`Holding SMS to ${msisdn} for ${Math.round(wait / 1000)}s to space it from the previous one`);
        await sleep(wait);
      }
    }
    lastSentTo.set(msisdn, Date.now());
    return fn();
  });

  // Keep the chain alive even if this link rejects.
  subscriberChain.set(msisdn, next.then(() => {}, () => {}));
  return next;
}

const stats = {
  enqueued: 0,
  delivered: 0,
  failed: 0,
  dropped: 0,
  requeuedOnStartup: 0,
  maxDepth: 0,
};

function jobKey(job) {
  // An activation is identified by its EDR chrono number; a threshold alert by
  // the pool/subscriber/bar/period it belongs to. Mixing the two shapes into one
  // key would let an activation collide with a threshold alert for the same
  // subscriber and be dropped as a duplicate.
  if (job.kind === 'activation') return `activation|${job.chronoNum}`;
  return `threshold|${job.walletId}|${job.msisdn}|${job.thresholdPercent}|${job.periodYm}`;
}

function emit(type, payload) {
  try {
    events.emit('event', { type, at: new Date().toISOString(), ...payload });
  } catch (err) {
    logger.warn(`SMS queue listener threw for "${type}": ${err.message}`);
  }
}

/**
 * Adds a delivery to the queue. The caller must already have claimed the MySQL
 * row, so the de-duplication guarantee holds regardless of what happens here.
 * Returns false when the job is already queued or in flight, or the queue is full.
 */
function enqueue(job) {
  const key = jobKey(job);

  if (inFlight.has(key) || queue.some((q) => jobKey(q) === key)) {
    logger.debug(`SMS already queued for ${key}, not adding again`);
    return false;
  }

  if (queue.length >= config.sms.queueMax) {
    stats.dropped += 1;
    logger.error(
      `SMS queue is full (${config.sms.queueMax}); dropped alert for ` +
        `${job.msisdn} at ${job.thresholdPercent}%. It stays PENDING in MySQL ` +
        'and will be retried on a later cycle.'
    );
    return false;
  }

  queue.push({ ...job, queuedAt: Date.now() });
  stats.enqueued += 1;
  stats.maxDepth = Math.max(stats.maxDepth, queue.length);

  emit('sms.queued', {
    msisdn: job.msisdn,
    thresholdPercent: job.thresholdPercent,
    depth: queue.length,
  });

  drain();
  return true;
}

/** Starts workers up to the concurrency limit. Safe to call at any time. */
function drain() {
  if (draining) return;
  draining = true;

  try {
    while (active < config.sms.queueConcurrency && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      // Deliberately not awaited: workers run alongside the poller.
      deliver(job).finally(() => {
        active -= 1;
        if (queue.length > 0) drain();
      });
    }
  } finally {
    draining = false;
  }
}

async function deliver(job) {
  const key = jobKey(job);
  inFlight.add(key);
  const waitedMs = Date.now() - job.queuedAt;

  try {
    const result = await serializePerSubscriber(job.msisdn, () => smsService.sendSms(job.msisdn, job.message));

    const repo = repoFor(job);
    const what = job.kind === 'activation'
      ? `activation of ${job.offerName}`
      : `${job.thresholdPercent}%`;

    if (result.success) {
      // The threshold repo also records the usage figure at send time; the
      // activation repo has no such column, so it takes the response alone.
      if (job.kind === 'activation') {
        await repo.markSent(job.slotId, result.response);
      } else {
        await repo.markSent(job.slotId, result.response, {
          gbsUsed: job.gbsUsed,
          bytesUsed: job.bytesUsed,
        });
      }
      stats.delivered += 1;
      emit('sms.sent', {
        kind: job.kind || 'threshold',
        msisdn: job.msisdn,
        thresholdPercent: job.thresholdPercent,
        offerName: job.offerName,
        gbsUsed: job.gbsUsed,
        message: job.message,
        dryRun: config.monitor.dryRun,
        waitedMs,
      });
      return;
    }

    const detail = result.errorBody
      ? `${result.error} :: ${JSON.stringify(result.errorBody)}`
      : result.error;
    await repo.markFailed(job.slotId, detail, result.retryable !== false);
    stats.failed += 1;
    logger.error(`SMS to ${job.msisdn} for ${what} failed: ${detail}`);
    emit('sms.failed', {
      kind: job.kind || 'threshold',
      msisdn: job.msisdn,
      thresholdPercent: job.thresholdPercent,
      offerName: job.offerName,
      error: detail,
      retryable: result.retryable !== false,
      waitedMs,
    });
  } catch (err) {
    // A failure here (typically MySQL) must not kill the worker loop. The row
    // stays PENDING/FAILED and a later cycle picks it up again.
    stats.failed += 1;
    logger.error(`SMS delivery threw for ${job.msisdn}: ${logger.describe(err)}`);
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Re-queues alerts left PENDING by a previous run.
 *
 * Rows are claimed before the SMS is sent, so a crash between those two steps
 * leaves a PENDING row whose message never went out. Without this they would
 * wait for the cycle-level retry; picking them up at startup delivers them at
 * once.
 */
async function recoverPending(periodYm) {
  const pending = await notificationRepo.listPending(periodYm);
  if (!pending.length) return 0;

  let queued = 0;
  for (const row of pending) {
    const added = enqueue({
      kind: 'threshold',
      slotId: row.id,
      msisdn: row.msisdn,
      accountCode: row.account_code,
      walletId: row.wallet_id,
      thresholdPercent: Number(row.threshold_percent),
      periodYm: row.period_ym,
      message: row.message,
      gbsUsed: Number(row.gbs_used),
      bytesUsed: Number(row.bytes_used),
    });
    if (added) queued += 1;
  }

  stats.requeuedOnStartup += queued;
  if (queued) {
    logger.info(`Re-queued ${queued} alert(s) left pending by a previous run`);
  }
  return queued;
}

/**
 * The activation equivalent: notices claimed but never delivered.
 *
 * Bounded to the day passed in, because an activation notice is only meaningful
 * on the day it happened - re-queuing yesterday's would tell someone their
 * expired bundle has just been activated.
 */
async function recoverPendingActivations(dayKey) {
  const pending = await activationRepo.listPending(dayKey);
  if (!pending.length) return 0;

  let queued = 0;
  for (const row of pending) {
    const added = enqueue({
      kind: 'activation',
      slotId: row.id,
      chronoNum: String(row.chrono_num),
      msisdn: row.msisdn,
      offerName: row.offer_name,
      message: row.message,
    });
    if (added) queued += 1;
  }

  stats.requeuedOnStartup += queued;
  if (queued) {
    logger.info(`Re-queued ${queued} activation notice(s) left pending by a previous run`);
  }
  return queued;
}

function getStats() {
  return {
    ...stats,
    depth: queue.length,
    active,
    concurrency: config.sms.queueConcurrency,
    capacity: config.sms.queueMax,
  };
}

/** Waits for the queue to empty - used by tests and graceful shutdown. */
async function idle(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while ((queue.length > 0 || active > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return queue.length === 0 && active === 0;
}

function clear() {
  const dropped = queue.length;
  queue.length = 0;
  return dropped;
}

module.exports = {
  enqueue,
  drain,
  recoverPending,
  recoverPendingActivations,
  getStats,
  idle,
  clear,
  events,
};
