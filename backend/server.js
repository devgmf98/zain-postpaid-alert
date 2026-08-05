'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const express = require('express');

const config = require('./src/config');
const logger = require('./src/logger');
const oracle = require('./src/db/oracle');
const mysqlDb = require('./src/db/mysql');
const monitor = require('./src/services/monitorService');
const activationMonitor = require('./src/services/activationMonitor');
const activationService = require('./src/services/activationService');
const usageService = require('./src/services/usageService');
const offerRepo = require('./src/repositories/offerRepo');
const adminRepo = require('./src/repositories/adminRepo');
const smsQueue = require('./src/services/smsQueue');
const realtime = require('./src/realtime');
const apiRoutes = require('./src/routes/api');

const app = express();

app.use(express.json({ limit: '256kb' }));
app.disable('x-powered-by');

app.get('/', (req, res) => {
  res.json({
    service: 'zain-data-pool-monitor',
    offersTable: config.mysql.tables.offers,
    pollIntervalMs: config.monitor.intervalMs,
    dryRun: config.monitor.dryRun,
    auth: config.auth.enabled
      ? 'Every route except /api/health and /api/auth/login needs a credential. ' +
        'POST /api/auth/login for a bearer token, or use HTTP Basic.'
      : 'AUTH_ENABLED=false - every route is open.',
    endpoints: [
      'POST /api/auth/login  { "username": "...", "password": "..." }',
      'GET  /api/health',
      'GET  /api/status',
      'GET  /api/offers',
      'GET  /api/offers/:walletId',
      'POST /api/offers  { WALLET_ID, OFFER_NAME, POOL_CAP_GB, THRESHOLD_50_GB, THRESHOLD_100_GB }',
      'PATCH  /api/offers/:walletId/active  { "active": false }',
      'DELETE /api/offers/:walletId',
      'GET  /api/offers/:walletId/cdrs',
      'GET  /api/usage?wallet=...',
      'GET  /api/usage/detailed?wallet=...',
      'GET  /api/usage/snapshot',
      'GET  /api/notifications?period=YYYY-MM&wallet=...',
      'POST /api/monitor/start',
      'POST /api/monitor/stop',
      'POST /api/monitor/run-once',
      'POST /api/sms/test  { "msisdn": "...", "message": "..." }',
      'GET  /api/queue',
      'GET  /api/admins',
      'POST /api/admins  { "username": "...", "password": "..." }',
      'POST /api/admins/password  { "newPassword": "..." }',
      `WS   ws://localhost:${config.port}${realtime.PATH}  (live feed + commands)`,
    ],
    websocket: {
      url: `ws://localhost:${config.port}${realtime.PATH}`,
      commands: ['ping', 'status', 'start', 'stop', 'offers'],
      events: [
        'snapshot', 'cycle', 'cycle.failed', 'usage.updated',
        'threshold.crossed', 'sms.sent', 'sms.failed',
        'pool.changed', 'monitor.started', 'monitor.stopped',
      ],
    },
  });
});

app.use('/api', apiRoutes);

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // A malformed body is the caller's typo, not a server fault. express.json()
  // reports it as a bare SyntaxError with a character offset, which reads like a
  // crash; name it for what it is and point at the position.
  if (err.type === 'entity.parse.failed') {
    logger.warn(`${req.method} ${req.originalUrl}: body is not valid JSON - ${err.message}`);
    return res.status(400).json({
      error: 'Body is not valid JSON',
      detail: err.message,
      fix: 'Check for a trailing comma, a missing quote, or single quotes instead of double.',
    });
  }

  logger.error(`${req.method} ${req.originalUrl} failed:`, err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(config.env === 'development' ? { stack: err.stack } : {}),
  });
});

let server = null;
let shuttingDown = false;
// Set when this run stopped the background service to get the port, so exit can
// hand it straight back instead of waiting for the scheduled trigger.
let tookPortFromService = false;

/**
 * Says plainly whether each active offer's wallet matches any CDRs. A wallet
 * with no traffic otherwise yields a monitor that reports itself perfectly
 * healthy while watching nothing at all.
 *
 * Runs per offer and never throws: this is a diagnostic, and one unreachable
 * wallet must not stop the others being reported.
 */
async function reportOfferHealth() {
  const offers = await offerRepo.listActive();
  if (!offers.length) {
    logger.warn(
      `No active offers in ${config.mysql.tables.offers} - nothing will be monitored. ` +
        'POST /api/offers to add one.'
    );
    return;
  }

  for (const offer of offers) {
    try {
      const info = await usageService.describeWallet(offer.walletId);
      logger.info(
        `Offer check: wallet ${offer.walletId} (${offer.offerName || 'unnamed'}) matches ` +
          `${info.cdrs} CDR(s) from ${info.subscribers} subscriber(s), newest ${info.lastCdr || 'none'}`
      );
      if (info.cdrs === 0) {
        logger.error(
          `Wallet ${offer.walletId} matches no CDRs in this window - that offer will never alert.`
        );
      }
    } catch (err) {
      logger.warn(
        `Offer check for wallet ${offer.walletId} did not finish: ` +
          `${logger.describe(err).split('\n')[0]}`
      );
    }
  }
}

const WINDOWS_SERVICE_TASK = 'ZainDataPoolMonitor';

/** Runs a PowerShell one-liner. Windows only; never called elsewhere. */
function powershell(command) {
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { ok: res.status === 0, out: (res.stdout || '').trim() };
}

/**
 * Stops the background service so this run can have the port.
 *
 * Only on Windows, and only when the port is held by our own scheduled-task
 * service: an unrelated process that happens to be on this port is never killed.
 * The task itself is left armed rather than disabled - its 5-minute trigger is
 * what brings the service back when this run ends, and a trigger cannot be lost
 * the way a "restore it on exit" step can when the process is killed outright.
 *
 * Returns true if it stopped something, so exit can start it again immediately
 * instead of waiting for that trigger.
 */
function takePortFromService() {
  if (process.platform !== 'win32') return false;
  if (!config.monitor.takeoverPort) return false;

  // The supervisor records its pid when it starts, and the process on the port
  // is its child. Both must hold for the owner to be ours.
  //
  // Checking only "is the scheduled task registered?" was not enough, and not
  // nearly conservative enough: the task is registered permanently, so that test
  // passed no matter who held the port, and this would have killed an unrelated
  // process - a pm2 app, a colleague's server - while reporting that it had
  // taken the port back from its own service.
  let supervisorPid = null;
  try {
    supervisorPid = Number(fs.readFileSync(path.join(__dirname, 'logs', 'supervisor.pid'), 'utf8').trim());
  } catch {
    supervisorPid = null;
  }
  if (!supervisorPid) return false;

  const owner = powershell(
    `(Get-NetTCPConnection -State Listen -LocalPort ${config.port} -ErrorAction SilentlyContinue |` +
      ' Select-Object -First 1).OwningProcess'
  ).out;
  if (!owner) return false;

  const ours = powershell(
    `$p = ${Number(owner)}; $sup = ${supervisorPid}; ` +
      '$ok = $false; for ($i = 0; $i -lt 4 -and $p; $i++) { ' +
      '  if ($p -eq $sup) { $ok = $true; break }; ' +
      '  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue; ' +
      '  if (-not $proc) { break }; $p = $proc.ParentProcessId }; ' +
      "if ($ok) { 'yes' }"
  ).out;
  if (ours !== 'yes') return false;

  logger.warn(`Port ${config.port} is held by the ${WINDOWS_SERVICE_TASK} service - taking it over for this run`);
  powershell(`Stop-ScheduledTask -TaskName '${WINDOWS_SERVICE_TASK}' -ErrorAction SilentlyContinue`);
  // /T so the supervisor's server.js goes with it rather than being orphaned,
  // still holding the port.
  powershell(`taskkill.exe /PID ${supervisorPid} /T /F 2>&1 | Out-Null`);
  return true;
}

/** "pid 25708 (node server.js)", or just "another process" if it cannot be read. */
function describePortOwner() {
  if (process.platform !== 'win32') return 'another process';
  const out = powershell(
    `$o = (Get-NetTCPConnection -State Listen -LocalPort ${config.port} -ErrorAction SilentlyContinue |` +
      ' Select-Object -First 1).OwningProcess; if ($o) { ' +
      '  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$o" -ErrorAction SilentlyContinue; ' +
      '  "$o|" + $(if ($p) { $p.CommandLine } else { "" }) }'
  ).out;
  if (!out) return 'another process';

  const [pid, command = ''] = out.split('|');
  const trimmed = command.trim().replace(/\s+/g, ' ');
  return `pid ${pid}${trimmed ? ` (${trimmed.slice(0, 80)})` : ''}`;
}

function giveBackPortToService() {
  if (!tookPortFromService) return;
  const started = powershell(`Start-ScheduledTask -TaskName '${WINDOWS_SERVICE_TASK}' -ErrorAction SilentlyContinue`);
  logger.info(
    started.ok
      ? `${WINDOWS_SERVICE_TASK} restarted - alerting continues in the background`
      : `Could not restart ${WINDOWS_SERVICE_TASK} directly; its 5-minute trigger picks it up`
  );
}

function bindOnce() {
  return new Promise((resolve, reject) => {
    server = app.listen(config.port);
    server.once('listening', () => {
      server.removeListener('error', reject);
      resolve();
    });
    server.once('error', reject);
  });
}

/**
 * Binds the HTTP port, and does not resolve until the socket is actually
 * listening.
 *
 * app.listen() reports failure asynchronously, so without this the rest of
 * bootstrap ran on regardless: the port error surfaced as an uncaught
 * exception, shutdown closed the database pools, and the monitor then started
 * on top of them and polled a closed pool every second. A second instance can
 * never send a duplicate SMS - the MySQL claim sees to that - but it filled the
 * log with failures that looked like a database fault rather than "this port is
 * taken".
 */
async function listen() {
  try {
    await bindOnce();
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;

    // One retry, and only after the port's owner was our own service. Anything
    // else is a genuine conflict the operator has to resolve.
    tookPortFromService = takePortFromService();
    if (!tookPortFromService) {
      // Name the process. "Port in use" with nothing else to go on is a dead end
      // when the holder is another copy of this very server started by hand -
      // which is the common case - because there is nothing to look up.
      throw new Error(
        `Port ${config.port} is already in use by ${describePortOwner()}. Stop it ` +
          `first, or run this instance elsewhere with PORT=${config.port + 100}.`
      );
    }

    for (let waited = 0; waited < 15000; waited += 300) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        await bindOnce();
        break;
      } catch (retryErr) {
        if (retryErr.code !== 'EADDRINUSE') throw retryErr;
        if (waited >= 14700) throw retryErr;
      }
    }
  }

  logger.info(`HTTP server listening on http://localhost:${config.port}`);
}

async function bootstrap() {
  config.validate();

  // State the configuration actually in force, so a stale or wrong value is
  // visible in the log rather than only as a monitor that quietly sees nothing.
  logger.info(`Config loaded from ${config.envFile}`);

  if (config.monitor.dryRun) {
    logger.warn('DRY_RUN is enabled - alerts are recorded in MySQL but no SMS leaves the box');
  }

  await mysqlDb.init();

  // Credentials and offers both live in MySQL now. Seeding happens once, only
  // when the respective table is empty, so a rotated password or a retuned offer
  // is never quietly reverted to whatever .env still says.
  await adminRepo.seedDefault();
  await offerRepo.seedFromEnv();

  const offers = await offerRepo.listActive();
  logger.info(
    `${offers.length} active offer(s) in ${config.mysql.tables.offers}` +
      (offers.length ? ':' : ' - POST /api/offers to add one')
  );
  for (const offer of offers) {
    logger.info(
      `  wallet ${offer.walletId} (${offer.offerName || 'unnamed'}) - cap ${offer.capGb} GB, ` +
        `bars ${offer.thresholds.map((l) => `${l.percent}%@${l.gb}GB`).join(' ')}`
    );
  }

  // A CBS outage must not stop the service from starting. The monitor's error
  // backoff retries every cycle, so it recovers on its own once Oracle returns -
  // far better than exiting and needing someone to notice and restart it.
  try {
    await oracle.init();
    await oracle.ping();
    logger.info('Oracle connectivity verified');
  } catch (err) {
    logger.error(`Oracle is unreachable at startup: ${logger.describe(err).split('\n')[0]}`);
    logger.warn('Starting anyway - the monitor will keep retrying until CBS responds');
  }

  await listen();
  realtime.attach(server);

  // Deliberately after listen() and deliberately not awaited. The pool check is
  // a diagnostic: it answers "is this account/wallet real?" by aggregating CDRs,
  // which on a large or unindexed CBS instance can take minutes. Awaiting it
  // before binding meant a slow database left a process that was running,
  // logging nothing after "Oracle connectivity verified", never listening and
  // never polling - alive, and doing nothing at all.
  reportOfferHealth().catch((err) => {
    logger.warn(`Offer check did not finish: ${logger.describe(err).split('\n')[0]}`);
  });

  // Alerts claimed but never delivered by a previous run are owed an SMS.
  // Re-queue them now rather than waiting for the retry cooldown.
  try {
    await smsQueue.recoverPending(config.resolveWindow().periodKey);
  } catch (err) {
    logger.warn(`Could not re-queue pending alerts: ${logger.describe(err).split('\n')[0]}`);
  }
  try {
    await smsQueue.recoverPendingActivations(activationService.resolveDay().dayKey);
  } catch (err) {
    logger.warn(`Could not re-queue pending activations: ${logger.describe(err).split('\n')[0]}`);
  }

  if (config.monitor.autostart) {
    monitor.start();
  } else {
    logger.info('MONITOR_AUTOSTART is false - POST /api/monitor/start to begin polling');
  }

  // Independent of the usage poller: it reads a different CBS table on its own
  // timer, so one being slow or failing never holds up the other.
  activationMonitor.start();
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received - shutting down`);

  monitor.stop();
  activationMonitor.stop();
  // Let in-flight deliveries finish so a claimed alert is not left PENDING.
  const drained = await smsQueue.idle(15000);
  if (!drained) logger.warn('SMS queue still had work after 15s; those alerts stay PENDING and will be re-queued on next start');
  await realtime.close();

  if (server) {
    await new Promise((resolve) => server.close(resolve));
    logger.info('HTTP server closed');
  }

  await Promise.allSettled([oracle.close(), mysqlDb.close()]);
  giveBackPortToService();
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal).catch((err) => {
      logger.error('Shutdown failed:', err.message);
      process.exit(1);
    });
  });
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason instanceof Error ? reason.message : reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err.message, err.stack);
  // Non-zero: the supervisor's log should record this as a fault, not as a
  // clean stop someone asked for.
  shutdown('uncaughtException', 1).catch(() => process.exit(1));
});

bootstrap().catch(async (err) => {
  logger.error(`Startup failed: ${logger.describe(err)}`);
  // The pools are usually already open by the time startup fails, and the
  // monitor was never started, so this is a plain resource close rather than a
  // full shutdown.
  monitor.stop();
  await Promise.allSettled([oracle.close(), mysqlDb.close()]);
  process.exit(1);
});
