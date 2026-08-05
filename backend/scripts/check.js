'use strict';

/**
 * One-shot health report: which offers are being watched, whether the service is
 * really polling, how far each subscriber is from their next SMS, and what has
 * been sent this month.
 *
 * Answers "is the automation actually working?" without anyone piecing it
 * together from curl, SQL and the log. Read-only - it sends nothing and writes
 * nothing.
 *
 *   node scripts/check.js
 */

const http = require('http');
const config = require('../src/config');
const mysqlDb = require('../src/db/mysql');
const offerRepo = require('../src/repositories/offerRepo');

const GB = 1024 ** 3;

// Most routes need a credential now. These are the seeded defaults; if the
// password has since been rotated the report says so rather than reporting the
// service as down.
const BASIC = Buffer.from(
  `${config.auth.defaultUsername}:${config.auth.defaultPassword}`
).toString('base64');

function get(path) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: config.port,
        path,
        timeout: 4000,
        headers: { Authorization: `Basic ${BASIC}` },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, body: null });
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function gb(n) {
  return `${Number(n).toFixed(3)} GB`;
}

(async () => {
  console.log('CONFIGURATION');
  console.log(`  env file    : ${config.envFile}`);
  console.log(`  database    : ${config.mysql.user}@${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`);
  console.log(`  poll        : every ${config.monitor.intervalMs} ms`);
  console.log(`  match mode  : ${config.thresholds.matchMode}`);
  console.log(`  DRY_RUN     : ${config.monitor.dryRun}${config.monitor.dryRun ? '   <-- no SMS will be sent' : ''}`);

  await mysqlDb.init();

  const offers = await offerRepo.listAll();
  console.log(`\nOFFERS (${config.mysql.tables.offers})`);
  if (!offers.length) {
    console.log('  none - nothing is being monitored. POST /api/offers to add one.');
  }
  for (const offer of offers) {
    console.log(
      `  wallet ${offer.walletId}  ${offer.active ? 'ACTIVE  ' : 'inactive'}  ` +
        `${offer.offerName || '(unnamed)'}`
    );
    console.log(
      `    cap ${offer.capGb} GB per round, bars ` +
        offer.thresholds.map((l) => `${l.percent}% at ${l.gb} GB`).join(', ')
    );
  }

  console.log('\nIS IT RUNNING?');
  const health = await get('/api/health');
  if (!health) {
    console.log(`  NOT RESPONDING on http://127.0.0.1:${config.port}`);
    console.log('  Nothing is polling, so no alerts are being sent. Start it with:');
    console.log('    node server.js');
  } else {
    const h = health.body || {};
    console.log(`  health      : ${h.status}  oracle=${h.oracle}  mysql=${h.mysql}  monitor=${h.monitor}`);

    const status = await get('/api/status');
    if (status && status.status === 401) {
      console.log('  status      : 401 - the admin password was changed, so this report');
      console.log('                cannot read the live counters. Set ADMIN_DEFAULT_PASSWORD');
      console.log('                in .env to the current one, or query /api/status yourself.');
    } else if (status && status.body) {
      const s = status.body;
      console.log(`  uptime      : ${Math.round((h.uptimeSeconds || 0) / 60)} min, ${s.cycles} cycles`);
      console.log(
        `  real rate   : ${s.lastPeriodMs ?? '?'} ms between polls ` +
          `(cycle takes ${s.lastCycleMs} ms across ${s.offersActive} offer(s))`
      );
      console.log(`  errors      : ${s.consecutiveErrors}${s.lastError ? ' - ' + s.lastError.message : ''}`);
      console.log(
        `  sms         : ${s.smsSent} sent, ${s.smsFailed} failed, ${s.smsQueue.depth} queued`
      );
      for (const o of s.offers || []) {
        if (o.lastError) console.log(`  wallet ${o.walletId} : ERROR - ${o.lastError.message}`);
      }
    }
  }

  const step = config.thresholds.matchMode === 'ROUNDED'
    ? 0.5 / 10 ** config.thresholds.matchDecimals
    : 0;
  const periodKey = config.resolveWindow().periodKey;

  for (const offer of offers) {
    console.log(`\nWHO IS CLOSE TO AN ALERT - wallet ${offer.walletId}`);
    const usage = await mysqlDb.query(
      `SELECT msisdn, gbs_used, bytes_used, round_no, period_bytes_used, updated_at
         FROM \`${config.mysql.tables.usage}\`
        WHERE wallet_id = ?
        ORDER BY bytes_used DESC`,
      [offer.walletId]
    );

    if (!usage.length) console.log('  no usage rows yet for this offer');

    for (const row of usage) {
      const inRound = Number(row.gbs_used);
      const total = Number(row.period_bytes_used) / GB;
      console.log(`  ${row.msisdn}  round ${row.round_no}`);
      console.log(`    used this round : ${gb(inRound)}   (month total ${gb(total)})`);
      for (const level of offer.thresholds) {
        const firesAt = level.gb - step;
        const left = firesAt - inRound;
        const absolute = (row.round_no - 1) * offer.capGb + level.gb;
        console.log(
          `    ${String(level.percent).padStart(3)}% at ${absolute} GB total : ` +
            (left <= 0 ? 'reached' : `${gb(left)} to go (${Math.round(left * 1024)} MB)`)
        );
      }
      const age = Math.round((Date.now() - new Date(row.updated_at).getTime()) / 1000);
      console.log(`    figures updated : ${age}s ago${age > 60 ? '   <-- stale, is the monitor running?' : ''}`);
    }

    console.log(`\nALERTS THIS MONTH - wallet ${offer.walletId}`);
    const sent = await mysqlDb.query(
      `SELECT msisdn, round_no, threshold_percent, status, gbs_used, attempts, error_message, sent_at
         FROM \`${config.mysql.tables.notifications}\`
        WHERE wallet_id = ? AND period_ym = ?
        ORDER BY id`,
      [offer.walletId, periodKey]
    );
    if (!sent.length) console.log('  none recorded yet');
    for (const r of sent) {
      const when = r.sent_at ? new Date(r.sent_at).toISOString().replace('T', ' ').slice(0, 19) : '-';
      console.log(
        `  ${r.msisdn}  round ${r.round_no}  ${String(r.threshold_percent).padStart(3)}%  ` +
          `${r.status.padEnd(7)} at ${r.gbs_used} GB  ${when}` +
          (r.error_message ? `  (${r.attempts} attempts: ${r.error_message})` : '')
      );
    }
  }

  await mysqlDb.close();
})().catch((err) => {
  console.error('check failed:', err.message);
  process.exit(1);
});
