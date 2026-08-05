'use strict';

const config = require('../config');
const logger = require('../logger');

/**
 * SERVICE_IDENTIFIER_V is stored in local format (e.g. 912107968). Set
 * SMS_COUNTRY_CODE if the gateway expects it in international format.
 */
function normalizeMsisdn(raw) {
  let msisdn = String(raw ?? '').trim().replace(/[^\d+]/g, '');
  if (msisdn.startsWith('+')) msisdn = msisdn.slice(1);

  const cc = config.sms.countryCode;
  if (!cc) return msisdn;
  if (msisdn.startsWith(cc)) return msisdn;

  return cc + msisdn.replace(/^0+/, '');
}

// Monotonic counter so two sends in the same millisecond still differ.
let referenceSeq = 0;

/**
 * Builds a reference that has never been used before.
 *
 * The gateway requires this to be unique and answers a repeat with a bare HTTP
 * 500 rather than a duplicate error, which is indistinguishable from an outage.
 * Every send - including each retry of the same alert - therefore gets a fresh
 * value; de-duplication is guaranteed by our own MySQL unique key, not by this.
 */
function buildReference(msisdn) {
  referenceSeq = (referenceSeq + 1) % 1000000;
  const stamp = Date.now().toString(36);
  const seq = referenceSeq.toString(36);
  return `${config.sms.referencePrefix}-${msisdn}-${stamp}${seq}`;
}

/**
 * Body for the Floodwave notify endpoint. The client and service identifiers
 * travel as headers, so the body carries the message, a unique reference and a
 * priority. If the gateway expects different keys, this is the only function to
 * change.
 */
function buildPayload(msisdn, message, reference = buildReference(msisdn)) {
  let body = String(message || '');
  if (body.length > config.sms.maxLength) {
    logger.warn(
      `SMS message to ${msisdn} exceeds ${config.sms.maxLength} chars; truncating ` +
        `${body.length} -> ${config.sms.maxLength}`
    );
    body = body.slice(0, config.sms.maxLength);
  }

  return {
    msisdn,
    message: body,
    sender_id: config.sms.senderId,
    reference,
    priority: config.sms.priority,
  };
}

function buildHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...config.sms.extraHeaders,
  };
  if (config.sms.apiKey) {
    headers[config.sms.authHeader] = config.sms.apiKey;
  }
  return headers;
}

/** Same headers, with the key masked - safe to log. */
function describeHeaders() {
  const headers = buildHeaders();
  if (headers[config.sms.authHeader]) {
    const key = headers[config.sms.authHeader];
    headers[config.sms.authHeader] = `${key.slice(0, 6)}...${key.slice(-4)} (${key.length} chars)`;
  }
  return headers;
}

// send sms 
async function postOnce(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.sms.timeoutMs);

  try {
    const response = await fetch(config.sms.url, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }

    if (!response.ok) {
      const error = new Error(`Floodwave responded ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }

    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Node's fetch reports connection problems as a bare "fetch failed" and hides the
 * real reason in err.cause, which is useless when diagnosing a gateway outage.
 */
function describeError(err) {
  if (err.name === 'AbortError') return `timeout after ${config.sms.timeoutMs} ms`;

  const parts = [err.message];
  const cause = err.cause;
  if (cause) {
    const detail = [cause.code, cause.message].filter(Boolean).join(' ');
    if (detail && !err.message.includes(detail)) parts.push(detail);
  }
  if (err.body !== undefined && err.body !== null) {
    parts.push(typeof err.body === 'string' ? err.body : JSON.stringify(err.body));
  }
  return parts.join(' :: ');
}

/**
 * Sends one SMS, retrying transient gateway failures with a linear backoff.
 * Resolves with { success, attempts, response|error } - it never throws, so a
 * gateway outage cannot take the polling loop down.
 */
async function sendSms(rawMsisdn, message) {
  const msisdn = normalizeMsisdn(rawMsisdn);

  // The gateway answers an over-long message with a 400 every single time, so
  // sending it is three wasted round trips and, worse, three attempts off a
  // retry budget that then abandons the alert for the month. Fail it here and
  // say exactly how far over it is.
  const limit = config.sms.maxLength;
  if (limit > 0 && String(message).length > limit) {
    const detail =
      `Message is ${String(message).length} characters, ${String(message).length - limit} ` +
      `over the ${limit} the gateway accepts. Shorten SMS_TEMPLATE_* or the offer name.`;
    logger.error(`SMS to ${msisdn} not attempted: ${detail}`);
    return {
      success: false,
      attempts: 0,
      // Permanent: retrying an identical message cannot start working.
      retryable: false,
      status: null,
      error: detail,
      errorBody: null,
    };
  }

  if (config.monitor.dryRun) {
    logger.warn(`[DRY_RUN] SMS withheld for ${msisdn}: ${message}`);
    return {
      success: true,
      dryRun: true,
      attempts: 0,
      response: { dryRun: true, msisdn, message },
    };
  }

  let lastError = null;

  for (let attempt = 1; attempt <= config.sms.maxAttempts; attempt += 1) {
    try {
      const result = await postOnce(buildPayload(msisdn, message));
      logger.info(`SMS delivered to ${msisdn} (attempt ${attempt}, HTTP ${result.status})`);
      return { success: true, attempts: attempt, response: result.body };
    } catch (err) {
      lastError = err;
      const detail = describeError(err);
      logger.warn(`SMS attempt ${attempt}/${config.sms.maxAttempts} to ${msisdn} failed: ${detail}`);

      // 4xx other than 408/429 will not succeed on a retry.
      if (err.status && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)) {
        break;
      }
      if (attempt < config.sms.maxAttempts) await sleep(attempt * 1000);
    }
  }

  // A 4xx means the request itself is wrong and will fail identically forever;
  // a 5xx, timeout or network error is the gateway being unwell and is worth
  // retrying for much longer. The caller uses this to size the retry budget.
  const status = lastError && lastError.status;
  const retryable =
    !status || status >= 500 || status === 408 || status === 429;

  return {
    success: false,
    attempts: config.sms.maxAttempts,
    retryable,
    status: status || null,
    error: lastError ? describeError(lastError) : 'Unknown SMS gateway failure',
    errorBody: lastError && lastError.body ? lastError.body : null,
  };
}

module.exports = { sendSms, normalizeMsisdn, buildPayload, describeHeaders };
