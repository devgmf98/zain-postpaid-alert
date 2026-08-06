'use strict';

const mysqlDb = require('../db/mysql');
const config = require('../config');

const DUPLICATE_ENTRY = 'ER_DUP_ENTRY';
const T = mysqlDb.TABLES.notifications;

// Every read and write is scoped to one wallet - the offer's identity. A
// subscriber active under two offers consumes each cap separately and is
// entitled to the 50% / 100% alert for each; within one offer they still
// receive each alert exactly once per period.
//
// account_code is no longer part of that scope. It is carried on the row for
// reporting only, and defaults to '' because the CDR query no longer resolves it.

function key(msisdn, thresholdPercent) {
  return `${msisdn}:${thresholdPercent}`;
}

/**
 * MySQL DATE literal for a JS Date, in local time. Falls back to the start of
 * the current period so a caller that omits the round cannot crash a cycle.
 */
function toSqlDate(d) {
  const date = d instanceof Date && !Number.isNaN(d.getTime())
    ? d
    : config.resolveWindow().from;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Where each subscriber's current round starts, for one offer.
 *
 * The cap is consumed in rounds: once the top threshold has been alerted, that
 * subscriber's counter restarts, so a subscriber who keeps using the same wallet
 * can be alerted again within the same month. A subscriber with no completed
 * round is measured from the start of the period.
 *
 * SKIPPED counts as completed: a cap crossing that happened before the monitor
 * first saw the subscriber is still a consumed cap, and treating it as unfinished
 * would replay every historical round as a fresh alert.
 *
 * capGb comes from the offer rather than global config, so two offers with
 * different caps advance their rounds independently.
 */
async function loadCycleStarts(walletId, periodYm, topThresholdPercent, capGb) {
  const rows = await mysqlDb.query(
    `SELECT msisdn,
            COUNT(*)        AS rounds_done,
            MAX(sent_at)    AS last_sent
       FROM \`${T}\`
      WHERE period_ym = ? AND wallet_id = ?
        AND threshold_percent = ? AND status IN ('SENT','SKIPPED')
      GROUP BY msisdn`,
    [periodYm, String(walletId), topThresholdPercent]
  );

  // The cap is the offer's total allowance, so one round is one full cap.
  // Consuming two caps means two completed rounds, and round three counts from
  // the 2 x cap mark.
  const roundBytes = Math.round(Number(capGb) * config.GB);

  const rounds = new Map();
  for (const row of rows) {
    const completed = Number(row.rounds_done || 0);

    rounds.set(row.msisdn, {
      // Anchored to whole multiples of the cap, not to wherever the previous
      // alert happened to land. With 5 GB / 10 GB bars that puts them at 5 and
      // 10, then 15 and 20 - fixed, and never dragged along by a late alert.
      roundNo: completed + 1,
      baselineBytes: completed * roundBytes,
      lastSentAt: row.last_sent ? new Date(row.last_sent) : null,
    });
  }
  return rounds;
}

/**
 * Every alert already recorded for one offer in the given period, as a Map keyed
 * by "<msisdn>:<percent>". The monitor loads this once per offer per cycle so a
 * subscriber can never be alerted twice for the same threshold.
 */
async function loadPeriodState(walletId, periodYm, rounds = new Map()) {
  const rows = await mysqlDb.query(
    `SELECT msisdn, threshold_percent, status, attempts, retryable, round_no,
            period_bytes_used,
            -- Age computed inside MySQL, against MySQL's own NOW(). Returning
            -- updated_at and subtracting it from Date.now() compared two
            -- different clocks: on a host where MySQL runs UTC and the process
            -- runs Africa/Juba that inflated every age by two hours, so the
            -- retry cooldown was always satisfied and a failing alert re-fired
            -- every second until its budget was gone. Both sides of this
            -- subtraction come from the same clock, so any skew cancels.
            TIMESTAMPDIFF(SECOND, updated_at, NOW()) AS age_seconds
       FROM \`${T}\`
      WHERE period_ym = ? AND wallet_id = ?`,
    [periodYm, String(walletId)]
  );

  const state = new Map();
  for (const row of rows) {
    // Only alerts belonging to the round currently being measured count as
    // already-sent; earlier rounds must not suppress this one.
    const currentRound = rounds.get(row.msisdn) ? rounds.get(row.msisdn).roundNo : 1;
    if (Number(row.round_no) !== currentRound) continue;
    state.set(key(row.msisdn, row.threshold_percent), {
      status: row.status,
      attempts: Number(row.attempts),
      retryable: row.retryable === undefined ? true : Boolean(row.retryable),
      // How long since this row last changed, in milliseconds.
      ageMs: Math.max(0, Number(row.age_seconds || 0)) * 1000,
      // Total usage when this alert went out. A higher threshold must not fire
      // off the same reading - it has to be genuinely reached.
      periodBytesAtSend: Number(row.period_bytes_used || 0),
    });
  }
  return state;
}

/**
 * Reserves the (wallet, msisdn, threshold, period, round) slot before the SMS
 * leaves the box, so a crash mid-send can never turn into a second SMS for the
 * same threshold. Returns the row id, or null when another cycle owns the slot.
 */
async function claim({
  walletId,
  msisdn,
  accountCode,
  accountName,
  thresholdPercent,
  thresholdGb,
  gbsUsed,
  bytesUsed,
  periodYm,
  cycleStart,
  roundNo,
  periodBytesUsed,
  message,
}) {
  try {
    const result = await mysqlDb.query(
      `INSERT INTO \`${T}\`
         (msisdn, account_code, wallet_id, account_name, threshold_percent, threshold_gb,
          gbs_used, bytes_used, period_ym, cycle_start, round_no, period_bytes_used,
          message, status, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0)`,
      [
        msisdn,
        accountCode ?? '',
        String(walletId),
        accountName ?? null,
        thresholdPercent,
        thresholdGb,
        gbsUsed,
        bytesUsed,
        periodYm,
        toSqlDate(cycleStart),
        roundNo || 1,
        periodBytesUsed || 0,
        message,
      ]
    );
    return result.insertId;
  } catch (err) {
    if (err.code === DUPLICATE_ENTRY) return null;
    throw err;
  }
}

/**
 * Records a threshold as passed-before-we-were-watching, so it is never sent.
 *
 * Written as a row rather than held in memory because the de-duplication key is
 * what actually prevents a send: a restart would otherwise see a clean slate and
 * announce the stale threshold after all. SKIPPED also leaves the decision
 * auditable - "why did this subscriber never get a 50%?" has an answer with a
 * timestamp and the usage figure behind it.
 */
async function markSkipped({
  walletId,
  msisdn,
  accountCode,
  accountName,
  thresholdPercent,
  thresholdGb,
  gbsUsed,
  bytesUsed,
  periodYm,
  cycleStart,
  roundNo,
  periodBytesUsed,
  message,
  reason,
}) {
  try {
    const result = await mysqlDb.query(
      `INSERT INTO \`${T}\`
         (msisdn, account_code, wallet_id, account_name, threshold_percent, threshold_gb,
          gbs_used, bytes_used, period_ym, cycle_start, round_no, period_bytes_used,
          message, status, attempts, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SKIPPED', 0, ?)`,
      [
        msisdn,
        accountCode ?? '',
        String(walletId),
        accountName ?? null,
        thresholdPercent,
        thresholdGb,
        gbsUsed,
        bytesUsed,
        periodYm,
        toSqlDate(cycleStart),
        roundNo || 1,
        periodBytesUsed || 0,
        message,
        reason || 'threshold was already passed when this subscriber was first seen',
      ]
    );
    return result.insertId;
  } catch (err) {
    if (err.code === DUPLICATE_ENTRY) return null;
    throw err;
  }
}

/**
 * Re-opens an existing PENDING/FAILED row for another delivery attempt.
 */
async function findSlot(walletId, msisdn, thresholdPercent, periodYm, roundNo) {
  const rows = await mysqlDb.query(
    `SELECT id, status, attempts, retryable
       FROM \`${T}\`
      WHERE msisdn = ? AND threshold_percent = ? AND period_ym = ?
        AND wallet_id = ? AND round_no = ?
      LIMIT 1`,
    [msisdn, thresholdPercent, periodYm, String(walletId), roundNo || 1]
  );
  return rows[0] || null;
}

async function markSent(id, gatewayResponse, usage = {}) {
  await mysqlDb.query(
    `UPDATE \`${T}\`
        SET status = 'SENT',
            attempts = attempts + 1,
            gateway_response = ?,
            error_message = NULL,
            gbs_used = COALESCE(?, gbs_used),
            bytes_used = COALESCE(?, bytes_used),
            sent_at = NOW()
      WHERE id = ?`,
    [
      truncate(gatewayResponse),
      usage.gbsUsed ?? null,
      usage.bytesUsed ?? null,
      id,
    ]
  );
}

async function markFailed(id, errorMessage, retryable = true) {
  await mysqlDb.query(
    `UPDATE \`${T}\`
        SET status = 'FAILED',
            attempts = attempts + 1,
            retryable = ?,
            error_message = ?
      WHERE id = ?`,
    [retryable ? 1 : 0, truncate(errorMessage), id]
  );
}

/**
 * Alerts claimed but never delivered - a crash between the INSERT and the send
 * leaves the row PENDING with the SMS still owed.
 *
 * Not scoped to a wallet: startup recovery owes these messages regardless of
 * which offer produced them, including offers since deactivated.
 */
async function listPending(periodYm) {
  return mysqlDb.query(
    `SELECT id, msisdn, account_code, wallet_id, threshold_percent, period_ym,
            message, gbs_used, bytes_used
       FROM \`${T}\`
      WHERE period_ym = ? AND status = 'PENDING' AND attempts < ?
      ORDER BY id`,
    [periodYm, config.sms.maxRetryCycles]
  );
}

/** Recorded alerts for a period, optionally narrowed to one offer. */
async function listByPeriod(periodYm, limit = 500, walletId = null) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 5000);
  const params = [periodYm];
  let scope = '';
  if (walletId) {
    scope = ' AND wallet_id = ?';
    params.push(String(walletId));
  }

  return mysqlDb.query(
    `SELECT id, msisdn, account_code, wallet_id, account_name, threshold_percent,
            threshold_gb, gbs_used, bytes_used, period_ym, message, status, attempts,
            error_message, created_at, sent_at
       FROM \`${T}\`
      WHERE period_ym = ?${scope}
      ORDER BY id DESC
      LIMIT ${safeLimit}`,
    params
  );
}

async function summaryByPeriod(periodYm, walletId = null) {
  const params = [periodYm];
  let scope = '';
  if (walletId) {
    scope = ' AND wallet_id = ?';
    params.push(String(walletId));
  }

  const rows = await mysqlDb.query(
    `SELECT wallet_id, threshold_percent, status, COUNT(*) AS total
       FROM \`${T}\`
      WHERE period_ym = ?${scope}
      GROUP BY wallet_id, threshold_percent, status
      ORDER BY wallet_id, threshold_percent`,
    params
  );
  return rows.map((row) => ({
    walletId: row.wallet_id,
    thresholdPercent: Number(row.threshold_percent),
    status: row.status,
    total: Number(row.total),
  }));
}

function truncate(value, max = 4000) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

module.exports = {
  key,
  loadPeriodState,
  claim,
  markSkipped,
  findSlot,
  markSent,
  markFailed,
  loadCycleStarts,
  listPending,
  listByPeriod,
  summaryByPeriod,
};
