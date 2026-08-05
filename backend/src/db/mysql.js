'use strict';

const mysql = require('mysql2/promise');
const config = require('../config');
const logger = require('../logger');

let pool = null;

const TABLES = config.mysql.tables;

/**
 * Alerts that have been sent. The unique key is the once-per-cycle rule:
 * one 50% and one 100% SMS per subscriber per period.
 */
const SCHEMA_NOTIFICATIONS = `
CREATE TABLE IF NOT EXISTS \`${TABLES.notifications}\` (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  msisdn            VARCHAR(32)     NOT NULL COMMENT 'SERVICE_IDENTIFIER_V from the CDR',
  account_code      VARCHAR(32)     NOT NULL DEFAULT '',
  wallet_id         VARCHAR(32)     NOT NULL DEFAULT '' COMMENT 'pool the usage was measured against',
  account_name      VARCHAR(255)    NULL,
  threshold_percent TINYINT UNSIGNED NOT NULL COMMENT '50 or 100',
  threshold_gb      DECIMAL(10,2)   NOT NULL,
  gbs_used          DECIMAL(14,3)   NOT NULL,
  bytes_used        BIGINT UNSIGNED NOT NULL,
  period_ym         CHAR(7)         NOT NULL COMMENT 'YYYY-MM - resets monthly',
  cycle_start       DATE            NOT NULL COMMENT 'day this round began (informational)',
  round_no          INT UNSIGNED    NOT NULL DEFAULT 1 COMMENT 'which pass through the cap; increments after each 100% alert',
  period_bytes_used BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'cumulative period usage at alert time; the next round counts from here',
  message           TEXT            NOT NULL,
  status            ENUM('PENDING','SENT','FAILED','SKIPPED') NOT NULL DEFAULT 'PENDING',
  attempts          INT UNSIGNED    NOT NULL DEFAULT 0,
  retryable         TINYINT(1)      NOT NULL DEFAULT 1 COMMENT 'last failure was transient (5xx/timeout), not a bad request',
  gateway_response  TEXT            NULL,
  error_message     TEXT            NULL,
  created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  sent_at           DATETIME        NULL,
  PRIMARY KEY (id),
  -- Scoped to the pool. The cap is an allowance of the account+wallet, so a
  -- subscriber active in two pools consumes each one separately and is entitled
  -- to the 50% / 100% alert for each. Within one pool they still get each alert
  -- exactly once per period.
  -- Keyed on the round number, not the date: a subscriber who re-subscribes and
  -- burns the cap again the same day starts a new round immediately, so two
  -- rounds can share a calendar day.
  UNIQUE KEY uk_pool_msisdn_threshold_round (account_code, wallet_id, msisdn, threshold_percent, period_ym, round_no),
  KEY idx_period (period_ym),
  KEY idx_status (status),
  KEY idx_msisdn (msisdn),
  KEY idx_pool (account_code, wallet_id, period_ym)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

/**
 * Live health and counters for the poller. One row per service instance, so
 * anything outside this process can see whether the automation is alive.
 */
const SCHEMA_STATUS = `
CREATE TABLE IF NOT EXISTS \`${TABLES.status}\` (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_name      VARCHAR(64)     NOT NULL,
  running           TINYINT(1)      NOT NULL DEFAULT 0,
  dry_run           TINYINT(1)      NOT NULL DEFAULT 1,
  account_code      VARCHAR(32)     NULL,
  wallet_id         VARCHAR(32)     NULL,
  period_ym         CHAR(7)         NULL,
  window_from       DATETIME        NULL,
  window_to         DATETIME        NULL,
  cap_gb            DECIMAL(10,3)   NULL,
  poll_interval_ms  INT UNSIGNED    NULL,
  cycles            BIGINT UNSIGNED NOT NULL DEFAULT 0,
  subscribers_seen  INT UNSIGNED    NOT NULL DEFAULT 0,
  sms_sent          INT UNSIGNED    NOT NULL DEFAULT 0,
  sms_failed        INT UNSIGNED    NOT NULL DEFAULT 0,
  last_cycle_at     DATETIME        NULL,
  last_cycle_ms     INT UNSIGNED    NULL,
  last_alert_at     DATETIME        NULL,
  last_error        TEXT            NULL,
  last_error_at     DATETIME        NULL,
  consecutive_errors INT UNSIGNED   NOT NULL DEFAULT 0,
  started_at        DATETIME        NULL,
  updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_service (service_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

/**
 * Latest known usage per subscriber per cycle - a local mirror of what the CBS
 * query returns, so reports and dashboards do not have to hit Oracle.
 */
const SCHEMA_USAGE = `
CREATE TABLE IF NOT EXISTS \`${TABLES.usage}\` (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  msisdn            VARCHAR(32)     NOT NULL,
  period_ym         CHAR(7)         NOT NULL,
  account_code      VARCHAR(32)     NOT NULL DEFAULT '',
  wallet_id         VARCHAR(32)     NOT NULL DEFAULT '' COMMENT 'pool this usage belongs to',
  account_name      VARCHAR(255)    NULL,
  currency_code     VARCHAR(16)     NULL,
  bytes_used        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  mbs_used          DECIMAL(16,2)   NOT NULL DEFAULT 0,
  gbs_used          DECIMAL(14,3)   NOT NULL DEFAULT 0,
  percent_of_cap    DECIMAL(8,2)    NOT NULL DEFAULT 0,
  thresholds_crossed VARCHAR(32)    NULL COMMENT 'e.g. "50" or "50,100"',
  round_no          INT UNSIGNED    NOT NULL DEFAULT 1 COMMENT 'round currently in progress',
  period_bytes_used BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'cumulative usage this period, across all rounds',
  window_from       DATETIME        NULL,
  window_to         DATETIME        NULL,
  first_seen_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_pool_msisdn_period (account_code, wallet_id, msisdn, period_ym),
  KEY idx_period (period_ym),
  KEY idx_bytes (bytes_used),
  KEY idx_pool (account_code, wallet_id, period_ym)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

/**
 * The offers the monitor watches. One row per wallet.
 *
 * This table, not .env, is what a polling cycle iterates: the cap and both
 * thresholds are read from here every cycle, so an offer can be added or retuned
 * through the API without a restart.
 *
 * The message text is deliberately NOT stored here. Both SMS are rendered from
 * the shared patterns in .env with offer_name substituted in, so a reword is one
 * change in one place rather than an UPDATE against every offer - and no offer
 * can drift into announcing a cap it no longer has.
 */
const SCHEMA_OFFERS = `
CREATE TABLE IF NOT EXISTS \`${TABLES.offers}\` (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  wallet_id         VARCHAR(32)     NOT NULL COMMENT 'WALLET_ID_1_V in the CDRs - the offer identity',
  offer_name        VARCHAR(128)    NOT NULL COMMENT 'substituted into {offer} in both SMS templates',
  pool_cap_gb       DECIMAL(10,3)   NOT NULL COMMENT 'one round; the counter restarts after each 100%',
  threshold_50_gb   DECIMAL(10,3)   NOT NULL,
  threshold_100_gb  DECIMAL(10,3)   NOT NULL,
  active            TINYINT(1)      NOT NULL DEFAULT 1 COMMENT 'inactive offers are skipped by the poller',
  created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- One offer per wallet. A second row for the same wallet would double every
  -- alert for its subscribers, so this is enforced rather than merely expected.
  UNIQUE KEY uk_offer_wallet (wallet_id),
  KEY idx_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

/**
 * Bundle-activation notices, one row per activation event.
 *
 * The unique key is chrono_num - CHRONO_NUM_V, the EDR's own identifier, which
 * CBS assigns once per record. Keying on the event rather than on the bundle is
 * what makes re-subscribing announce again: a second subscription is a second
 * EDR with its own chrono number, so it is a new row and a new SMS. Keying on
 * (msisdn, bundle) instead would silence every repeat.
 */
const SCHEMA_ACTIVATIONS = `
CREATE TABLE IF NOT EXISTS \`${TABLES.activations}\` (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  chrono_num        VARCHAR(64)     NOT NULL COMMENT 'CHRONO_NUM_V - one EDR, one notification',
  msisdn            VARCHAR(32)     NOT NULL COMMENT 'CHARGING_PARTY_NUMBER_V',
  tariff_code       VARCHAR(64)     NOT NULL DEFAULT '' COMMENT 'ATTRIBUTE1_V, joined to CB_OFFERS',
  attribute4        VARCHAR(255)    NULL COMMENT 'ATTRIBUTE4_V as it appeared in the EDR',
  offer_raw         VARCHAR(255)    NULL COMMENT 'DETAIL_DESCRIPTION_V exactly as stored in CBS',
  offer_name        VARCHAR(255)    NOT NULL COMMENT 'as sent to the customer: _ and - replaced by spaces',
  event_at          DATETIME        NOT NULL COMMENT 'EVENT_DATE_TIME_DT',
  event_day         DATE            NOT NULL COMMENT 'the day this run covers',
  message           TEXT            NOT NULL,
  status            ENUM('PENDING','SENT','FAILED','SKIPPED') NOT NULL DEFAULT 'PENDING',
  attempts          INT UNSIGNED    NOT NULL DEFAULT 0,
  retryable         TINYINT(1)      NOT NULL DEFAULT 1,
  gateway_response  TEXT            NULL,
  error_message     TEXT            NULL,
  created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  sent_at           DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_activation_chrono (chrono_num),
  KEY idx_day (event_day),
  KEY idx_status (status),
  KEY idx_msisdn (msisdn),
  KEY idx_event (event_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

/** API credentials. Passwords are scrypt hashes; nothing here is reversible. */
const SCHEMA_ADMINS = `
CREATE TABLE IF NOT EXISTS \`${TABLES.admins}\` (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(64)     NOT NULL,
  password_hash VARCHAR(255)    NOT NULL COMMENT 'scrypt$N$r$p$salt$hash',
  active        TINYINT(1)      NOT NULL DEFAULT 1,
  last_login_at DATETIME        NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_admin_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

/**
 * Creates the database if it is missing, then opens the pool and applies schemas.
 */
async function init() {
  if (pool) return pool;

  const { host, port, user, password, database, connectionLimit } = config.mysql;

  const bootstrap = await mysql.createConnection({ host, port, user, password });
  try {
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await bootstrap.end();
  }

  pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit,
    queueLimit: 0,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'local',
  });

  await migrateLegacyTable(database);
  await pool.query(SCHEMA_NOTIFICATIONS);
  await pool.query(SCHEMA_STATUS);
  await pool.query(SCHEMA_USAGE);
  await pool.query(SCHEMA_OFFERS);
  await pool.query(SCHEMA_ADMINS);
  await pool.query(SCHEMA_ACTIVATIONS);
  await migratePoolScoping(database);
  await migrateSkippedStatus(database);
  await migrateWalletScoping(database);
  await migrateOfferTemplates(database);

  logger.info(
    `MySQL pool ready -> ${host}:${port}/${database} ` +
      `(${Object.values(TABLES).join(', ')})`
  );
  return pool;
}

/**
 * The alerts table was originally called sms_notifications. If that one is still
 * present and the current one is not, rename it so previously recorded alerts
 * survive - losing them would let already-notified subscribers be alerted again.
 */
async function migrateLegacyTable(database) {
  const legacy = config.mysql.legacyTable;
  if (!legacy || legacy === TABLES.notifications) return;

  const [rows] = await pool.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?, ?)`,
    [database, legacy, TABLES.notifications]
  );

  const present = new Set(rows.map((r) => r.TABLE_NAME));
  if (present.has(legacy) && !present.has(TABLES.notifications)) {
    await pool.query(`RENAME TABLE \`${legacy}\` TO \`${TABLES.notifications}\``);
    logger.info(
      `Renamed ${legacy} -> ${TABLES.notifications}, existing alert history preserved`
    );
  }
}

async function hasColumn(database, table, column) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [database, table, column]
  );
  return rows.length > 0;
}

async function hasIndex(database, table, indexName) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [database, table, indexName]
  );
  return rows.length > 0;
}

/**
 * Brings tables created before pool scoping up to date: adds wallet_id and
 * replaces the unique keys with pool-scoped ones.
 *
 * Without wallet_id these tables cannot tell one pool from another - usage rows
 * from a previous wallet linger indistinguishably, and worse, an alert already
 * sent for a subscriber under one wallet would suppress that subscriber's alert
 * under a different wallet. Idempotent: safe to run on every startup.
 */
/**
 * Adds SKIPPED to the status enum on tables created before it existed.
 *
 * CREATE TABLE IF NOT EXISTS leaves an existing table alone, so a deployment
 * that has been running keeps the old three-value enum and every attempt to
 * record a skipped threshold fails with a truncation error.
 */
async function migrateSkippedStatus(database) {
  const [rows] = await pool.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = 'status'`,
    [database, TABLES.notifications]
  );
  if (!rows.length || String(rows[0].COLUMN_TYPE).includes("'SKIPPED'")) return;

  await pool.query(
    `ALTER TABLE \`${TABLES.notifications}\`
       MODIFY status ENUM('PENDING','SENT','FAILED','SKIPPED') NOT NULL DEFAULT 'PENDING'`
  );
  logger.info(`${TABLES.notifications}: status enum extended with SKIPPED`);
}

async function migratePoolScoping(database) {
  const work = [
    {
      table: TABLES.notifications,
      oldKey: 'uk_pool_msisdn_threshold_cycle',
      newKey: 'uk_pool_msisdn_threshold_round',
      newKeyCols: '(account_code, wallet_id, msisdn, threshold_percent, period_ym, round_no)',
      supersededBy: 'uk_offer_msisdn_threshold_round',
    },
    {
      table: TABLES.usage,
      oldKey: 'uk_msisdn_period',
      newKey: 'uk_pool_msisdn_period',
      newKeyCols: '(account_code, wallet_id, msisdn, period_ym)',
      supersededBy: 'uk_offer_msisdn_period',
    },
  ];

  for (const { table, oldKey, newKey, newKeyCols, supersededBy } of work) {
    if (!(await hasColumn(database, table, 'wallet_id'))) {
      await pool.query(
        `ALTER TABLE \`${table}\`
           ADD COLUMN wallet_id VARCHAR(32) NOT NULL DEFAULT '' AFTER account_code`
      );
      // Existing rows predate scoping. They can only have come from the pool
      // configured now, so stamp them with it rather than leaving them blank.
      const [res] = await pool.query(
        `UPDATE \`${table}\` SET wallet_id = ?
          WHERE wallet_id = '' AND account_code = ?`,
        [config.pool.walletId, config.pool.accountCode]
      );
      logger.info(
        `${table}: added wallet_id, stamped ${res.affectedRows} existing row(s) ` +
          `with wallet ${config.pool.walletId}`
      );
    }

    // account_code takes part in the key, so it cannot stay nullable.
    await pool.query(
      `UPDATE \`${table}\` SET account_code = '' WHERE account_code IS NULL`
    );
    await pool.query(
      `ALTER TABLE \`${table}\` MODIFY account_code VARCHAR(32) NOT NULL DEFAULT ''`
    );

    // Tables created before rolling cap rounds need this column, and it takes
    // part in the unique key below, so it must exist first. Existing rows
    // predate rounds and are backfilled to the start of their own month.
    if (table === TABLES.notifications && !(await hasColumn(database, table, 'cycle_start'))) {
      await pool.query(
        `ALTER TABLE \`${table}\` ADD COLUMN cycle_start DATE NULL AFTER period_ym`
      );
      const [res] = await pool.query(
        `UPDATE \`${table}\`
            SET cycle_start = STR_TO_DATE(CONCAT(period_ym, '-01'), '%Y-%m-%d')
          WHERE cycle_start IS NULL`
      );
      await pool.query(`ALTER TABLE \`${table}\` MODIFY cycle_start DATE NOT NULL`);
      logger.info(
        `${table}: added cycle_start, backfilled ${res.affectedRows} existing row(s) ` +
          'to the start of their period'
      );
    }

    // Rounds are keyed by number rather than date, so a subscriber who
    // re-subscribes and burns the cap again the same day starts a new round at
    // once. Existing rows are all round 1.
    if (table === TABLES.notifications && !(await hasColumn(database, table, 'round_no'))) {
      await pool.query(
        `ALTER TABLE \`${table}\`
           ADD COLUMN round_no INT UNSIGNED NOT NULL DEFAULT 1 AFTER cycle_start,
           ADD COLUMN period_bytes_used BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER round_no`
      );
      logger.info(`${table}: added round_no and period_bytes_used`);
    }

    // The usage mirror carries the round in progress, so the live state is
    // visible in the table rather than only through the API.
    if (table === TABLES.usage && !(await hasColumn(database, table, 'round_no'))) {
      await pool.query(
        `ALTER TABLE \`${table}\`
           ADD COLUMN round_no INT UNSIGNED NOT NULL DEFAULT 1,
           ADD COLUMN period_bytes_used BIGINT UNSIGNED NOT NULL DEFAULT 0`
      );
      logger.info(`${table}: added round_no and period_bytes_used`);
    }

    // Tables created before transient-failure tracking need this column.
    if (table === TABLES.notifications && !(await hasColumn(database, table, 'retryable'))) {
      await pool.query(
        `ALTER TABLE \`${table}\` ADD COLUMN retryable TINYINT(1) NOT NULL DEFAULT 1 AFTER attempts`
      );
      logger.info(`${table}: added retryable column`);
    }

    // Skip once the wallet-scoped key has taken over. Without this check the two
    // migrations undo each other on every boot: this one re-adds the
    // account-scoped key that migrateWalletScoping has just dropped, leaving the
    // table carrying both.
    if (await hasIndex(database, table, supersededBy)) continue;

    if (!(await hasIndex(database, table, newKey))) {
      if (await hasIndex(database, table, oldKey)) {
        await pool.query(`ALTER TABLE \`${table}\` DROP INDEX \`${oldKey}\``);
      }
      await pool.query(`ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${newKey}\` ${newKeyCols}`);
      logger.info(`${table}: unique key is now ${newKeyCols}`);
    }
  }
}

/**
 * Narrows the de-duplication keys from account+wallet scope to wallet scope.
 *
 * An offer is now identified by its wallet alone - the CDR query no longer
 * filters on ACCOUNT_CODE - so account_code must leave the unique key. Left in,
 * it would split one subscriber's alert history the moment their account code
 * resolved differently (or not at all, now that the lookup join is gone), and a
 * split history means the same threshold can be announced twice.
 *
 * Idempotent: does nothing once the wallet-scoped key is present.
 */
async function migrateWalletScoping(database) {
  const work = [
    {
      table: TABLES.notifications,
      oldKey: 'uk_pool_msisdn_threshold_round',
      newKey: 'uk_offer_msisdn_threshold_round',
      cols: ['wallet_id', 'msisdn', 'threshold_percent', 'period_ym', 'round_no'],
    },
    {
      table: TABLES.usage,
      oldKey: 'uk_pool_msisdn_period',
      newKey: 'uk_offer_msisdn_period',
      cols: ['wallet_id', 'msisdn', 'period_ym'],
    },
  ];

  for (const { table, oldKey, newKey, cols } of work) {
    if (await hasIndex(database, table, newKey)) {
      // Self-healing: an earlier build let migratePoolScoping re-add the
      // account-scoped key alongside this one. Harmless for correctness - the
      // wallet-scoped key is the stricter of the two - but it is dead weight on
      // every write, so clear it out if it is still there.
      if (await hasIndex(database, table, oldKey)) {
        await pool.query(`ALTER TABLE \`${table}\` DROP INDEX \`${oldKey}\``);
        logger.info(`${table}: dropped the superseded account-scoped key ${oldKey}`);
      }
      continue;
    }

    // Dropping account_code merges rows that differed only by it. Find any such
    // pair before touching the index: a failed ALTER would leave the table with
    // no unique key at all, and that key is the whole duplicate-SMS guarantee.
    const list = cols.join(', ');
    const [collisions] = await pool.query(
      `SELECT ${list}, COUNT(*) AS n FROM \`${table}\`
        GROUP BY ${list} HAVING n > 1`
    );
    if (collisions.length) {
      const sample = collisions
        .slice(0, 5)
        .map((row) => cols.map((c) => row[c]).join('/'))
        .join('; ');
      throw new Error(
        `${table}: ${collisions.length} group(s) of rows differ only by account_code ` +
          `and would collide under ${newKey} (${sample}). Merge or delete them and ` +
          'restart. Starting without this key would let one subscriber be alerted ' +
          'twice for the same threshold.'
      );
    }

    if (await hasIndex(database, table, oldKey)) {
      await pool.query(`ALTER TABLE \`${table}\` DROP INDEX \`${oldKey}\``);
    }
    await pool.query(`ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${newKey}\` (${list})`);
    logger.info(`${table}: de-duplication key is now wallet-scoped (${list})`);
  }
}

/**
 * Drops the per-offer message columns and makes offer_name mandatory.
 *
 * Message text moved out of this table and into the shared .env patterns, where
 * `{offer}` is replaced with offer_name. An offer therefore cannot exist without
 * a name any more - it is what the customer reads in the SMS - so any row that
 * predates the rule is backfilled from its wallet id rather than being rejected.
 */
async function migrateOfferTemplates(database) {
  if (await hasColumn(database, TABLES.offers, 'sms_template_50')) {
    await pool.query(
      `ALTER TABLE \`${TABLES.offers}\`
         DROP COLUMN sms_template_50,
         DROP COLUMN sms_template_100`
    );
    logger.info(
      `${TABLES.offers}: dropped the per-offer message columns - both SMS are now ` +
        'rendered from SMS_TEMPLATE_50 / SMS_TEMPLATE_100 with {offer} substituted'
    );
  }

  const [nameCol] = await pool.query(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = 'offer_name'`,
    [database, TABLES.offers]
  );
  if (nameCol.length && nameCol[0].IS_NULLABLE === 'YES') {
    const [res] = await pool.query(
      `UPDATE \`${TABLES.offers}\`
          SET offer_name = CONCAT('Wallet ', wallet_id)
        WHERE offer_name IS NULL OR offer_name = ''`
    );
    await pool.query(
      `ALTER TABLE \`${TABLES.offers}\` MODIFY offer_name VARCHAR(128) NOT NULL`
    );
    logger.info(
      `${TABLES.offers}: offer_name is now required` +
        (res.affectedRows ? `, backfilled ${res.affectedRows} unnamed offer(s)` : '')
    );
  }
}

function getPool() {
  if (!pool) throw new Error('MySQL pool has not been initialised - call init() first');
  return pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

/**
 * Non-prepared variant, for statements whose placeholder count varies between
 * calls (the bulk usage upsert). Using execute() there would mint a new prepared
 * statement for every distinct batch size.
 */
async function queryRaw(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

async function ping() {
  const rows = await query('SELECT 1 AS ok');
  return rows.length === 1;
}

async function close() {
  if (!pool) return;
  try {
    await pool.end();
    logger.info('MySQL pool closed');
  } catch (err) {
    logger.warn('Error while closing the MySQL pool:', err.message);
  } finally {
    pool = null;
  }
}

module.exports = { init, query, queryRaw, getPool, ping, close, TABLES };
