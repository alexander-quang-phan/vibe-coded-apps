# Subscription Marking (Phase 17) Implementation Plan

> **For agentic workers:** executed **natively** in the authoring session (Alex said "build out what
> you think is ready"), then a fresh multi-lens review of the whole branch. Steps use `- [ ]`.

**Goal:** Let Alex mark any logged expense as a tracked subscription, attach later charges by
answering a prompt, and see it on /subscriptions immediately — without ever auto-creating a
transaction and without ever silently hiding a different subscription.

**Architecture:** Reuse the `recurrences` table with a new `auto_log` flag (false = tracked). A pure
matcher (`lib/subscriptionMatch.js`) decides "same subscription?" — silently only on the exact note
it was marked with, asking otherwise. Tracked rows' figures are derived from attached charges at read
time. Six new endpoints under `/api/subscriptions`, a `subscriptionMatch` field on transaction create,
a guarded nightly job, and three client entry points.

**Tech Stack:** Express 4 + Zod (ESM), Supabase/PostgREST via the encryption codec, `node --test`
with the fake PostgREST in `test/helpers/routeHarness.js`, React 18 + TanStack Query + sonner.

**Spec:** `docs/superpowers/specs/2026-10-13-subscription-marking-design.md` (read it; this plan
argues from it and does not repeat its rationale).

## Global Constraints

- Every query `.eq('user_id', req.user.id)`; every client-supplied id ownership-checked (service role bypasses RLS).
- Reads: `selectFor` + `decodeRow(s)`; writes: `encodeWrite` **per row**; responses built field by field.
- Every insert/update/delete whose result is read chains `.select(...)`.
- Route change ⇒ same change in `server/scripts/devMock.js`, same session, same guards.
- Migration file name `017a_subscription_tracking.sql` (019 must stay last — `encryptionScope.test.js:179`).
- Interval value in the DB is `annual`; UI label "Yearly".
- No new path calls `applyLogEvent` (no XP).
- Copy: friendly, never red. Marking toast "Tracking it as a subscription 🔁" / "See it on Subscriptions."
- Baseline before work: `npm test` → **507 pass, 0 skipped**, real-PG tests installed.

## Review Focus

1. A tracked row reaching the nightly job (null `next_run_at`, `auto_log` false or missing) must never insert — pinned in Task 5.
2. Double-tapping "Track it" must not create two subscriptions — pinned in Task 7 (`/track` 409 + no orphan).
3. A tracked row with zero attached charges must not 500 the Subscriptions page — pinned in Task 6.
4. A price jump (+300%) on an exact note must still be attachable — pinned in Tasks 4 and 7.
5. Deleting a category must not silently delete subscriptions — pinned in Task 9.

---

### Task 1: Make the fake PostgREST as strict as the real one

**Files:** Modify `server/test/helpers/routeHarness.js`.

- [ ] insert/update/delete/upsert return `{ data: null }` unless `.select()` was chained after the write.
- [ ] insert/upsert ids from `randomUUID()` (not `gen-N`).
- [ ] `select(cols, { count, head })` → result carries `count: rows.length`; `data: null` when `head`.
- [ ] Chained `.order()` calls accumulate (multi-key sort) and are recorded in `q._orders` and `calls[].orders`.
- [ ] `fakeSupabase(tables, { maxRows, failOn })`: `maxRows` truncates select results **after** range/offset; `failOn(table, op)` → returns `{ error }` for that call (error injection).
- [ ] Run `npm test` → still 507 pass. Fix any test that relied on the forgiving behaviour (none expected per review).
- [ ] Commit `test: make the fake PostgREST as strict as PostgREST`.

### Task 2: Migration 017a + real-PostgreSQL migration test

**Files:** Create `server/migrations/017a_subscription_tracking.sql`, `server/test/subscriptionTracking.pg.test.js`.

- [ ] SQL exactly as the spec's Data model block (idempotent: `add column if not exists`, `drop constraint if exists`).
- [ ] `.pg` test in the style of `writeBarrier.pg.test.js`: stub roles/auth schema as that file does, apply `001`…`014`, insert one recurrence, apply `017a` **twice**; assert: second run OK; existing row `auto_log = true`; `auto_log=false, next_run_at=null` accepted; `auto_log=true, next_run_at=null` rejected (23514); `interval='annual'` accepted with `auto_log=false`; `'yearly'` rejected.
- [ ] `npm test` green; report the count of real-PG tests that ran. Commit.

### Task 3: Pure recurrence/cost helpers + detector primitive

**Files:** Modify `server/lib/recurrences.js`, `server/lib/subscriptions.js`; test `server/test/recurrences.test.js`.

**Produces:** `CADENCE_DAYS = { weekly: 7, monthly: 30, annual: 365 }`; `subscriptionCost(amount, cadence) → { monthlyCost, annualCost }` (rounded 2dp; weekly ×52/12 & ×52; annual ÷12 & ×1); `isTracked(r) → r?.auto_log === false`; `nextExpectedFrom(lastCharged, cadence) → ISO | null`; `dueRecurrences` fails closed (`r.auto_log === true && r.next_run_at && !r.cancelled_at && r.next_run_at <= today`). `lib/subscriptions.js`: `finaliseDetection` adds `lastAmount` (primitive); `addDays` exported.

- [ ] Tests first: cost per cadence; `isTracked(undefined/true)` false; `dueRecurrences` skips false/undefined/null-date; `nextExpectedFrom(null)` null.
- [ ] Implement; existing recurrences tests stay green. Commit.

### Task 4: The matcher

**Files:** Create `server/lib/subscriptionMatch.js`, `server/test/subscriptionMatch.test.js`.

**Produces:** `prototypeOf(rec, linkedTxs) → { id, ownKey, keys:Set, category_id, amount, cadence, lastCharged, cancelledDay|null, active }`; `nameStrength(key, proto)`; `isSameSubscription({key, amount}, proto)` (ownKey + ±30%); `isExactNote({key}, proto)`; `looksLikeSameCharge(tx, proto)`; `cycleAligned(date, lastCharged, cadence)`; `bestTrackedMatch(tx, protos) → { proto, kind:'attach'|'reactivate'|'finalOrBack' } | null`; `bestPreviewMatch(expense, protos) → { proto, kind, strength } | null`. Pure; the cancellation day is passed in on the prototype (`cancelledDay`), never computed here.

- [ ] Tests first — every case listed in the spec's `subscriptionMatch.test.js` bullet, including Apple Music/Apple TV, absorbed "Apple" key never silent, +300% exact attachable, weekly offsets 3/4/10/11, cancelled exact-only, final-charge kind, zero-charge never toasts.
- [ ] Implement; commit.

### Task 5: Nightly job guards

**Files:** Modify `server/lib/runRecurrences.js`, `server/test/helpers/cronRecurrencesSuite.js` (+ `auto_log: true` on fixtures), `server/test/recurrences.test.js`.

- [ ] `RECURRENCE_COLUMNS` gains `auto_log`; select `.eq('auto_log', true)`; claim `.eq('auto_log', true)`.
- [ ] `processOne` exported; returns `{ outcome: 'skipped' }` first unless `auto_log === true && next_run_at`.
- [ ] Each `processOne` in the loop wrapped in try/catch → counted as an error.
- [ ] Tests: stale-read guard-2 (in-memory row `auto_log:true`, stored row `auto_log:false` → no claim, no insert); tracked null-date and tracked annual skipped without throwing; end-to-end tracked due row never fired; a throwing row doesn't stop others. Commit.

### Task 6: GET /api/subscriptions — derived tracked rows, suppression, paging

**Files:** Modify `server/routes/subscriptions.js`; extend `server/test/helpers/subscriptionsRouteSuite.js` (fixtures `auto_log: true`).

- [ ] Paged expense read (`order date, id`; advance by rows returned; stop on empty page; dedupe by id).
- [ ] Recurrences select `auto_log`; manual rows `tracking: isTracked(r)`; tracked rows use derived `lastCharged/amount/nextExpected/occurrences/totalPaid` (zero-charge ⇒ nulls + stored amount); costs via `subscriptionCost`.
- [ ] Detected rows built field by field (no `...d`); suppression via `isSameSubscription` against active tracked prototypes, plus cancelled ones when `detected.lastCharged <= cancelledDay`; synthetic rows never suppressed.
- [ ] PATCH: tracked + `amount` → 400 "follows your latest charge".
- [ ] Tests per spec (zero-charge 200 ×3 phases; suppression matrix; paging past `maxRows`; leak check). Commit.

### Task 7: The six new endpoints

**Files:** Modify `server/routes/subscriptions.js`; extend the subscriptions suite.

- [ ] `GET /track/preview`, `GET /track/recent`, `POST /track`, `POST /:key/attach`, `POST /:key/detach`, `DELETE /:key` — exactly per the spec's API section (409 bodies include `strength`; `needsCategory`; link update `.select('id')` + orphan rollback; conditional attach; explicit unlink before delete).
- [ ] Route order: register `/track/...` before `/:merchantKey` routes.
- [ ] Tests per spec. Commit.

### Task 8: POST /api/transactions — subscriptionMatch + explicit auto_log

**Files:** Modify `server/routes/transactions.js`; extend `transactionsRouteSuite.js`.

- [ ] Opt-in recurrence insert writes `auto_log: true`.
- [ ] After create (expense, no opt-in): load tracked recurrences (+ their linked charges' `date, amount, description`), compute `bestTrackedMatch`; any error → log ids, `subscriptionMatch: null`; never fails the 201.
- [ ] Tests: attach / reactivate / final-or-back kinds; outside window null; none tracked ⇒ null and no extra recurrence query; injected failure still 201. Commit.

### Task 9: Category delete keeps subscriptions

**Files:** Modify `server/routes/categories.js`, `client/src/components/CategoryManager.jsx`; create `server/test/helpers/categoriesRouteSuite.js` + `routeCategories.{off,dual,enc}.test.js`.

- [ ] Count recurrences beside transactions; 409 `{ transactionCount, subscriptionCount }`; reassign moves both, user-scoped.
- [ ] Client opens the reassign dialog when either count > 0; copy names both.
- [ ] Tests: 409 with subscriptionCount only; reassign actually moves recurrences; other user's untouched. Commit.

### Task 10: devMock mirror

**Files:** Modify `server/scripts/devMock.js`.

- [ ] Import `lib/subscriptionMatch.js` + `lib/recurrences.js` helpers; delete the mock's own cadence/cost copies.
- [ ] Mirror Tasks 5–9 with identical guards/messages; explicit `auto_log` on every mock recurrence; seeds: one tracked sub (1 attached charge), one unlinked look-alike near its next date, one older look-alike; close the PATCH /api/transactions category/type guard gap.
- [ ] Smoke-test with curl against `npm run dev:mock`. Commit.

### Task 11: Client

**Files:** `components/ui/toaster.jsx`, `components/ui/dialog.jsx`, `lib/subscriptions.js`, create `components/SubscriptionMarker.jsx`, `pages/Transactions.jsx`, `pages/Subscriptions.jsx`, `components/SubscriptionRow.jsx`, `components/QuickAddDialog.jsx`.

- [ ] Toaster `style={{ pointerEvents: 'auto' }}`; DialogContent `onInteractOutside` ignores `[data-sonner-toaster]` (and still calls a caller's handler).
- [ ] `CADENCE_LABELS.annual = 'Yearly'`.
- [ ] `SubscriptionMarker` (preview with current values + interval; existing/detected/pills+likely/maybe; needsCategory; exact vs weak).
- [ ] Transactions: EditDialog Subscription section on `onSave` (PATCH then track/attach/detach; 409 keeps dialog open with the offer); `?edit=<id>` opens that row; "Subscription" pill; Recurring filter `recurrence_id || is_recurring`.
- [ ] Subscriptions: "Add a subscription" dialog (`/track/recent` + search → marker → Track it, 409 → offer); empty-state copy.
- [ ] SubscriptionRow: "Marked by you"/"Logs itself"; Remove (confirm) for tracked; no amount edit for tracked.
- [ ] QuickAdd: match toast fired last; Yes → attach (`reactivate` per kind); "It's back"/"Final charge" for the final-or-back kind.
- [ ] `npm run build` passes. Commit.

### Task 12: See it working

- [ ] `npm run dev:mock` + `npm run dev`; agents can't log in to Supabase, so use a throwaway preview entry (`client/preview.html` + `src/preview.jsx`) rendering the real pages with the TanStack cache pre-seeded from the mock's real payloads (feature skill). Click through: Edit → mark; Add dialog; Subscriptions pills/Remove; Quick Add toast. Screenshot. Delete the harness.

### Task 13: Docs + ledger

- [ ] FEATURES.md, ARCHITECTURE.md, BUILD_PLAN.md (Phase 17), SECURITY.md, BUGS-FIXED.md row (category cascade). Commit.

### Task 14: Independent whole-branch review

- [ ] Workflow: correctness/security, spec-compliance, and UI-reachability reviewers; verify findings; fix confirmed ones; re-run `npm test` + build.
