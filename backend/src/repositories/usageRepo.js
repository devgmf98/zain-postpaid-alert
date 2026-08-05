'use strict';

const mysqlDb = require('../db/mysql');

const T = mysqlDb.TABLES.usage;

// Usage is only meaningful against the offer it was measured in, and an offer is
// a wallet. account_code is written as '' - the CDR query no longer resolves it.

function toSqlDateTime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Upserts the latest usage reading for each subscriber in one statement.
 *
 * The caller passes rows whose byte count moved, plus - once every
 * USAGE_PERSIST_MS - the full roster, so the table keeps ticking while CDRs are
 * between batches.
 */
async function upsertMany(walletId, rows, window) {
  if (!rows.length) return 0;

  const columns =
    '(msisdn, period_ym, account_code, wallet_id, account_name, currency_code, bytes_used, ' +
    'mbs_used, gbs_used, percent_of_cap, thresholds_crossed, round_no, period_bytes_used, window_from, window_to)';

  const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');

  const from = toSqlDateTime(window.from);
  const to = toSqlDateTime(window.to);

  const params = [];
  for (const r of rows) {
    params.push(
      r.msisdn,
      window.periodKey,
      r.accountCode ?? '',
      String(walletId),
      r.accountName ?? null,
      r.currencyCode ?? null,
      r.bytesUsed,
      r.mbsUsed,
      r.gbsUsed,
      r.percentOfCap,
      r.thresholdsCrossed || null,
      r.roundNo || 1,
      r.periodBytesUsed || 0,
      from,
      to
    );
  }

  const result = await mysqlDb.queryRaw(
    `INSERT INTO \`${T}\` ${columns}
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
        account_code = VALUES(account_code),
        account_name = VALUES(account_name),
        currency_code = VALUES(currency_code),
        bytes_used = VALUES(bytes_used),
        mbs_used = VALUES(mbs_used),
        gbs_used = VALUES(gbs_used),
        percent_of_cap = VALUES(percent_of_cap),
        thresholds_crossed = VALUES(thresholds_crossed),
        round_no = VALUES(round_no),
        period_bytes_used = VALUES(period_bytes_used),
        window_from = VALUES(window_from),
        window_to = VALUES(window_to),
        -- Set explicitly rather than relying on ON UPDATE CURRENT_TIMESTAMP:
        -- when every value re-written is identical MySQL counts the row as
        -- unchanged and leaves the timestamp alone, which makes a live figure
        -- indistinguishable from a dead monitor.
        updated_at = CURRENT_TIMESTAMP`,
    params
  );
  return result.affectedRows;
}

/**
 * Makes the table match reality for one offer: it keeps exactly the subscribers
 * CBS returned for the current period under that wallet, and nothing else.
 *
 * Removes rows from earlier periods (so the table resets when the monthly cycle
 * rolls over) and subscribers that no longer appear (so an empty CBS result
 * leaves an empty table rather than stale figures that look current).
 *
 * Deliberately narrow: it only ever touches rows belonging to the wallet passed
 * in. Other offers' rows are never affected - which is what makes it safe to run
 * once per offer within a single cycle.
 */
async function reconcile(walletId, msisdns, window) {
  const wallet = String(walletId);

  if (!msisdns.length) {
    const result = await mysqlDb.query(`DELETE FROM \`${T}\` WHERE wallet_id = ?`, [wallet]);
    return result.affectedRows;
  }

  const placeholders = msisdns.map(() => '?').join(', ');
  const result = await mysqlDb.queryRaw(
    `DELETE FROM \`${T}\`
      WHERE wallet_id = ?
        AND (period_ym <> ? OR msisdn NOT IN (${placeholders}))`,
    [wallet, window.periodKey, ...msisdns]
  );
  return result.affectedRows;
}

/** Stored usage for a period, optionally narrowed to one offer. */
async function listByPeriod(periodYm, limit = 500, walletId = null) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 5000);
  const params = [periodYm];
  let scope = '';
  if (walletId) {
    scope = ' AND wallet_id = ?';
    params.push(String(walletId));
  }

  return mysqlDb.query(
    `SELECT msisdn, period_ym, account_code, wallet_id, account_name, currency_code,
            bytes_used, mbs_used, gbs_used, percent_of_cap, thresholds_crossed, round_no, period_bytes_used,
            first_seen_at, updated_at
       FROM \`${T}\`
      WHERE period_ym = ?${scope}
      ORDER BY bytes_used DESC
      LIMIT ${safeLimit}`,
    params
  );
}

/**
 * MSISDNs this offer already has a usage row for in the given period - the
 * subscribers the monitor has observed at least once. Anyone absent is being
 * seen for the first time, which is what decides whether a threshold they are
 * already past counts as news or as history.
 *
 * Read from the table rather than an in-memory set on purpose: a restart must
 * not make every subscriber look new and replay thresholds they passed weeks ago.
 */
async function seenMsisdns(walletId, periodYm) {
  const rows = await mysqlDb.query(
    `SELECT msisdn FROM \`${T}\` WHERE period_ym = ? AND wallet_id = ?`,
    [periodYm, String(walletId)]
  );
  return new Set(rows.map((r) => r.msisdn));
}

module.exports = { upsertMany, reconcile, listByPeriod, seenMsisdns };
