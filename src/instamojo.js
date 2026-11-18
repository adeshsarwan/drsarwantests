// Instamojo payment gateway (API v2, OAuth client credentials).
// Secrets (Cloudflare → Worker → Settings → Variables and Secrets):
//   INSTAMOJO_CLIENT_ID, INSTAMOJO_CLIENT_SECRET – Instamojo dashboard → API & Plugins → "Generate credentials"
//   INSTAMOJO_SALT – the "Private salt" on the same page (checks that webhook calls really come from Instamojo)
// Variable INSTAMOJO_ENV = "test" uses test.instamojo.com (sandbox); anything else = live.
// INSTAMOJO_URL overrides the base URL (local testing only).

export const imConfigured = (env) => !!(env.INSTAMOJO_CLIENT_ID && env.INSTAMOJO_CLIENT_SECRET);
export const imIsTest = (env) => String(env.INSTAMOJO_ENV || "").toLowerCase() === "test";
const base = (env) => (env.INSTAMOJO_URL || (imIsTest(env) ? "https://test.instamojo.com" : "https://api.instamojo.com")).replace(/\/+$/, "");

let tok = null; // { key, value, exp }
async function token(env) {
  const key = env.INSTAMOJO_CLIENT_ID + "|" + base(env);
  if (tok && tok.key === key && tok.exp > Date.now() + 60000) return tok.value;
  const r = await fetch(`${base(env)}/oauth2/token/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.INSTAMOJO_CLIENT_ID, client_secret: env.INSTAMOJO_CLIENT_SECRET }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Instamojo sign-in failed (${r.status}${j.error ? ": " + (j.error_description || j.error) : ""}). Check INSTAMOJO_CLIENT_ID / SECRET${imIsTest(env) ? " (test keys)" : ""}.`);
  tok = { key, value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return tok.value;
}

async function call(env, method, path, form) {
  const t = await token(env);
  const r = await fetch(`${base(env)}${path}`, {
    method,
    headers: { authorization: `Bearer ${t}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) tok = null;
  if (!r.ok) {
    const msg = typeof j === "object" ? Object.entries(j).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(" ") : typeof v === "object" ? JSON.stringify(v) : v}`).join("; ") : "";
    throw new Error(`Instamojo ${r.status}${msg ? " – " + msg : ""}`);
  }
  return j;
}

// A payment request = a hosted payment page for one booking.
export async function imCreateRequest(env, { amount, purpose, name, phone, email, redirectUrl, webhookUrl }) {
  const form = {
    amount: String(amount), purpose: String(purpose).slice(0, 30), buyer_name: String(name || "").slice(0, 100),
    phone: phone ? "+91" + phone : "", redirect_url: redirectUrl, send_email: "false", send_sms: "false", allow_repeated_payments: "false",
  };
  if (email) form.email = email;
  if (webhookUrl && /^https:\/\//.test(webhookUrl)) form.webhook = webhookUrl; // Instamojo only calls public https URLs
  const j = await call(env, "POST", "/v2/payment_requests/", form);
  if (!j.id || !j.longurl) throw new Error("Instamojo didn't return a payment page");
  return { id: j.id, url: j.longurl, raw: j };
}

export const imGetRequest = (env, id) => call(env, "GET", `/v2/payment_requests/${encodeURIComponent(id)}/`);
export const imGetPayment = (env, id) => call(env, "GET", `/v2/payments/${encodeURIComponent(id)}/`);

// Was this payment successful, for this payment request, for at least this amount?
export function imPaymentOk(p, requestId, amount) {
  if (!p) return { ok: false, reason: "Payment not found" };
  const st = p.status;
  const success = st === true || /^(credit|success|successful|completed)$/i.test(String(st));
  const pr = String(p.payment_request || p.payment_request_id || "");
  if (requestId && pr && !pr.includes(requestId)) return { ok: false, reason: "Payment belongs to another payment request" };
  if (!success) {
    const f = p.failure || {};
    return { ok: false, reason: [f.reason, f.message].filter(Boolean).join(": ") || (st === false ? "Payment failed" : `Payment status: ${st}`) };
  }
  if (amount && Number(p.amount) + 0.001 < Number(amount)) return { ok: false, reason: `Paid ₹${p.amount}, expected ₹${amount}` };
  return { ok: true, amount: Number(p.amount), method: p.instrument_type || "" };
}

// Webhook check: HMAC-SHA1 over the values sorted by key (case-insensitive), joined with "|", key = private salt.
export async function imMacOk(env, fields) {
  if (!env.INSTAMOJO_SALT) return null; // can't check – the caller re-verifies with the API anyway
  const mac = String(fields.mac || "").toLowerCase();
  const keys = Object.keys(fields).filter((k) => k !== "mac").sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const msg = keys.map((k) => fields[k]).join("|");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.INSTAMOJO_SALT), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  const hex = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  return hex === mac;
}
