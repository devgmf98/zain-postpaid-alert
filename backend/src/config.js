'use strict';

const path = require('path');

// .env is the single source of configuration. .env.example is a template only -
// nothing reads it, and no other file is loaded.
//
// Standard dotenv precedence: a variable already in the environment wins over
// the file. That matters for containerised deploys, and for test harnesses that
// point the process at a scratch database - forcing the file to win made an
// explicit MYSQL_DATABASE override silently ineffective. The resolved values are
// logged at startup instead, which surfaces a wrong value just as clearly.
const ENV_FILE = path.resolve(__dirname, '..', '.env');
// `parsed` is what the file itself says, before dotenv's "environment wins"
// merge. Kept so PORT can be read from the file alone - see below.
const FILE_ENV = require('dotenv').config({ path: ENV_FILE }).parsed || {};

const GB = 1024 * 1024 * 1024;

function str(name, fallback = '') {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return fallback;
  return String(raw).trim();
}

function num(name, fallback) {
  const raw = str(name);
  if (raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

function bool(name, fallback) {
  const raw = str(name).toLowerCase();
  if (raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

// dotenv keeps quotes off, but templates are quoted in .env so that the "#" in
// *190# is not treated as an inline comment. Strip any quotes that survive.
function template(name, fallback) {
  const raw = str(name, fallback);
  return raw.replace(/^["']/, '').replace(/["']$/, '').trim();
}

// The MySQL block was originally supplied as DB_*; accept those as a fallback so
// an existing .env in that style keeps working.
function mysqlValue(preferred, legacy, fallback) {
  const value = str(preferred);
  if (value !== '') return value;
  const legacyValue = str(legacy);
  return legacyValue !== '' ? legacyValue : fallback;
}

/**
 * Parses "Name: value, Other-Name: value" into a header object. Accepts "=" as
 * the separator too, since that is how the values tend to be handed over.
 * Only the first separator splits, so values may contain ":" or "=".
 */
function parseHeaders(raw) {
  const headers = {};
  if (!raw) return headers;

  for (const entry of raw.split(',')) {
    const part = entry.trim();
    if (!part) continue;

    const at = part.search(/[:=]/);
    if (at === -1) {
      throw new Error(`FLOODWAVE_HEADERS entry "${part}" must be "Name: value"`);
    }
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (!name) throw new Error(`FLOODWAVE_HEADERS entry "${part}" has no header name`);
    headers[name] = value;
  }
  return headers;
}

/**
 * Threshold sizes are configured in GB, but testing wants values like 100 MB
 * that are awkward fractions of a GB. An MB variable, when set, wins over its GB
 * counterpart. 1 GB = 1024 MB, consistent with the /1024/1024/1024 in the query.
 */
function sizeInGb(mbName, gbName, fallbackGb) {
  const mb = str(mbName);
  if (mb !== '') {
    const parsed = Number(mb);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Environment variable ${mbName} must be a number, got "${mb}"`);
    }
    return parsed / 1024;
  }
  return num(gbName, fallbackGb);
}

function parseDateTime(value, label) {
  // Accepts "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DD" in server local time.
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  if (!match) {
    throw new Error(`${label} must look like "YYYY-MM-DD HH:mm:ss", got "${value}"`);
  }
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = match;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

const usageWindow = str('USAGE_WINDOW', 'MONTH').toUpperCase();
if (!['MONTH', 'DAY', 'CUSTOM'].includes(usageWindow)) {
  throw new Error(`USAGE_WINDOW must be MONTH, DAY or CUSTOM, got "${usageWindow}"`);
}

// Where the monthly counter rolls over to zero.
//   LAST_DAY  - 00:00 on the last day of the month (31 Jul 00:00, 28 Feb 00:00, ...)
//   FIRST_DAY - 00:00 on the 1st of the month
// The two differ by one full day of usage, so this is deliberately explicit.
const monthResetMode = str('MONTH_RESET', 'LAST_DAY').toUpperCase();
if (!['LAST_DAY', 'FIRST_DAY'].includes(monthResetMode)) {
  throw new Error(`MONTH_RESET must be LAST_DAY or FIRST_DAY, got "${monthResetMode}"`);
}

const config = {
  envFile: ENV_FILE,
  env: str('NODE_ENV', 'development'),
  // The port comes from .env and nowhere else. Every other setting follows the
  // usual "environment wins" precedence, but a stray PORT left in the shell is
  // the difference between reaching the service and quietly starting a second
  // one on another port, so the file is the only authority here.
  port: (() => {
    const raw = String(FILE_ENV.PORT ?? '').trim();
    if (raw === '') return 5004;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`PORT in .env must be a number, got "${raw}"`);
    }
    return parsed;
  })(),
  logLevel: str('LOG_LEVEL', 'info').toLowerCase(),

  oracle: {
    user: str('ORACLE_USER'),
    password: str('ORACLE_PASSWORD'),
    host: str('ORACLE_HOST'),
    port: num('ORACLE_PORT', 1521),
    service: str('ORACLE_SERVICE'),
    poolMin: num('ORACLE_POOL_MIN', 1),
    poolMax: num('ORACLE_POOL_MAX', 4),
    clientDir: str('ORACLE_CLIENT_DIR'),
    // Upper bound on a single CBS query. Without one, a slow database stalls the
    // polling cycle indefinitely and the monitor is alive but doing nothing.
    // 0 disables the limit.
    queryTimeoutMs: num('ORACLE_QUERY_TIMEOUT_MS', 30000),
    get connectString() {
      return `${this.host}:${this.port}/${this.service}`;
    },
  },

  mysql: {
    host: mysqlValue('MYSQL_HOST', 'DB_HOST', '127.0.0.1'),
    user: mysqlValue('MYSQL_USER', 'DB_USER', 'root'),
    password: mysqlValue('MYSQL_PASSWORD', 'DB_PASSWORD', ''),
    database: mysqlValue('MYSQL_DATABASE', 'DB_NAME', 'automations'),
    port: Number(mysqlValue('MYSQL_PORT', 'DB_PORT', '3306')),
    connectionLimit: num('MYSQL_POOL_LIMIT', 5),
    // Table names cannot be bound parameters, so these are interpolated into SQL.
    // validate() enforces plain identifiers to keep that interpolation safe.
    tables: {
      notifications: str('MYSQL_TABLE_NOTIFICATIONS', 'automation_notifications'),
      status: str('MYSQL_TABLE_STATUS', 'automation_status'),
      usage: str('MYSQL_TABLE_USAGE', 'automation_usage'),
      // One row per monitored offer: the wallet, its cap, its two thresholds and
      // the two message templates. This table - not .env - is what the monitor
      // iterates, so an offer can be added or retuned without a restart.
      offers: str('MYSQL_TABLE_OFFERS', 'offers_info'),
      admins: str('MYSQL_TABLE_ADMINS', 'admins'),
      // Bundle-activation notices, kept apart from the threshold alerts: a
      // different trigger (an EDR, not a usage total), a different message and a
      // different de-duplication rule - one SMS per activation event, so
      // re-subscribing to the same bundle is announced again.
      activations: str('MYSQL_TABLE_ACTIVATIONS', 'activation_notifications'),
    },
    // Renamed to the current notifications table on startup if still present.
    legacyTable: 'sms_notifications',
  },

  pool: {
    // Only used to seed the first row of offers_info on a fresh install. Once
    // that table has rows it is the sole source of truth and these are ignored.
    accountCode: str('ACCOUNT_CODE', ''),
    walletId: str('WALLET_ID', ''),
    offerName: str('OFFER_NAME', ''),
    // Whether that seeded row starts active. Off by default: a fresh host's
    // WALLET_ID is rarely the wallet anyone intended to monitor, and an offer
    // that goes live unreviewed either alerts nobody or alerts everybody.
    seedActive: bool('OFFER_SEED_ACTIVE', false),
    window: usageWindow,
    monthReset: monthResetMode,
    customFrom: str('CUSTOM_FROM'),
    customTo: str('CUSTOM_TO'),
  },

  thresholds: {
    capGb: sizeInGb('POOL_CAP_MB', 'POOL_CAP_GB', 10),
    sendMissed: bool('SEND_MISSED_THRESHOLDS', true),
    // Starting mid-month, a subscriber may already be deep into their cap.
    // With this on, bars they passed before the monitor ever saw them are
    // recorded as SKIPPED instead of announced late - except the most recent
    // cap crossing, which still fires because 'you have used your whole
    // allowance' remains true and actionable.
    skipPassedOnFirstSight: bool('SKIP_PASSED_ON_FIRST_SIGHT', true),
    // What to do when a subscriber clears more than one bar between polls.
    //   SEPARATE - send the lowest outstanding one now, the next on a later
    //              cycle. Every threshold still fires, but each is its own
    //              event rather than several SMS in the same second.
    //   ALL      - send every outstanding threshold immediately, in order.
    //   HIGHEST  - send only the highest; the ones jumped over are skipped.
    fireMode: (() => {
      const mode = str('THRESHOLD_FIRE', 'SEPARATE').toUpperCase();
      if (!['SEPARATE', 'ALL', 'HIGHEST'].includes(mode)) {
        throw new Error(`THRESHOLD_FIRE must be SEPARATE, ALL or HIGHEST, got "${mode}"`);
      }
      return mode;
    })(),
    // How usage is compared against a threshold.
    //   EXACT   - raw bytes. Never alerts before the data is genuinely used,
    //             but the report can show "1 GB" while the counter is a few
    //             hundred bytes short and no SMS has gone out.
    //   ROUNDED - compares the same rounded GB figure the report displays, so
    //             the alert always agrees with what operators see. Fires up to
    //             half a rounding step early (0.05 GB at 1 decimal place).
    matchMode: (() => {
      const mode = str('THRESHOLD_MATCH', 'EXACT').toUpperCase();
      if (!['EXACT', 'ROUNDED'].includes(mode)) {
        throw new Error(`THRESHOLD_MATCH must be EXACT or ROUNDED, got "${mode}"`);
      }
      return mode;
    })(),
    // Decimal places used when matchMode is ROUNDED. 1 matches the
    // ROUND(..., 1) that produces GBS_USED in the report query.
    matchDecimals: num('THRESHOLD_MATCH_DECIMALS', 1),
    // Ordered low -> high; the monitor walks them in this order.
    levels: [
      { percent: 50, gb: sizeInGb('THRESHOLD_50_MB', 'THRESHOLD_50_GB', 5) },
      { percent: 100, gb: sizeInGb('THRESHOLD_100_MB', 'THRESHOLD_100_GB', 10) },
    ],
  },

  monitor: {
    intervalMs: num('POLL_INTERVAL_MS', 1000),
    autostart: bool('MONITOR_AUTOSTART', true),
    dryRun: bool('DRY_RUN', true),
    // How often the status row is rewritten. Throttled so a one-second poll does
    // not rewrite the same row 86,400 times a day.
    statusPersistMs: num('STATUS_PERSIST_MS', 15000),
    // How often the usage rows are rewritten even when the figures have not
    // moved, so the table visibly ticks and updated_at proves it is live.
    usagePersistMs: num('USAGE_PERSIST_MS', 1000),
    // Windows only: when the HTTP port is held by the ZainDataPoolMonitor
    // service, stop it and take the port for this run, handing it back on exit.
    // Set false to make a port clash a plain failure instead.
    takeoverPort: bool('TAKEOVER_PORT', true),
  },

  sms: {
    url: str('FLOODWAVE_NOTIFY_URL'),
    clientId: str('FLOODWAVE_CLIENT_ID'),
    serviceType: str('FLOODWAVE_NOTIFY_SERVICE_TYPE', 'notification'),
    senderId: str('FLOODWAVE_SENDER_ID'),
    timeoutMs: num('FLOODWAVE_TIMEOUT_MS', 15000),
    // HTTP retries within a single delivery.
    maxAttempts: num('FLOODWAVE_MAX_ATTEMPTS', 3),
    // How many times a failing delivery is re-attempted before the alert is
    // abandoned for the month.
    maxRetryCycles: num('SMS_MAX_RETRY_CYCLES', 5),
    // A gateway 5xx/timeout is not our fault and can last hours. Those get a far
    // larger budget, so an outage does not lose the alert for the whole month.
    // A 4xx keeps the small budget - it would fail identically every time.
    maxRetryCyclesTransient: num('SMS_MAX_RETRY_CYCLES_TRANSIENT', 200),
    // Minimum wait between those re-attempts. Without this the retry budget is
    // spent in as many seconds as there are retries, because the poller runs
    // every second - a brief gateway blip would permanently lose the alert.
    retryCooldownMs: num('SMS_RETRY_COOLDOWN_MS', 300000),
    // Deliveries run on a queue so the poller never blocks on the gateway.
    // Concurrency bounds how hard the gateway is hit during a burst.
    queueConcurrency: num('SMS_QUEUE_CONCURRENCY', 2),
    queueMax: num('SMS_QUEUE_MAX', 5000),
    // Optional spacing between two messages to the SAME subscriber. Off by
    // default: an alert should go out when its threshold is reached, not be
    // held back. Only useful if a burst of completed rounds would otherwise
    // deliver several SMS at once.
    minGapMs: num('SMS_MIN_GAP_MS', 0),
    apiKey: str('FLOODWAVE_API_KEY'),
    // Header the API key is sent in.
    authHeader: str('FLOODWAVE_AUTH_HEADER', 'X-API-Key'),
    // Any further headers the gateway requires, e.g. "X-Client-ID: 29, X-Service-Type: notification"
    extraHeaders: parseHeaders(str('FLOODWAVE_HEADERS')),
    countryCode: str('SMS_COUNTRY_CODE'),
    // The gateway requires a unique reference per message and answers a repeat
    // with a bare HTTP 500. This prefixes the generated value so alerts from this
    // service are identifiable in their logs.
    referencePrefix: str('SMS_REFERENCE_PREFIX', 'ZBSS'),
    priority: num('SMS_PRIORITY', 1),
    // The gateway rejects anything longer with a 400 and
    // {"message":"Message exceeds 160 characters"} - a permanent failure, not a
    // transient one, so a too-long template silently loses every alert it
    // touches. Checked before an offer is saved and again before each send.
    maxLength: num('SMS_MAX_LENGTH', 160),
    // Words taken out of a bundle name before it reaches the customer -
    // currency codes and internal jargon that mean nothing to them. Comma
    // separated, matched whole-word and case-insensitively, so a rule removing
    // "USD" leaves "USDA" alone. In .env because this list keeps growing: it
    // began as SSP and USD, then gained Quota.
    offerNameStrip: str('SMS_OFFER_NAME_STRIP', 'SSP,USD,Quota')
      .split(',')
      .map((word) => word.trim())
      .filter(Boolean),
  },

  // Bundle-activation notices, driven by the EDR feed rather than by usage.
  activation: {
    enabled: bool('ACTIVATION_ENABLED', true),
    // Polled on its own timer, not inside the usage cycle: the two queries hit
    // different CBS tables and one being slow must not delay the other.
    intervalMs: num('ACTIVATION_POLL_INTERVAL_MS', 1000),
    // Only offers with this SUB_SERVICE_CODE_V are announced. The column is on
    // CB_OFFERS, not on the EDR: it describes the offer taken, so the offer row
    // is what says whether a subscription is HYBRID. Leaving this empty would
    // announce every subscription on the platform, so it is required.
    subServiceCode: str('ACTIVATION_SUB_SERVICE_CODE', 'HYBRID'),
    // A restart re-reads the whole of today. Events already recorded are skipped
    // by the unique key, but on the very first run of a day every activation
    // since midnight is new - and telling someone at 18:00 that their morning
    // bundle "has been activated" is both wrong and a burst of SMS. Off by
    // default: that backlog is recorded as SKIPPED instead of sent.
    announceBacklog: bool('ACTIVATION_ANNOUNCE_BACKLOG', false),
  },

  auth: {
    // Signs the bearer tokens handed out by POST /api/auth/login. Generated per
    // boot when unset, which is fine for a single instance but invalidates every
    // token on restart - set it explicitly once there is more than one process.
    secret: str('AUTH_SECRET'),
    tokenTtlMinutes: num('AUTH_TOKEN_TTL_MINUTES', 720),
    // Seeded into the admins table on first start, and only then. Changing these
    // afterwards does nothing - the stored row is the source of truth, so a
    // rotated password cannot be silently reverted by an old .env.
    defaultUsername: str('ADMIN_DEFAULT_USERNAME', 'zainadmin'),
    defaultPassword: str('ADMIN_DEFAULT_PASSWORD', 'admin@2026'),
    // Leaves every route open when false. Only useful for local debugging.
    enabled: bool('AUTH_ENABLED', true),
  },

  // Message wording, shared by every offer. `{offer}` is replaced with that
  // offer's name from offers_info, so adding an offer needs a name and nothing
  // else - there is no per-offer message to keep in step with the cap.
  //
  // Kept in .env rather than in code so the wording can be corrected without a
  // deploy, and kept out of offers_info so one reword applies everywhere at once
  // instead of having to be re-pushed for every offer.
  // Must fit SMS_MAX_LENGTH once {offer} is substituted - the gateway rejects
  // anything longer outright, so a template that overflows loses every alert.
  templates: {
    50: template(
      'SMS_TEMPLATE_50',
      'Dear Valued Customer, you have used 50% of your {offer} data bundle. ' +
        'Dial *190# to recharge and subscribe. Thank you for choosing Zain.'
    ),
    100: template(
      'SMS_TEMPLATE_100',
      'Dear Valued Customer, you have used 100% of your {offer} data bundle. ' +
        'Dial *190# to recharge and subscribe. Thank you for choosing Zain.'
    ),
    // Sent when an EDR shows a bundle was activated. {offer} is the CB_OFFERS
    // description with underscores and hyphens turned into spaces.
    activation: template(
      'SMS_TEMPLATE_ACTIVATION',
      'Dear Valued Customer, your data bundle of {offer} has been successfully ' +
        'activated. Thank you for using Zain service.'
    ),
  },

  GB,
};

// Attach the byte value for each threshold so comparisons never touch floats.
for (const level of config.thresholds.levels) {
  level.bytes = Math.round(level.gb * GB);
  level.message = config.templates[level.percent];
}

/**
 * Whether a byte count has reached a threshold, per THRESHOLD_MATCH.
 *
 * ROUNDED deliberately compares the displayed figure rather than the raw bytes,
 * so an alert never disagrees with the report an operator is reading.
 */
/**
 * The message for a threshold, with the offer's name substituted in.
 *
 * `{offer}` is the documented placeholder; the other two spellings are accepted
 * because they are what someone editing .env tends to write first, and a
 * placeholder that silently fails to substitute would send every customer the
 * literal text "{offer_name}".
 */
config.renderMessage = function renderMessage(percent, offerName) {
  const pattern = config.templates[percent] || '';
  // Cleaned the same way as an activation name, so "Postpaid Hybrid 1GB SSP"
  // reaches the customer as "Postpaid Hybrid 1GB" whichever message carries it.
  // The stored offer_name keeps its suffix; only the SMS drops it.
  return pattern.replace(
    /\{\s*(offer|offer_name|offerName)\s*\}/gi,
    config.cleanOfferName(offerName)
  );
};

/**
 * Bundle name as the customer should read it: underscores and hyphens become
 * spaces, runs of whitespace collapse, ends trimmed.
 *
 * Note this does flatten names where the hyphen was standing in for a decimal
 * point - CBS carries "Malyaan Daily 1-5GB" for what is a 1.5 GB bundle, and it
 * comes out as "1 5GB". Substituting "." instead would be wrong for every other
 * name, so the rule is applied as specified and the odd one is left visible.
 */
/**
 * One whole-word alternation built from SMS_OFFER_NAME_STRIP.
 *
 * Each word is escaped before going into the pattern - the list is operator
 * input, and an unescaped "." or "+" in it would quietly match far more than
 * intended. Compiled once rather than per name, since this runs for every
 * subscriber on every cycle.
 */
const STRIP_WORDS = config.sms.offerNameStrip.length
  ? new RegExp(
      `\\b(${config.sms.offerNameStrip
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})\\b`,
      'gi'
    )
  : // Matches nothing, so an empty list leaves names untouched rather than
    // producing a pattern that matches everywhere.
    /(?!)/g;

config.cleanOfferName = function cleanOfferName(raw) {
  const spaced = String(raw ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Currency codes and internal jargon are bookkeeping - "3 GB_USD",
  // "Postpaid_Hybrid-15GB_SSP" and "Daily_Quota_1GB" name the same things to
  // the customer as "3 GB", "Postpaid Hybrid 15GB" and "Daily 1GB". Matched on
  // word boundaries so a name merely containing those letters ("USDA") is left
  // intact. The word list comes from SMS_OFFER_NAME_STRIP.
  const stripped = spaced.replace(STRIP_WORDS, ' ').replace(/\s+/g, ' ').trim();

  // Only ever remove the token from a name - never remove the whole name. A
  // bundle called just "USD" would otherwise clean to nothing and be reported
  // as having no name at all, which is a different and much worse failure than
  // leaving one currency code in the message.
  return stripped || spaced;
};

/** The activation message for a bundle, with its name substituted in. */
config.renderActivation = function renderActivation(offerName) {
  return config.templates.activation.replace(
    /\{\s*(offer|offer_name|offerName|bundle)\s*\}/gi,
    config.cleanOfferName(offerName)
  );
};

config.hasReached = function hasReached(bytesUsed, level) {
  if (config.thresholds.matchMode === 'EXACT') return bytesUsed >= level.bytes;

  const d = config.thresholds.matchDecimals;
  const usedGb = Number((bytesUsed / GB).toFixed(d));
  const barGb = Number(level.gb.toFixed(d));
  return usedGb >= barGb;
};
config.thresholds.levels.sort((a, b) => a.bytes - b.bytes);

/**
 * 00:00 local time on the last calendar day of the given month.
 * Day 0 of the following month is the last day of this one, so February and the
 * 30/31-day months are handled without a lookup table.
 */
function lastDayMidnight(year, monthIndex) {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return new Date(year, monthIndex, lastDay, 0, 0, 0, 0);
}

/**
 * Resolves the [from, to) window the usage query accumulates over, plus the
 * period key ("YYYY-MM") used to de-duplicate SMS in MySQL.
 *
 * The window and the period key are resolved together, so when the counter
 * rolls over the de-duplication key rolls with it and every subscriber becomes
 * eligible for a fresh 50% and 100% alert.
 */
config.resolveWindow = function resolveWindow(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

  if (config.pool.window === 'MONTH' && config.pool.monthReset === 'LAST_DAY') {
    // Cycle boundaries sit at 00:00 on the last day of each month. The period is
    // named after the month its closing boundary falls in, so the cycle that
    // covers most of July is "2026-07".
    const thisMonthReset = lastDayMidnight(now.getFullYear(), now.getMonth());

    if (now.getTime() < thisMonthReset.getTime()) {
      const from = lastDayMidnight(now.getFullYear(), now.getMonth() - 1);
      return { from, to: thisMonthReset, periodKey: ym(thisMonthReset) };
    }

    const to = lastDayMidnight(now.getFullYear(), now.getMonth() + 1);
    return { from: thisMonthReset, to, periodKey: ym(to) };
  }

  if (config.pool.window === 'DAY') {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return { from, to, periodKey: `${now.getFullYear()}-${pad(now.getMonth() + 1)}` };
  }

  if (config.pool.window === 'CUSTOM') {
    const from = parseDateTime(config.pool.customFrom, 'CUSTOM_FROM');
    const to = parseDateTime(config.pool.customTo, 'CUSTOM_TO');
    // CUSTOM_TO is inclusive in the original SQL (23:59:59); the query uses "<".
    const exclusiveTo = new Date(to.getTime() + 1000);
    return {
      from,
      to: exclusiveTo,
      periodKey: `${from.getFullYear()}-${pad(from.getMonth() + 1)}`,
    };
  }

  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { from, to, periodKey: `${now.getFullYear()}-${pad(now.getMonth() + 1)}` };
};

/**
 * Fails fast at boot instead of throwing once a subscriber crosses a threshold.
 */
config.validate = function validate() {
  const problems = [];

  for (const key of ['user', 'password', 'host', 'service']) {
    if (!config.oracle[key]) problems.push(`ORACLE_${key.toUpperCase()} is required`);
  }
  if (!config.mysql.database) problems.push('MYSQL_DATABASE is required');
  for (const [role, name] of Object.entries(config.mysql.tables)) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      problems.push(`The ${role} table name must be a plain identifier, got "${name}"`);
    }
  }
  const tableNames = Object.values(config.mysql.tables);
  if (new Set(tableNames).size !== tableNames.length) {
    problems.push(
      `Every table must have a distinct name: ${tableNames.join(', ')}`
    );
  }
  // ACCOUNT_CODE is deliberately not required. The CDR query filters on
  // WALLET_ID alone - an offer is identified by its wallet - and the account
  // code is now only carried through for reporting.

  if (!config.monitor.dryRun) {
    if (!config.sms.url) problems.push('FLOODWAVE_NOTIFY_URL is required when DRY_RUN=false');
    if (!config.sms.senderId) problems.push('FLOODWAVE_SENDER_ID is required when DRY_RUN=false');
    if (!config.sms.clientId) problems.push('FLOODWAVE_CLIENT_ID is required when DRY_RUN=false');
  }

  if (config.monitor.intervalMs < 1) {
    problems.push('POLL_INTERVAL_MS must be at least 1');
  }

  if (config.activation.enabled) {
    // An empty code would drop the predicate's whole purpose and announce every
    // subscription CBS records, on every service type.
    if (!config.activation.subServiceCode) {
      problems.push(
        'ACTIVATION_SUB_SERVICE_CODE is required when ACTIVATION_ENABLED=true - ' +
          'without it every subscription on the platform would be announced'
      );
    }
    if (!config.templates.activation) {
      problems.push('SMS_TEMPLATE_ACTIVATION must not be empty when ACTIVATION_ENABLED=true');
    }
    if (config.activation.intervalMs < 1) {
      problems.push('ACTIVATION_POLL_INTERVAL_MS must be at least 1');
    }
  }
  for (const level of config.thresholds.levels) {
    if (!(level.gb > 0)) problems.push(`Threshold for ${level.percent}% must be greater than 0`);
    if (!level.message) problems.push(`SMS template for ${level.percent}% is empty`);
  }

  // Each threshold owns the band from its own value up to the next one, so the
  // levels must be strictly increasing. Equal values would leave the lower one
  // with an empty band - configured, expected by whoever set it, and never able
  // to fire. Refuse to start rather than drop a threshold silently.
  // Compared in percent order, not array order: the array is sorted by size, so
  // an inverted pair would look correctly ordered here and quietly swap which
  // message fires first.
  const byPercent = config.thresholds.levels.slice().sort((a, b) => a.percent - b.percent);
  for (let i = 1; i < byPercent.length; i += 1) {
    const lower = byPercent[i - 1];
    const higher = byPercent[i];
    if (lower.gb === higher.gb) {
      problems.push(
        `THRESHOLD_${lower.percent}_GB and THRESHOLD_${higher.percent}_GB are both ` +
          `${lower.gb} GB. The ${lower.percent}% band would be empty and it could ` +
          `never fire - set THRESHOLD_${lower.percent}_GB below THRESHOLD_${higher.percent}_GB.`
      );
    } else if (lower.gb > higher.gb) {
      problems.push(
        `THRESHOLD_${lower.percent}_GB (${lower.gb} GB) is above ` +
          `THRESHOLD_${higher.percent}_GB (${higher.gb} GB) - thresholds must increase.`
      );
    }
  }
  if (config.pool.window === 'CUSTOM') {
    try {
      config.resolveWindow();
    } catch (err) {
      problems.push(err.message);
    }
  }

  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
};

module.exports = config;
