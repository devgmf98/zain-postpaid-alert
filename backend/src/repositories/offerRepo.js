'use strict';

const mysqlDb = require('../db/mysql');
const config = require('../config');
const logger = require('../logger');

const DUPLICATE_ENTRY = 'ER_DUP_ENTRY';
const T = mysqlDb.TABLES.offers;

const COLUMNS = `id, wallet_id, offer_name, pool_cap_gb, threshold_50_gb, threshold_100_gb,
                 active, created_at, updated_at`;

/**
 * Turns a stored row into the shape a polling cycle works with.
 *
 * DECIMAL columns arrive from mysql2 as strings, so every number is converted
 * once here rather than at each comparison - a string would make `>=` compare
 * lexically and "9" would sit above "10".
 *
 * Both messages are rendered here, once per cycle, from the shared .env patterns
 * with this offer's name substituted in.
 */
function hydrate(row) {
  const capGb = Number(row.pool_cap_gb);
  const offerName = row.offer_name;
  const levels = [
    { percent: 50, gb: Number(row.threshold_50_gb), message: config.renderMessage(50, offerName) },
    { percent: 100, gb: Number(row.threshold_100_gb), message: config.renderMessage(100, offerName) },
  ];
  for (const level of levels) level.bytes = Math.round(level.gb * config.GB);
  levels.sort((a, b) => a.bytes - b.bytes);

  return {
    id: Number(row.id),
    walletId: String(row.wallet_id),
    offerName: row.offer_name || null,
    capGb,
    thresholds: levels,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Checks an offer the way config.validate() checks the .env equivalent, so a bad
 * row is rejected at the API rather than throwing mid-cycle once a subscriber
 * crosses a bar.
 *
 * Returns an array of problems; empty means valid.
 */
function validate({ walletId, offerName, capGb, threshold50Gb, threshold100Gb }) {
  const problems = [];

  if (!/^[0-9]+$/.test(String(walletId ?? '').trim())) {
    problems.push(`walletId must be numeric, got "${walletId}"`);
  }
  // The name is what the customer reads - "you have used 50% of your <name> data
  // bundle" - so an offer without one would send a sentence with a hole in it.
  const name = String(offerName ?? '').trim();
  if (!name) {
    problems.push('offerName is required - it is substituted into both SMS messages');
  } else if (name.length > 128) {
    problems.push(`offerName must be 128 characters or fewer, got ${name.length}`);
  } else {
    // The gateway rejects an over-long message with a 400, which is permanent.
    // Caught here, while someone is looking at the screen, rather than as an
    // alert that claims its slot, fails five times and is lost for the month.
    const limit = config.sms.maxLength;
    for (const percent of [50, 100]) {
      const rendered = config.renderMessage(percent, name);
      if (rendered.length > limit) {
        problems.push(
          `the ${percent}% message would be ${rendered.length} characters, ` +
            `${rendered.length - limit} over the ${limit} the gateway accepts. ` +
            `Shorten offerName (currently ${name.length} chars) or SMS_TEMPLATE_${percent}.`
        );
      }
    }
  }
  for (const [field, value] of Object.entries({ capGb, threshold50Gb, threshold100Gb })) {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
      problems.push(`${field} must be a number greater than 0, got "${value}"`);
    }
  }

  const t50 = Number(threshold50Gb);
  const t100 = Number(threshold100Gb);
  // The 50% band runs from its own value up to the 100%. Equal values leave it
  // empty - configured, expected by whoever set it, and unable to ever fire.
  if (Number.isFinite(t50) && Number.isFinite(t100)) {
    if (t50 === t100) {
      problems.push(
        `threshold50Gb and threshold100Gb are both ${t50} GB. The 50% band would be ` +
          'empty and could never fire - set threshold50Gb below threshold100Gb.'
      );
    } else if (t50 > t100) {
      problems.push(`threshold50Gb (${t50}) must be below threshold100Gb (${t100})`);
    }
  }

  // A round is one full cap. If the top bar sits elsewhere the round closes at a
  // different point from the alert that closes it and the sequence stops lining
  // up, so this is a warning in .env and a hard error here where it is cheap to fix.
  const cap = Number(capGb);
  if (Number.isFinite(cap) && Number.isFinite(t100) && Math.abs(cap - t100) > 1e-9) {
    problems.push(
      `poolCapGb (${cap}) must equal threshold100Gb (${t100}) - a round is one full ` +
        'cap, and the 100% alert is what closes it.'
    );
  }

  return problems;
}

/** Every offer the poller should act on, cheapest query in the cycle. */
async function listActive() {
  const rows = await mysqlDb.query(
    `SELECT ${COLUMNS} FROM \`${T}\` WHERE active = 1 ORDER BY wallet_id`
  );
  return rows.map(hydrate);
}

async function listAll() {
  const rows = await mysqlDb.query(`SELECT ${COLUMNS} FROM \`${T}\` ORDER BY wallet_id`);
  return rows.map(hydrate);
}

async function findByWallet(walletId) {
  const rows = await mysqlDb.query(
    `SELECT ${COLUMNS} FROM \`${T}\` WHERE wallet_id = ? LIMIT 1`,
    [String(walletId).trim()]
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

/**
 * Creates the offer, or updates it when the wallet already has one.
 *
 * Upsert rather than insert-only because the wallet is the offer's identity:
 * pushing the same wallet again is how an operator retunes a cap or reworded
 * message, and that must not become a second row.
 */
async function upsert({
  walletId,
  offerName,
  capGb,
  threshold50Gb,
  threshold100Gb,
  active = true,
}) {
  const existing = await findByWallet(walletId);

  await mysqlDb.query(
    `INSERT INTO \`${T}\`
       (wallet_id, offer_name, pool_cap_gb, threshold_50_gb, threshold_100_gb, active)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
        offer_name       = VALUES(offer_name),
        pool_cap_gb      = VALUES(pool_cap_gb),
        threshold_50_gb  = VALUES(threshold_50_gb),
        threshold_100_gb = VALUES(threshold_100_gb),
        active           = VALUES(active)`,
    [
      String(walletId).trim(),
      String(offerName).trim(),
      Number(capGb),
      Number(threshold50Gb),
      Number(threshold100Gb),
      active ? 1 : 0,
    ]
  );

  return { offer: await findByWallet(walletId), created: !existing };
}

async function setActive(walletId, active) {
  const result = await mysqlDb.query(
    `UPDATE \`${T}\` SET active = ? WHERE wallet_id = ?`,
    [active ? 1 : 0, String(walletId).trim()]
  );
  return result.affectedRows > 0;
}

/**
 * Removes an offer. The alert history under that wallet is deliberately left
 * behind: it is the record of what was sent, and deleting it would let a
 * re-added offer announce every threshold again.
 */
async function remove(walletId) {
  const result = await mysqlDb.query(`DELETE FROM \`${T}\` WHERE wallet_id = ?`, [
    String(walletId).trim(),
  ]);
  return result.affectedRows > 0;
}

/**
 * Seeds the first offer from .env, once, when the table is empty.
 *
 * Without this, upgrading an installation that was alerting happily from .env
 * leaves an empty offers table and a monitor that polls, reports itself healthy
 * and silently watches nothing. The seeded row reproduces the previous
 * behaviour exactly and is then editable through the API.
 */
async function seedFromEnv() {
  const [{ n }] = await mysqlDb.query(`SELECT COUNT(*) AS n FROM \`${T}\``);
  if (Number(n) > 0) return null;

  const walletId = config.pool.walletId;
  if (!walletId) {
    logger.warn(
      `${T} is empty and WALLET_ID is not set, so there is nothing to seed. ` +
        'POST /api/offers to add one - until then the monitor has no offer to watch.'
    );
    return null;
  }

  const candidate = {
    walletId,
    // Goes into the customer's SMS, so it has to read as an offer name rather
    // than as a note about where the row came from.
    offerName: config.pool.offerName || `Wallet ${walletId}`,
    capGb: config.thresholds.capGb,
    threshold50Gb: config.thresholds.levels.find((l) => l.percent === 50).gb,
    threshold100Gb: config.thresholds.levels.find((l) => l.percent === 100).gb,
    // Staged inactive. WALLET_ID in .env is whatever the file happened to carry
    // when this host was provisioned, and on a fresh deployment that is usually
    // a leftover from somewhere else - it was 10271, a wallet with no traffic,
    // which produced an offer that logged "will never alert" on every boot.
    // Worse, had it been a busy wallet, a brand-new install would have started
    // SMSing its subscribers before anyone had looked at the settings.
    // Activate deliberately: PATCH /api/offers/:walletId/active {"active":true}
    active: config.pool.seedActive,
  };

  const problems = validate(candidate);
  if (problems.length) {
    logger.warn(
      `${T} is empty and the .env values cannot seed a valid offer:\n  - ` +
        `${problems.join('\n  - ')}\nPOST /api/offers to add one instead.`
    );
    return null;
  }

  const { offer } = await upsert(candidate);
  logger.info(
    `${T} was empty - seeded wallet ${offer.walletId} from .env ` +
      `(cap ${offer.capGb} GB, bars ${offer.thresholds.map((l) => `${l.percent}%@${l.gb}GB`).join(' ')})` +
      (offer.active ? '' : ', INACTIVE')
  );
  if (!offer.active) {
    logger.warn(
      `That seeded offer is inactive and nothing is being monitored yet. Check it ` +
        `matches real traffic with GET /api/offers/${offer.walletId}/cdrs, then either ` +
        `activate it (PATCH /api/offers/${offer.walletId}/active {"active":true}) or ` +
        'POST /api/offers with the wallet you actually want. ' +
        'Set OFFER_SEED_ACTIVE=true to have future installs seed it active.'
    );
  }
  return offer;
}

module.exports = {
  hydrate,
  validate,
  listActive,
  listAll,
  findByWallet,
  upsert,
  setActive,
  remove,
  seedFromEnv,
  DUPLICATE_ENTRY,
};
