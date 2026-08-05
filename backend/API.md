# Zain Data Pool Monitor — API Reference

The monitor polls CBS every second and SMSes subscribers when they reach 50% and
100% of their offer's cap. This API is how offers are created, retuned and
inspected — without restarting the service or editing `.env`.

- **Base URL** — `http://localhost:5005/api`
- **Auth** — username and password on every request (HTTP Basic)
- **Content type** — `application/json`

---

## Authentication

Send your username and password with every request. Nothing else is needed —
there is no login step and no token to manage.

```bash
curl -u zainadmin:<your-password> http://localhost:5005/api/offers
```

**In Postman:** the *Authorization* tab → type **Basic Auth** → username
`zainadmin`, password `<your-password>`. Set it once on the collection and every
request inherits it.

Two routes are open and need no credential: `GET /api/health` and
`POST /api/auth/login`. Everything else returns `401` without one.

> **Change the seeded password.** On first start, while the `admins` table is
> empty, one account is created from `.env` — `zainadmin` / `admin@2026`. That
> default is committed in `.env.example`, so treat it as public until you rotate
> it with `POST /api/admins/password`. Seeding only ever runs while the table is
> empty, so a restart will not undo the rotation.

Passwords are stored as scrypt hashes. `POST /api/auth/login` also exists and
returns a 12-hour bearer token if you ever want one for an automated client — it
saves a password hash verification per request. It is entirely optional and the
rest of this document uses username and password throughout.

---

## Quick start

Three calls take you from a cold service to a live offer. An offer is a
**wallet**: one row carrying a name, a cap and two thresholds.

### 1. Push the offer, staged inactive

```bash
curl -u zainadmin:<your-password> -X POST http://localhost:5005/api/offers \
  -H 'Content-Type: application/json' \
  -d '{
    "WALLET_ID": "10271",
    "OFFER_NAME": "10GB Postpaid Pool",
    "POOL_CAP_GB": 10,
    "THRESHOLD_50_GB": 5,
    "THRESHOLD_100_GB": 10,
    "active": false
  }'
```

### 2. Check it matches real traffic

```bash
curl -u zainadmin:<your-password> http://localhost:5005/api/offers/10271/cdrs
# { "walletId":"10271", "cdrs":17560, "subscribers":89, "lastCdr":"2026-08-05 11:43" }
```

### 3. Activate it

```bash
curl -u zainadmin:<your-password> -X PATCH \
  http://localhost:5005/api/offers/10271/active \
  -H 'Content-Type: application/json' -d '{"active": true}'
```

> **Why stage it first.** Activating an offer makes every subscriber on that
> wallet first-seen at once. Bars they passed unobserved are recorded as
> `SKIPPED`, but *the most recent cap crossing still fires* — so a wallet whose
> subscribers are already over their cap sends a burst of 100% messages on the
> next cycle. Adding wallet `10489` on UAT (89 subscribers) queued **39 alerts
> immediately**. Staging lets you read the numbers before anyone is messaged.

---

## Offers

The wallet is the offer's identity. Re-posting the same wallet **updates** that
offer rather than creating a second one — a duplicate row would double every
alert for its subscribers.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/offers` | Create or retune an offer. One object, or an array. |
| `GET` | `/api/offers` | Every offer, with the exact SMS text each will send. |
| `GET` | `/api/offers/:walletId` | One offer. `404` if that wallet has none. |
| `GET` | `/api/offers/:walletId/cdrs` | Does this wallet match any CDRs right now? |
| `PATCH` | `/api/offers/:walletId/active` | Pause or resume one offer. |
| `DELETE` | `/api/offers/:walletId` | Remove an offer. Its alert history is kept. |

### POST /api/offers

**Request**

```json
{
  "WALLET_ID": "10271",
  "OFFER_NAME": "10GB Postpaid Pool",
  "POOL_CAP_GB": 10,
  "THRESHOLD_50_GB": 5,
  "THRESHOLD_100_GB": 10,
  "active": true
}
```

**Response `201`**

```json
{
  "ok": true,
  "count": 1,
  "offers": [{
    "id": 1,
    "walletId": "10271",
    "offerName": "10GB Postpaid Pool",
    "poolCapGb": 10,
    "threshold50Gb": 5,
    "threshold100Gb": 10,
    "active": true,
    "messagePreview": {
      "50":  "Dear Valued Customer, you have used 50% of your 10GB Postpaid Pool data bundle. Please recharge and dial *190# ...",
      "100": "Dear Valued Customer, you have used 100% of your 10GB Postpaid Pool data bundle. Please recharge and dial *190# ..."
    },
    "created": true
  }]
}
```

Post an **array** to push several at once. All are validated *before* any is
written, so a bad third entry cannot leave the first two applied. Changes are
live on the next polling cycle — no restart.

### DELETE /api/offers/:walletId

The alert history under that wallet is deliberately left behind. It is the record
of what was already sent, and deleting it would let a re-added offer announce
every threshold again.

---

## Fields and aliases

Both the `.env`-style names and camelCase are accepted, so a request can be
pasted together from either without a translation step.

| Field | Also accepted | Type | |
| --- | --- | --- | --- |
| `WALLET_ID` | `walletId`, `wallet_id` | numeric string | **required** |
| `OFFER_NAME` | `offerName`, `offer_name`, `name` | string ≤ 128 | **required** |
| `POOL_CAP_GB` | `poolCapGb`, `capGb` | number > 0 | **required** |
| `THRESHOLD_50_GB` | `threshold50Gb`, `threshold_50_gb` | number > 0 | **required** |
| `THRESHOLD_100_GB` | `threshold100Gb`, `threshold_100_gb` | number > 0 | **required** |
| `active` | `ACTIVE` | boolean | optional, defaults `true` |

### There is no message field

Both SMS are rendered from `SMS_TEMPLATE_50` and `SMS_TEMPLATE_100` in `.env`,
with `{offer}` replaced by that offer's `OFFER_NAME`:

```
OFFER_NAME = "10GB Postpaid Pool"

  -> Dear Valued Customer, you have used 50% of your 10GB Postpaid Pool data
     bundle. Please recharge and dial *190# to subscribe to our valid offers and
     internet services. Thank you for choosing Zain's service.
```

One reword applies to every offer at once, and no offer can drift into announcing
a cap it no longer has — which had already happened, with message text saying
"20 gb" while `POOL_CAP_GB` was `10`. The rendered text comes back as
`messagePreview`; read it before activating.

---

## Validation rules

Checked at the API rather than mid-cycle, so a bad offer is rejected while
someone is still looking at the screen. A `400` writes nothing at all.

| Rule | Why it exists |
| --- | --- |
| `POOL_CAP_GB` **must equal** `THRESHOLD_100_GB` | A round is one full cap, and the 100% alert is what closes it. If the top bar sits elsewhere, the round closes at a different point from the alert that closes it and the sequence stops lining up with the cap. |
| `THRESHOLD_50_GB` **below** `THRESHOLD_100_GB` | The 50% band runs from its own value up to the 100%. Equal values leave it empty — configured, expected by whoever set it, and unable to ever fire. |
| `OFFER_NAME` required | It is what the customer reads mid-sentence. Without it the SMS goes out with a hole in it. |
| `WALLET_ID` numeric and unique | Two rows for one wallet would double every alert. |

**`400` response**

```json
{
  "error": "Invalid offer(s) - nothing was written",
  "failures": [{
    "index": 0,
    "walletId": "10489",
    "problems": [
      "threshold50Gb (12) must be below threshold100Gb (8)",
      "poolCapGb (10) must equal threshold100Gb (8) - a round is one full cap, and the 100% alert is what closes it."
    ]
  }]
}
```

---

## Monitor control

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/monitor/start` | Begin polling. |
| `POST` | `/api/monitor/stop` | Pause polling. The HTTP server stays up — the fastest way to halt sending. |
| `POST` | `/api/monitor/run-once` | Run exactly one cycle across every active offer, and return the resulting status. |
| `POST` | `/api/sms/test` | Send one message: `{ "msisdn": "9XXXXXXXX", "message": "..." }` |

> `POST /api/sms/test` honours `DRY_RUN` and nothing else. With `DRY_RUN=false`
> it delivers a real SMS to a real handset.

---

## Reporting

`?wallet=` is optional while exactly one offer is active. With several it is
required — silently picking one would report the wrong offer's figures under the
right-looking heading.

| Endpoint | Returns | Hits Oracle |
| --- | --- | --- |
| `GET /api/health` | Oracle + MySQL reachability, monitor state (**open**) | yes |
| `GET /api/status` | Cycle counters, per-offer stats, queue depth, top usage | no |
| `GET /api/usage?wallet=` | Live per-subscriber totals and thresholds crossed | yes |
| `GET /api/usage/detailed?wallet=` | The original report query, split by usage type and bundle | yes |
| `GET /api/usage/snapshot` | Last cycle's cached snapshot | no |
| `GET /api/usage/stored?period=` | The persisted usage mirror | no |
| `GET /api/notifications?period=` | Alerts recorded for a month, plus a summary | no |
| `GET /api/status/stored` | Persisted status rows — one per offer | no |
| `GET /api/queue` | Delivery queue depth and counters | no |
| `GET /api/tables` | Which database and tables this service writes to | no |

`period` is `YYYY-MM` and defaults to the current cycle. `limit` caps rows at 5000.

---

## Admin accounts

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/auth/me` | Who the current credential belongs to. |
| `GET` | `/api/admins` | Accounts with last login. Never returns password hashes. |
| `POST` | `/api/admins` | Create an account: `{ "username": "...", "password": "..." }`, min 8 chars. |
| `POST` | `/api/admins/password` | Change a password: `{ "newPassword": "..." }`, defaults to your own account. |

```bash
curl -u zainadmin:<current-password> -X POST \
  http://localhost:5005/api/admins/password \
  -H 'Content-Type: application/json' -d '{"newPassword":"<new-password>"}'
```

---

## Alert statuses

Every alert is written to MySQL **before** the SMS is sent, so a crash
mid-delivery can never become a duplicate message. These are the states a row
moves through in `automation_notifications`.

| Status | Meaning | `gateway_response` |
| --- | --- | --- |
| `PENDING` | Slot claimed, handed to the delivery queue, not yet sent. | `null` |
| `SENT` | The gateway accepted it. | full reply |
| `FAILED` | Delivery failed. Retried on later cycles until the budget runs out. | error detail |
| `SKIPPED` | The bar was already behind the subscriber when the monitor first saw them. Recorded rather than announced, so the decision is auditable — and never sent. | `null` |

A `null` `gateway_response` on `SKIPPED` and `PENDING` rows is correct: no
message was sent, so there is no reply to record.

---

## Response codes

| Code | When |
| --- | --- |
| `200` | Success. |
| `201` | Offer or admin created. |
| `400` | Validation failed. The body names every problem; nothing was written. |
| `401` | Missing or wrong username/password. |
| `404` | No offer or admin for that identifier. |
| `409` | That admin username already exists. |
| `502` | The SMS gateway rejected a test message. |
| `503` | Health check only — Oracle or MySQL is unreachable. |

---

## Before you go live

**Two instances on one wallet must share one MySQL database.** The unique key is
the entire duplicate-SMS guarantee, and it only holds if both processes claim the
same row. Point a second instance at a different database and each keeps its own
idea of what has been sent — subscribers get two of everything.

**An offer is a wallet, not an account.** One wallet's subscribers routinely sit
under many different account codes — on UAT, wallet `10489` spans dozens of
accounts with a single subscriber each. CDRs are selected by `WALLET_ID_1_V`
alone; account code and name are resolved separately and carried for reporting
only.

**`DRY_RUN=true` is the safe rehearsal.** The monitor polls, evaluates every
threshold and writes to MySQL exactly as it would in production — it simply never
calls the gateway. Read `automation_notifications` afterwards to see precisely
who would have been messaged.
