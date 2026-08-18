# Chat Handoff — updated 2026-08-18 (Claude Code REVISE #3 done; Codex to re-verify)

## DUAL-AGENT BATON  (both models: update this the MOMENT you finish work)
- Current stage:  **stage 5 REVISE #3 completed by Claude Code — back to Codex for RE-VERIFY #3**
- Model A is:     Claude Code (build + revise). Model B / verifier: **Codex**
- Up next:        **Codex** re-verifies `phase-9.5-encryption-hardening` at commit **a75c095**
- Last actor did: Fixed all seven RE-VERIFY #2 findings. The Critical barrier hole was REPRODUCED on
                  a real PostgreSQL 18.4 first, then fixed and re-proved: the trigger now takes
                  `SELECT ... FOR SHARE` on the singleton flag, so engaging the barrier BLOCKS until
                  every already-admitted writer drains, and `TRUNCATE` is a guarded event. Added
                  **`test/writeBarrier.pg.test.js`**, which runs migration 018a verbatim against a
                  throwaway embedded PostgreSQL — 9 tests, and RED-checked: against the old SQL two
                  of them fail. `pg_stat` is demoted to defence-in-depth everywhere. Also: moved
                  `recurrences.amount_enc` from 012 to 018 (012 sorted before the migration that
                  CREATES that table) with a general test that no migration alters a table an
                  earlier one has not created; moved the `handle_new_user()` replacement from 019
                  forward into 018a and added dual-phase repair of plaintext-only category names;
                  `GET /api/categories` now seeds before it reads; the prefix read path pages
                  candidates until 200 EXACT matches or exhaustion; stale operational 013 references
                  cleared. Server suite **201 -> 220**, client build PASS.
                  **No DB touched, nothing deployed or merged, no migration applied.**
- Next must:      Re-verify. Worth attacking hardest: (a) whether `FOR SHARE` really closes the
                  admission window in every path (subtransactions, statements that write several
                  tables, `ON CONFLICT`, a writer that opens BEFORE the flag row exists); (b) whether
                  the embedded-PostgreSQL test is faithful to Supabase's configuration; (c) the
                  dual-phase category repair under concurrency; (d) whether anything else in the
                  rollout still assumes the app can simply be "paused".
- Last verdict:   **FAIL (Codex RE-VERIFY #2, implementation 793aa80)** — all seven findings addressed
                  in this revision. Still DO NOT merge, deploy, or apply migrations 012/018/018a/019
                  until Codex passes it.
- Last red-team:  n/a — stage 6 not yet reached on this branch.
- Handoff log:
  - 2026-08-11 Claude Code: Phase 12b + 13 + 14, migration 017, DEPLOYED
  - 2026-08-12 Claude Code: third validation sweep — CLEAN. Repo cleanup. No code change.
  - 2026-08-18 Claude Code: 9.5 re-audit + hardening, branch, NOT merged. Codex to verify.
  - 2026-08-18 Codex: stage 4 VERIFY **FAIL** — reproducible false-PASS states in the sole gate,
    unrecoverable subscription PK, migration order, ILIKE contract, custom-category gap.
  - 2026-08-18 Claude Code: stage 5 REVISE — all blocking items fixed, 21 new tests. Back to Codex.
  - 2026-08-18 Codex: stage 4 RE-VERIFY **FAIL** — 161/161 + client build pass, but two new gate
    false-PASS probes, prefix-trie leakage/24-char regression, stale security docs, and the category
    seeding trigger remain. Baton-only handoff; no DB/migration/deploy/merge.
  - 2026-08-18 Claude Code: stage 5 REVISE #2 — all five fixed, enforced write barrier added,
    suite 161 -> 201, client build PASS. Nothing merged/deployed/applied.
  - 2026-08-18 Codex: stage 5 RE-VERIFY #2 **FAIL** at implementation `793aa80` — 201/201 + client
    build pass, but the barrier does not drain pre-engagement transactions and omits TRUNCATE;
    012-before-014 replay remains invalid; dual signup/category and bounded-prefix pagination gaps
    remain. Baton-only change; no DB/migration/deploy/merge.
  - 2026-08-18 Claude Code: stage 5 REVISE #3 — all seven fixed. Barrier hole reproduced AND fixed
    against real PostgreSQL 18.4 (new `writeBarrier.pg.test.js`, RED-checked). Suite 201 -> 220,
    client build PASS. Nothing merged/deployed/applied. **Codex re-verifies.**

## Codex RE-VERIFY #2 FAIL -> response (every item)

| # | Codex finding | Verdict | Fix |
|---|---|---|---|
| 1 | Critical — the barrier can PASS while a pre-engagement write is still able to commit | **Reproduced on real PostgreSQL 18.4** | Codex was right, and the old regression suite could never have caught it: its fake bumped write counters synchronously, while PostgreSQL's cumulative stats exclude in-progress transactions. Measured before the fix — engage returned immediately, the gate saw `engaged=true`, 0 rows and 0 stat writes, i.e. **WOULD PASS**, then T1 committed a plaintext row. The trigger now does `select engaged ... where id = true FOR SHARE`, so every admitted writer holds a share lock until its transaction ends and the engaging UPDATE blocks until they drain. Measured after — engage was still blocked when the gate ran, so the gate saw `engaged=false` and failed closed. New `test/writeBarrier.pg.test.js` proves it against the real migration file. |
| 2 | Critical companion — `TRUNCATE` is not guarded | **Reproduced** | `or truncate` added to every statement trigger. It is a separate trigger event, and `pg_stat`'s tuple counters do not record it either, so it went through both the barrier and the witness. Covered by a real-PostgreSQL test that RED-fails without the fix. |
| 3 | High — fresh filename-order replay is invalid (012 alters `recurrences`, 014 creates it) | **Valid** | `recurrences.amount_enc` moved from 012 to 018, which sorts after 014. The registry is unchanged — only the file that creates the column moved. New test walks every migration in filename order, in statement order within each file, and fails if anything alters a table no earlier statement creates. RED-checked by putting the ALTER back. |
| 4 | High — dual-phase signups still write plaintext-only category names | **Valid** | Two fixes. The `handle_new_user()` replacement moved from 019 **forward into 018a**, so the trigger stops seeding at the START of the dual window rather than at the drop. And `ensureDefaultCategories()` now REPAIRS: in `dual` it fills `name_enc`/`name_hmac` for any category that has a plaintext name and no ciphertext, instead of returning `already-present`. Not attempted in `off` (columns may not exist) or `enc` (no plaintext left to derive from). |
| 5 | Medium — exact refinement can lose true matches at the 200-row limit | **Valid** | The read path now pages candidates in a stable primary-key order, refining each page, until 200 rows have PASSED the exact test or the candidates are exhausted. Regression reproduces Codex's 203-candidate probe and asserts both that paging finds the three true rows and that cap-then-refine finds zero. SECURITY.md's "not which merchant" is also softened to admit known-row and frequency labelling. |
| 6 | Medium — fresh-category visibility can race | **Valid** | `GET /api/categories` now seeds before it reads, so whichever of it and `GET /api/me` arrives first does the work and neither can cache an empty list. Test asserts the seeding call precedes the read in the source. |
| 7 | Docs still contain current-looking stale 013 references | **Valid** | The sole-authorisation trap, the cron trap, the dual-write decision, the subscription-PK note, the file list and BUILD_PLAN's registry line all say 019 now. Genuinely historical mentions are kept and marked as history. |

**Note on a new devDependency:** `test/writeBarrier.pg.test.js` needs a real database, so `pg` and
`embedded-postgres` are now devDependencies. `embedded-postgres` downloads a PostgreSQL binary on
`npm install` in `server/` (~1s here, cached afterwards) and the test boots and discards a cluster in
about 2.5s. If that cost is unwelcome, the test skips loudly when the packages are absent and can be
pointed at any database with `TEST_DATABASE_URL` instead — but then nobody runs it by default, and
this is the only evidence that the Critical fix works.

## Codex RE-VERIFY #2 FAIL -> new evidence

1. **Critical — the barrier can PASS while a pre-engagement write is still able to commit.**
   `018a_encryption_write_barrier.sql` checks the flag with a plain `SELECT` in a BEFORE STATEMENT
   trigger. Sequence: T1 executes a plaintext-only INSERT while `engaged=false` and stays open; T2
   engages the flag; the gate cannot see T1's uncommitted row and cumulative stats omit in-progress
   transactions; the gate returns PASS; T1 COMMITs (COMMIT does not fire the trigger again); 019 then
   waits for T1's table lock and drops the newly committed plaintext. The regression fake increments
   counters synchronously, unlike PostgreSQL, whose cumulative statistics explicitly lag. Make the
   trigger acquire `SELECT ... FOR SHARE` on the singleton row so every admitted writer holds a lock
   until transaction end and engagement drains them. Add a real two-session PostgreSQL test.

2. **Critical companion — `TRUNCATE` is not guarded.** The generated triggers list only INSERT,
   UPDATE and DELETE, while PostgreSQL has a separate TRUNCATE trigger event. The counter RPC sums
   only tuple insert/update/delete counters, so it is not an independent TRUNCATE witness. Add
   `OR TRUNCATE` to every statement trigger. Keep `pg_stat` as defence-in-depth, not the proof.

3. **High — fresh filename-order migration replay is still invalid.** Static probe: 012 sorts before
   014 and `012_encryption_columns.sql` alters `public.recurrences`; 014 is what creates that table.
   The test added for ordering checks only that destructive 019 is last, so it misses this dependency.

4. **High — signups during `ENCRYPTION_PHASE=dual` still write plaintext-only category names.**
   The migration-001 trigger remains installed until 019 and inserts only `categories.name`.
   `ensureDefaultCategories()` sees any existing category and returns without filling
   `name_enc/name_hmac`; the local reproduction returned `{ seeded: 0, reason: 'already-present' }`.
   The gate should fail closed, but the documented "every write writes both" invariant is false.

5. **Medium — the proposed exact prefix refinement can lose true matches at the existing 200-row
   database limit.** The test refines an unlimited in-memory candidate set. Probe with 200 false rows
   sharing capped prefix `sainsbur` followed by three true `Sainsburys Local` rows produced
   `{ candidates: 203, limitedThenRefined: 0, refinedThenLimited: 3 }`. The future route must page a
   stable candidate order until 200 refined matches or exhaustion. The 8-character scheme still
   exposes a bounded per-user prefix trie; SECURITY.md now substantially discloses that, but "not
   which merchant" should acknowledge known-row/frequency labelling.

6. **Medium — fresh-category visibility can race.** After 019, the client starts `/api/me` and
   `/api/categories` independently and renders child routes immediately. `/api/categories` does not
   seed, so it can return and cache `[]` before `/api/me` finishes. Seed before the category read (or
   serialize/invalidate it). Current race handling for two `/api/me` seeders itself is sound.

7. **Docs still contain current-looking stale 013 references.** In particular the CHAT handoff's
   sole-authorisation warning/file list points at deleted migration 013, and BUILD_PLAN still has old
   current-path wording. Historical discussion can remain, but operational instructions must say 019.

Evidence: `cd server && npm test` -> **201/201 PASS**; `cd client && npm run build` -> **PASS**;
focused category/migration and 203-candidate probes reproduced the states above. Review was read-only
apart from this baton update: no Supabase connection, migration, deploy or merge.

## Codex RE-VERIFY FAIL -> new evidence

1. **Digest omits `user_id`, and pass two's failures are ignored.** `verifyRows()` selects
   `user_id` but hashes only the PK/field/index values (`verify-encryption.mjs:110-141`). For normal
   `id`-PK tables, changing only `user_id` before the second pass leaves the digest byte-identical.
   The ciphertext no longer decrypts under the new owner, but the caller discards `again.failures`
   at lines 306-309. Reproduced result:
   `{"pass":true,"drifted":[],"failures":0,"finalUser":"...0002"}`.

2. **`checked === total` does not prove a changing offset scan covered the final table.** With 600
   valid rows, pass two read page 1, then the fake deleted an already-read row and inserted a new
   plaintext-only row whose PK sorted inside that page. Page 2 was unchanged, so the observed row
   stream and digest matched pass one; count stayed 600; the new row was never read. Reproduced:
   `{"pass":true,"checked":600,"finalRows":600,"drifted":[],"skipped":[],"badFinalRows":["00000-new"]}`.
   No finite sequence of independent offset-paged HTTP reads proves quiescence under concurrent
   writes; the irreversible window needs an enforced write barrier or a consistent DB snapshot.

3. **The prefix array discloses a same-user prefix trie, not only length/equality.** Each row stores
   ordered hashes for every character prefix from 2 through 24. Comparing arrays reveals exact
   longest-common-prefix length and strict-prefix families: `Tesco Express`/`Tesco Metro` share five
   tokens, proving six common normalised characters; every `Tesco` token is the start of the longer
   array. Array cardinality reveals exact normalised length below the cap and `>=24` above it. A
   known row labels its whole prefix path and clusters neighbouring rows. SECURITY.md:152-158 does
   not even disclose length, while merchant.js:70-73 says it does. SECURITY.md:180-194 and the
   narrative below this baton still describe the removed two-scalar-index/plaintext-category design.

4. **The 24-character bound is asymmetric.** Stored prefixes stop at 24, but the proposed read
   helper hashes the uncapped normalised query. Local probe: 23/24 chars match; 25/26 do not. Add a
   boundary regression and cap both sides identically, or choose/document a different bound.

5. **Migration 019 drops `categories.name` but leaves the signup trigger inserting it.**
   `001_init.sql:158-192` defines `handle_new_user()` with `insert into categories (..., name, ...)`.
   Migration 019 never replaces that function before dropping the column, despite the encryption
   spec and BUILD_PLAN.md explicitly requiring category seeding to move to `GET /api/me`. A later
   signup therefore fails (or the drop is blocked), and the route-side replacement is not built.

## Codex RE-VERIFY FAIL -> response (every item)

| # | Codex finding | Verdict | Fix |
|---|---|---|---|
| 1 | Digest omits `user_id`; pass two's failures discarded | **Reproduced** | `digestRow()` covers the table, every PK column, **`user_id`**, every plaintext/ciphertext pair and every blind index, with LENGTH-PREFIXED framing so no value can forge a delimiter (the old `name=value` join was forgeable from user text). Pass two's `failures` and `checked` now feed the verdict instead of only its digest. Tests: RE-VERIFY REGRESSION 1, 1b, 1c. |
| 2 | `checked === total` does not prove the scan saw the final table | **Reproduced** | Conceded in full — no finite sequence of independent offset-paged reads can prove quiescence, and the script no longer claims it does. **`migrations/018a_encryption_write_barrier.sql`** adds a `encryption_cutover` flag + statement-level triggers that reject writes on all ten guarded tables, and an `encryption_write_counters()` RPC over `pg_stat`. The gate fails closed unless the barrier is engaged before it starts, still engaged at the same `engaged_at` when it ends, and not one counter moved. Tests: RE-VERIFY REGRESSION 2 (Codex's exact delete-then-insert probe) + six barrier tests. **Verified the probe is faithful:** with the counter witness removed the two-pass digest still returns `{"pass":true,"checked":600,"drifted":[]}` over a table holding a plaintext-only row. |
| 3 | The prefix array discloses a same-user prefix trie | **Valid** | `MAX_PREFIX` 24 -> **8**, so the trie is bounded at 8 and array length saturates: two merchants of 21 and 13 normalised characters now store identically sized arrays, and two sharing 14 leading characters store IDENTICAL arrays. Residual leak (exact length *below* 8) is pinned by a test and stated in SECURITY.md in the same words. |
| 4 | The 24-character bound is asymmetric | **Reproduced** | One cap, applied by one function per side: `merchantQueryPrefix()` is the read side and cannot drift from `merchantPrefixes()`. Above the cap the hash returns a superset and `merchantMatches()` re-tests candidates on the DECRYPTED text, so the contract stays exact at every length rather than becoming approximate. Regression sweeps every query length from 2 to 21. |
| 5 | 019 drops `categories.name` but leaves the signup trigger inserting it | **Valid, severe** | 019 now `create or replace`s `handle_new_user()` — user_stats only — BEFORE the drop, with a test asserting that ordering and that the replacement contains no `insert into public.categories`. The route-side replacement the spec always required is built: `lib/defaultCategories.js` seeds from `GET /api/me`, idempotent, phase-aware via the new `lib/encryptionPhase.js` (`off` by default = today's behaviour exactly). Migration 018 adds a partial unique index on `(user_id, sort_order) where is_default` so two tabs cannot double-seed. |

**Found while fixing, not on Codex's list:** the digest's `name=value` framing was forgeable from
user-supplied description text — two different rows could hash identically. Fixed by length
prefixes and pinned by RE-VERIFY REGRESSION 1c.

## Codex FAIL -> response (every item)

| # | Codex finding | Verdict | Fix |
|---|---|---|---|
| 1 | Gate false-PASS: 501-row composite PK, only 500 checked | **Reproduced** | Ordered offset paging over ALL pk columns, plus a `checked === exact count` invariant that fails the gate on ANY paging bug. Test: "501 rows under a composite PK are all verified". |
| 2 | Gate false-PASS: value-only post-scan edit, no drift reported | **Reproduced** | Drift is now a SHA-256 digest over every row's keys, plaintext, ciphertext and indexes, compared across two full passes. A count cannot see 250->25; a digest can. Test: "a value-only edit after the read pass is detected as drift". |
| 3 | Gate must prove target / role / key identity / row totals | Valid | Preflight prints the database host, decodes the JWT role and FAILS unless `service_role` (through the anon key RLS hides rows and every count reads zero), prints a 12-char key fingerprint (never the key), and reports `checked/total` per table. |
| 4 | Field `kind` not enforced | Valid | `encryptRegistered` / `decryptRegistered` in lib/crypto.js. Gate and backfill now reject an "amount" that decrypts to `""`/`"abc"` — previously certified as fine, then 0/NaN in the app after the drop. |
| 5 | Capped responses could skip rows | Valid | The read window advances by rows RETURNED, not requested. Test simulates a 137-row server cap over 1200 rows. |
| 6 | `merchant_key` HMAC-only is not rebuildable after key rotation | Valid, serious | Added `merchant_key_enc` — an encrypted, recoverable copy — beside the hash. Rotation can decrypt under the old key and re-hash under the new one. |
| 7 | Ordered migrations run 013 before 018 | Valid | Renumbered **013 -> 019**. A test asserts the destructive migration sorts last of all. |
| 8 | 019 drops DB integrity constraints | Valid | Every NOT NULL the dropped columns carried is re-applied to its `_enc` column, derived from `notNull` in the registry and asserted by test. The `> 0` and length CHECKs genuinely cannot survive encryption — now documented in 019 and SECURITY.md as living only in Zod. |
| 9 | `merchantMemory.test.js` models prefix equality, not `%term%` ILIKE | Valid | **Merchant memory is a typeahead** (QuickAddDialog fires per keystroke from 2 chars), so exact-match hashing would have broken it. Replaced the two scalar hashes with `merchant_prefix_hmacs text[]` (GIN) holding every prefix. Tests now exercise the real route path incl. vote counting and the `>=3 -> high` confidence rule, and pin the two DOCUMENTED LOSSES (infix, second-word-only). |
| 10 | `blindIndex()` accepts a missing user id | Valid | Throws. Previously derived from the literal `"blind:undefined"` — one shared key making those rows comparable ACROSS users, the exact thing per-user keys prevent. |
| 11 | `categories.name` is not only 12 seeded defaults | Valid — my error | `POST /api/categories` accepts any name; PATCH renames. Now encrypted with a blind index for the exact `.eq('name', …)` keyword lookup. The false claim is corrected in the code, migration 018 and SECURITY.md. |

Found while fixing, not on Codex's list: comparing a kind-converted value would have
turned a stored `"12.50"` into `12.5` and mismatched **every two-decimal amount** — a gate
that could never pass. And `verifyRows` originally skipped blank-ciphertext rows, trusting a
count taken at a different instant, so a row inserted between the two was invisible to both.
Both fixed and tested.

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
which rows share a merchant — not its name, though a single known row labels every row that shares
its hash. That trade is documented in SECURITY.md and pinned
by tests.

## Current state

**Branch `phase-9.5-encryption-hardening`. NOT merged, NOT deployed.**
Server suite **86 → 220**, client builds clean, working tree clean.
Nothing in the live database changed: migrations 012, 018, 018a and 019 are all unapplied and
`DATA_ENCRYPTION_KEY` is still unset. The feature remains inert — deliberately.

Nine of those 220 tests now run against a REAL PostgreSQL (embedded, booted and discarded per run),
because the barrier's correctness is a question about transaction visibility and no in-memory fake
can answer it. That is what caught Codex's Critical finding: the previous fake incremented write
counters synchronously, modelling a database that cannot exist.

One nuance since the last handoff: `GET /api/me` now imports the encryption code, via
`ensureDefaultCategories()`. It writes `name_enc`/`name_hmac` **only** when `ENCRYPTION_PHASE` is
`dual` or `enc`; the default is `off`, where it writes exactly the columns it always did and is a
single indexed `limit 1` that finds a row and returns. It had to exist before 019, because 019
drops the column the signup trigger still writes.

### Scope expansion (second pass, after Alex's answer)
Encrypted on top of the money: `transactions.description`, `recurrences.description`,
`savings_goals.name`, `savings_contributions.note`, `special_groups.name`,
`subscription_overrides.display_name`. **`categories.name` is encrypted too** (corrected after
Codex's first VERIFY — "only the 12 seeded defaults" was false; `POST /api/categories` accepts any
name and `PATCH` renames one), with `name_hmac` answering the exact `.eq('name', …)` lookup.

- **`blindIndex()` in `lib/crypto.js`** — per-user keyed HMAC. The two scalar hashes this started
  with (`merchant_hmac`, `merchant_hmac_1`) are GONE: merchant memory is a typeahead, and an
  exact-match hash would have lit the category chip only once the merchant was typed in full. They
  were replaced by `transactions.merchant_prefix_hmacs`, a `text[]` holding one hash per prefix of
  the normalised merchant from 2 to **8** characters (capped at 8 since Codex's RE-VERIFY; 24
  published a prefix trie). Queries longer than the cap match a superset in the database and are
  then re-tested exactly against the decrypted description. `test/merchantMemory.test.js` proves the
  typeahead, the vote counting, the confidence rule and both documented losses.
- **`lib/merchant.js`** — the ONE normalisation. There were two, and they disagreed on apostrophes:
  `routes/categories.js` produced `"sainsbury s"` while `lib/subscriptions.js` produced
  `"sainsburys local"`, so **merchant memory has silently never matched an apostrophe merchant**.
  A blind index makes that class of drift fatal rather than merely wrong, so it is now shared — and
  the bug is fixed as a side effect.
- **`subscription_overrides.merchant_key`** was the PRIMARY KEY holding the merchant name, or a
  synthetic key embedding an amount bucket (`auto:<cat>:25:monthly`) — leaking merchants AND roughly
  their cost in a column no amount encryption touched. Replaced by `merchant_key_hmac`; migration
  019 moves the primary key onto it.
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
1. **The draft plaintext-drop migration in the plan document** (numbered 013 then, 019 now). Written
   in July against the original scope; the
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

- **Dual-write, NO rename.** Migration 019 drops plaintext and renames nothing; `_enc` suffixes stay
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
   019.** Not the backfill's exit code, not a UI click-through. And its exit 0 now MEANS something
   only because migration 018a's write barrier was engaged for the whole run — the gate refuses to
   pass otherwise.
4. **Engage the write barrier and disable the 03:00 recurrences cron** for the whole window from the
   gate passing to 019 finishing. `lib/runRecurrences.js` INSERTs transactions and cannot write
   `_enc`. Engaging BLOCKS until in-flight writers drain; that wait is the mechanism, not a hang.
5. Everything from previous sessions still applies: `invalidateMoney()`, `server/lib/month.js` for
   period boundaries, mirror route changes in `devMock.js`, `position: fixed` vs `animate-fade-up`,
   and a passing `npm run build` is not working code.

## Files that matter
- `server/lib/encryptedFields.js` — **NEW, the one registry** (15 encrypted fields + 3 blind
  indexes). Start here.
- `server/lib/merchant.js` — **NEW.** The one merchant normalisation. Both sides of every blind
  index must use it.
- `server/migrations/018_encryption_text_columns.sql` — **NEW.** Free text + blind indexes + lookup
  indexes, plus the partial unique index that makes route-side category seeding atomic. Apply with 012.
- `server/migrations/018a_encryption_write_barrier.sql` — **NEW, and the answer to Codex's second
  false-PASS.** The `encryption_cutover` flag, statement-level reject triggers on all ten guarded
  tables, and the `encryption_write_counters()` RPC. Inert until engaged. Apply with 012/018.
- `server/lib/defaultCategories.js` — **NEW.** The 12 defaults + idempotent seeding from
  `GET /api/me`. This is what lets 019 stop the signup trigger writing `categories.name`.
- `server/lib/encryptionPhase.js` — **NEW.** `ENCRYPTION_PHASE` (`off` | `dual` | `enc`), validated
  at import so a typo stops the server instead of writing the wrong columns. 019's footer has told
  the operator to set this since July; nothing read it until now.
- `server/migrations/018a_encryption_write_barrier.sql` — read the `FOR SHARE` section of its header
  before touching it. A plain `SELECT` there is a Critical bug, not a style choice, and the reason is
  written out with the measurements.
- `server/test/defaultCategories.test.js` — **NEW.** 16 tests, incl. the two migration-ordering
  regressions for finding 5.
- `server/test/merchantMemory.test.js` — **NEW.** Proves encrypting descriptions did not break the
  suggested-category chip.
- `server/lib/crypto.js` — v2 envelope, AAD, redacted errors, `blindIndex()`. 34 tests.
- `server/migrations/012_encryption_columns.sql` — additive, never applied, now includes
  `original_amount_enc`.
- `server/migrations/019_encryption_drop_plaintext.sql` — **NEW.** Irreversible; preconditions in
  its own header. Replaces the draft removed from the plan doc. (Written as 013, renumbered to 019
  so filename order is a safe apply order — there is no 013 in this repo.)
- `server/scripts/verify-encryption.mjs` — the gate. Rewritten. 11 tests.
- `server/scripts/encrypt-backfill.mjs` — 14 tests.
- `server/test/encryptionScope.test.js` — **NEW.** Fails the build if the registry, 012, 018, 018a
  and 019 drift — including if any migration alters a table an earlier one has not created.
- `server/test/writeBarrier.pg.test.js` — **NEW.** Runs migration 018a against a REAL PostgreSQL
  (embedded, thrown away afterwards) and proves the barrier drains in-flight writers.
- `docs/2026-08-18-encryption-reaudit.md` — all 36 findings + verdicts, incl. the 12 unverified.
- `SECURITY.md` — "Encryption at rest" section + key custody + the 10-step rollout order.

## Next steps (in order)

1. **Codex re-verifies this branch (RE-VERIFY #2).** Not me — CLAUDE.md forbids the builder
   validating its own stage, and names 9.5 as the change that needs the two-model loop.
2. ~~Alex decides the description question~~ — **ANSWERED 2026-08-18: encrypt them, via a blind
   index.** Done and tested; see "Scope expansion" above.
3. **The route sweep — the whole remaining feature, ~111 DB call sites.** Not started. Recommended
   shape: a thin codec at the query boundary so the ~180 arithmetic sites are untouched, phased on
   `ENCRYPTION_PHASE` (`off` default = identical to today), so it can ship and be proven in
   production *before* any key exists. Two routes need real thought rather than mechanical porting,
   and both now have a proven design to port TO:
   - `routes/categories.js` `/suggest` — swap `.ilike('description', …)` for an equality match on
     `merchant_prefix_hmacs` — hash `merchantQueryPrefix(typed)`, then re-test the candidates
     with `merchantMatches()` against the decrypted description, because above the 8-character cap
     the database can only narrow, not decide. The exact read-path logic is in
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
- **A judgement call I made for you, easy to overturn:** Codex offered two ways to resolve the
  prefix-trie leak — "cap the read query consistently at 24, or change the design". I changed the
  design: the cap is now **8 characters on both sides**, with exact server-side refinement above it.
  Capping at 24 would have satisfied the letter of the finding while still publishing a 24-deep
  prefix trie and every merchant's exact length. Cost of my choice: `/suggest` decrypts a slightly
  larger candidate set per keystroke (irrelevant at five users). If you want the strictest option
  instead — one hash of the whole merchant, which leaks only "these rows share a merchant" and
  nothing else — say so; the typeahead would then need the server to scan and decrypt your recent
  descriptions rather than letting the database narrow first.
- **The write barrier makes Trim briefly unwritable** during the cutover window, on purpose. Engage
  it, run the gate, run 019, release it. If a write is attempted meanwhile the app returns an error
  rather than silently losing a row. That is the trade Codex's finding 2 forces, and I think it is
  the right one for a five-user app.
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
