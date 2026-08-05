# Zain Data Pool Monitor

Node.js backend that polls the CBS Oracle CDR table on an interval and SMSes any
subscriber on a monitored **offer** when their usage reaches 50% and 100% of that
offer's cap. Each subscriber receives each alert **at most once per offer per
calendar month**, enforced by a unique key in MySQL.

An offer is a **wallet**: one row in `offers_info` carrying a name, a cap and two
thresholds. Offers are pushed in over the API, and the poller picks them up on the
next cycle - no restart, no `.env` edit.

## How it works

```
every POLL_INTERVAL_MS
  |
  '-- for each active row in offers_info:
        |-- Oracle : SUM(DATA_VOLUME_UPLOADED_N) per SERVICE_IDENTIFIER_V
        |            WHERE WALLET_ID_1_V = <this offer's wallet>
        |-- MySQL  : load the alerts already recorded for this wallet this month
        |
        '-- for each subscriber, for each crossed threshold not yet alerted:
              1. INSERT a PENDING row  (the unique key is what prevents a second SMS)
              2. POST to the Floodwave gateway
              3. UPDATE the row to SENT or FAILED
```

Offers are polled in sequence, not in parallel: each is a CBS query taking
seconds, and firing them together would multiply the load on a database this
service is only a guest on. One offer failing does not stop the others.

The row is written **before** the SMS is sent, so a crash mid-delivery can never
turn into a duplicate message. A failed delivery is retried on later cycles up to
`SMS_MAX_RETRY_CYCLES`, then abandoned for the month.

## Setup

```bash
cd backend
npm install
# review .env, then:
npm start
```

The `automations` database and all three tables are created automatically on every
startup if they are missing — nothing has to be provisioned by hand.
`sql/schema.sql` holds the same DDL for DBA review.

| Table | Holds |
| --- | --- |
| `automation_notifications` | every alert sent, one row per subscriber per threshold per cycle |
| `automation_status` | live health of the poller — one row, upserted as it runs |
| `automation_usage` | latest usage per subscriber, mirrored from CBS for the web app |

Table names are configurable via `MYSQL_TABLE_NOTIFICATIONS`, `MYSQL_TABLE_STATUS`
and `MYSQL_TABLE_USAGE`. If a table named `sms_notifications` is found from an
earlier version, it is renamed on startup rather than dropped, so alert history
survives and already-notified subscribers are not alerted twice.

`DRY_RUN=true` is the shipped default: alerts are evaluated and recorded, but no
SMS leaves the box. **Set `DRY_RUN=false` to go live.**

## Running it as a service

`npm start` runs it in your terminal, which is fine while you are watching it but
stops when you close the window. In production it runs unattended:

```powershell
cd backend
npm run install-autostart     # register and start it
npm run uninstall-autostart   # stop it and remove the task
```

That registers a **`ZainDataPoolMonitor`** scheduled task under the current user —
no administrator rights, no stored password. It runs
`scripts/start-hidden.vbs` → `scripts/supervisor.js` → `server.js`, with:

- **Two triggers.** At logon, plus a repeat every 5 minutes so the service comes
  back after a hard kill without anyone logging in to restart it.
- **A single-instance lock.** The launcher exits immediately (that is what keeps
  the console window hidden), so the task always reads as "not running" and the
  5-minute trigger would otherwise stack up a new supervisor every time. The
  supervisor binds `127.0.0.1:5005` instead — an atomic OS-level lock, immune to
  the recycled-pid problem a pid file has. A duplicate launch logs one line and
  exits.
- **Restart with backoff.** `server.js` is respawned on any exit, backing off 2s →
  60s so a crash loop does not hammer CBS and MySQL. A child that survived two
  minutes resets the backoff.
- **Daily logs** in `backend/logs/monitor-<date>.log`, pruned after 14 days.

Check it is alive with `curl http://localhost:5005/api/health`, or
`Get-ScheduledTask ZainDataPoolMonitor`. Set `SUPERVISOR_LOCK_PORT` if 5005 is
taken. Run the supervisor in the foreground with `npm run service`.

### Running it in your terminal

`server.js` is the **only** entry point. `npm start` is exactly `node server.js`
and `npm run dev` adds `--watch`; no wrapper script sits in front of either, so
a process manager supervises the server itself rather than an npm shim two hops
away:

```bash
pm2 start server.js --name autob
```

On Windows it still just works while the service holds the port, because the
takeover lives inside `server.js`:

```powershell
npm start
# [WARN] Port 5005 is held by the ZainDataPoolMonitor service - taking it over for this run
# [INFO] HTTP server listening on http://localhost:5005
```

It only ever stops **our own** scheduled-task service: the port owner must be a
child of the pid in `logs/supervisor.pid`, so a port held by an unrelated
process is reported, never killed. And `TAKEOVER_PORT=false` turns the
behaviour off so a clash becomes a plain startup failure. On Linux none of it
runs. Only one monitor polls CBS at a time either way; two would double the query
load and both write the usage table.

The scheduled task is **never disabled** to achieve this. An earlier version
disabled it and re-enabled it on exit, until the wrapper was killed outright and
the task stayed disabled — alerting silently stopped, and nothing said so. Now
the trigger stays armed and the *supervisor* stands down: before spawning it
checks whether anything is listening on the port and exits if so. The guarantee
therefore lives in the trigger, which cannot be lost:

- Stop the foreground run normally → it starts the service again on exit.
- Kill it, close the window, pull the plug → the 5-minute trigger brings the
  service back on its own.

To run alongside the service instead of taking over, pick another port:
`$env:PORT=<another-port>; npm start`. Duplicate SMS are impossible either way — the MySQL
claim is what authorises a send, so whichever instance claims first is the only
one that sends.

`npm run logs` tails the service's log without disturbing it.

## Authentication

Send a username and password with every request — no login step, nothing to keep
track of. In Postman: *Authorization* → **Basic Auth**, set once on the collection.

```bash
curl -u zainadmin:<password> localhost:5005/api/offers

# rotate the password (a rotation is never undone by a restart)
curl -u zainadmin:<password> -X POST localhost:5005/api/admins/password \
     -H 'Content-Type: application/json' -d '{"newPassword":"..."}'
```

Every route needs it except `GET /api/health` and `POST /api/auth/login`. On
first start, while the `admins` table is empty, the default from `.env` is
created — `zainadmin` / `admin@2026`. **Change it**: that value is committed in
`.env.example`, so treat it as public until rotated.

`POST /api/auth/login` also returns a 12-hour bearer token if you want one for an
automated client — it saves a password hash verification per request. Optional;
username and password work everywhere.

Passwords are scrypt hashes; tokens are HMAC-SHA256 signed with `AUTH_SECRET`.
No extra npm dependency — both come from Node's `crypto`.

Full endpoint reference: **[API.md](API.md)**.

## Managing offers

```bash
curl -u zainadmin:admin@2026 -X POST localhost:5005/api/offers \
  -H 'Content-Type: application/json' -d '{
    "WALLET_ID": "10271",
    "OFFER_NAME": "10GB Postpaid Pool",
    "POOL_CAP_GB": 10,
    "THRESHOLD_50_GB": 5,
    "THRESHOLD_100_GB": 10
  }'
```

camelCase (`walletId`, `poolCapGb`, …) is accepted too. Send an array to push
several at once — they are all validated before any is written, so a bad third
entry cannot leave the first two applied.

**No message text is supplied per offer.** Both SMS are rendered from
`SMS_TEMPLATE_50` / `SMS_TEMPLATE_100` in `.env`, with `{offer}` replaced by
`OFFER_NAME`. The response returns the exact rendered text as `messagePreview`.
This is why `OFFER_NAME` is required — it is what the customer reads.

Pushing the same wallet again **updates** that offer rather than adding a second
one; the wallet is the offer's identity. `POOL_CAP_GB` must equal
`THRESHOLD_100_GB`: a round is one full cap, and the 100% alert is what closes it.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/login` | exchange username + password for a bearer token |
| GET | `/api/health` | Oracle + MySQL connectivity (open, no credential) |
| GET | `/api/status` | poller stats, window, per-offer counters, top usage |
| GET | `/api/offers` | every offer, with its rendered message preview |
| GET | `/api/offers/:walletId` | one offer |
| POST | `/api/offers` | create or retune offer(s) |
| PATCH | `/api/offers/:walletId/active` | pause or resume one offer |
| DELETE | `/api/offers/:walletId` | remove an offer (its alert history is kept) |
| GET | `/api/offers/:walletId/cdrs` | does this wallet match any CDRs right now? |
| GET | `/api/usage?wallet=...` | live per-subscriber totals and thresholds crossed |
| GET | `/api/usage/detailed?wallet=...` | the original report query (per usage type / bundle) |
| GET | `/api/usage/snapshot` | last cycle's cached snapshot, no DB hit |
| GET | `/api/notifications?period=YYYY-MM&wallet=...` | alerts recorded for a cycle |
| GET | `/api/status/stored` | the persisted status row(s), one per offer |
| GET | `/api/usage/stored?period=YYYY-MM` | the persisted usage mirror, no Oracle hit |
| GET | `/api/tables` | which database and tables this service writes to |
| POST | `/api/monitor/start` \| `/stop` \| `/run-once` | control the poller |
| POST | `/api/sms/test` | send one SMS (`{"msisdn":"...","message":"..."}`) |
| GET | `/api/admins` | list admin accounts |
| POST | `/api/admins` | create an admin |
| POST | `/api/admins/password` | change a password |

`?wallet=` is optional while exactly one offer is active; with several it is
required, because silently picking one would report the wrong offer's figures
under the right-looking heading.

## Live feed (WebSocket)

`ws://localhost:5005/ws` — a client receives a `snapshot` on connect and every
event thereafter, so a dashboard stays current without polling.

Events: `snapshot`, `cycle`, `cycle.failed`, `usage.updated`,
`threshold.crossed`, `sms.sent`, `sms.failed`, `monitor.started`,
`monitor.stopped`. `threshold.crossed` and the usage frames carry `walletId`, so
a dashboard can tell the offers apart.

`usage.updated` is only pushed when a byte count actually moved, so idle seconds
do not flood clients with identical frames.

Commands, sent as JSON — include a `requestId` and it is echoed on the reply:

```json
{ "action": "status" }
{ "action": "start" }
{ "action": "stop" }
{ "action": "offers", "requestId": "abc" }
```

Offers are read-only over the socket. Changing one is an authenticated write, and
a socket that never presented a credential must not perform it.

## Why everything is scoped by wallet

Both tables are keyed by `(wallet_id, msisdn, …)` — deliberately **without**
`account_code`.

A pooled offer belongs to the wallet, and one wallet's subscribers routinely sit
under many different account codes: on the UAT data, wallet `10489` spans dozens
of accounts with a single subscriber each. Filtering CDRs by account would
therefore have monitored roughly one subscriber out of eighty-nine.

The scoping matters for correctness, not tidiness. A subscriber active on two
offers consumes each cap separately and is entitled to both sets of alerts;
within one offer they still get each alert exactly once. And because
`account_code` is no longer resolved at all, leaving it in the unique key would
split one subscriber's history the moment it came back empty — a split history is
how the same threshold gets announced twice.

## Configuration notes

**`USAGE_WINDOW`** decides what "usage so far" means:
- `MONTH` (default) — the monthly cycle described below.
- `DAY` — today only.
- `CUSTOM` — fixed `CUSTOM_FROM`/`CUSTOM_TO`, matching the original report script.

**`MONTH_RESET`** is where the monthly counter rolls over to zero:
- `LAST_DAY` (default) — 00:00 on the last day of the month: 31 Jul, 31 Aug,
  28 Feb (29 Feb in a leap year). The cycle covering most of July therefore runs
  `30 Jun 00:00 -> 31 Jul 00:00` and is keyed `2026-07`.
- `FIRST_DAY` — 00:00 on the 1st of the month, i.e. one day later.

The two differ by a full day of usage: under `LAST_DAY` the traffic on the last
day of a month counts toward the *next* cycle. Cycles are contiguous — each one
starts exactly where the previous ended, so no usage is double counted or lost.

The window and the de-duplication key are resolved together, so when the counter
resets every subscriber immediately becomes eligible for a fresh 50% and 100%
alert.

**Threshold units** — thresholds are configured in GB, but `POOL_CAP_MB`,
`THRESHOLD_50_MB` and `THRESHOLD_100_MB` override their GB counterparts when set.
Useful for lowering the bar during testing (e.g. 100 MB / 200 MB) without writing
awkward fractions. 1 GB = 1024 MB.

**Thresholds** are compared on raw bytes, not on the rounded `GBS_USED` column.
`ROUND(4.96, 1)` is `5.0`, which would otherwise fire the 50% alert about 40 MB
early. 1 GB = 1024³ bytes, matching the `/1024/1024/1024` in the query.

**Which threshold is due** is decided by the *band* the reading sits in, not by
how many bars it has passed:

| Usage in the current round | Sent |
| --- | --- |
| below `THRESHOLD_50_GB` | nothing |
| `>= THRESHOLD_50_GB` and `< THRESHOLD_100_GB` | the 50% message |
| `>= THRESHOLD_100_GB` (the cap) | the 100% message |
| beyond the cap | nothing, until the round rolls over |

So a subscriber whose usage lands straight above the cap gets the 100% **on its
own** — the 50% band was never occupied, and back-filling it a second before the
message that supersedes it helps nobody.

Only one threshold is ever due at a time, which is why `THRESHOLD_FIRE` and
`SEND_MISSED_THRESHOLDS` no longer change what is sent. They are still parsed so
an existing `.env` validates.

A higher threshold also never fires off the *same* usage reading as a lower one:
if the 50% went out at 6.2 GB, the 100% waits until the counter genuinely moves.

**`USAGE_PERSIST_MS`** (default 1000) — `automation_usage` is rewritten on this
cadence even when nothing moved, so `updated_at` proves the figures are live.
Without it an idle subscriber's row looks identical whether the monitor is
running or dead. `updated_at` is set explicitly rather than left to
`ON UPDATE CURRENT_TIMESTAMP`, which MySQL skips when every rewritten value is
unchanged.

**MSISDN format** — `SERVICE_IDENTIFIER_V` is stored locally (e.g. `912107968`).
Set `SMS_COUNTRY_CODE=249` if the gateway needs international format.

**Gateway headers** — the API key goes in the header named by
`FLOODWAVE_AUTH_HEADER` (`X-API-KEY`). Any other required headers go in
`FLOODWAVE_HEADERS` as a comma-separated list, e.g.
`X-Client-ID: 29, X-Service-Type: notification`. The client and service
identifiers travel as headers, not in the request body.

**Retry pacing** — a failed delivery is retried up to `SMS_MAX_RETRY_CYCLES`
times, but no more often than `SMS_RETRY_COOLDOWN_MS` (default 5 min). The
cooldown is essential at a 1-second poll: without it the entire retry budget is
spent in as many *seconds* as there are retries, so a brief gateway blip would
lose the alert for the whole month.

## Query change from the original script

The monitoring query is the supplied report query with `CALL_TYPE_V` and
`BUNDLE_NAME` removed from the `GROUP BY`. The alert rule is "this MSISDN reached
5 GB", which needs one total per subscriber; leaving those columns in splits each
subscriber across several rows (one per usage type and bundle), and no single row
would ever reach the cap. The per-bundle breakdown is still available unchanged at
`/api/usage/detailed`.

Date bounds are passed as `TO_DATE('YYYY-MM-DD HH24:MI:SS')` text rather than as
bound `Date` objects, so the window cannot shift if the Node host and the CBS host
disagree about the session time zone.

## Operational warnings

- **Adding an offer makes every subscriber on that wallet first-seen at once.**
  With `SKIP_PASSED_ON_FIRST_SIGHT=true` (the default) the bars they passed
  unobserved are recorded as `SKIPPED`, but *the most recent cap crossing still
  fires* — so a wallet whose subscribers are already over their cap produces a
  burst of 100% messages on the very next cycle. Adding wallet `10489` on UAT (89
  subscribers, most far past a 10 GB cap) queued **39 alerts immediately**.
  Push new offers with `"active": false`, check
  `GET /api/offers/:walletId/cdrs` and `GET /api/usage?wallet=...`, then activate
  — or run with `DRY_RUN=true` first and read `automation_notifications`.
- **Two instances on one wallet must share one MySQL database.** The unique key
  is the entire duplicate-SMS guarantee, and it only works if both processes
  claim the same row. Pointing a second instance at a different database gives
  each its own idea of what has been sent, and subscribers get two of everything.
- **The query counts `DATA_VOLUME_UPLOADED_N` only**, exactly as the supplied
  script does. If the pool is meant to bill uploaded **plus** downloaded volume,
  the sum is currently low and the alerts will fire late.
- **Thresholds are per subscriber, not per account.** As specified: each MSISDN is
  alerted when *its own* usage reaches 5 GB / 10 GB. If the 10 GB pool is actually
  shared across the whole account, the aggregation level needs to change.
- **Watch `POLL_INTERVAL_MS` as the pool grows.** Measured against UAT: ~70 ms per
  cycle for a small account (1–3 subscribers), but ~1–1.8 s for a 12-subscriber
  pool with several TB of history. At 1 s polling the second case queries CBS
  continuously. Cycles never overlap — a guard skips a tick while one is still
  running — so the effective interval is `max(POLL_INTERVAL_MS, query time)`.
  CDRs are batch-loaded into this table, so a 1 s poll rarely sees fresher data
  than a 30 s poll; raising the interval cuts CBS load proportionally.
- **The Floodwave API key is provisioned for the wrong service.** Live probing of
  `POST /api/v1/notify/notification` returns `401 UNAUTHORIZED` for every request
  shape and every destination MSISDN. The gateway's own replies show why:

  | `X-Service-Type` sent | Response |
  | --- | --- |
  | `notification` | "Client ID is not authorized for subscriber_lookup service" |
  | anything unrecognised | "Invalid service type requested. **Expected: subscriber_lookup**" |
  | `subscriber_lookup` | "Endpoint expects service type **'notification'**" |

  The key is bound to `subscriber_lookup`; the notify endpoint requires a key
  bound to `notification`. No request shape satisfies both — client ID 29 needs a
  notification-service key, or the notification permission added to this one.

  What *is* confirmed: `X-API-KEY` is the right auth header (the key is accepted
  and client 29 identified), and `X-Client-ID` must be a header — a `client_id`
  field in the body is ignored ("X-Client-ID header or client_id parameter is
  required"). Request assembly lives in `buildHeaders()` / `buildPayload()` in
  `src/services/smsService.js`; the body shape is the one part still unconfirmed,
  since no request has got past authorisation.
