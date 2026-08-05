'use strict';

const oracledb = require('oracledb');
const config = require('../config');
const logger = require('../logger');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsString = [oracledb.CLOB];

if (config.oracle.clientDir) {
  // Thick mode - only needed for Oracle databases older than 12.1.
  oracledb.initOracleClient({ libDir: config.oracle.clientDir });
  logger.info(`Oracle client initialised in thick mode from ${config.oracle.clientDir}`);
}

let pool = null;

async function init() {
  if (pool) return pool;

  // Assign only on success. Leaving a half-created pool behind would make every
  // later query believe it is connected and skip the retry path.
  pool = await createPoolOrThrow();
  logger.info(`Oracle pool ready -> ${config.oracle.connectString} as ${config.oracle.user}`);
  return pool;
}

async function createPoolOrThrow() {
  return oracledb.createPool({
    user: config.oracle.user,
    password: config.oracle.password,
    connectString: config.oracle.connectString,
    poolMin: config.oracle.poolMin,
    poolMax: config.oracle.poolMax,
    poolIncrement: 1,
    queueTimeout: 30000,
  });
}

/**
 * Runs a read-only query and returns plain row objects.
 */
async function query(sql, binds = {}, options = {}) {
  if (!pool) await init();

  let connection;
  try {
    connection = await pool.getConnection();

    // Without this a slow query has no upper bound: the driver waits for CBS
    // indefinitely, the polling cycle never returns, and the monitor looks alive
    // while doing nothing. A timeout turns that into an error the cycle can
    // report and retry. options.timeoutMs overrides it for a deliberately
    // long-running diagnostic; 0 disables it.
    const timeoutMs = options.timeoutMs ?? config.oracle.queryTimeoutMs;
    if (timeoutMs > 0) connection.callTimeout = timeoutMs;

    const { timeoutMs: _ignored, ...execOptions } = options;
    const result = await connection.execute(sql, binds, execOptions);
    return result.rows || [];
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        logger.warn('Failed to return an Oracle connection to the pool:', err.message);
      }
    }
  }
}

async function ping() {
  const rows = await query('SELECT 1 AS OK FROM DUAL');
  return rows.length === 1;
}

async function close() {
  if (!pool) return;
  try {
    await pool.close(10);
    logger.info('Oracle pool closed');
  } catch (err) {
    logger.warn('Error while closing the Oracle pool:', err.message);
  } finally {
    pool = null;
  }
}

module.exports = { init, query, ping, close };
