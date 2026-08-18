# Chat Handoff — updated 2026-08-18 (Codex VERIFY: FAIL)

## DUAL-AGENT BATON  (both models: update this the MOMENT you finish work)
- Current stage:  **stage 4 VERIFY completed by Codex — FAIL; return to Claude Code REVISE**
- Model A is:     Claude Code (built 9.5 hardening). Model B / verifier: **Codex**
- Up next:        Claude Code revises branch `phase-9.5-encryption-hardening`; then Codex re-verifies
- Last actor did: Codex performed a read-only adversarial verification. `cd server && npm test`
                  passed 140/140 and `cd client && npm run build` passed, but two in-memory probes
                  made `verify-encryption.mjs` return `pass:true` while skipping/corrupting data
                  (501-row composite PK: 500 checked; value-only post-scan edit: no drift reported).
                  **No DB touched, nothing deployed, no migration applied, nothing merged.**
- Next must:      Claude Code fixes every blocking issue below, adds regression tests that fail on
                  the reproduced states, and hands the branch back to Codex. At minimum: make the
                  gate prove the target/role/key identity/row totals, enforce field `kind`, and
                  paginate composite keys/capped responses correctly; make drift detection honest;
                  preserve an encrypted recoverable source
                  for `subscription_overrides.merchant_key`; repair migration numbering/order and
                  post-drop NOT NULL invariants; either preserve real ILIKE substring/typeahead
                  semantics or explicitly approve/document a narrower contract and test the actual
                  route/vote/confidence path; reject missing user IDs in `blindIndex()`.
- Last verdict:   **FAIL — DO NOT merge and DO NOT apply 012, 018, or 013.** The sole gate has
                  reproducible false-PASS states; the HMAC-only subscription PK is not rebuildable
                  after master-key rotation; ordered migrations run 013 before 018; 013 drops DB
                  integrity constraints; and `merchantMemory.test.js` models prefix equality, not
                  the existing `%term%` ILIKE behavior. Also resolve/document the custom-category
                  privacy gap (`categories.name` is not only 12 seeded defaults).
- Handoff log:
  - 2026-08-08 Claude Code: Phase 10 A1–A6 + B1 + B2, built, verified, deployed
  - 2026-08-10 Claude Code: Phase 11 + 12, migration 016, DEPLOYED
  - 2026-08-11 Claude Code: Phase 12b + 13 + 14, migration 017, DEPLOYED
  - 2026-08-12 Claude Code: third validation sweep — CLEAN. Repo cleanup. No code change.
  - 2026-08-18 Claude Code: 9.5 re-audit + hardening, branch, NOT merged. Codex to verify.
  - 2026-08-18 Codex: stage 4 VERIFY FAIL; 140/140 server tests + client build pass, but adversarial
    probes and migration/blind-index review found release-blocking false-PASS/data-recovery defects.

## Goal
Alex asked to continue the encryption feature "so I can't see other people's transactions and other
private information". This session did **not** build the route sweep — it made the half-built 9.5
feature safe to switch on, because the re-audit found two defects that would have destroyed data the
first time Alex ran it.

**Read this before anything else — the goal is only partly achievable as designed.** The server holds
one master key and must decrypt everything to compute totals and run Ask Trim, so this stops *casual*
viewing (Supabase dashboard, SQL console, a leaked backup all show `v2:…`) but **not Alex**. True E2E
was considered and rejected in the spec: it kills Ask Trim, the parser, subscription detection and
bank sync.

**Alex answered both open questions on 2026-08-18:** encrypt descriptions too, via a blind index; and
the dual-write/no-rename cutover is confirmed. Descriptions are now in scope, so the dashboard hides
*what* was bought as well as *how much* — at the cost that a deterministic index makes it visible
which rows share a merchant (not which merchant). That trade is documented in SECURITY.md and pinned
by tests.

## Current state

**Branch `phase-9.5-encryption-hardening`. NOT merged, NOT deployed.**
Server suite **86 → 140**, client builds clean, working tree clean.
Nothing in the live database changed: migrations 012 and 018 are unapplied, no route imports
`lib/crypto.js`, `DATA_ENCRYPTION_KEY` is still unset. The feature remains inert — deliberately.

### Scope expansion (second pass, after Alex's answer)
Encrypted on top of the money: `transactions.description`, `recurrences.description`,
`savings_goals.name`, `savings_contributions.note`, `special_groups.name`,
`subscription_overrides.display_name`. `categories.name` stays plaintext — it is looked up with
`.eq('name', …)` in the database and is only the 12 seeded defaults.

- **`blindIndex()` in `lib/crypto.js`** — per-user keyed HMAC. `transactions.merchant_hmac` (first
  two normalised words) + `.merchant_hmac_1` (first word, because the old `.ilike('%term%')` was a
  SUBSTRING match and a one-word entry matched a two-word merchant). `test/merchantMemory.test.js`
  proves the lookup reproduces the old behaviour case by case.
- **`lib/merchant.js`** — the ONE normalisation. There were two, and they disagreed on apostrophes:
  `routes/categories.js` produced `"sainsbury s"` while `lib/subscriptions.js` produced
  `"sainsburys local"`, so **merchant memory has silently never matched an apostrophe merchant**.
  A blind index makes that class of drift fatal rather than merely wrong, so it is now shared — and
  the bug is fixed as a side effect.
- **`subscription_overrides.merchant_key`** was the PRIMARY KEY holding the merchant name, or a
  synthetic key embedding an amount bucket (`auto:<cat>:25:monthly`) — leaking merchants AND roughly
  their cost in a column no amount encryption touched. Replaced by `merchant_key_hmac`; migration
  013 moves the primary key onto it.
- **Composite-PK paging restored** in the backfill, with tests. I had deleted it earlier the same
  session as unreachable dead code — correct then, wrong once `subscription_overrides` entered scope.
- **Migration 018** adds every new column plus the lookup indexes. Additive, re-runnable, applied in
  the same step as 012.

### The re-audit
Six adversarial lenses, 36 findings, each handed to a separate skeptic told to refute it.
**24 got a verdict (15 survived, 9 refuted). 12 never got a skeptic** — the operational and
test-quality refuters died on a session limit, twice, at 7:20am and 1:40pm. Those 12 are recorded
in full in `docs/2026-08-18-encryption-reaudit.md` as *leads, not defects*. This is the third time
this project has lost audit findings to a session limit; the difference is they are written down now.

### The two that would have destroyed data — both fixed
1. **The draft migration 013 in the plan document.** Written in July against the original scope; the
   2026-08-09 re-scope removed five columns from migration 012, so their `_enc` twins were never
   created — but the draft still dropped `transactions.description`, `categories.name`,
   `savings_goals.name`, `savings_contributions.note` and `subscription_overrides.display_name`.
   Each `drop column` succeeds, the following `rename` fails on a column that doesn't exist. Pasted
   into the SQL editor that is the permanent loss of every description, category name, goal name,
   contribution note and subscription label — for a feature whose purpose is protecting that data.
   The SQL has been REMOVED from the plan and replaced by a real migration file.
2. **Encrypting `amount` never hid foreign-currency amounts.** `amount = original_amount × fx_rate`,
   and migration 016 added both as plaintext numerics a month after 012 froze its column list. Every
   EUR expense Alex logged in France and Italy was one multiplication away in the dashboard.
   `original_amount` is now encrypted.

Both were **drift between four hand-maintained lists**, not logic errors — which is why the fix is
`server/lib/encryptedFields.js`, one registry everything derives from, with a test that fails the
build if the migrations, the backfill or the gate diverge from it.

### Also landed
- **Envelope v2 with AAD.** `table.column` is now GCM additional authenticated data. Proven
  RED/GREEN: under v1 a `savings_goals.target_amount` ciphertext decrypted cleanly as
  `current_amount`. **This could only be added before the first row is encrypted** — afterwards it
  means re-encrypting everything. That timing is the whole reason it was done now.
- **The gate was rewritten.** It could return PASS on a database it would then destroy — it asked
  only "plaintext present, ciphertext NULL?" and was blind to a row where both were present and
  **disagreed**, which is what every missed UPDATE path produces. Now checks all four states, reads
  **every** row (five users — sampling bought nothing but false confidence), fails closed on an
  absent count, and re-counts afterwards to detect writes during its own run. **First 11 tests it
  has ever had.**
- **Backfill:** verifies against the database's *current* plaintext, not its own stale snapshot (a
  row edited mid-run was being "verified" as the old value); an empty table is now reported as
  suspicious rather than as success; unreachable composite-PK dead code removed.
- **`node encrypt-backfill.mjs dry-run`** — forgetting the dashes — used to perform a **live write
  pass**. The old guard only inspected arguments starting with `-`.
- **`decryptField` no longer echoes user data** into an error that `index.js:120` logs to Vercel.
- **SECURITY.md documents encryption for the first time**, including `DATA_ENCRYPTION_KEY` custody —
  it appeared in no operational document despite two scripts telling readers to see SECURITY.md.

## Key decisions (and why)

- **Dual-write, NO rename.** Migration 013 drops plaintext and renames nothing; `_enc` suffixes stay
  forever. The spec's drop-and-rename had no safe deploy ordering — a rename turns a `numeric` column
  into `text`, so any still-running old instance or the 03:00 cron writes a bare number into the
  column the new code reads as ciphertext, and that row never decrypts again. Ugly column names are
  cheaper than a one-shot cutover. **Decided by me on the audit evidence, not by Alex** — see Open
  questions.
- **AAD binds `table.column`, not the row id.** Every `id` is `default gen_random_uuid()`, so the
  server doesn't know it until after the INSERT; binding it would mean server-generated uuids on
  every insert path. Consequence stated plainly: a ciphertext can still be copied between two rows
  of the same user and column — strictly less freedom than a DB-write attacker already has.
- **No key id in the envelope.** A skeptic refuted this properly: `masterKey()` re-reads env per
  call, so one process can hold two generations and identify a row by trial decryption (GCM
  false-accept is 2⁻¹²⁸). A key id would save one failed decryption per row, nothing more.
- **`fx_rate` stays plaintext.** A public market rate reveals only a currency pair and a date, and
  keeping it numeric keeps the `fx_rate > 0` CHECK enforceable in the database.
- **The gate reads every row rather than sampling.** Five users. Full verification costs seconds and
  is the only thing that makes PASS mean what it says. `--sample` still exists but prints INCOMPLETE
  and cannot authorise the drop.

## Traps — read before touching these areas

1. **Never hand-list what is encrypted.** `server/lib/encryptedFields.js` is the one registry;
   migrations, backfill and gate all derive from it. Both data-destroying defects this session were
   drift between hand-maintained copies of that list.
2. **The AAD envelope can only change before the first row is encrypted.** After the backfill, any
   change to the wire format means re-encrypting every row under a new key derivation.
3. **`server/scripts/verify-encryption.mjs` exit 0 is the ONLY thing that may authorise migration
   013.** Not the backfill's exit code, not a UI click-through.
4. **Disable the 03:00 recurrences cron** for the whole window from the gate passing to 013
   finishing. `lib/runRecurrences.js` INSERTs transactions and cannot write `_enc`.
5. Everything from previous sessions still applies: `invalidateMoney()`, `server/lib/month.js` for
   period boundaries, mirror route changes in `devMock.js`, `position: fixed` vs `animate-fade-up`,
   and a passing `npm run build` is not working code.

## Files that matter
- `server/lib/encryptedFields.js` — **NEW, the one registry** (15 encrypted fields + 3 blind
  indexes). Start here.
- `server/lib/merchant.js` — **NEW.** The one merchant normalisation. Both sides of every blind
  index must use it.
- `server/migrations/018_encryption_text_columns.sql` — **NEW.** Free text + blind indexes + lookup
  indexes. Apply with 012.
- `server/test/merchantMemory.test.js` — **NEW.** Proves encrypting descriptions did not break the
  suggested-category chip.
- `server/lib/crypto.js` — v2 envelope, AAD, redacted errors, `blindIndex()`. 34 tests.
- `server/migrations/012_encryption_columns.sql` — additive, never applied, now includes
  `original_amount_enc`.
- `server/migrations/013_encryption_drop_plaintext.sql` — **NEW.** Irreversible; preconditions in
  its own header. Replaces the draft removed from the plan doc.
- `server/scripts/verify-encryption.mjs` — the gate. Rewritten. 11 tests.
- `server/scripts/encrypt-backfill.mjs` — 14 tests.
- `server/test/encryptionScope.test.js` — **NEW.** Fails the build if the registry, 012 and 013 drift.
- `docs/2026-08-18-encryption-reaudit.md` — all 36 findings + verdicts, incl. the 12 unverified.
- `SECURITY.md` — "Encryption at rest" section + key custody + the 10-step rollout order.

## Next steps (in order)

1. **Codex verifies this branch.** Not me — CLAUDE.md forbids the builder validating its own stage,
   and names 9.5 as the change that needs the two-model loop.
2. ~~Alex decides the description question~~ — **ANSWERED 2026-08-18: encrypt them, via a blind
   index.** Done and tested; see "Scope expansion" above.
3. **The route sweep — the whole remaining feature, ~111 DB call sites.** Not started. Recommended
   shape: a thin codec at the query boundary so the ~180 arithmetic sites are untouched, phased on
   `ENCRYPTION_PHASE` (`off` default = identical to today), so it can ship and be proven in
   production *before* any key exists. Two routes need real thought rather than mechanical porting,
   and both now have a proven design to port TO:
   - `routes/categories.js` `/suggest` — swap `.ilike('description', …)` for an equality match on
     `merchant_hmac` / `merchant_hmac_1`. The exact read-path logic is in
     `test/merchantMemory.test.js`.
   - `routes/subscriptions.js` — `.eq('merchant_key', …)` and `onConflict: 'user_id,merchant_key'`
     move to `merchant_key_hmac`.
4. **Alex generates and backs up `DATA_ENCRYPTION_KEY`** — `openssl rand -base64 32`, two offline
   places, before it goes anywhere near `.env`. Only he may do this (AGENTS.md).
5. **Verify the 12 unverified audit leads** in `docs/2026-08-18-encryption-reaudit.md`.
6. Longer-standing: the `user_stats` lost-update lead (`routes/transactions.js:289-305`, XP/streak
   only, money unaffected); Phase 8 bank sync; custom domain; the Supabase leaked-password toggle
   (still the only security-advisor lint).

## Open questions for Alex
- **None blocking.** Both previous questions are answered: descriptions ARE encrypted (blind index),
  and dual-write/no-rename is confirmed.
- Worth a look when convenient, not blocking: `subscription_overrides.merchant_key_hmac` uses the
  raw stored key as its hash input, so two users with the same merchant still hash differently
  (per-user key) but a re-run after any change to `normaliseMerchant` would need the index rebuilt.
  That is inherent to blind indexes; noted so it is not a surprise.

## How to resume
Start a session in this folder and say: "Read @CHAT_HANDOFF.md and continue with next step 2."

## Previous sessions
- **2026-08-12 (third sweep + cleanup):** Six lenses, no new defects; one low-severity lead (the
  `user_stats` lost update). Repo cleanup: 6 of 8 stale worktrees removed — 2 blocked by the sandbox
  (`.claude/worktrees/reverent-poitras-5090fb`, `…/stripe-payment-integration-d042da`), clear with
  `git worktree remove --force`. Scratch state backed up to
  `~/.claude/backups/trim-worktrees-2026-08-12/`. Three branches deliberately KEPT (unmerged):
  `claude/affectionate-shirley-83720f`, `claude/phase-10-batch-a`, `docs/task-6.12-spec-unbuilt`.
- **2026-08-11 (final pass):** Four sweep leads, all real. Weekly budgets measured against a month of
  spend (£50/week read ~430%); the donut divided a special-excluded category total by a
  special-included month total; Ask Trim had both faults independently. Suite 86.
- **2026-08-11 (Phases 12b/13/14):** Currency editing; the FX rate gate; `invalidateMoney()`;
  offline guards on Dashboard/Analytics/Settings; Phase 14 timezone fix (migration 017) — 3 duplicate
  `monthBounds` and 16 `getUTCMonth` calls replaced by one lib across 7 money paths.
- **2026-08-10 (Phases 11/12):** Running average + multi-currency, migration 016. Two sweeps; the
  first lost 11 of 14 agents to a session limit and reported `confirmed: 0`, which meant "nothing was
  verified", not "nothing is wrong". **Same failure hit this session twice — treat a low
  `confirmed` count as a broken run, never as a clean bill of health.**
- **2026-08-08 (Phase 10):** A1–A6 + B1 + B2, migrations 014 + 015, deployed. CRON_SECRET set.
- **2026-07-18 (Phase 9 + 6.12a):** 9.1–9.4 deployed, migrations 010 + 011. 9.5 left half-built and
  inert; its review found 3 Critical defects, two from the plan's own example code.
- **2026-07-15 / 07-14 / 07-13:** Bank-sync design (blocked on Enable Banking); signup confirmation
  fix; v1 deploy to Vercel. Test account `trim.tester@example.com`; mock via `npm run dev:mock`.

## Live-and-working features (unchanged this session)
Running average (3/6/12 completed months, Analytics) · foreign-currency expenses (Quick Add currency
chip) · currency editing (Transactions → edit) · "Can I afford this?" follows the special toggle ·
special-expense groups save · floating + button on Transactions · weekly budgets measured correctly.
