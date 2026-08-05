'use strict';

const express = require('express');
const config = require('../config');
const logger = require('../logger');
const oracle = require('../db/oracle');
const mysqlDb = require('../db/mysql');
const usageService = require('../services/usageService');
const smsService = require('../services/smsService');
const authService = require('../services/authService');
const monitor = require('../services/monitorService');
const activationMonitor = require('../services/activationMonitor');
const activationService = require('../services/activationService');
const activationRepo = require('../repositories/activationRepo');
const notificationRepo = require('../repositories/notificationRepo');
const statusRepo = require('../repositories/statusRepo');
const usageRepo = require('../repositories/usageRepo');
const offerRepo = require('../repositories/offerRepo');
const adminRepo = require('../repositories/adminRepo');
const smsQueue = require('../services/smsQueue');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

// Wraps an async handler so a rejection reaches the error middleware.
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/* -------------------------------------------------------------------------- */
/* Open routes - everything below requireAuth needs a credential               */
/* -------------------------------------------------------------------------- */

router.get('/health', wrap(async (req, res) => {
  const [oracleOk, mysqlOk] = await Promise.all([
    oracle.ping().then(() => true).catch(() => false),
    mysqlDb.ping().then(() => true).catch(() => false),
  ]);

  const healthy = oracleOk && mysqlOk;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    oracle: oracleOk ? 'up' : 'down',
    mysql: mysqlOk ? 'up' : 'down',
    monitor: monitor.getStatus().running ? 'running' : 'stopped',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}));

/**
 * Exchanges a username and password for a bearer token.
 *
 * A wrong username and a wrong password give the same answer and take a similar
 * amount of time, so this cannot be used to discover which accounts exist.
 */
router.post('/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const admin = await adminRepo.findByUsername(username);
  const ok = admin && admin.active
    ? await authService.verifyPassword(password, admin.password_hash)
    // Still run a verification against a throwaway hash so a missing user does
    // not answer measurably faster than a wrong password.
    : await authService.verifyPassword(password, await authService.hashPassword('no-such-user'));

  if (!admin || !admin.active || !ok) {
    logger.warn(`Failed login for "${String(username).slice(0, 64)}"`);
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  await adminRepo.touchLogin(admin.id);
  const token = authService.issueToken(admin);
  logger.info(`Admin "${admin.username}" logged in`);
  res.json({ username: admin.username, ...token });
}));

/* -------------------------------------------------------------------------- */

router.use(requireAuth);

/* -------------------------------------------------------------------------- */
/* Offers                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Accepts both the .env-style names an operator already knows
 * (WALLET_ID, POOL_CAP_GB, THRESHOLD_50_GB, ...) and camelCase, so a request can
 * be pasted together from either without a translation step.
 */
function normalizeOffer(body = {}) {
  const payload = normalizeOfferPayload(body);
  const pick = (...names) => {
    for (const name of names) {
      if (payload[name] !== undefined && payload[name] !== null && payload[name] !== '') return payload[name];
    }
    return undefined;
  };

  return {
    walletId: pick('walletId', 'WALLET_ID', 'wallet_id'),
    offerName: pick('offerName', 'OFFER_NAME', 'offer_name', 'name'),
    capGb: pick('poolCapGb', 'POOL_CAP_GB', 'pool_cap_gb', 'capGb'),
    threshold50Gb: pick('threshold50Gb', 'THRESHOLD_50_GB', 'threshold_50_gb'),
    threshold100Gb: pick('threshold100Gb', 'THRESHOLD_100_GB', 'threshold_100_gb'),
    active: pick('active', 'ACTIVE'),
  };
}

function normalizeOfferPayload(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const candidate = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    return hasOfferFields(obj);
  };

  if (candidate(body)) return body;
  if (candidate(body.offer)) return body.offer;
  if (candidate(body.payload)) return body.payload;
  if (candidate(body.data)) return body.data;

  const keys = Object.keys(body);
  if (keys.length === 1) {
    const only = body[keys[0]];
    if (candidate(only)) return only;
  }

  return body;
}

function hasOfferFields(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = new Set(Object.keys(body));
  return [
    'walletId', 'WALLET_ID', 'wallet_id',
    'offerName', 'OFFER_NAME', 'offer_name', 'name',
    'poolCapGb', 'POOL_CAP_GB', 'pool_cap_gb', 'capGb',
    'threshold50Gb', 'THRESHOLD_50_GB', 'threshold_50_gb',
    'threshold100Gb', 'THRESHOLD_100_GB', 'threshold_100_gb',
  ].some((field) => keys.has(field));
}

/**
 * The stored offer plus the two messages it will actually send.
 *
 * The rendered text is returned rather than the pattern so whoever pushed the
 * offer can read exactly what the customer will receive - a name that reads
 * oddly mid-sentence is obvious here and invisible in the template.
 */
function present(offer) {
  return {
    id: offer.id,
    walletId: offer.walletId,
    offerName: offer.offerName,
    poolCapGb: offer.capGb,
    threshold50Gb: offer.thresholds.find((l) => l.percent === 50).gb,
    threshold100Gb: offer.thresholds.find((l) => l.percent === 100).gb,
    active: offer.active,
    messagePreview: {
      50: offer.thresholds.find((l) => l.percent === 50).message,
      100: offer.thresholds.find((l) => l.percent === 100).message,
      // Surfaced because the gateway rejects anything over the limit outright,
      // and a long offer name is the usual way a template tips over it.
      length: {
        50: offer.thresholds.find((l) => l.percent === 50).message.length,
        100: offer.thresholds.find((l) => l.percent === 100).message.length,
        limit: config.sms.maxLength,
      },
    },
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
  };
}

router.get('/offers', wrap(async (req, res) => {
  const offers = await offerRepo.listAll();
  res.json({ table: mysqlDb.TABLES.offers, count: offers.length, offers: offers.map(present) });
}));

router.get('/offers/:walletId', wrap(async (req, res) => {
  const offer = await offerRepo.findByWallet(req.params.walletId);
  if (!offer) return res.status(404).json({ error: `No offer for wallet ${req.params.walletId}` });
  res.json(present(offer));
}));

/**
 * Creates or retunes offers. Accepts one object or an array of them.
 *
 * Upsert by wallet, because the wallet is the offer's identity: pushing the same
 * wallet again is how a cap or a message gets changed, and that must not become
 * a second row alerting the same subscribers twice.
 */
router.post('/offers', wrap(async (req, res) => {
  const body = req.body;

  // An empty body is a different mistake from a bad one, and saying so saves a
  // long hunt: express.json() only parses when Content-Type is application/json,
  // so a raw body sent as text/plain arrives here as {} and every field reads
  // "undefined" - which looks like five validation failures rather than the one
  // missing header that actually caused it.
  const supplied = Array.isArray(body) ? body.length : body && typeof body === 'object'
    ? Object.keys(body).length
    : 0;
  if (!supplied) {
    return res.status(400).json({
      error: 'No JSON body received',
      likelyCause:
        `Content-Type was "${req.get('content-type') || 'not set'}". This endpoint reads ` +
        'application/json only.',
      fix: 'In Postman: Body -> raw -> pick JSON in the dropdown (not Text). With curl: -H "Content-Type: application/json"',
      example: {
        WALLET_ID: '10271',
        OFFER_NAME: '10GB Postpaid Pool',
        POOL_CAP_GB: 10,
        THRESHOLD_50_GB: 5,
        THRESHOLD_100_GB: 10,
      },
    });
  }

  const items = Array.isArray(body) ? body : [body];
  if (!items.length || !items[0] || typeof items[0] !== 'object') {
    return res.status(400).json({
      error: 'Send an offer object, or an array of them',
      example: {
        WALLET_ID: '10271',
        OFFER_NAME: '10GB Postpaid Pool',
        POOL_CAP_GB: 10,
        THRESHOLD_50_GB: 5,
        THRESHOLD_100_GB: 10,
      },
      messages:
        'Not supplied per offer. Both SMS are rendered from SMS_TEMPLATE_50 / ' +
        'SMS_TEMPLATE_100 in .env with {offer} replaced by OFFER_NAME. The exact ' +
        'text is returned as messagePreview.',
    });
  }

  // Validate every item before writing any of them, so a bad third entry cannot
  // leave the first two applied and the caller unsure what actually landed.
  const normalized = items.map(normalizeOffer);
  const failures = [];
  normalized.forEach((offer, i) => {
    const problems = offerRepo.validate(offer);
    if (problems.length) failures.push({ index: i, walletId: offer.walletId ?? null, problems });
  });
  if (failures.length) {
    return res.status(400).json({ error: 'Invalid offer(s) - nothing was written', failures });
  }

  const wallets = normalized.map((o) => String(o.walletId).trim());
  const duplicated = wallets.filter((w, i) => wallets.indexOf(w) !== i);
  if (duplicated.length) {
    return res.status(400).json({
      error: `The same wallet appears more than once in this request: ${[...new Set(duplicated)].join(', ')}`,
    });
  }

  const results = [];
  for (const offer of normalized) {
    const { offer: saved, created } = await offerRepo.upsert({
      ...offer,
      active: offer.active === undefined ? true : truthy(offer.active),
    });
    monitor.invalidateOffer(saved.walletId);
    results.push({ ...present(saved), created });
    logger.info(
      `Offer ${created ? 'created' : 'updated'} by ${req.admin.username}: wallet ` +
        `${saved.walletId} (${saved.offerName || 'unnamed'}), cap ${saved.capGb} GB, ` +
        `bars ${saved.thresholds.map((l) => `${l.percent}%@${l.gb}GB`).join(' ')}`
    );
  }

  res.status(201).json({
    ok: true,
    count: results.length,
    offers: results,
    note:
      'Live on the next polling cycle. Subscribers already past a bar on a new offer are ' +
      'recorded as SKIPPED rather than alerted, except the most recent cap crossing ' +
      '(SKIP_PASSED_ON_FIRST_SIGHT).',
  });
}));

function truthy(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

/** Pauses or resumes one offer without losing its settings or its history. */
router.patch('/offers/:walletId/active', wrap(async (req, res) => {
  const { active } = req.body || {};
  if (active === undefined) return res.status(400).json({ error: 'active is required' });

  const updated = await offerRepo.setActive(req.params.walletId, truthy(active));
  if (!updated) return res.status(404).json({ error: `No offer for wallet ${req.params.walletId}` });

  monitor.invalidateOffer(req.params.walletId);
  logger.info(
    `Offer wallet ${req.params.walletId} set ${truthy(active) ? 'active' : 'inactive'} ` +
      `by ${req.admin.username}`
  );
  res.json({ ok: true, walletId: req.params.walletId, active: truthy(active) });
}));

router.delete('/offers/:walletId', wrap(async (req, res) => {
  const removed = await offerRepo.remove(req.params.walletId);
  if (!removed) return res.status(404).json({ error: `No offer for wallet ${req.params.walletId}` });

  monitor.invalidateOffer(req.params.walletId);
  logger.info(`Offer wallet ${req.params.walletId} deleted by ${req.admin.username}`);
  res.json({
    ok: true,
    walletId: req.params.walletId,
    note:
      'The alert history for this wallet is kept. It is the record of what was sent, and ' +
      'deleting it would let a re-added offer announce every threshold again.',
  });
}));

/** CBS reality check for one wallet: does it match any CDRs in this window? */
router.get('/offers/:walletId/cdrs', wrap(async (req, res) => {
  res.json(await usageService.describeWallet(req.params.walletId));
}));

/* -------------------------------------------------------------------------- */
/* Admins                                                                      */
/* -------------------------------------------------------------------------- */

router.get('/auth/me', (req, res) => {
  res.json({ username: req.admin.username, via: req.admin.via });
});

router.get('/admins', wrap(async (req, res) => {
  const admins = await adminRepo.list();
  res.json({ count: admins.length, admins });
}));

router.post('/admins', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  if (await adminRepo.findByUsername(username)) {
    return res.status(409).json({ error: `Admin "${username}" already exists` });
  }

  const created = await adminRepo.create(username, password);
  logger.info(`Admin "${created.username}" created by ${req.admin.username}`);
  res.status(201).json({ ok: true, ...created });
}));

router.post('/admins/password', wrap(async (req, res) => {
  const { username, newPassword } = req.body || {};
  const target = username || req.admin.username;
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
  }

  const updated = await adminRepo.setPassword(target, newPassword);
  if (!updated) return res.status(404).json({ error: `No admin named "${target}"` });

  logger.info(`Password changed for "${target}" by ${req.admin.username}`);
  res.json({ ok: true, username: target, note: 'Existing bearer tokens remain valid until they expire.' });
}));

/* -------------------------------------------------------------------------- */
/* Monitoring and reporting                                                    */
/* -------------------------------------------------------------------------- */

router.get('/status', (req, res) => {
  res.json({ ...monitor.getStatus(), activations: activationMonitor.getStatus() });
});

/* -------------------------------------------------------------------------- */
/* Bundle activation notices                                                   */
/* -------------------------------------------------------------------------- */

/** Activation notices recorded for a day, defaulting to today. */
router.get('/activations', wrap(async (req, res) => {
  const day = String(req.query.date || activationService.resolveDay().dayKey);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(400).json({ error: 'date must be formatted as YYYY-MM-DD' });
  }

  const [rows, summary] = await Promise.all([
    activationRepo.listByDay(day, req.query.limit),
    activationRepo.summaryByDay(day),
  ]);
  res.json({ date: day, summary, count: rows.length, activations: rows });
}));

/** How many activation EDRs CBS holds for a day - does the feed have anything? */
router.get('/activations/source', wrap(async (req, res) => {
  res.json(await activationService.countActivations());
}));

router.post('/activations/start', (req, res) => res.json(activationMonitor.start()));
router.post('/activations/stop', (req, res) => res.json(activationMonitor.stop()));

/** Runs a single activation pass on demand. */
router.post('/activations/run-once', wrap(async (req, res) => {
  await activationMonitor.runCycle();
  res.json({ ok: true, status: activationMonitor.getStatus() });
}));

/**
 * Resolves which wallet a report is about.
 *
 * With one active offer the parameter is optional, because there is no ambiguity.
 * With several it is required: silently picking one would report the wrong
 * offer's figures under the right-looking heading.
 */
async function resolveWallet(req) {
  const asked = req.query.wallet || req.query.walletId;
  if (asked) {
    const offer = await offerRepo.findByWallet(asked);
    return { walletId: String(asked).trim(), offer };
  }

  const active = await offerRepo.listActive();
  if (active.length === 1) return { walletId: active[0].walletId, offer: active[0] };
  return {
    error:
      active.length === 0
        ? 'No active offers - add one with POST /api/offers'
        : `Several active offers; add ?wallet=... (${active.map((o) => o.walletId).join(', ')})`,
  };
}

/** Live per-subscriber totals for the current window. */
router.get('/usage', wrap(async (req, res) => {
  const scope = await resolveWallet(req);
  if (scope.error) return res.status(400).json({ error: scope.error });

  const window = config.resolveWindow();
  const rows = await usageService.fetchUsageByMsisdn(scope.walletId, window);
  const offer = scope.offer;
  const accounts = await usageService.fetchAccountInfo(rows.map((r) => r.msisdn));

  const enriched = rows
    .map((row) => ({
      msisdn: row.msisdn,
      accountCode: (accounts.get(row.msisdn) || {}).accountCode ?? null,
      accountName: (accounts.get(row.msisdn) || {}).accountName ?? null,
      mbsUsed: row.mbsUsed,
      gbsUsed: Number(row.exactGb.toFixed(3)),
      bytesUsed: row.bytesUsed,
      percentOfCap: offer ? Number(((row.exactGb / offer.capGb) * 100).toFixed(1)) : null,
      thresholdsCrossed: offer
        ? offer.thresholds.filter((l) => config.hasReached(row.bytesUsed, l)).map((l) => l.percent)
        : [],
    }))
    .sort((a, b) => b.bytesUsed - a.bytesUsed);

  res.json({
    walletId: scope.walletId,
    offerName: offer ? offer.offerName : null,
    window: {
      mode: config.pool.window,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      periodKey: window.periodKey,
    },
    capGb: offer ? offer.capGb : null,
    count: enriched.length,
    subscribers: enriched,
  });
}));

/** The original report query, broken down by usage type and bundle. */
router.get('/usage/detailed', wrap(async (req, res) => {
  const scope = await resolveWallet(req);
  if (scope.error) return res.status(400).json({ error: scope.error });

  const window = config.resolveWindow();
  const rows = await usageService.fetchUsageDetailed(scope.walletId, window);
  res.json({
    walletId: scope.walletId,
    window: {
      mode: config.pool.window,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    },
    count: rows.length,
    rows,
  });
}));

/** Cached snapshot from the last polling cycle - no database hit. */
router.get('/usage/snapshot', (req, res) => {
  res.json({ count: monitor.getSnapshot().length, subscribers: monitor.getSnapshot() });
});

/** SMS alerts recorded for a month, defaulting to the current one. */
router.get('/notifications', wrap(async (req, res) => {
  const periodYm = String(req.query.period || config.resolveWindow().periodKey);
  if (!/^\d{4}-\d{2}$/.test(periodYm)) {
    return res.status(400).json({ error: 'period must be formatted as YYYY-MM' });
  }
  const wallet = req.query.wallet || req.query.walletId || null;

  const [rows, summary] = await Promise.all([
    notificationRepo.listByPeriod(periodYm, req.query.limit, wallet),
    notificationRepo.summaryByPeriod(periodYm, wallet),
  ]);

  res.json({ period: periodYm, walletId: wallet, summary, count: rows.length, notifications: rows });
}));

/** The persisted status row(s), as stored in the status table. */
router.get('/status/stored', wrap(async (req, res) => {
  const rows = await statusRepo.list();
  res.json({ table: mysqlDb.TABLES.status, count: rows.length, services: rows });
}));

/** The persisted usage mirror, no Oracle hit. */
router.get('/usage/stored', wrap(async (req, res) => {
  const periodYm = String(req.query.period || config.resolveWindow().periodKey);
  if (!/^\d{4}-\d{2}$/.test(periodYm)) {
    return res.status(400).json({ error: 'period must be formatted as YYYY-MM' });
  }
  const wallet = req.query.wallet || req.query.walletId || null;
  const rows = await usageRepo.listByPeriod(periodYm, req.query.limit, wallet);
  res.json({ table: mysqlDb.TABLES.usage, period: periodYm, walletId: wallet, count: rows.length, subscribers: rows });
}));

/** Which tables this service writes to. */
router.get('/tables', (req, res) => {
  res.json({ database: config.mysql.database, tables: mysqlDb.TABLES });
});

/** Delivery queue depth and counters. */
router.get('/queue', (req, res) => {
  res.json(smsQueue.getStats());
});

router.post('/monitor/start', (req, res) => {
  res.json(monitor.start());
});

router.post('/monitor/stop', (req, res) => {
  res.json(monitor.stop());
});

/** Runs a single cycle on demand - useful for verifying the wiring. */
router.post('/monitor/run-once', wrap(async (req, res) => {
  await monitor.runCycle();
  res.json({ ok: true, status: monitor.getStatus() });
}));

/** Sends a test SMS. Honours DRY_RUN. */
router.post('/sms/test', wrap(async (req, res) => {
  const { msisdn, message } = req.body || {};
  if (!msisdn) return res.status(400).json({ error: 'msisdn is required' });

  // Render the 50% pattern against a stand-in name, so the default test message
  // is the real wording rather than one containing a raw "{offer}" placeholder.
  const text = message || config.renderMessage(50, req.body.offerName || 'Test Offer');
  const result = await smsService.sendSms(msisdn, text);
  logger.info(`Test SMS to ${msisdn} requested by ${req.admin.username}`);
  res.status(result.success ? 200 : 502).json({
    normalizedMsisdn: smsService.normalizeMsisdn(msisdn),
    dryRun: config.monitor.dryRun,
    ...result,
  });
}));

module.exports = router;
