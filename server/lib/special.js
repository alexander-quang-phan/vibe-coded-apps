// Phase 9.2: special expenses are excluded from budget math ONLY while the
// user's opt-in preference is on. Off = flags dormant, everything counts.
export function excludeSpecial(rows, specialEnabled) {
  return specialEnabled ? rows.filter((t) => !t.is_special) : rows;
}

export function sumSpecial(rows, specialEnabled) {
  if (!specialEnabled) return 0;
  return rows.reduce(
    (sum, t) => (t.is_special && t.type !== 'income' ? sum + Number(t.amount) : sum),
    0,
  );
}
