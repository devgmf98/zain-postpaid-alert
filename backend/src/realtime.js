'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const config = require('./config');
const logger = require('./logger');
const monitor = require('./services/monitorService');

const PATH = '/ws';
const HEARTBEAT_MS = 30000;

let wss = null;
let heartbeat = null;

function send(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch (err) {
    logger.warn(`WebSocket send failed: ${err.message}`);
  }
}

function broadcast(payload) {
  if (!wss) return;
  const frame = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    try {
      client.send(frame);
    } catch (err) {
      logger.warn(`WebSocket broadcast failed: ${err.message}`);
    }
  }
}

/** The snapshot a client gets on connect, so it can render without polling. */
function snapshot() {
  return {
    type: 'snapshot',
    at: new Date().toISOString(),
    status: monitor.getStatus(),
    subscribers: monitor.getSnapshot(),
  };
}

/**
 * Commands a client may issue over the socket. Each returns the payload to send
 * back; throwing produces an error frame.
 */
const commands = {
  ping: () => ({ type: 'pong' }),
  status: () => snapshot(),
  start: () => ({ type: 'monitor.start.ack', result: monitor.start() }),
  stop: () => ({ type: 'monitor.stop.ack', result: monitor.stop() }),

  /**
   * The monitored pool is no longer a single runtime setting - it is whatever
   * offers_info holds, and each offer carries its own cap, thresholds and
   * templates. Changing it is an authenticated write, which a socket that never
   * asked for a credential must not perform.
   */
  offers: () => ({
    type: 'offers.info',
    message:
      'Offers are managed over HTTP: GET/POST /api/offers with an admin credential. ' +
      'Changes take effect on the next polling cycle.',
    offers: monitor.getStatus().offers,
  }),
};

async function handleMessage(socket, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return send(socket, { type: 'error', error: 'message must be JSON' });
  }

  const action = String(msg.action || '').toLowerCase();
  const handler = commands[action];
  if (!handler) {
    return send(socket, {
      type: 'error',
      error: `unknown action "${msg.action}"`,
      actions: Object.keys(commands),
    });
  }

  try {
    send(socket, { ...(await handler(msg)), requestId: msg.requestId });
  } catch (err) {
    send(socket, { type: 'error', error: err.message, requestId: msg.requestId });
  }
}

/**
 * Attaches the live socket to the running HTTP server. Clients receive a
 * snapshot on connect and every monitor event thereafter, so a dashboard stays
 * current without polling the REST API.
 */
function attach(server) {
  wss = new WebSocketServer({ server, path: PATH });

  wss.on('connection', (socket, req) => {
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    logger.info(`WebSocket client connected from ${req.socket.remoteAddress} (${wss.clients.size} total)`);
    send(socket, snapshot());

    socket.on('message', (raw) => handleMessage(socket, raw));
    socket.on('error', (err) => logger.warn(`WebSocket client error: ${err.message}`));
    socket.on('close', () => {
      logger.info(`WebSocket client disconnected (${wss.clients.size} remaining)`);
    });
  });

  // Drop clients that stopped responding, otherwise dead sockets accumulate and
  // every broadcast pays for them.
  heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  monitor.events.on('event', broadcast);

  logger.info(`WebSocket live feed on ws://localhost:${config.port}${PATH}`);
  return wss;
}

async function close() {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  monitor.events.off('event', broadcast);
  if (!wss) return;

  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
  wss = null;
  logger.info('WebSocket server closed');
}

module.exports = { attach, close, broadcast, PATH };
