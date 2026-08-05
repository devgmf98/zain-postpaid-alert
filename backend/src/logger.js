'use strict';

const config = require('./config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const active = LEVELS[config.logLevel] ?? LEVELS.info;

/**
 * Secrets that must never reach a log file, longest first so a value that
 * contains another is replaced whole rather than in pieces.
 *
 * Applied centrally instead of at each call site: log lines get added over time,
 * and one that interpolates a connect string or an error carrying request
 * details would otherwise write a credential to disk with nobody noticing. Logs
 * are shipped to no one, but they are read over shoulders, pasted into tickets
 * and kept for 14 days.
 */
function secrets() {
  const values = [
    [config.sms.apiKey, '<API_KEY>'],
    [config.oracle.password, '<ORACLE_PASSWORD>'],
    [config.mysql.password, '<MYSQL_PASSWORD>'],
    [config.oracle.user, '<ORACLE_USER>'],
    [config.oracle.host, '<ORACLE_HOST>'],
  ];
  return values
    .filter(([value]) => typeof value === 'string' && value.length >= 4)
    .sort((a, b) => b[0].length - a[0].length);
}

const REDACTIONS = secrets();
const maskMsisdn = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.LOG_MASK_MSISDN || '').trim().toLowerCase()
);

/**
 * Subscriber numbers are personal data, but they are also how an operator
 * follows one subscriber through a log, so this is off by default and enabled
 * with LOG_MASK_MSISDN=true.
 *
 * Deliberately anchored on the phrases that precede a number rather than on
 * "any long digit string": byte counts are the same length as an MSISDN, and a
 * blanket rule turns 27153278559 into 271***559 and destroys the diagnostics
 * this log exists for.
 */
function maskMsisdns(text) {
  return text.replace(
    /\b(to|by|for|MSISDN|msisdn)\s+(\d{3})(\d{3,})(\d{3})\b/g,
    (match, lead, head, _mid, tail) => `${lead} ${head}***${tail}`
  );
}

function redact(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const [secret, placeholder] of REDACTIONS) out = out.split(secret).join(placeholder);
  return maskMsisdn ? maskMsisdns(out) : out;
}

function emit(level, args) {
  if (LEVELS[level] > active) return;
  const stamp = new Date().toISOString();
  const line = `${stamp} [${level.toUpperCase()}]`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(line, ...args.map(redact));
}

/**
 * Renders an error with everything useful on it. Some driver errors carry an
 * empty .message, and logging that alone produces a line with no diagnosis in it.
 */
function describe(err) {
  if (!err) return String(err);
  if (!(err instanceof Error)) return typeof err === 'string' ? err : JSON.stringify(err);

  const parts = [];
  if (err.message) parts.push(err.message);
  if (err.code) parts.push(`code=${err.code}`);
  if (err.errno !== undefined) parts.push(`errno=${err.errno}`);
  if (err.errorNum !== undefined) parts.push(`oraNum=${err.errorNum}`);
  if (err.sqlState) parts.push(`sqlState=${err.sqlState}`);
  if (err.sqlMessage) parts.push(`sql=${err.sqlMessage}`);
  if (err.cause) parts.push(`cause=${describe(err.cause)}`);
  if (!parts.length) parts.push(`${err.name || 'Error'} with no message`);

  const text = parts.join(' ');
  return err.stack ? `${text}\n${err.stack}` : text;
}

module.exports = {
  describe,
  redact,
  error: (...args) => emit('error', args),
  warn: (...args) => emit('warn', args),
  info: (...args) => emit('info', args),
  debug: (...args) => emit('debug', args),
};
