'use strict';

/**
 * Keeps server.js alive without anyone watching it.
 *
 * The monitor is a permanently-running service: if it is not up, usage stops
 * being refreshed and threshold alerts are simply not sent. A bare
 * "node server.js" under Task Scheduler dies with the first unhandled fault and
 * stays dead, so the scheduled task starts this instead. It respawns the server,
 * backs off when the failure is immediate rather than hammering CBS and MySQL,
 * and keeps a log so an overnight restart can be explained after the fact.
 *
 *   node scripts/supervisor.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const SERVER = path.join(BACKEND, 'server.js');
const LOG_DIR = path.join(BACKEND, 'logs');
const PID_FILE = path.join(LOG_DIR, 'supervisor.pid');
// A listening socket is the single-instance lock. The scheduled task re-fires
// every five minutes to recover from a hard kill, and it cannot tell that the
// last launcher already left a supervisor running in the background - a pid file
// alone would not be enough, since a recycled pid reads as "still alive".
// Binding is atomic, and the OS releases it the moment the process dies.
// Kept one above the HTTP port so the pair stays obvious.
const LOCK_PORT = Number(process.env.SUPERVISOR_LOCK_PORT || 5005);
// Read from .env so it always matches the port server.js will try to bind.
require('dotenv').config({ path: path.join(BACKEND, '.env') });
const HTTP_PORT = Number(process.env.PORT || 5005);

// Backoff between restarts. A crash loop caused by, say, a bad password should
// not retry 60 times a minute.
const MIN_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;
// A child that lasted this long is considered healthy, so the next failure
// starts backing off from scratch instead of inheriting an old penalty.
const HEALTHY_UPTIME_MS = 120000;
const LOG_RETENTION_DAYS = 14;

fs.mkdirSync(LOG_DIR, { recursive: true });

let child = null;
let backoffMs = MIN_BACKOFF_MS;
let restarts = 0;
let shuttingDown = false;
let restartTimer = null;
let logStream = null;
let logDay = null;

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Returns the stream for today's log, rolling over at midnight. One file per day
 * keeps a long-running service from producing a single unopenable log.
 */
function stream() {
  const day = today();
  if (logStream && logDay === day) return logStream;

  if (logStream) logStream.end();
  logDay = day;
  logStream = fs.createWriteStream(path.join(LOG_DIR, `monitor-${day}.log`), { flags: 'a' });
  pruneOldLogs();
  return logStream;
}

function pruneOldLogs() {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400000;
  let files;
  try {
    files = fs.readdirSync(LOG_DIR);
  } catch {
    return;
  }
  for (const name of files) {
    if (!/^monitor-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const full = path.join(LOG_DIR, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {
      // A log we cannot stat or delete is not worth failing the service over.
    }
  }
}

function write(text) {
  try {
    stream().write(text);
  } catch {
    // Never let logging take the service down.
  }
}

// For the paths that exit immediately afterwards, where a buffered write would
// be lost.
function logSync(line) {
  try {
    fs.appendFileSync(path.join(LOG_DIR, `monitor-${today()}.log`), line);
  } catch {
    // Never let logging take the service down.
  }
  process.stdout.write(line);
}

function say(message) {
  const line = `${new Date().toISOString()} [SUPERVISOR] ${message}\n`;
  write(line);
  process.stdout.write(line);
}

/**
 * True when something else is already serving a healthy monitor on the HTTP
 * port - in practice a foreground "npm start" the operator is watching.
 *
 * Without this check the 5-minute task trigger would fight that session: a
 * supervisor starts, its server.js cannot bind, it exits, and the backoff loop
 * repeats for as long as someone is working. Standing down instead makes the
 * foreground run the owner while it lasts, and the next trigger picks the
 * service back up within five minutes of it ending. That is deliberately the
 * whole recovery mechanism: nothing has to be handed back by a wrapper that
 * might be killed before it can.
 */
function portOccupied() {
  return new Promise((resolve) => {
    const probe = net.connect({ host: '127.0.0.1', port: HTTP_PORT }, () => {
      probe.destroy();
      resolve(true);
    });
    probe.on('error', () => resolve(false));
    probe.setTimeout(2000, () => {
      probe.destroy();
      resolve(false);
    });
  });
}

function monitorAnswering() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: HTTP_PORT, path: '/api/health', timeout: 2000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).monitor === 'running');
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// start() is async only because of the port check; a failure there must not
// become an unhandled rejection that kills the supervisor outright.
function onStartFailed(err) {
  say(`could not start server.js: ${err.message} - retrying in ${Math.round(backoffMs / 1000)}s`);
  restartTimer = setTimeout(() => { start().catch(onStartFailed); }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

async function start() {
  restartTimer = null;

  // The TCP check is the authoritative one. Basing this on /api/health alone
  // meant one slow or missed reply let the supervisor spawn a server that could
  // not bind, then crash-loop against the port for as long as the other instance
  // lived. If anything at all is listening, spawning cannot succeed - so stand
  // down and let the trigger try again later.
  if (await portOccupied()) {
    const healthy = await monitorAnswering();
    say(
      `port ${HTTP_PORT} is already served by ${healthy ? 'a healthy monitor' : 'another process'}` +
        ' - standing down, the task retries later'
    );
    shuttingDown = true;
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      // Already gone.
    }
    process.exit(0);
  }

  const startedAt = Date.now();

  child = spawn(process.execPath, [SERVER], {
    cwd: BACKEND,
    // The scheduled task runs without a console, so the child's output has
    // nowhere to go unless it is piped here and written to the log.
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', (chunk) => write(chunk.toString()));
  child.stderr.on('data', (chunk) => write(chunk.toString()));

  child.on('exit', (code, signal) => {
    child = null;
    if (shuttingDown) return;

    const uptimeMs = Date.now() - startedAt;
    if (uptimeMs >= HEALTHY_UPTIME_MS) backoffMs = MIN_BACKOFF_MS;

    restarts += 1;
    say(
      `server.js exited (${signal ? `signal ${signal}` : `code ${code}`}) after ` +
        `${Math.round(uptimeMs / 1000)}s - restart #${restarts} in ${Math.round(backoffMs / 1000)}s`
    );

    restartTimer = setTimeout(() => { start().catch(onStartFailed); }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  });

  child.on('error', (err) => {
    say(`could not spawn server.js: ${err.message}`);
  });

  say(`server.js started (pid ${child.pid})`);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  say(`${signal} received - stopping`);

  if (restartTimer) clearTimeout(restartTimer);
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Already gone.
  }

  if (!child) process.exit(0);

  // server.js closes its Oracle and MySQL pools on SIGTERM; give it a moment
  // before insisting.
  child.kill('SIGTERM');
  const force = setTimeout(() => child && child.kill(), 10000);
  child.on('exit', () => {
    clearTimeout(force);
    process.exit(0);
  });
}

// Deliberately kept referenced: it is the one handle guaranteed to hold the
// event loop open, so the supervisor cannot quietly exit between restarts.
const lock = net.createServer();

lock.on('error', (err) => {
  // Written synchronously: this process exits on the next line, and a buffered
  // stream write would never reach disk.
  const note = `${new Date().toISOString()} [SUPERVISOR] `;
  if (err.code === 'EADDRINUSE') {
    // Expected on every heartbeat launch while the service is healthy. Logged so
    // the file shows the check happening rather than going silent for hours.
    logSync(`${note}another supervisor already holds the lock - nothing to do\n`);
    process.exit(0);
  }
  logSync(`${note}lock failed: ${err.message}\n`);
  process.exit(1);
});

lock.listen(LOCK_PORT, '127.0.0.1', () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));

  say(`supervisor up (pid ${process.pid}) - logs in ${LOG_DIR}`);
  start().catch(onStartFailed);
});
