#!/usr/bin/env node
// Order one eSIM + plan for a customer.
//   XS_FIRSTY_BEARER="$(firsty auth token)" node scripts/order-esim.js --customer cust-001 --variant sandbox
// Options: --order <id> (default: random), --plan <ref>, --lang <xx>, --dry-run, --allow-paid
import { parseArgs } from "node:util";
import { FirstyClient, orderEsimForCustomer, SANDBOX_PLAN, randomUUID } from "../src/firsty.js";

const { values: a } = parseArgs({
  options: {
    customer: { type: "string" },
    variant: { type: "string" },
    order: { type: "string" },
    plan: { type: "string", default: SANDBOX_PLAN },
    lang: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "allow-paid": { type: "boolean", default: false },
  },
});

if (!a.customer || !a.variant) {
  console.error("usage: order-esim.js --customer <id> --variant sandbox|travel_ota [--order id] [--plan ref] [--dry-run]");
  process.exit(2);
}
const orderId = a.order ?? `ord-${randomUUID()}`;

if (a["dry-run"]) {
  console.log(JSON.stringify({ dryRun: true, orderId, customerId: a.customer, esimVariant: a.variant, planReference: a.plan }, null, 2));
  process.exit(0);
}

const client = new FirstyClient({ env: "test" });
try {
  const r = await orderEsimForCustomer(client, {
    orderId, customerId: a.customer, esimVariant: a.variant, planReference: a.plan,
    languageCode: a.lang, allowPaid: a["allow-paid"],
  });
  if (r.sandbox) console.error("NOTE: sandbox eSIM — free mock data, it will NOT install or work on a phone.");
  console.log(JSON.stringify({ orderId, ...r }, null, 2));
} catch (err) {
  console.error(err.message, err.problem ? JSON.stringify(err.problem) : "");
  process.exit(1);
}
