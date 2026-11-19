import { test } from "node:test";
import assert from "node:assert/strict";
import { FirstyClient, orderEsimForCustomer, SANDBOX_PLAN } from "../src/firsty.js";

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const h = handlers.shift();
    const { status = 200, body = {}, headers = {} } = typeof h === "function" ? h(url, init) : h;
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
  };
  fn.calls = calls;
  return fn;
}

const esimResp = { status: 201, body: { data: { profileReference: "1234567890123456", esimReference: "123456000000000001", iccid: "8901", activationCode: "LPA:1$x$y", esimVariant: "sandbox", lifecycleStatus: "preactive" } } };
const pkgResp = { status: 200, body: { data: { packageReference: "SG050GB030DGLN_ABC", status: "pending" } } };

test("gets a token with client credentials and caches it", async () => {
  const f = fakeFetch([
    { body: { access_token: "T1", token_type: "Bearer", expires_in: 86400 } },
    esimResp, pkgResp,
  ]);
  const c = new FirstyClient({ clientId: "512039", clientSecret: "s", bearer: undefined, fetchImpl: f });
  await orderEsimForCustomer(c, { orderId: "o1", customerId: "cust1", esimVariant: "sandbox" });
  assert.equal(f.calls[0].url, "https://connect.test.firsty.app/api/v3/auth/token");
  assert.equal(f.calls[0].init.body.get("grant_type"), "client_credentials");
  assert.equal(f.calls.length, 3); // one token call only
  assert.equal(f.calls[1].init.headers.Authorization, "Bearer T1");
});

test("orders eSIM with explicit variant, then the 50 GB plan, with idempotency keys", async () => {
  const f = fakeFetch([esimResp, pkgResp]);
  const c = new FirstyClient({ bearer: "B", fetchImpl: f });
  const r = await orderEsimForCustomer(c, { orderId: "o2", customerId: "cust2", esimVariant: "sandbox" });
  const [e, p] = f.calls;
  assert.equal(e.url, "https://connect.test.firsty.app/api/v3/esims");
  assert.deepEqual(JSON.parse(e.init.body), { esimVariant: "sandbox", externalProfileId: "cust2" });
  assert.equal(e.init.headers["X-Idempotency-Key"], "xs-esim-o2");
  assert.equal(p.url, "https://connect.test.firsty.app/api/v3/profiles/1234567890123456/esims/123456000000000001/packages");
  assert.deepEqual(JSON.parse(p.init.body), { planReference: SANDBOX_PLAN, externalTransactionId: "o2" });
  assert.equal(p.init.headers["X-Idempotency-Key"], "xs-pkg-o2");
  assert.equal(r.sandbox, true);
  assert.equal(r.activationCode, "LPA:1$x$y");
});

test("refuses missing variant, paid variant without allowPaid, and other plans on sandbox", async () => {
  const c = new FirstyClient({ bearer: "B", fetchImpl: fakeFetch([]) });
  await assert.rejects(orderEsimForCustomer(c, { orderId: "o", customerId: "c" }), /esimVariant is required/);
  await assert.rejects(orderEsimForCustomer(c, { orderId: "o", customerId: "c", esimVariant: "travel_ota" }), /paid order/);
  await assert.rejects(orderEsimForCustomer(c, { orderId: "o", customerId: "c", esimVariant: "sandbox", planReference: "SG010GB030DGLN" }), /only take/);
});

test("retries 429 with the same idempotency key and surfaces problem documents", async () => {
  const f = fakeFetch([{ status: 429, headers: { "retry-after": "0" } }, esimResp,
    { status: 409, body: { code: "conflict", title: "Conflict", status: 409, detail: "nope" } }]);
  const c = new FirstyClient({ bearer: "B", fetchImpl: f });
  const err = await orderEsimForCustomer(c, { orderId: "o3", customerId: "c3", esimVariant: "sandbox" }).catch((e) => e);
  assert.equal(f.calls[0].init.headers["X-Idempotency-Key"], f.calls[1].init.headers["X-Idempotency-Key"]);
  assert.equal(err.status, 409);
  assert.equal(err.code, "conflict");
});
