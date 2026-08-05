-- MySQL schema for the data-pool automation.
--
-- The server applies all of this automatically on startup (CREATE DATABASE and
-- CREATE TABLE IF NOT EXISTS), so running this by hand is optional - it is kept
-- here for DBA review and for provisioning the database ahead of first run.

CREATE DATABASE IF NOT EXISTS `automations`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE `automations`;

-- ---------------------------------------------------------------------------
-- Alerts that have been sent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automation_notifications (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  msisdn            VARCHAR(32)     NOT NULL COMMENT 'SERVICE_IDENTIFIER_V from the CDR',
  account_code      VARCHAR(32)     NULL,
  account_name      VARCHAR(255)    NULL,
  threshold_percent TINYINT UNSIGNED NOT NULL COMMENT '50 or 100',
  threshold_gb      DECIMAL(10,2)   NOT NULL,
  gbs_used          DECIMAL(14,3)   NOT NULL,
  bytes_used        BIGINT UNSIGNED NOT NULL,
  period_ym         CHAR(7)         NOT NULL COMMENT 'YYYY-MM - one alert per threshold per cycle',
  message           TEXT            NOT NULL,
  status            ENUM('PENDING','SENT','FAILED') NOT NULL DEFAULT 'PENDING',
  attempts          INT UNSIGNED    NOT NULL DEFAULT 0,
  gateway_response  TEXT            NULL,
  error_message     TEXT            NULL,
  created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  sent_at           DATETIME        NULL,
  PRIMARY KEY (id),
  -- This is the rule "each MSISDN gets the 50% SMS once and the 100% SMS once
  -- per cycle" - the database enforces it, not application logic.
  UNIQUE KEY uk_msisdn_threshold_period (msisdn, threshold_percent, period_ym),
  KEY idx_period (period_ym),
  KEY idx_status (status),
  KEY idx_msisdn (msisdn)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Live health and counters for the poller. One row per service instance.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automation_status (
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

-- ---------------------------------------------------------------------------
-- Latest usage per subscriber per cycle - a local mirror of the CBS query, so
-- the web app can read usage without touching Oracle.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automation_usage (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  msisdn            VARCHAR(32)     NOT NULL,
  period_ym         CHAR(7)         NOT NULL,
  account_code      VARCHAR(32)     NULL,
  account_name      VARCHAR(255)    NULL,
  currency_code     VARCHAR(16)     NULL,
  bytes_used        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  mbs_used          DECIMAL(16,2)   NOT NULL DEFAULT 0,
  gbs_used          DECIMAL(14,3)   NOT NULL DEFAULT 0,
  percent_of_cap    DECIMAL(8,2)    NOT NULL DEFAULT 0,
  thresholds_crossed VARCHAR(32)    NULL COMMENT 'e.g. "50" or "50,100"',
  window_from       DATETIME        NULL,
  window_to         DATETIME        NULL,
  first_seen_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_msisdn_period (msisdn, period_ym),
  KEY idx_period (period_ym),
  KEY idx_bytes (bytes_used)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Handy queries for the web app --------------------------------------------

-- Is the automation alive?
-- SELECT service_name, running, cycles, subscribers_seen, sms_sent, sms_failed,
--        last_cycle_at, last_error
--   FROM automation_status;

-- Current usage leaderboard for this cycle
-- SELECT msisdn, mbs_used, gbs_used, percent_of_cap, thresholds_crossed, updated_at
--   FROM automation_usage
--  WHERE period_ym = DATE_FORMAT(CURDATE(), '%Y-%m')
--  ORDER BY bytes_used DESC;

-- Alerts sent this cycle
-- SELECT msisdn, threshold_percent, gbs_used, status, sent_at
--   FROM automation_notifications
--  WHERE period_ym = DATE_FORMAT(CURDATE(), '%Y-%m')
--  ORDER BY sent_at DESC;

-- Subscribers who received both alerts this cycle
-- SELECT msisdn, COUNT(*) AS alerts FROM automation_notifications
--  WHERE period_ym = DATE_FORMAT(CURDATE(), '%Y-%m') AND status = 'SENT'
--  GROUP BY msisdn HAVING alerts = 2;

-- Re-open a failed alert for another try
-- UPDATE automation_notifications SET status='PENDING', attempts=0
--  WHERE msisdn='912107968' AND threshold_percent=50 AND period_ym='2026-07';
