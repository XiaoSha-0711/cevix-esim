# Cevix eSIM

Global data eSIMs for Chinese-speaking travellers and people living abroad — one eSIM, 250+ countries and regions, 30-day plans.
Customers find Cevix through our Telegram channels (~10k members), buy on the Cevix website (Stripe checkout), and get their
eSIM QR code instantly on the order page and by email.

Built on the [Firsty eSIM API](https://developers.firsty.app/api-reference). Node >= 22, no dependencies.

## What's here

| Path | What it is |
|---|---|
| `src/firsty.js` | Firsty API client: token caching, retries with idempotency keys (a retry can never buy twice), and `orderEsimForCustomer()` — order eSIM → attach plan → return the LPA activation code. |
| `scripts/order-esim.js` | Order one eSIM for a customer from the terminal. |
| `test/` | `npm test` — uses a fake fetch, no network. |
| `web/index.html` | Clickable demo of the full purchase flow (Telegram post → website → checkout → QR code). Demo only, no charges. |

```sh
npm test
```

## Safety rules

- Every order names `esimVariant`. `sandbox` = free mock eSIM (never works on a phone).
  `travel_ota` = real, paid eSIM — only with `--allow-paid`, only when explicitly asked.
- Never order in a loop; the test account has a hard eSIM limit.
- Credentials come from the environment (`XS_FIRSTY_CLIENT_ID` / `XS_FIRSTY_CLIENT_SECRET`), never from the repo.

## Roadmap

1. Signed Firsty webhook receiver (HMAC + timestamp check), registration script, fixtures for every event type.
2. Order database and state machine; idempotent fulfilment.
3. Cevix storefront (mobile-first for Telegram's in-app browser) with Stripe checkout and UTM attribution per channel.
4. Order page + email delivery of QR codes; top-ups.
5. Monitoring, runbooks, CI.

Contributors (including AI agents) work with test keys only, have no production access, and cannot merge their own PRs.
