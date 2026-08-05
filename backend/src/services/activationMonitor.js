'use strict';

const config = require('../config');
const logger = require('../logger');
const smsQueue = require('./smsQueue');
const activationService = require('./activationService');
const activationRepo = require('../repositories/activationRepo');

const MAX_ERROR_BACKOFF_MS = 60000;

/**
 * Sends a "your bundle is activated" SMS for every new activation EDR.
 *
 * Runs on its own timer rather than inside the usage cycle: the two read
 * different CBS tables, and a slow EDR query must not delay a threshold alert
 * (or the reverse). Delivery goes through the shared smsQueue, so both kinds of
 * message respect one concurrency limit against the gateway and are serialised
 * per subscriber - two messages to the same person never arrive together.
 */

const stats = {
  running: false,
  startedAt: null,
  day: null,
  cycles: 0,
  lastCycleAt: null,
  lastCycleMs: null,
  lastError: null,
  consecutiveErrors: 0,
  eventsSeen: 0,
  queued: 0,
  skippedBacklog: 0,
  unnamed: 0,
  lastActivationAt: null,
};

let timer = null;
let stopped = true;
let cycleInFlight = false;
// The day the last cycle covered, so the rollover is visible in the log rather
// than being an invisible change in what the query returns.
let lastDayKey = null;

/**
 * One pass over today's activation EDRs.
 *
 * Every event already in MySQL is skipped by its chrono number; anything new is
 * claimed and queued. The claim is written before the SMS goes out, so a crash
 * between the two leaves a PENDING row that startup recovery picks up rather
 * than a message nobody knows was owed.
 */
async function runCycle() {
  const startedAt = Date.now();
  const day = activationService.resolveDay();

  if (lastDayKey && lastDayKey !== day.dayKey) {
    logger.info(`Activation day rolled over: ${lastDayKey} -> ${day.dayKey}`);
  }
  lastDayKey = day.dayKey;
  stats.day = day.dayKey;

  const [events, dayState] = await Promise.all([
    activationService.fetchActivations(day),
    activationRepo.loadDayState(day.dayKey),
  ]);

  stats.eventsSeen = events.length;

  // On the first run of a day the whole backlog since midnight looks new.
  // Announcing it would tell someone at 18:00 that their 07:00 bundle has just
  // been activated, and would do it for every subscriber at once.
  const firstRunOfDay = dayState.size === 0;
  const announceBacklog = config.activation.announceBacklog;

  for (const event of events) {
    if (!event.chronoNum || !event.msisdn) continue;
    if (dayState.has(event.chronoNum)) continue;

    // No usable bundle name anywhere on the row. Recorded so it is auditable and
    // never retried, rather than sending a sentence with a hole in it.
    if (!event.offerName) {
      stats.unnamed += 1;
      await activationRepo.claim({
        ...event,
        offerName: '(unknown)',
        dayKey: day.dayKey,
        message: '(not sent - CB_OFFERS had no description for this tariff)',
        status: 'SKIPPED',
        errorMessage:
          `neither DETAIL_DESCRIPTION_V (${JSON.stringify(event.offerRaw)}) nor ` +
          `ATTRIBUTE4_V (${JSON.stringify(event.attribute4)}) held a bundle name`,
      });
      dayState.set(event.chronoNum, { status: 'SKIPPED' });
      continue;
    }

    const message = config.renderActivation(event.offerName);
    const backlog = firstRunOfDay && !announceBacklog;

    const slotId = await activationRepo.claim({
      ...event,
      dayKey: day.dayKey,
      message,
      status: backlog ? 'SKIPPED' : 'PENDING',
      errorMessage: backlog
        ? 'already activated before this run started - announcing it now would be stale'
        : null,
    });
    // Another cycle owns it; nothing to do.
    if (!slotId) continue;

    dayState.set(event.chronoNum, { status: backlog ? 'SKIPPED' : 'PENDING' });

    if (backlog) {
      stats.skippedBacklog += 1;
      continue;
    }

    logger.info(
      `Activation: ${event.msisdn} subscribed to "${event.offerName}" ` +
        `at ${event.eventAt.toISOString()} - queueing SMS`
    );
    smsQueue.enqueue({
      kind: 'activation',
      slotId,
      chronoNum: event.chronoNum,
      msisdn: event.msisdn,
      offerName: event.offerName,
      message,
    });
    stats.queued += 1;
    stats.lastActivationAt = new Date().toISOString();
  }

  if (firstRunOfDay && !announceBacklog && stats.skippedBacklog > 0) {
    logger.warn(
      `${stats.skippedBacklog} activation(s) from earlier today were recorded as SKIPPED ` +
        'rather than announced. Set ACTIVATION_ANNOUNCE_BACKLOG=true to send them instead.'
    );
  }

  stats.cycles += 1;
  stats.lastCycleAt = new Date().toISOString();
  stats.lastCycleMs = Date.now() - startedAt;
  stats.lastError = null;
  stats.consecutiveErrors = 0;
}

function scheduleNext(delayMs) {
  if (stopped) return;
  timer = setTimeout(tick, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

async function tick() {
  if (stopped) return;
  if (cycleInFlight) {
    scheduleNext(config.activation.intervalMs);
    return;
  }

  cycleInFlight = true;
  const startedMs = Date.now();
  let delay = config.activation.intervalMs;

  try {
    await runCycle();
    delay = Math.max(0, config.activation.intervalMs - (Date.now() - startedMs));
  } catch (err) {
    stats.consecutiveErrors += 1;
    const detail = logger.describe(err);
    stats.lastError = { message: detail.split('\n')[0], at: new Date().toISOString() };
    logger.error(`Activation cycle #${stats.cycles + 1} failed: ${detail}`);
    delay = Math.min(
      config.activation.intervalMs * 2 ** Math.min(stats.consecutiveErrors, 6),
      MAX_ERROR_BACKOFF_MS
    );
  } finally {
    cycleInFlight = false;
    scheduleNext(delay);
  }
}

function start() {
  if (!config.activation.enabled) {
    logger.info('ACTIVATION_ENABLED is false - bundle activation notices are off');
    return { started: false, reason: 'disabled' };
  }
  if (!stopped) return { started: false, reason: 'Activation monitor is already running' };

  stopped = false;
  stats.running = true;
  stats.startedAt = new Date().toISOString();

  const day = activationService.resolveDay();
  logger.info(
    `Activation monitor started - EDRs for ${day.dayKey}, every ` +
      `${config.activation.intervalMs} ms, dryRun=${config.monitor.dryRun}, ` +
      `announceBacklog=${config.activation.announceBacklog}`
  );
  tick();
  return { started: true };
}

function stop() {
  if (stopped) return { stopped: false, reason: 'Activation monitor is not running' };
  stopped = true;
  stats.running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  logger.info('Activation monitor stopped');
  return { stopped: true };
}

function getStatus() {
  return {
    ...stats,
    enabled: config.activation.enabled,
    intervalMs: config.activation.intervalMs,
    announceBacklog: config.activation.announceBacklog,
    cycleInFlight,
    table: config.mysql.tables.activations,
  };
}

module.exports = { start, stop, runCycle, getStatus };
