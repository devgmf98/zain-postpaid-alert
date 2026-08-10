'use strict';

const { EventEmitter } = require('events');
const config = require('../config');
const logger = require('../logger');
const usageService = require('./usageService');
const smsQueue = require('./smsQueue');
const notificationRepo = require('../repositories/notificationRepo');
const statusRepo = require('../repositories/statusRepo');
const usageRepo = require('../repositories/usageRepo');
const offerRepo = require('../repositories/offerRepo');

const MAX_ERROR_BACKOFF_MS = 60000;
const SERVICE_NAME = 'data-pool-monitor';

/**
 * Live event stream. The realtime layer subscribes to this rather than the
 * monitor calling into it, which keeps this module free of any transport
 * concerns. Listener errors are contained so a broken client cannot break a
 * polling cycle.
 */
const events = new EventEmitter();
events.setMaxListeners(0);

// The queue reports delivery outcomes; forward them onto the same stream so
// WebSocket clients see one coherent feed, and keep the counters here in step.
smsQueue.events.on('event', (evt) => {
  if (evt.type === 'sms.sent') stats.smsSent += 1;
  if (evt.type === 'sms.failed') stats.smsFailed += 1;
  events.emit('event', evt);
});

function emit(type, payload) {
  try {
    events.emit('event', { type, at: new Date().toISOString(), ...payload });
  } catch (err) {
    logger.warn(`Event listener threw for "${type}": ${err.message}`);
  }
}

/**
 * Per-offer caches, keyed by wallet id.
 *
 * Everything that used to be a single value is now one per offer: offers are
 * polled independently within a cycle, and sharing any of this between them
 * would let one offer's roster suppress another's writes.
 */
const persistedBytes = new Map(); // walletId -> Map(msisdn -> bytes)
const lastRosterKey = new Map(); // walletId -> roster signature
let persistedPeriod = null;
let lastStatusWriteMs = 0;
let lastUsageWriteMs = 0;
// When the previous cycle began, so the next one can be scheduled at a fixed
// rate rather than a fixed gap after the last one finished.
let lastCycleStartMs = 0;

const stats = {
  running: false,
  startedAt: null,
  cycles: 0,
  lastCycleAt: null,
  lastCycleMs: null,
  // Time between the start of consecutive cycles - the real polling rate.
  lastPeriodMs: null,
  lastError: null,
  consecutiveErrors: 0,
  offersActive: 0,
  subscribersSeen: 0,
  smsSent: 0,
  smsFailed: 0,
  smsSkippedAlreadySent: 0,
  // Bars closed as already-passed when a subscriber was first seen.
  thresholdsSkipped: 0,
  lastAlertAt: null,
};

// Per-offer counters and last error, surfaced through /api/status so one
// misconfigured offer is visible rather than hidden in a global total.
const offerStats = new Map();

let timer = null;
let cycleInFlight = false;
let stopped = true;
let lastSnapshot = [];

function statsFor(walletId) {
  if (!offerStats.has(walletId)) {
    offerStats.set(walletId, {
      walletId,
      subscribersSeen: 0,
      cycles: 0,
      alertsQueued: 0,
      thresholdsSkipped: 0,
      lastCycleAt: null,
      lastCycleMs: null,
      lastError: null,
    });
  }
  return offerStats.get(walletId);
}

/**
 * A threshold still needs an SMS when nothing is recorded for it this month, or
 * when the recorded row failed, has retries left, and has waited out the
 * cooldown. The cooldown matters because the poller runs every second: without
 * it the whole retry budget would be spent within a few seconds of a gateway
 * blip and the alert lost for the rest of the month.
 */
function needsSend(periodState, msisdn, level) {
  const existing = periodState.get(notificationRepo.key(msisdn, level.percent));
  if (!existing) return true;
  // SKIPPED means the bar was already behind the subscriber when we first saw
  // them, so announcing it now would be stale news. Closed, like SENT.
  if (existing.status === 'SENT' || existing.status === 'SKIPPED') return false;

  // A transient gateway fault (5xx, timeout, connection error) is worth retrying
  // for far longer than a bad request, which would fail identically every time.
  const budget = existing.retryable === false
    ? config.sms.maxRetryCycles
    : config.sms.maxRetryCyclesTransient;
  if (existing.attempts >= budget) return false;

  // PENDING means claimed and handed to the delivery queue; FAILED means an
  // attempt finished badly. In both cases wait out the cooldown - without it a
  // one-second poll would re-claim an in-flight job on every tick.
  //
  // ageMs is measured by MySQL against its own clock, not by subtracting a
  // stored timestamp from this process's clock. The two hosts do not always
  // agree on the time, and when they do not that subtraction silently makes
  // every row look old enough to retry.
  return existing.ageMs >= config.sms.retryCooldownMs;
}

/**
 * Reserves the month/threshold slot in MySQL before the SMS goes out.
 * Returns the row id to deliver against, or null if the slot is closed.
 */
async function acquireSlot(offer, payload) {
  const insertedId = await notificationRepo.claim(payload);
  if (insertedId) return insertedId;

  const slot = await notificationRepo.findSlot(
    offer.walletId,
    payload.msisdn,
    payload.thresholdPercent,
    payload.periodYm,
    payload.roundNo
  );
  if (!slot) return null;
  if (slot.status === 'SENT' || slot.status === 'SKIPPED') return null;
  const budget = slot.retryable === 0 ? config.sms.maxRetryCycles : config.sms.maxRetryCyclesTransient;
  if (Number(slot.attempts) >= budget) return null;
  return slot.id;
}

async function deliverAlert(offer, row, level, periodYm, periodState) {
  const payload = {
    walletId: offer.walletId,
    msisdn: row.msisdn,
    accountCode: row.accountCode ?? '',
    accountName: row.accountName,
    thresholdPercent: level.percent,
    thresholdGb: level.gb,
    gbsUsed: Number(row.exactGb.toFixed(3)),
    bytesUsed: row.bytesUsed,
    periodYm,
    cycleStart: row.cycleStart || config.resolveWindow().from,
    roundNo: row.roundNo || 1,
    periodBytesUsed: row.periodBytesUsed || 0,
    message: level.message,
  };

  const slotId = await acquireSlot(offer, payload);
  if (!slotId) {
    stats.smsSkippedAlreadySent += 1;
    periodState.set(notificationRepo.key(row.msisdn, level.percent), {
      status: 'SENT',
      attempts: config.sms.maxRetryCycles,
    });
    return;
  }

  logger.info(
    `[wallet ${offer.walletId}] threshold ${level.percent}% (${level.gb} GB) crossed by ` +
      `${row.msisdn} - used ${row.exactGb.toFixed(3)} GB in ${periodYm}, sending SMS`
  );
  emit('threshold.crossed', {
    msisdn: row.msisdn,
    walletId: offer.walletId,
    offerName: offer.offerName,
    thresholdPercent: level.percent,
    thresholdGb: level.gb,
    gbsUsed: payload.gbsUsed,
    periodYm,
  });

  // Hand off to the queue rather than sending here. The slot is already claimed,
  // so the de-duplication guarantee holds; the poller stays responsive instead of
  // blocking on the gateway for up to timeout x attempts per subscriber.
  smsQueue.enqueue({
    kind: 'threshold',
    slotId,
    msisdn: row.msisdn,
    accountCode: payload.accountCode,
    walletId: offer.walletId,
    thresholdPercent: level.percent,
    periodYm,
    message: level.message,
    gbsUsed: payload.gbsUsed,
    bytesUsed: payload.bytesUsed,
  });
  statsFor(offer.walletId).alertsQueued += 1;

  // Treated as handled for this cycle so it is not re-queued on the next poll a
  // second later. The real outcome is recorded by the queue worker in MySQL, and
  // a failure becomes eligible again once the retry cooldown has elapsed.
  periodState.set(notificationRepo.key(row.msisdn, level.percent), {
    status: 'PENDING',
    attempts: 1,
    ageMs: 0,
  });
  stats.lastAlertAt = new Date().toISOString();
}

/**
 * For subscribers being seen for the first time this period, records every
 * threshold they had already passed as SKIPPED, keeping only the most recent cap
 * crossing open so it can fire.
 *
 * Starting mid-month otherwise replays a subscriber's whole history as fresh
 * alerts. Someone sitting at 19.3 GB of a 20 GB cap was told "you have consumed
 * 50% of your 20 gb data cap" - true weeks ago, absurd now - and then got the
 * 100% an hour later when they crossed.
 *
 * This matters more now than it did: adding an offer through the API makes every
 * subscriber on that wallet first-seen at once.
 */
async function closePassedThresholds(offer, usageRows, alreadySeen, window, periodState) {
  const levels = offer.thresholds;
  const top = levels[levels.length - 1];
  const capGb = offer.capGb;

  for (const row of usageRows) {
    if (!row.msisdn || alreadySeen.has(row.msisdn)) continue;

    const totalGb = (row.periodBytesUsed || row.bytesUsed) / config.GB;
    // Whole caps already consumed. The cap crossing that closed the most recent
    // one is the alert this subscriber should get; everything before it is history.
    const completedRounds = Math.floor(totalGb / capGb);

    for (let roundNo = 1; roundNo <= completedRounds + 1; roundNo += 1) {
      for (const level of levels) {
        const absoluteGb = (roundNo - 1) * capGb + level.gb;
        if (absoluteGb > totalGb) break;
        if (level.percent === top.percent && roundNo === completedRounds) continue;

        try {
          const id = await notificationRepo.markSkipped({
            walletId: offer.walletId,
            msisdn: row.msisdn,
            accountCode: row.accountCode,
            accountName: row.accountName,
            thresholdPercent: level.percent,
            thresholdGb: level.gb,
            gbsUsed: Number(Math.max(0, totalGb - (roundNo - 1) * capGb).toFixed(3)),
            bytesUsed: row.bytesUsed,
            periodYm: window.periodKey,
            cycleStart: window.from,
            roundNo,
            periodBytesUsed: row.periodBytesUsed || row.bytesUsed,
            message: level.message,
            reason:
              `already at ${totalGb.toFixed(3)} GB when first seen - the ${level.percent}% ` +
              `bar for round ${roundNo} (${absoluteGb} GB) was passed unobserved`,
          });
          if (id) {
            stats.thresholdsSkipped += 1;
            statsFor(offer.walletId).thresholdsSkipped += 1;
            // Keep this cycle's in-memory view in step, so nothing downstream
            // treats the bar as still open before the next reload.
            if (roundNo === (row.roundNo || 1)) {
              periodState.set(notificationRepo.key(row.msisdn, level.percent), {
                status: 'SKIPPED',
                attempts: 0,
                retryable: false,
                ageMs: 0,
                periodBytesAtSend: row.periodBytesUsed || row.bytesUsed,
              });
            }
          }
        } catch (err) {
          // A subscriber we cannot close off is better left to normal alerting
          // than allowed to break the cycle for everyone else.
          logger.warn(
            `[wallet ${offer.walletId}] could not close passed thresholds for ` +
              `${row.msisdn}: ${logger.describe(err).split('\n')[0]}`
          );
        }
      }
    }

    if (completedRounds > 0) {
      logger.info(
        `[wallet ${offer.walletId}] ${row.msisdn} first seen at ${totalGb.toFixed(3)} GB - ` +
          `${completedRounds} cap(s) already consumed; sending the 100% only`
      );
    }
  }
}

/**
 * One poll for one offer: read that wallet's usage from Oracle, compare against
 * the offer's own thresholds and send whatever has not already been sent.
 */
/**
 * The window this offer is measured over.
 *
 * Under MONTH/DAY/CUSTOM every offer shares one span, so the shared window is
 * used as-is. Under CONTINUOUS the span reaches back to CONTINUOUS_FROM, which
 * may predate the offer entirely - an offer added in September would otherwise
 * sum August's CDRs for that wallet and inherit usage that was never part of
 * it, quite possibly firing a cap alert on its first cycle.
 *
 * So each offer starts counting from its own row instead, and only reaches
 * further back if CONTINUOUS_FROM is later. Offers that run past a month end
 * keep accumulating across it either way; that is the point of the mode.
 */
function windowForOffer(offer, window) {
  if (window.periodKey !== config.CONTINUOUS_PERIOD) return window;

  const offerStart = offer.createdAt ? new Date(offer.createdAt) : null;
  if (!offerStart || Number.isNaN(offerStart.getTime())) return window;
  if (offerStart <= window.from) return window;

  return { ...window, from: offerStart };
}

async function runOfferCycle(offer, sharedWindow) {
  const startedAt = Date.now();
  const mine = statsFor(offer.walletId);
  // Each offer accumulates from its own start under CONTINUOUS; identical to
  // the shared window in every other mode.
  const window = windowForOffer(offer, sharedWindow);

  // The cap is consumed in rounds. A subscriber already alerted at the top
  // threshold restarts counting from that point, so each can be measured over a
  // different span within the same month.
  const topPercent = offer.thresholds[offer.thresholds.length - 1].percent;
  const rounds = await notificationRepo.loadCycleStarts(
    offer.walletId,
    window.periodKey,
    topPercent,
    offer.capGb
  );

  const [usageRows, periodState, alreadySeen] = await Promise.all([
    usageService.fetchUsageByCycle(offer.walletId, window, rounds),
    notificationRepo.loadPeriodState(offer.walletId, window.periodKey, rounds),
    config.thresholds.skipPassedOnFirstSight
      ? usageRepo.seenMsisdns(offer.walletId, window.periodKey)
      : Promise.resolve(new Set()),
  ]);

  // Account code and name are reporting fields - the CDR query deliberately no
  // longer resolves them, because joining the service master to it risks
  // double-counting usage. Resolved separately and cached, so an alert row still
  // records who the subscriber is.
  const accounts = await usageService.fetchAccountInfo(usageRows.map((r) => r.msisdn));
  for (const row of usageRows) {
    const info = accounts.get(row.msisdn);
    if (info) {
      row.accountCode = info.accountCode;
      row.accountName = info.accountName;
      row.currencyCode = info.currencyCode;
    }
  }

  // Subscribers the monitor has never observed on this offer may already be deep
  // into their cap. Close off the bars they passed unobserved before any
  // alerting decision is made for them.
  if (config.thresholds.skipPassedOnFirstSight) {
    await closePassedThresholds(offer, usageRows, alreadySeen, window, periodState);
  }

  for (const row of usageRows) {
    if (!row.msisdn || row.bytesUsed <= 0) continue;

    // Only the threshold whose band the reading actually sits in is due:
    //   50%  -> usage >= threshold_50_gb and still below threshold_100_gb
    //   100% -> usage >= threshold_100_gb (the cap)
    // Past the cap there is nothing further to send; the round has to roll over
    // first. A subscriber whose usage lands straight above the cap therefore
    // gets the 100% alone - the 50% band was never occupied, so it is not
    // back-filled a second before the alert that supersedes it.
    const crossed = offer.thresholds.filter((level, i) => {
      if (!config.hasReached(row.bytesUsed, level)) return false;
      const next = offer.thresholds[i + 1];
      return !next || !config.hasReached(row.bytesUsed, next);
    });
    if (crossed.length === 0) continue;

    let outstanding = crossed.filter((level) => needsSend(periodState, row.msisdn, level));
    if (outstanding.length === 0) continue;

    // A threshold must be genuinely reached, not inferred from a reading that
    // already satisfied a lower one. If the 50% went out at this same usage
    // figure, the 100% waits until more data is actually consumed - otherwise
    // both land seconds apart off one measurement, which is not what "reached
    // 100%" means to the customer.
    outstanding = outstanding.filter((level) => {
      const lower = offer.thresholds.filter((l) => l.bytes < level.bytes);
      return !lower.some((l) => {
        const sent = periodState.get(notificationRepo.key(row.msisdn, l.percent));
        // Only a bar that was actually announced can make a higher one look like
        // the same event. A SKIPPED bar was never sent, so it must not block the
        // alert above it - that left a subscriber first seen above two caps with
        // no message at all.
        if (!sent || sent.status === 'SKIPPED') return false;
        return sent.periodBytesAtSend >= row.periodBytesUsed;
      });
    });
    if (outstanding.length === 0) continue;

    // How several bars cleared at once are handled. SEPARATE sends the lowest
    // outstanding threshold and leaves the rest for later cycles, so each alert
    // is its own event instead of two SMS landing in the same second.
    let toSend;
    if (!config.thresholds.sendMissed || config.thresholds.fireMode === 'HIGHEST') {
      // The highest bar actually crossed, not the highest still outstanding.
      const highest = crossed[crossed.length - 1];
      toSend = outstanding.filter((level) => level.percent === highest.percent);
    } else if (config.thresholds.fireMode === 'SEPARATE') {
      toSend = outstanding.slice(0, 1);
    } else {
      toSend = outstanding;
    }

    for (const level of toSend) {
      await deliverAlert(offer, row, level, window.periodKey, periodState);
    }
  }

  const changedCount = await persistUsage(offer, usageRows, window);

  mine.subscribersSeen = usageRows.length;
  mine.cycles += 1;
  mine.lastCycleAt = new Date().toISOString();
  mine.lastCycleMs = Date.now() - startedAt;
  mine.lastError = null;

  return { offer, usageRows, changedCount };
}

/**
 * One poll across every active offer.
 *
 * Offers are polled in sequence rather than in parallel: each one is a CBS query
 * taking seconds, and firing them together would multiply the load on the
 * database this service is a guest on. A failure in one offer is contained -
 * the rest of the cycle still runs, because one bad wallet must not stop
 * alerting for every other.
 */
async function runCycle() {
  const startedAt = Date.now();
  const window = config.resolveWindow();

  if (persistedPeriod !== window.periodKey) {
    persistedBytes.clear();
    lastRosterKey.clear();
    persistedPeriod = window.periodKey;
  }

  const offers = await offerRepo.listActive();
  stats.offersActive = offers.length;

  if (offers.length === 0) {
    // Loud, because the alternative is a monitor that reports itself perfectly
    // healthy while watching nothing at all.
    logger.warn(
      `No active offers in ${config.mysql.tables.offers} - nothing is being monitored. ` +
        'POST /api/offers to add one.'
    );
  }

  const snapshot = [];
  let subscribersSeen = 0;
  let changedTotal = 0;
  const failures = [];

  for (const offer of offers) {
    try {
      const result = await runOfferCycle(offer, window);
      subscribersSeen += result.usageRows.length;
      changedTotal += result.changedCount;

      snapshot.push(
        ...result.usageRows
          .slice()
          .sort((a, b) => b.bytesUsed - a.bytesUsed)
          .slice(0, 50)
          .map((row) => ({
            msisdn: row.msisdn,
            walletId: offer.walletId,
            offerName: offer.offerName,
            gbsUsed: Number(row.exactGb.toFixed(3)),
            mbsUsed: row.mbsUsed,
            capGb: offer.capGb,
            percentOfCap: Number(((row.exactGb / offer.capGb) * 100).toFixed(1)),
            roundNo: row.roundNo || 1,
          }))
      );
    } catch (err) {
      const detail = logger.describe(err).split('\n')[0];
      statsFor(offer.walletId).lastError = { message: detail, at: new Date().toISOString() };
      failures.push(`wallet ${offer.walletId}: ${detail}`);
      logger.error(`[wallet ${offer.walletId}] cycle failed: ${detail}`);
    }
  }

  // Every offer failing is a systemic fault - Oracle down, credentials wrong -
  // and must reach the caller so the backoff and the status row record it. One
  // offer failing among several is that offer's problem and is reported per offer.
  if (offers.length > 0 && failures.length === offers.length) {
    throw new Error(`every offer failed this cycle: ${failures.join('; ')}`);
  }

  stats.subscribersSeen = subscribersSeen;
  lastSnapshot = snapshot.sort((a, b) => b.gbsUsed - a.gbsUsed).slice(0, 100);

  stats.cycles += 1;
  stats.lastCycleAt = new Date().toISOString();
  stats.lastCycleMs = Date.now() - startedAt;
  stats.lastError = null;
  stats.consecutiveErrors = 0;

  await persistStatus(window, offers);

  // Only push a usage frame when something actually moved, so idle seconds do
  // not flood every connected client with identical data.
  if (changedTotal > 0) {
    emit('usage.updated', {
      periodYm: window.periodKey,
      changed: changedTotal,
      offers: offers.length,
      subscribers: lastSnapshot,
    });
  }

  emit('cycle', {
    cycles: stats.cycles,
    durationMs: stats.lastCycleMs,
    offers: offers.length,
    subscribersSeen: stats.subscribersSeen,
    periodYm: window.periodKey,
    failures,
  });
}

/**
 * Mirrors one offer's current usage into the usage table, writing only the
 * subscribers whose byte count actually moved since the last write.
 */
async function persistUsage(offer, usageRows, window) {
  const wallet = offer.walletId;
  if (!persistedBytes.has(wallet)) persistedBytes.set(wallet, new Map());
  const seen = persistedBytes.get(wallet);

  // Keep the table an exact mirror of the current period for this offer: drop
  // earlier periods and subscribers CBS no longer returns. Doing this only when
  // the roster or period actually changes avoids a DELETE on every poll.
  const msisdns = usageRows.map((r) => r.msisdn).filter(Boolean);
  const rosterKey = `${wallet}|${window.periodKey}|${[...msisdns].sort().join(',')}`;

  if (rosterKey !== lastRosterKey.get(wallet)) {
    try {
      const removed = await usageRepo.reconcile(wallet, msisdns, window);
      if (removed > 0) {
        logger.info(
          `[wallet ${wallet}] usage table: removed ${removed} stale row(s) - ` +
            `${msisdns.length} subscriber(s) now current for ${window.periodKey}`
        );
      }
      lastRosterKey.set(wallet, rosterKey);
      // Anything dropped must be re-inserted if it reappears.
      for (const msisdn of [...seen.keys()]) {
        if (!msisdns.includes(msisdn)) seen.delete(msisdn);
      }
    } catch (err) {
      logger.warn(`[wallet ${wallet}] could not reconcile the usage table: ${logger.describe(err)}`);
    }
  }

  // Refresh on a fixed cadence even when nothing moved, so updated_at proves the
  // figures are live. Without it an idle subscriber's row looks frozen and there
  // is no way to tell "unchanged" from "the monitor died".
  const dueRefresh = Date.now() - lastUsageWriteMs >= config.monitor.usagePersistMs;

  const changed = [];
  for (const row of usageRows) {
    if (!row.msisdn) continue;
    if (!dueRefresh && seen.get(row.msisdn) === row.bytesUsed) continue;

    changed.push({
      msisdn: row.msisdn,
      accountCode: row.accountCode ?? '',
      accountName: row.accountName,
      currencyCode: row.currencyCode,
      bytesUsed: row.bytesUsed,
      mbsUsed: row.mbsUsed,
      gbsUsed: Number(row.exactGb.toFixed(3)),
      percentOfCap: Number(((row.exactGb / offer.capGb) * 100).toFixed(2)),
      thresholdsCrossed: offer.thresholds
        .filter((l) => config.hasReached(row.bytesUsed, l))
        .map((l) => l.percent)
        .join(','),
      roundNo: row.roundNo || 1,
      periodBytesUsed: row.periodBytesUsed || 0,
    });
  }

  if (!changed.length) return 0;

  try {
    await usageRepo.upsertMany(wallet, changed, window);
    lastUsageWriteMs = Date.now();
    for (const row of changed) seen.set(row.msisdn, row.bytesUsed);
    logger.debug(`[wallet ${wallet}] usage table updated for ${changed.length} subscriber(s)`);
    return changed.length;
  } catch (err) {
    // Never let a reporting write break alerting, which is the job that matters.
    logger.warn(`[wallet ${wallet}] could not update the usage table: ${logger.describe(err)}`);
    return 0;
  }
}

/**
 * Upserts the service's status row plus one row per offer, throttled so a
 * one-second poll does not rewrite them every second.
 *
 * Per-offer rows use "<service>:<wallet>" as the service name, so the existing
 * unique key gives each offer its own row and an operator can see which offer
 * stalled without reading the logs.
 */
async function persistStatus(window, offers = [], force = false) {
  const now = Date.now();
  if (!force && now - lastStatusWriteMs < config.monitor.statusPersistMs) return;
  lastStatusWriteMs = now;

  const base = {
    running: stats.running,
    dryRun: config.monitor.dryRun,
    periodYm: window.periodKey,
    windowFrom: window.from,
    windowTo: window.to,
    pollIntervalMs: config.monitor.intervalMs,
    startedAt: stats.startedAt,
  };

  try {
    await statusRepo.save(SERVICE_NAME, {
      ...base,
      accountCode: '',
      walletId: `${offers.length} offer(s)`,
      capGb: null,
      cycles: stats.cycles,
      subscribersSeen: stats.subscribersSeen,
      smsSent: stats.smsSent,
      smsFailed: stats.smsFailed,
      lastCycleAt: stats.lastCycleAt,
      lastCycleMs: stats.lastCycleMs,
      lastAlertAt: stats.lastAlertAt,
      lastError: stats.lastError ? stats.lastError.message : null,
      lastErrorAt: stats.lastError ? stats.lastError.at : null,
      consecutiveErrors: stats.consecutiveErrors,
    });

    for (const offer of offers) {
      const mine = statsFor(offer.walletId);
      await statusRepo.save(`${SERVICE_NAME}:${offer.walletId}`, {
        ...base,
        accountCode: '',
        walletId: offer.walletId,
        capGb: offer.capGb,
        cycles: mine.cycles,
        subscribersSeen: mine.subscribersSeen,
        smsSent: mine.alertsQueued,
        smsFailed: 0,
        lastCycleAt: mine.lastCycleAt,
        lastCycleMs: mine.lastCycleMs,
        lastAlertAt: stats.lastAlertAt,
        lastError: mine.lastError ? mine.lastError.message : null,
        lastErrorAt: mine.lastError ? mine.lastError.at : null,
        consecutiveErrors: 0,
      });
    }
  } catch (err) {
    logger.warn(`Could not update the status table: ${logger.describe(err)}`);
  }
}

function scheduleNext(delayMs) {
  if (stopped) return;
  timer = setTimeout(tick, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

async function tick() {
  if (stopped) return;

  // A slow CBS query must never let two cycles overlap.
  if (cycleInFlight) {
    scheduleNext(config.monitor.intervalMs);
    return;
  }

  cycleInFlight = true;
  const cycleStartedMs = Date.now();
  stats.lastPeriodMs = lastCycleStartMs ? cycleStartedMs - lastCycleStartMs : null;
  lastCycleStartMs = cycleStartedMs;
  let delay = config.monitor.intervalMs;

  try {
    await runCycle();

    // Fixed rate, measured from when this cycle STARTED. Waiting a full interval
    // after it finished made the real period "query time + 1000 ms". When a cycle
    // overruns the interval the next one starts immediately; cycles still never
    // overlap. With several offers polled in sequence, overrunning is normal.
    delay = Math.max(0, config.monitor.intervalMs - (Date.now() - cycleStartedMs));
  } catch (err) {
    stats.consecutiveErrors += 1;
    const detail = logger.describe(err);
    stats.lastError = { message: detail.split('\n')[0], at: new Date().toISOString() };
    logger.error(`Monitor cycle #${stats.cycles + 1} failed: ${detail}`);

    // Back off instead of retrying a dead database once a second.
    delay = Math.min(
      config.monitor.intervalMs * 2 ** Math.min(stats.consecutiveErrors, 6),
      MAX_ERROR_BACKOFF_MS
    );
    logger.warn(`Backing off for ${delay} ms before the next cycle`);
    emit('cycle.failed', {
      error: detail.split('\n')[0],
      consecutiveErrors: stats.consecutiveErrors,
      backoffMs: delay,
    });

    // Record the failure immediately, bypassing the throttle - a status row that
    // silently stops updating is exactly what an operator needs to see.
    try {
      await persistStatus(config.resolveWindow(), [], true);
    } catch {
      // persistStatus already logs; nothing further to do here.
    }
  } finally {
    cycleInFlight = false;
    scheduleNext(delay);
  }
}

function start() {
  if (!stopped) return { started: false, reason: 'Monitor is already running' };

  stopped = false;
  stats.running = true;
  stats.startedAt = new Date().toISOString();

  if (config.monitor.intervalMs < 250) {
    logger.warn(
      `POLL_INTERVAL_MS=${config.monitor.intervalMs} queries CBS essentially ` +
        'back-to-back. Cycles cannot overlap, so the real rate is capped by query ' +
        'time - and CDRs are batch-loaded, so this rarely sees fresher data.'
    );
  }

  const window = config.resolveWindow();
  logger.info(
    `Monitor started - offers from ${config.mysql.tables.offers}, every ` +
      `${config.monitor.intervalMs} ms, window ${window.from.toISOString()} -> ` +
      `${window.to.toISOString()} (${config.pool.window}), dryRun=${config.monitor.dryRun}`
  );

  emit('monitor.started', { intervalMs: config.monitor.intervalMs, dryRun: config.monitor.dryRun });
  tick();
  return { started: true };
}

function stop() {
  if (stopped) return { stopped: false, reason: 'Monitor is not running' };

  stopped = true;
  stats.running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  // Best effort - the caller may be a shutdown handler about to close the pool.
  statusRepo
    .markStopped(SERVICE_NAME)
    .catch((err) => logger.warn(`Could not mark the service stopped: ${err.message}`));

  emit('monitor.stopped', {});
  logger.info('Monitor stopped');
  return { stopped: true };
}

function getStatus() {
  const window = config.resolveWindow();
  return {
    ...stats,
    cycleInFlight,
    intervalMs: config.monitor.intervalMs,
    dryRun: config.monitor.dryRun,
    offersTable: config.mysql.tables.offers,
    offers: [...offerStats.values()],
    window: {
      mode: config.pool.window,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      periodKey: window.periodKey,
    },
    topUsage: lastSnapshot.slice(0, 10),
    smsQueue: smsQueue.getStats(),
  };
}

function getSnapshot() {
  return lastSnapshot;
}

/**
 * Drops the per-offer caches so the next cycle re-reads everything.
 *
 * Called after an offer is added, retuned or removed. The offer list itself is
 * read fresh every cycle, so this only has to clear what is remembered between
 * cycles - the byte counts and roster signatures describing the old settings.
 */
function invalidateOffer(walletId = null) {
  if (walletId) {
    persistedBytes.delete(String(walletId));
    lastRosterKey.delete(String(walletId));
    offerStats.delete(String(walletId));
  } else {
    persistedBytes.clear();
    lastRosterKey.clear();
    offerStats.clear();
  }
  lastSnapshot = [];
}

module.exports = {
  start,
  stop,
  runCycle,
  getStatus,
  getSnapshot,
  invalidateOffer,
  events,
};
