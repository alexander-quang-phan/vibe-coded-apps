/**
 * A row's primary key, safe to print in a failure message.
 *
 * The backfill and the gate promise never to log user data, and name rows by
 * primary key. But subscription_overrides.merchant_key IS user data: a merchant
 * name ("dr jane") or a key embedding an amount bucket ("auto:<cat>:25:monthly").
 * These messages get pasted into chats and handoff notes, and CHAT_HANDOFF.md is
 * tracked in a public repo. So a primary-key column that is itself encrypted
 * prints as a short hash instead. [2026-11-01]
 *
 * A locator, not a secret: someone holding a guess and the user id could confirm
 * it, which is far less than printing the value. To find the row:
 *
 *   select * from public.subscription_overrides
 *   where user_id = '<user_id>'
 *     and left(encode(sha256((user_id::text || '|' || merchant_key)::bytea), 'hex'), 12) = '<hash>';
 */
import { createHash } from 'node:crypto';
import { fieldKey, isEncryptedField } from './encryptedFields.js';

const locator = (userId, value) => createHash('sha256').update(`${userId}|${value}`).digest('hex').slice(0, 12);

export function pkLabel(job, row) {
  return (job.pk ?? ['id'])
    .map((k) => (isEncryptedField(fieldKey(job.table, k)) ? `${k}=sha256:${locator(row.user_id, row[k])}` : `${k}=${row[k]}`))
    .join(' ');
}
