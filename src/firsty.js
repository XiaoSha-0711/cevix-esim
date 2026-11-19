// Minimal Firsty Partners API v3 client for XS Network LLC's backend.
// Node >= 22 (global fetch). No dependencies.
//
// Credentials come from the environment, never from code:
//   XS_FIRSTY_CLIENT_ID / XS_FIRSTY_CLIENT_SECRET  client credentials (Integration page → API credentials)
//   XS_FIRSTY_BEARER                               dev only: a ready token, e.g. XS_FIRSTY_BEARER="$(firsty auth token)"
// We deliberately do NOT use FIRSTY_CLIENT_ID / FIRSTY_CLIENT_SECRET: the Firsty CLI
// refuses `firsty login` while those are set.

import { randomUUID } from "node:crypto";

export const BASE_URLS = {
  test: "https://connect.test.firsty.app/api/v3",
  live: "https://connect.firsty.app/api/v3",
};

// Variants we know about. `sandbox` is free mock data (never installs on a phone);
// `travel_ota` is a real eSIM charged to the balance.
export const FREE_VARIANTS = new Set(["sandbox"]);
export const PAID_VARIANTS = new Set(["travel_ota"]);

// For now sandbox eSIMs only take the 50 GB plan; the other test plans can't take packages yet.
export const SANDBOX_PLAN = "SG050GB030DGLN";

export class FirstyError extends Error {
  constructor(problem, status) {
    super(`${problem?.title ?? "Firsty API error"} (HTTP ${status})${problem?.detail ? `: ${problem.detail}` : ""}`);
    this.name = "FirstyError";
    this.status = status;
    this.code = problem?.code;
    this.problem = problem; // RFC 9457 problem document, incl. fieldErrors / requestId when present
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FirstyClient {
  constructor({
    env = "test",
    clientId = process.env.XS_FIRSTY_CLIENT_ID,
    clientSecret = process.env.XS_FIRSTY_CLIENT_SECRET,
    bearer = process.env.XS_FIRSTY_BEARER,
    fetchImpl = globalThis.fetch,
    maxRetries = 3,
  } = {}) {
    if (!BASE_URLS[env]) throw new Error(`unknown env ${env}`);
    this.env = env;
    this.baseUrl = BASE_URLS[env];
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
    this.maxRetries = maxRetries;
    this.token = bearer ? { value: bearer, expiresAt: Infinity } : null;
    if (!this.token && !(clientId && clientSecret)) {
      throw new Error("Set XS_FIRSTY_CLIENT_ID and XS_FIRSTY_CLIENT_SECRET (or XS_FIRSTY_BEARER for dev).");
    }
  }

  // POST /auth/token (form-encoded client credentials). Tokens live 24 h; cache and refresh 5 min early.
  async getToken() {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const res = await this.fetch(`${this.baseUrl}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new FirstyError(body, res.status);
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in - 300) * 1000,
    };
    return this.token.value;
  }

  // JSON request with retry on 429 / 503 / network errors. State-changing calls carry an
  // idempotency key, so retries can never create a second eSIM or package.
  async request(method, path, { body, idempotencyKey } = {}) {
    for (let attempt = 0; ; attempt++) {
      const headers = { Authorization: `Bearer ${await this.getToken()}`, Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
      let res;
      try {
        res = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (attempt < this.maxRetries && (idempotencyKey || method === "GET")) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw err;
      }
      const retryable = res.status === 429 || res.status === 503 || res.status === 423;
      if (retryable && attempt < this.maxRetries) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 && this.clientSecret && attempt === 0) {
        this.token = null; // token revoked or expired early: fetch a fresh one once
        continue;
      }
      const data = res.status === 204 ? null : await res.json().catch(() => null);
      if (!res.ok) throw new FirstyError({ ...data, requestId: data?.requestId ?? res.headers.get("x-request-id") }, res.status);
      return data;
    }
  }

  listPackagePlans(query = "") {
    return this.request("GET", `/catalog/packages${query}`);
  }

  // POST /esims — creates a profile and an eSIM. esimVariant is required by us (the API has no safe default).
  orderEsim({ esimVariant, externalProfileId, communicationLanguageCode }, idempotencyKey) {
    return this.request("POST", "/esims", {
      body: { esimVariant, externalProfileId, communicationLanguageCode },
      idempotencyKey,
    });
  }

  // POST /profiles/{p}/esims/{e}/packages
  orderPackage(profileReference, esimReference, { planReference, externalTransactionId }, idempotencyKey) {
    return this.request(
      "POST",
      `/profiles/${encodeURIComponent(profileReference)}/esims/${encodeURIComponent(esimReference)}/packages`,
      { body: { planReference, externalTransactionId }, idempotencyKey },
    );
  }

  getEsim(profileReference, esimReference) {
    return this.request("GET", `/profiles/${encodeURIComponent(profileReference)}/esims/${encodeURIComponent(esimReference)}`);
  }
}

// Business flow: order an eSIM for one customer order, put a plan on it, return what the
// customer needs (the LPA activation code) plus the references to store.
//
// orderId must be stable for this customer order (e.g. your DB order id): it seeds the
// idempotency keys, so retrying the same order never buys twice.
export async function orderEsimForCustomer(client, {
  orderId,
  customerId,
  esimVariant,
  planReference = SANDBOX_PLAN,
  languageCode,
  allowPaid = false,
}) {
  if (!orderId) throw new Error("orderId is required (stable per customer order)");
  if (!esimVariant) throw new Error("esimVariant is required: 'sandbox' (free, never works on a phone) or 'travel_ota' (real, paid)");
  const paid = client.env === "live" || PAID_VARIANTS.has(esimVariant) || !FREE_VARIANTS.has(esimVariant);
  if (paid && !allowPaid) {
    throw new Error(`Refusing a paid order (variant ${esimVariant}, env ${client.env}) without allowPaid: true`);
  }
  if (esimVariant === "sandbox" && planReference !== SANDBOX_PLAN) {
    throw new Error(`Sandbox eSIMs currently only take ${SANDBOX_PLAN}`);
  }

  const esim = (await client.orderEsim(
    { esimVariant, externalProfileId: customerId, communicationLanguageCode: languageCode },
    `xs-esim-${orderId}`,
  )).data;

  const pkg = (await client.orderPackage(
    esim.profileReference,
    esim.esimReference,
    { planReference, externalTransactionId: orderId },
    `xs-pkg-${orderId}`,
  )).data;

  return {
    sandbox: esim.esimVariant === "sandbox",
    profileReference: esim.profileReference,
    esimReference: esim.esimReference,
    iccid: esim.iccid,
    activationCode: esim.activationCode, // LPA string → QR code / install link for the customer
    lifecycleStatus: esim.lifecycleStatus,
    packageReference: pkg.packageReference,
    packageStatus: pkg.status, // "pending" until package.activated webhook
  };
}

export { randomUUID };
