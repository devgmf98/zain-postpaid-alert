'use strict';

const oracle = require('../db/oracle');
const config = require('../config');

/**
 * Bundle activations from the EDR feed.
 *
 * The supplied query with a date range added. Without one it reads the whole
 * table on every poll - which at a one-second interval is both a heavy query and
 * unbounded: an activation from last month would be treated as news the first
 * time this ran.
 *
 * The window is a single day, resolved fresh on every cycle, so it rolls over at
 * midnight on its own with nothing to reset.
 */
const ACTIVATIONS_SQL = `
SELECT a.CHRONO_NUM_V            AS CHRONO_NUM,
       a.CHARGING_PARTY_NUMBER_V AS MSISDN,
       a.ATTRIBUTE1_V            AS TARIFF_CODE,
       a.ATTRIBUTE4_V            AS ATTRIBUTE4,
       b.DETAIL_DESCRIPTION_V    AS OFFER_NAME,
       a.EVENT_DATE_TIME_DT      AS EVENT_AT
  FROM CBS_CORE.CB_PREPAID_UPLOAD_ALL_EDRS a
  JOIN CBS_CORE.CB_OFFERS b
    ON b.APPLY_TARIFF_CODE_V = a.ATTRIBUTE1_V
 WHERE b.SUB_SERVICE_CODE_V = :subServiceCode
   AND a.EVENT_DATE_TIME_DT >= TO_DATE(:fromDt, 'SYYYY-MM-DD HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')
   AND a.EVENT_DATE_TIME_DT <  TO_DATE(:toDt,   'SYYYY-MM-DD HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')
 ORDER BY a.EVENT_DATE_TIME_DT
`;

/**
 * Binds shared by both queries.
 *
 * SUB_SERVICE_CODE_V lives on CB_OFFERS, not on the EDR - it describes the offer
 * the subscriber took, so it is the offer row that says whether this is a HYBRID
 * subscription. On the UAT day this was written it cut 23 events down to 4; the
 * other 19 were PREPAID.
 */
function buildBinds(day) {
  return {
    subServiceCode: config.activation.subServiceCode,
    fromDt: formatOracleDateTime(day.from),
    toDt: formatOracleDateTime(day.to),
  };
}

/** Wall-clock string for TO_DATE - never a bound Date, which drifts by session time zone. */
function formatOracleDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Midnight-to-midnight for the day `now` falls in, plus a YYYY-MM-DD key.
 *
 * Resolved per cycle rather than held, so the run naturally covers only today
 * and starts a fresh day at 00:00 without a scheduled reset.
 */
function resolveDay(now = new Date()) {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    from,
    to,
    dayKey: `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}`,
  };
}

/**
 * Resolves the name to put in the SMS.
 *
 * CB_OFFERS does not always carry a description - some rows come back as the
 * literal string "null" - and "your data bundle of null has been activated" is
 * worse than sending nothing. ATTRIBUTE4_V sometimes holds the bundle name for
 * exactly those rows, so it is the fallback; when neither is usable the caller
 * skips the event rather than sending a sentence with a hole in it.
 */
function resolveOfferName(row) {
  const candidates = [row.OFFER_NAME, row.ATTRIBUTE4];
  for (const candidate of candidates) {
    const text = String(candidate ?? '').trim();
    if (!text) continue;
    if (text.toLowerCase() === 'null') continue;
    // ATTRIBUTE4_V is "0" on most rows - a placeholder, not a bundle name.
    if (/^0+$/.test(text)) continue;
    return config.cleanOfferName(text);
  }
  return null;
}

/**
 * One entry per activation event in the given day.
 *
 * Events whose bundle cannot be named are returned with `offerName: null` so the
 * caller can count and log them rather than having them vanish silently.
 */
async function fetchActivations(day = resolveDay()) {
  const rows = await oracle.query(ACTIVATIONS_SQL, buildBinds(day));

  return rows.map((row) => {
    const eventAt = row.EVENT_AT instanceof Date ? row.EVENT_AT : new Date(row.EVENT_AT);
    return {
      // CBS assigns this once per EDR, so it is the identity of the activation
      // and the thing that decides whether a notification already went out.
      chronoNum: String(row.CHRONO_NUM ?? '').trim(),
      msisdn: String(row.MSISDN ?? '').trim(),
      tariffCode: String(row.TARIFF_CODE ?? '').trim(),
      attribute4: row.ATTRIBUTE4 === null ? null : String(row.ATTRIBUTE4),
      offerRaw: row.OFFER_NAME === null ? null : String(row.OFFER_NAME),
      offerName: resolveOfferName(row),
      eventAt,
      dayKey: day.dayKey,
    };
  });
}

/** How many activation EDRs the day holds - a cheap health probe. */
async function countActivations(day = resolveDay()) {
  const rows = await oracle.query(
    `SELECT COUNT(*) AS N, COUNT(DISTINCT a.CHARGING_PARTY_NUMBER_V) AS SUBS,
            TO_CHAR(MAX(a.EVENT_DATE_TIME_DT), 'YYYY-MM-DD HH24:MI') AS LAST_EVENT
       FROM CBS_CORE.CB_PREPAID_UPLOAD_ALL_EDRS a
       JOIN CBS_CORE.CB_OFFERS b ON b.APPLY_TARIFF_CODE_V = a.ATTRIBUTE1_V
      WHERE b.SUB_SERVICE_CODE_V = :subServiceCode
        AND a.EVENT_DATE_TIME_DT >= TO_DATE(:fromDt, 'SYYYY-MM-DD HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')
        AND a.EVENT_DATE_TIME_DT <  TO_DATE(:toDt,   'SYYYY-MM-DD HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')`,
    buildBinds(day)
  );
  const row = rows[0] || {};
  return {
    day: day.dayKey,
    subServiceCode: config.activation.subServiceCode,
    events: Number(row.N || 0),
    subscribers: Number(row.SUBS || 0),
    lastEvent: row.LAST_EVENT || null,
  };
}

module.exports = {
  ACTIVATIONS_SQL,
  resolveDay,
  resolveOfferName,
  fetchActivations,
  countActivations,
};
