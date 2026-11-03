// The transaction columns a route hands back, shared by routes/transactions.js and
// routes/trips.js so a trip's expenses are the same shape as the Transactions page's:
// the shared edit dialog reads either. `selectFor` turns these into what the current
// encryption phase needs; `presentRow(s)` turns stored rows back into exactly this.
export const TX_LIST_COLUMNS =
  'id, amount, type, description, date, category_id, is_recurring, is_special, special_group_id, recurrence_id, trip_id, trip_stop_id, original_amount, original_currency, fx_rate, created_at';
export const TX_WRITE_COLUMNS =
  'id, amount, type, description, date, category_id, is_special, special_group_id, is_recurring, recurrence_id, trip_id, trip_stop_id, original_amount, original_currency, fx_rate, created_at';
