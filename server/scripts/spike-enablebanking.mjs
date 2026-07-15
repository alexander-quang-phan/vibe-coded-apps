// SPIKE — task 8.A0 (go/no-go). Throwaway; intentionally NOT committed.
// Proves the Enable Banking flow end-to-end with a real UK bank before any product code.
//
// Prereqs (see chat / spec §8 row A0):
//   1. Enable Banking account + application registered (redirect URL:
//      https://trim-budget.vercel.app/connect-bank/callback), private key downloaded.
//   2. In server/.env:
//        ENABLEBANKING_APP_ID=<application id>
//        ENABLEBANKING_PRIVATE_KEY_PATH=/absolute/path/to/private.pem
//
// Run from server/ (uses the already-installed `jose`):
//   node scripts/spike-enablebanking.mjs check                    # credentials work?
//   node scripts/spike-enablebanking.mjs banks                    # list UK banks
//   node scripts/spike-enablebanking.mjs connect "<Bank Name>"    # prints URL → open it, log in at your bank
//   node scripts/spike-enablebanking.mjs session <code>           # paste ?code=… from the redirect URL bar
//   node scripts/spike-enablebanking.mjs transactions <accountUid>  # last 30 days, booked only

import { readFileSync, existsSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';

const BASE = 'https://api.enablebanking.com';

// --- env (reads server/.env directly so the script has zero setup) ---
function loadEnv() {
  const path = new URL('../.env', import.meta.url);
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const APP_ID = process.env.ENABLEBANKING_APP_ID;
const KEY_PATH = process.env.ENABLEBANKING_PRIVATE_KEY_PATH;
if (!APP_ID || !KEY_PATH) {
  console.error('Missing ENABLEBANKING_APP_ID or ENABLEBANKING_PRIVATE_KEY_PATH in server/.env');
  process.exit(1);
}

// --- auth: RS256 JWT signed with the app's private key (kid = application id) ---
async function appJwt() {
  const key = createPrivateKey(readFileSync(KEY_PATH, 'utf8')); // handles PKCS#1 and PKCS#8 PEM
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: APP_ID })
    .setIssuer('enablebanking.com')
    .setAudience('api.enablebanking.com')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await appJwt()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    console.error(`${method} ${path} → HTTP ${res.status}`);
    console.error(JSON.stringify(json, null, 2));
    process.exit(1);
  }
  return json;
}

const [, , cmd, arg] = process.argv;

if (cmd === 'check') {
  const app = await api('GET', '/application');
  console.log('✅ Credentials work. Application:');
  console.log(JSON.stringify(app, null, 2));

} else if (cmd === 'banks') {
  const { aspsps } = await api('GET', '/aspsps?country=GB');
  console.log(`✅ ${aspsps.length} UK banks available:\n`);
  for (const a of aspsps) console.log(`  - ${a.name}`);

} else if (cmd === 'connect') {
  if (!arg) { console.error('Usage: connect "<Bank Name exactly as listed by `banks`>"'); process.exit(1); }
  const validUntil = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
  const res = await api('POST', '/auth', {
    access: { valid_until: validUntil },
    aspsp: { name: arg, country: 'GB' },
    state: `spike-${Date.now()}`,
    redirect_url: 'https://trim-budget.vercel.app/connect-bank/callback',
    psu_type: 'personal',
  });
  console.log('✅ Authorization started. Open this URL and log in at your bank:\n');
  console.log(res.url);
  console.log('\nAfter approving, the browser lands on trim-budget.vercel.app (page may 404 — fine).');
  console.log('Copy the `code` parameter from the URL bar, then run:');
  console.log('  node scripts/spike-enablebanking.mjs session <code>');

} else if (cmd === 'session') {
  if (!arg) { console.error('Usage: session <code from the redirect URL>'); process.exit(1); }
  const s = await api('POST', '/sessions', { code: arg });
  console.log(`✅ Session created: ${s.session_id}`);
  console.log('Consent valid until:', s.access?.valid_until ?? '(not returned)');
  console.log('\nAccounts:');
  for (const acc of s.accounts ?? []) {
    console.log(JSON.stringify(acc, null, 2));
  }
  console.log('\nPick an account uid, then run:');
  console.log('  node scripts/spike-enablebanking.mjs transactions <accountUid>');

} else if (cmd === 'transactions') {
  if (!arg) { console.error('Usage: transactions <accountUid>'); process.exit(1); }
  const dateFrom = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  let all = [];
  let ck;
  do {
    const q = new URLSearchParams({ date_from: dateFrom, ...(ck ? { continuation_key: ck } : {}) });
    const page = await api('GET', `/accounts/${arg}/transactions?${q}`);
    all = all.concat(page.transactions ?? []);
    ck = page.continuation_key;
  } while (ck);
  const booked = all.filter((t) => (t.status ?? 'BOOK') === 'BOOK');
  console.log(`✅ ${all.length} transactions since ${dateFrom} (${booked.length} booked):\n`);
  for (const t of booked) {
    const amt = t.transaction_amount ?? {};
    const desc = t.remittance_information?.join(' ') ?? t.creditor?.name ?? t.debtor?.name ?? '(no description)';
    console.log(
      `  ${t.booking_date ?? t.value_date}  ${t.credit_debit_indicator === 'CRDT' ? '+' : '-'}${amt.amount} ${amt.currency}` +
      `  ${desc}  [id: ${t.entry_reference ?? '⚠️ NO STABLE ID'}]`
    );
  }
  console.log('\nSpike checklist (spec §9):');
  console.log('  - Do rows show a stable id (entry_reference)? → decides hash-fallback frequency (item 4)');
  console.log('  - Note the consent valid_until from the session step (item 3)');

} else {
  console.log('Usage: node scripts/spike-enablebanking.mjs <check|banks|connect|session|transactions> [arg]');
}
