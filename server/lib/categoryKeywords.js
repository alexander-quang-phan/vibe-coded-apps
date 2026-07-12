// Task 6.9 — first-time-merchant fallback for category suggestions.
// Hand-curated and deliberately small: history beats keywords, so this only
// fires for merchants the user has never logged before. Keys are matched as
// substrings of the normalised description; values are the DEFAULT category
// names seeded by migration 001 (suggestion is skipped if the user renamed or
// deleted the category — never guess into the wrong bucket).
export const CATEGORY_KEYWORDS = [
  // Groceries
  ['tesco', 'Groceries'],
  ['sainsbury', 'Groceries'],
  ['aldi', 'Groceries'],
  ['lidl', 'Groceries'],
  ['asda', 'Groceries'],
  ['waitrose', 'Groceries'],
  ['morrisons', 'Groceries'],
  ['co-op', 'Groceries'],
  ['coop', 'Groceries'],
  ['whole foods', 'Groceries'],
  ['trader joe', 'Groceries'],
  ['grocery', 'Groceries'],
  ['supermarket', 'Groceries'],

  // Food / dining out
  ['pret', 'Food'],
  ['starbucks', 'Food'],
  ['costa', 'Food'],
  ['greggs', 'Food'],
  ['mcdonald', 'Food'],
  ['kfc', 'Food'],
  ['nando', 'Food'],
  ['deliveroo', 'Food'],
  ['uber eats', 'Food'],
  ['just eat', 'Food'],
  ['dominos', 'Food'],
  ['pizza', 'Food'],
  ['cafe', 'Food'],
  ['coffee', 'Food'],
  ['restaurant', 'Food'],
  ['takeaway', 'Food'],

  // Transport
  ['uber', 'Transport'],
  ['lyft', 'Transport'],
  ['bolt', 'Transport'],
  ['tfl', 'Transport'],
  ['trainline', 'Transport'],
  ['national rail', 'Transport'],
  ['shell', 'Transport'],
  ['bp', 'Transport'],
  ['esso', 'Transport'],
  ['petrol', 'Transport'],
  ['parking', 'Transport'],
  ['bus', 'Transport'],
  ['taxi', 'Transport'],

  // Entertainment
  ['netflix', 'Entertainment'],
  ['spotify', 'Entertainment'],
  ['disney', 'Entertainment'],
  ['prime video', 'Entertainment'],
  ['youtube', 'Entertainment'],
  ['cinema', 'Entertainment'],
  ['odeon', 'Entertainment'],
  ['vue', 'Entertainment'],
  ['steam', 'Entertainment'],
  ['playstation', 'Entertainment'],
  ['xbox', 'Entertainment'],
  ['nintendo', 'Entertainment'],

  // Shopping
  ['amazon', 'Shopping'],
  ['ebay', 'Shopping'],
  ['argos', 'Shopping'],
  ['uniqlo', 'Shopping'],
  ['zara', 'Shopping'],
  ['h&m', 'Shopping'],
  ['primark', 'Shopping'],
  ['nike', 'Shopping'],
  ['adidas', 'Shopping'],
  ['ikea', 'Shopping'],
  ['john lewis', 'Shopping'],

  // Health
  ['boots', 'Health'],
  ['pharmacy', 'Health'],
  ['gym', 'Health'],
  ['puregym', 'Health'],
  ['dentist', 'Health'],
  ['doctor', 'Health'],
  ['optician', 'Health'],

  // Bills
  ['edf', 'Bills'],
  ['octopus energy', 'Bills'],
  ['british gas', 'Bills'],
  ['thames water', 'Bills'],
  ['vodafone', 'Bills'],
  ['o2', 'Bills'],
  ['ee', 'Bills'],
  ['three', 'Bills'],
  ['giffgaff', 'Bills'],
  ['council tax', 'Bills'],
  ['insurance', 'Bills'],
  ['electricity', 'Bills'],
  ['water bill', 'Bills'],
  ['broadband', 'Bills'],
  ['wifi', 'Bills'],

  // Rent
  ['rent', 'Rent'],
  ['landlord', 'Rent'],
  ['mortgage', 'Rent'],
];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Return the default-category NAME suggested for a freetext description, or
 * null. Keywords match on word boundaries (so "ee" never fires inside
 * "coffee"); the longest matching keyword wins so "uber eats" beats "uber".
 */
export function suggestCategoryName(description) {
  const norm = (description || '').toLowerCase().trim();
  if (!norm) return null;
  let best = null;
  for (const [keyword, name] of CATEGORY_KEYWORDS) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(keyword)}([^a-z0-9]|$)`);
    if (re.test(norm) && (!best || keyword.length > best.keyword.length)) {
      best = { keyword, name };
    }
  }
  return best?.name ?? null;
}
