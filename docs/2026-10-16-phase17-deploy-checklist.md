# Phase 17 deploy checklist (subscription marking)

Do these in order. The pre-deploy gate (`deploy-guard`) said **GO** on 16 Oct 2026, on one condition:
the database update (step 2) must go in **before** the server deploys (step 4). Deploying the server
first would break the Subscriptions page.

## 1. Check first (read-only)

Supabase → your Trim project → **SQL Editor** → **New query**. Run:

```sql
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.recurrences'::regclass and contype = 'c';
```

It must list a rule named exactly `recurrences_interval_check` (allowing `monthly` and `weekly`).
**If the name is different, stop** and tell Claude. Then run this and write down both numbers:

```sql
select count(*) as total,
       count(*) filter (where cancelled_at is null) as active
from public.recurrences;
```

## 2. Apply the database update

Open `server/migrations/017a_subscription_tracking.sql` in the repo, copy all of it, paste it into a new
query and click **Run**. You should see "Success. No rows returned". It is safe to run twice.
**Do not run 012, 018, 018a or 019.**

## 3. Check after (read-only)

Run the first query from step 1 again. Expect three rules: `recurrences_amount_check`,
`recurrences_interval_check` (now also allowing `annual`) and `recurrences_next_run_required`. Then:

```sql
select count(*) as total,
       count(*) filter (where auto_log) as auto_log_true,
       count(*) filter (where next_run_at is null) as null_next
from public.recurrences;
```

Expect: `total` the same as in step 1, `auto_log_true` equal to `total`, and `null_next` = 0.

## 4. Merge and deploy

Merge `feature/subscription-marking` into `main` (it fast-forwards), then use the `/deploy` skill:
**server (trim-api) first, then the client.** After the server deploys, check that `/api/health` answers
200 and that `/api/subscriptions` without logging in answers 401.

## 5. Try it, logged in

- Subscriptions loads with no error; your Repeat-this items show **"Logs itself"**.
- Transactions → pencil on any expense → the **Subscription** section appears → "This is a subscription".
- Subscriptions → **Add a subscription**.
- Quick Add with **"Repeat this"** ticked still saves.

## 6. Next morning

Vercel → trim-api → logs. Find the 03:00 UTC `[cron:recurrences]` line and check `errors` is 0. Nothing
alerts you if the nightly job fails, so this check is the only way to find out.

## If something goes wrong

In Vercel, promote the previous **client** deployment and the previous **trim-api** deployment.
**Leave the database update in place**: the old server code works with it. Never undo the database change
while the new server is live.
