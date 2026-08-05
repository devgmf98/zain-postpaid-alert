'use strict';

const oracle = require('../db/oracle');
const config = require('../config');
const logger = require('../logger');

/**
 * Threshold query.
 *
 * This is the supplied report query with CALL_TYPE_V and BUNDLE_NAME dropped from
 * the GROUP BY: the alert rule is "this MSISDN reached 5 GB", which needs one
 * total per subscriber. Leaving those columns in splits a subscriber across
 * several rows (one per usage type / bundle) and no single row would ever reach
 * the cap. The raw byte sum is selected alongside the rounded GB so the
 * comparison never rides on a rounded value - ROUND(4.96, 1) is 5.0, which would
 * fire the alert early.
 *
 * Scoped by WALLET_ID alone. An offer is a wallet, so the wallet is the whole
 * predicate - a subscriber's usage counts towards the offer they are subscribed
 * to, whatever account they happen to sit under.
 *
 * The joins to GSM_SERVICE_MAST and CB_ACCOUNT_MASTER are deliberately gone.
 * They existed to supply ACCOUNT_CODE_N for the account filter; with that filter
 * removed they contribute nothing but risk. GSM_SERVICE_MAST holds one row per
 * service, and a subscriber with two of them would have every CDR counted twice
 * by the join - silently doubling the figure that decides whether an SMS goes
 * out. Account code and name are reporting fields only, so they are not worth a
 * fan-out bug on the query that runs every second.
 */
const USAGE_BY_MSISDN_SQL = `
SELECT
    c.SERVICE_IDENTIFIER_V                                 AS MOBILE_NUMBER,
    SUM(c.DATA_VOLUME_UPLOADED_N)                          AS BYTES_USED,
    ROUND(SUM(c.DATA_VOLUME_UPLOADED_N) / 1024 / 1024, 0)  AS MBS_USED,
    ROUND(SUM(c.DATA_VOLUME_UPLOADED_N) / 1024 / 1024 / 1024, 1) AS GBS_USED
FROM CBS_CORE.CB_PREPAID_UPLOAD_ALL_CDRS c
WHERE c.CALL_TYPE_V IN ('18', '001', '031')
  AND c.WALLET_ID_1_V = :walletId
  AND c.CALL_DATE_TIME_DT >= TO_DATE(:fromDt, 'SYYYY-MM-DD HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')
  AND c.CALL_DATE_TIME_DT <  TO_DATE(:toDt,   'SYYYY-MM-DD HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')
GROUP BY c.SERVICE_IDENTIFIER_V
ORDER BY MOBILE_NUMBER
`;

/**
 * The original report query, kept for /api/usage/detailed so the per-bundle and
 * per-usage-type breakdown is still available.
 *
 * This one keeps its joins: it is on-demand rather than per-second, and its
 * GROUP BY already splits a subscriber across bundles, so a duplicated row is
 * visible in the breakdown rather than hidden inside a total that triggers an SMS.
 */
const USAGE_DETAILED_SQL = `
SELECT
    d.ACCOUNT_CODE_N AS ACCOUNT_CODE,
    e.ACCOUNT_NAME_V AS ACCOUNT_NAME,
    c.SERVICE_IDENTIFIER_V AS MOBILE_NUMBER,
    e.CURRENCY_CODE_V,
    ROUND(SUM(c.DATA_VOLUME_UPLOADED_N) / 1024 / 1024, 0) AS MBS_USED,
    ROUND(SUM(c.DATA_VOLUME_UPLOADED_N) / 1024 / 1024 / 1024, 1) AS GBS_USED,
    DECODE(
        c.CALL_TYPE_V,
        '001','OUTGOING',
        '002','INCOMING',
        '031','SMS',
        '18','DATA'
    ) AS USAGE_TYPE,
    o.DETAIL_DESCRIPTION_V AS BUNDLE_NAME
FROM CBS_CORE.CB_PREPAID_UPLOAD_ALL_CDRS c
LEFT JOIN CBS_CORE.CB_OFFERS o
    ON c.TARIFF_TYPE_V = o.APPLY_TARIFF_CODE_V
LEFT JOIN CBS_CORE.GSM_SERVICE_MAST d
    ON d.MOBL_NUM_VOICE_V = c.SERVICE_IDENTIFIER_V
LEFT JOIN CB_ACCOUNT_MASTER e
    ON e.ACCOUNT_CODE_N = c.ACCOUNT_CODE_N
WHERE c.CALL_TYPE_V IN ('18', '001', '031')
  AND c.WALLET_ID_1_V = :walletId
  AND c.CALL_DATE_TIME_DT >= TO_DATE(:fromDt, 'SYYYY-MM-DD HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')
  AND c.CALL_DATE_TIME_DT <  TO_DATE(:toDt,   'SYYYY-MM-DD HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')
GROUP BY
    d.ACCOUNT_CODE_N,
    e.ACCOUNT_NAME_V,
    e.CURRENCY_CODE_V,
    c.SERVICE_IDENTIFIER_V,
    c.CALL_TYPE_V,
    o.DETAIL_DESCRIPTION_V
ORDER BY MOBILE_NUMBER
`;

/**
 * Same totals, but broken down by day.
 *
 * Each subscriber can be measured over a different span: after the 100% alert
 * their counter restarts, so one shared window is no longer enough. Daily
 * buckets let a single query serve every subscriber - the caller sums only the
 * days at or after that subscriber's own cycle start.
 */
const USAGE_BY_MSISDN_DAILY_SQL = `
SELECT
    c.SERVICE_IDENTIFIER_V           AS MOBILE_NUMBER,
    TRUNC(c.CALL_DATE_TIME_DT)       AS USAGE_DAY,
    SUM(c.DATA_VOLUME_UPLOADED_N)    AS BYTES_USED
FROM CBS_CORE.CB_PREPAID_UPLOAD_ALL_CDRS c
WHERE c.CALL_TYPE_V IN ('18', '001', '031')
  AND c.WALLET_ID_1_V = :walletId
  AND c.CALL_DATE_TIME_DT >= TO_DATE(:fromDt, 'SYYYY-MM-DD HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')
  AND c.CALL_DATE_TIME_DT <  TO_DATE(:toDt,   'SYYYY-MM-DD HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')
GROUP BY
    c.SERVICE_IDENTIFIER_V,
    TRUNC(c.CALL_DATE_TIME_DT)
ORDER BY MOBILE_NUMBER, USAGE_DAY
`;

/**
 * Formats a Date as the wall-clock string the query's TO_DATE expects.
 *
 * The bounds are passed as text rather than as bound Date objects on purpose:
 * binding a JS Date makes Oracle interpret it through the session time zone, so
 * the window would silently shift if the Node host and the CBS host disagree
 * about the time zone. A literal 'YYYY-MM-DD HH24:MI:SS' has no such ambiguity
 * and matches the TO_DATE literals in the original report query.
 */
function formatOracleDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function buildBinds(walletId, window) {
  const wallet = String(walletId ?? '').trim();
  if (!wallet) {
    // Without a wallet the predicate would match every CDR in CBS. Refuse rather
    // than run it: that query would measure the whole platform against one
    // offer's cap and alert an unbounded number of subscribers.
    throw new Error('A wallet id is required - refusing to query CDRs unscoped');
  }
  return {
    walletId: wallet,
    fromDt: formatOracleDateTime(window.from),
    toDt: formatOracleDateTime(window.to),
  };
}

/**
 * One row per subscriber for the current accumulation window.
 */
async function fetchUsageByMsisdn(walletId, window = config.resolveWindow()) {
  const rows = await oracle.query(USAGE_BY_MSISDN_SQL, buildBinds(walletId, window));

  return rows.map((row) => {
    const bytesUsed = Number(row.BYTES_USED) || 0;
    return {
      accountCode: null,
      accountName: null,
      currencyCode: null,
      msisdn: String(row.MOBILE_NUMBER),
      bytesUsed,
      mbsUsed: Number(row.MBS_USED) || 0,
      gbsUsed: Number(row.GBS_USED) || 0,
      // Full precision, used for every threshold comparison and for reporting.
      exactGb: bytesUsed / config.GB,
    };
  });
}

/** Local midnight for a date, so day comparisons ignore any time component. */
function dayKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Per-subscriber usage measured from each subscriber's own cycle start.
 *
 * cycleStarts maps msisdn -> round info; anything absent is measured from the
 * start of the period. The baseline is subtracted so the counter restarts after
 * each completed cap.
 */
async function fetchUsageByCycle(
  walletId,
  window = config.resolveWindow(),
  cycleStarts = new Map()
) {
  const rows = await oracle.query(USAGE_BY_MSISDN_DAILY_SQL, buildBinds(walletId, window));

  const bySubscriber = new Map();
  for (const row of rows) {
    const msisdn = String(row.MOBILE_NUMBER);
    const day = row.USAGE_DAY instanceof Date ? row.USAGE_DAY : new Date(row.USAGE_DAY);
    const bytes = Number(row.BYTES_USED) || 0;

    if (!bySubscriber.has(msisdn)) {
      bySubscriber.set(msisdn, { msisdn, days: [] });
    }
    bySubscriber.get(msisdn).days.push({ day, dayKey: dayKey(day), bytes });
  }

  const result = [];
  for (const entry of bySubscriber.values()) {
    const round = cycleStarts.get(entry.msisdn);
    const periodBytes = entry.days.reduce((sum, d) => sum + d.bytes, 0);

    // A round is measured from the meter reading taken at the previous 100%
    // alert, not from a day boundary. That way a subscriber who re-subscribes
    // and carries on the same day starts accumulating immediately, instead of
    // having the rest of that day discarded.
    const baseline = round ? round.baselineBytes : 0;
    const bytesUsed = Math.max(0, periodBytes - baseline);

    result.push({
      accountCode: null,
      accountName: null,
      currencyCode: null,
      msisdn: entry.msisdn,
      bytesUsed,
      mbsUsed: Math.round(bytesUsed / 1048576),
      gbsUsed: Number((bytesUsed / config.GB).toFixed(1)),
      exactGb: bytesUsed / config.GB,
      // The whole period, ignoring round restarts - stored on the alert so the
      // next round knows where to count from.
      periodBytesUsed: periodBytes,
      roundNo: round ? round.roundNo : 1,
      baselineBytes: baseline,
      cycleStart: round && round.lastSentAt ? round.lastSentAt : window.from,
      cycleStartKey: dayKey(round && round.lastSentAt ? round.lastSentAt : window.from),
    });
  }

  return result.sort((a, b) => a.msisdn.localeCompare(b.msisdn));
}

async function fetchUsageDetailed(walletId, window = config.resolveWindow()) {
  const rows = await oracle.query(USAGE_DETAILED_SQL, buildBinds(walletId, window));

  return rows.map((row) => ({
    accountCode: row.ACCOUNT_CODE === null ? null : String(row.ACCOUNT_CODE),
    accountName: row.ACCOUNT_NAME || null,
    msisdn: String(row.MOBILE_NUMBER),
    currencyCode: row.CURRENCY_CODE_V || null,
    mbsUsed: Number(row.MBS_USED) || 0,
    gbsUsed: Number(row.GBS_USED) || 0,
    usageType: row.USAGE_TYPE || null,
    bundleName: row.BUNDLE_NAME || null,
  }));
}

/**
 * msisdn -> { accountCode, accountName }, cached.
 *
 * Resolved by its own query rather than by joining the CDR table, which is the
 * whole point: GSM_SERVICE_MAST holds one row per service, and a subscriber with
 * two of them would have every CDR counted twice by a join - silently doubling
 * the figure that decides whether an SMS goes out. Here the same duplication is
 * harmless, because MAX() over a GROUP BY collapses it and no usage is summed.
 *
 * Cached because this is reference data that changes on the timescale of
 * provisioning, not of a one-second poll.
 */
const accountCache = new Map(); // msisdn -> { accountCode, accountName, at }
const ACCOUNT_TTL_MS = 10 * 60 * 1000;
// Oracle rejects an IN list longer than 1000 entries.
const IN_CHUNK = 900;

async function fetchAccountInfo(msisdns) {
  const now = Date.now();
  const wanted = [...new Set(msisdns.filter(Boolean).map(String))];
  const stale = wanted.filter((m) => {
    const hit = accountCache.get(m);
    return !hit || now - hit.at > ACCOUNT_TTL_MS;
  });

  for (let i = 0; i < stale.length; i += IN_CHUNK) {
    const chunk = stale.slice(i, i + IN_CHUNK);
    const binds = {};
    const names = chunk.map((m, j) => {
      binds[`m${j}`] = m;
      return `:m${j}`;
    });

    let rows = [];
    try {
      rows = await oracle.query(
        `SELECT d.MOBL_NUM_VOICE_V        AS MSISDN,
                MAX(d.ACCOUNT_CODE_N)     AS ACCOUNT_CODE,
                MAX(e.ACCOUNT_NAME_V)     AS ACCOUNT_NAME,
                MAX(e.CURRENCY_CODE_V)    AS CURRENCY_CODE
           FROM CBS_CORE.GSM_SERVICE_MAST d
           LEFT JOIN CB_ACCOUNT_MASTER e
             ON e.ACCOUNT_CODE_N = d.ACCOUNT_CODE_N
          WHERE d.MOBL_NUM_VOICE_V IN (${names.join(', ')})
          GROUP BY d.MOBL_NUM_VOICE_V`,
        binds
      );
    } catch (err) {
      // Reporting data only. A failure here must never stop alerting, so the
      // subscribers in this chunk simply stay unresolved for now.
      logger.warn(`Could not resolve account details: ${logger.describe(err).split('\n')[0]}`);
    }

    const found = new Set();
    for (const row of rows) {
      const msisdn = String(row.MSISDN);
      found.add(msisdn);
      accountCache.set(msisdn, {
        accountCode: row.ACCOUNT_CODE === null ? null : String(row.ACCOUNT_CODE),
        accountName: row.ACCOUNT_NAME || null,
        currencyCode: row.CURRENCY_CODE || null,
        at: now,
      });
    }
    // Cache the misses too, so an MSISDN with no service-master row is not
    // looked up again on every single cycle.
    for (const msisdn of chunk) {
      if (!found.has(msisdn)) {
        accountCache.set(msisdn, {
          accountCode: null,
          accountName: null,
          currencyCode: null,
          at: now,
        });
      }
    }
  }

  const result = new Map();
  for (const msisdn of wanted) {
    const hit = accountCache.get(msisdn);
    result.set(msisdn, {
      accountCode: hit ? hit.accountCode : null,
      accountName: hit ? hit.accountName : null,
      currencyCode: hit ? hit.currencyCode : null,
    });
  }
  return result;
}

/**
 * Sanity check for one offer's wallet, run at startup and available on demand.
 *
 * A wallet with no CDRs produces a monitor that looks perfectly healthy - Oracle
 * up, no errors, quick cycles - while matching nothing and therefore never
 * alerting. This turns that silent failure into a loud one.
 *
 * Deliberately scoped to the wallet and the current window. The previous version
 * enumerated every wallet on an account to suggest alternatives; without an
 * account to scope it that same query would group the entire CDR table.
 */
async function describeWallet(walletId, window = config.resolveWindow()) {
  const rows = await oracle.query(
    `SELECT COUNT(*) AS CDRS, COUNT(DISTINCT c.SERVICE_IDENTIFIER_V) AS SUBSCRIBERS,
            TO_CHAR(MAX(c.CALL_DATE_TIME_DT), 'YYYY-MM-DD HH24:MI') AS LAST_CDR
       FROM CBS_CORE.CB_PREPAID_UPLOAD_ALL_CDRS c
      WHERE c.CALL_TYPE_V IN ('18', '001', '031')
        AND c.WALLET_ID_1_V = :walletId
        AND c.CALL_DATE_TIME_DT >= TO_DATE(:fromDt, 'SYYYY-MM-DD HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')
        AND c.CALL_DATE_TIME_DT <  TO_DATE(:toDt,   'SYYYY-MM-DD HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')`,
    buildBinds(walletId, window)
  );

  const row = rows[0] || {};
  return {
    walletId: String(walletId),
    cdrs: Number(row.CDRS || 0),
    subscribers: Number(row.SUBSCRIBERS || 0),
    lastCdr: row.LAST_CDR || null,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
  };
}

module.exports = {
  fetchUsageByMsisdn,
  fetchUsageByCycle,
  fetchUsageDetailed,
  fetchAccountInfo,
  describeWallet,
  USAGE_BY_MSISDN_SQL,
  USAGE_BY_MSISDN_DAILY_SQL,
  USAGE_DETAILED_SQL,
};
