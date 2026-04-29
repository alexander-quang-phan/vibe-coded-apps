// Subscription detection for Trim.
// Pure function on a user's transactions — no DB access. Routes pass in the
// full set of expense transactions; detection groups by normalised merchant
// and returns rows the API can merge with the user's overrides table.
//
// Two grouping paths:
//   1. Description-grouped (original): normaliseMerchant(description) → key.
//   2. Synthetic fallback (Task 6.2.1): for transactions with no description,
//      group by (category_id, amount-bucket-of-£5, cadence). The merchantKey
//      is `auto:<categoryId|none>:<bucket>:<cadence>` so re-runs land in the
//      same key and inherit the user-given name from the override.

const MIN_OCCURRENCES = 3;
const MONTHLY_DAYS = 30;
const ANNUAL_DAYS = 365;
const DAY_TOLERANCE = 5;
const AMOUNT_TOLERANCE = 0.10;
const AMOUNT_BUCKET_SIZE = 5;

export function normaliseMerchant(description) {
  if (!description) return null;
  const cleaned = description
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const words = cleaned.split(' ').filter(Boolean).slice(0, 2);
  if (words.length === 0) return null;
  return words.join(' ');
}

export function prettifyMerchant(description, fallbackKey) {
  const source = description ?? fallbackKey ?? '';
  const words = source
    .replace(/['’]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  if (words.length === 0) return fallbackKey ?? '';
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function diffDays(laterISO, earlierISO) {
  const a = new Date(`${laterISO}T00:00:00Z`).getTime();
  const b = new Date(`${earlierISO}T00:00:00Z`).getTime();
  return Math.round((a - b) / 86_400_000);
}

function addDays(iso, days) {
  const t = new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Same-day charges are usually accidental re-logs that would zero out an
// interval. Collapse to one per date by keeping the largest amount; the
// uncollapsed list is still used for `totalPaid` so the user sees their real
// spend.
function dedupeByDate(items) {
  const byDate = new Map();
  for (const t of items) {
    const amt = Number(t.amount);
    const existing = byDate.get(t.date);
    if (!existing || amt > Number(existing.amount)) {
      byDate.set(t.date, { ...t, amount: amt });
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function bucketAmount(amount) {
  return Math.round(Number(amount) / AMOUNT_BUCKET_SIZE) * AMOUNT_BUCKET_SIZE;
}

export function syntheticMerchantKey(categoryId, bucket, cadence) {
  return `auto:${categoryId ?? 'none'}:${bucket}:${cadence}`;
}

// Greedy ±10% sweep over a sorted-by-amount list — keeps the synthetic path
// from over-merging two real subs that happen to fall in the same £5 bucket.
function clusterByAmount(items) {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => Number(a.amount) - Number(b.amount));
  const clusters = [];
  let current = [sorted[0]];
  let clusterMin = Number(sorted[0].amount);
  for (let i = 1; i < sorted.length; i++) {
    const amt = Number(sorted[i].amount);
    if (clusterMin > 0 && amt <= clusterMin * (1 + AMOUNT_TOLERANCE)) {
      current.push(sorted[i]);
    } else {
      clusters.push(current);
      current = [sorted[i]];
      clusterMin = amt;
    }
  }
  clusters.push(current);
  return clusters;
}

// Walk the deduped, date-sorted list and pull out the longest contiguous run
// whose intervals all match the same cadence (monthly or annual). Required so
// the synthetic path doesn't get fooled by a one-off charge sitting between
// the recurring ones.
function findCadenceRun(uniqueByDate) {
  const cadences = [
    { name: 'monthly', days: MONTHLY_DAYS },
    { name: 'annual', days: ANNUAL_DAYS },
  ];

  for (const { name, days } of cadences) {
    let bestStart = -1;
    let bestLen = 0;
    let runStart = 0;
    for (let i = 1; i <= uniqueByDate.length; i++) {
      const breaks =
        i === uniqueByDate.length ||
        Math.abs(diffDays(uniqueByDate[i].date, uniqueByDate[i - 1].date) - days) > DAY_TOLERANCE;
      if (breaks) {
        const len = i - runStart;
        if (len > bestLen) {
          bestLen = len;
          bestStart = runStart;
        }
        runStart = i;
      }
    }
    if (bestLen >= MIN_OCCURRENCES) {
      return {
        cadence: name,
        cadenceDays: days,
        run: uniqueByDate.slice(bestStart, bestStart + bestLen),
      };
    }
  }
  return null;
}

function buildDescribed(key, items) {
  const unique = dedupeByDate(items);
  if (unique.length < MIN_OCCURRENCES) return null;

  const recent = unique.slice(-MIN_OCCURRENCES);
  const intervals = [];
  for (let i = 1; i < recent.length; i++) {
    intervals.push(diffDays(recent[i].date, recent[i - 1].date));
  }

  let cadence = null;
  let cadenceDays = 0;
  if (intervals.every((d) => Math.abs(d - MONTHLY_DAYS) <= DAY_TOLERANCE)) {
    cadence = 'monthly';
    cadenceDays = MONTHLY_DAYS;
  } else if (intervals.every((d) => Math.abs(d - ANNUAL_DAYS) <= DAY_TOLERANCE)) {
    cadence = 'annual';
    cadenceDays = ANNUAL_DAYS;
  } else {
    return null;
  }

  const recentAmounts = recent.map((t) => Number(t.amount));
  const minAmt = Math.min(...recentAmounts);
  const maxAmt = Math.max(...recentAmounts);
  if (minAmt <= 0 || maxAmt / minAmt > 1 + AMOUNT_TOLERANCE) return null;

  const lastTx = unique[unique.length - 1];
  return finaliseDetection({
    merchantKey: key,
    name: prettifyMerchant(lastTx.description, key),
    inferred: false,
    cadence,
    cadenceDays,
    recentAmounts,
    items,
    unique,
    lastTx,
  });
}

function buildInferred(items) {
  const unique = dedupeByDate(items);
  if (unique.length < MIN_OCCURRENCES) return null;

  const found = findCadenceRun(unique);
  if (!found) return null;

  const recentAmounts = found.run.map((t) => Number(t.amount));
  const minAmt = Math.min(...recentAmounts);
  const maxAmt = Math.max(...recentAmounts);
  if (minAmt <= 0 || maxAmt / minAmt > 1 + AMOUNT_TOLERANCE) return null;

  const representativeAmount = median(recentAmounts);
  const bucket = bucketAmount(representativeAmount);
  const lastTx = found.run[found.run.length - 1];
  const categoryId = lastTx.category_id ?? null;

  return finaliseDetection({
    merchantKey: syntheticMerchantKey(categoryId, bucket, found.cadence),
    name: null,
    inferred: true,
    cadence: found.cadence,
    cadenceDays: found.cadenceDays,
    recentAmounts,
    items,
    unique,
    lastTx,
  });
}

function finaliseDetection({
  merchantKey,
  name,
  inferred,
  cadence,
  cadenceDays,
  recentAmounts,
  items,
  unique,
  lastTx,
}) {
  const representativeAmount = median(recentAmounts);
  const totalPaid = items.reduce((sum, t) => sum + Number(t.amount), 0);
  const monthlyCost = cadence === 'monthly' ? representativeAmount : representativeAmount / 12;
  const annualCost = cadence === 'monthly' ? representativeAmount * 12 : representativeAmount;

  return {
    merchantKey,
    name,
    inferred,
    cadence,
    cadenceDays,
    amount: round2(representativeAmount),
    monthlyCost: round2(monthlyCost),
    annualCost: round2(annualCost),
    lastCharged: lastTx.date,
    nextExpected: addDays(lastTx.date, cadenceDays),
    totalPaid: round2(totalPaid),
    occurrences: unique.length,
    categoryId: lastTx.category_id ?? null,
  };
}

/**
 * @param {Array<{ id, amount, type, description, date, category_id }>} transactions
 * @returns {Array} detected subscriptions, sorted by monthlyCost desc.
 */
export function detectSubscriptions(transactions) {
  const described = new Map();
  const undescribed = [];
  for (const t of transactions) {
    if (t.type !== 'expense') continue;
    const key = normaliseMerchant(t.description);
    if (key) {
      if (!described.has(key)) described.set(key, []);
      described.get(key).push(t);
    } else {
      undescribed.push(t);
    }
  }

  const detected = [];

  for (const [key, items] of described) {
    const sub = buildDescribed(key, items);
    if (sub) detected.push(sub);
  }

  const byCategory = new Map();
  for (const t of undescribed) {
    const cat = t.category_id ?? 'none';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(t);
  }
  for (const items of byCategory.values()) {
    for (const cluster of clusterByAmount(items)) {
      const sub = buildInferred(cluster);
      if (sub) detected.push(sub);
    }
  }

  detected.sort((a, b) => b.monthlyCost - a.monthlyCost);
  return detected;
}
