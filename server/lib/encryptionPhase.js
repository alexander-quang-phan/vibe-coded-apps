/**
 * Which columns the routes write during the Phase 9.5 cutover.
 *
 * Migration 019's footer has always told the operator to "set ENCRYPTION_PHASE=enc
 * and redeploy", but nothing read the variable — it was a note about a mechanism
 * that did not exist. It exists now, because moving the default-category seeding
 * off the signup trigger (see lib/defaultCategories.js) created the first code
 * path that has to write DIFFERENT columns before and after the drop.
 *
 *   off   the schema as it is today. Plaintext columns only. Identical behaviour
 *         to before Phase 9.5 existed, and the DEFAULT — nothing changes for
 *         anyone until Alex deliberately moves the flag.
 *   dual  migrations 012/018/018a applied, 019 NOT yet. Write BOTH the plaintext
 *         and the `_enc`/`_hmac` columns, so the backfill's work stays true and
 *         every write path is demonstrably writing both before anything is
 *         dropped. This is precondition 3 of migration 019.
 *   enc   migration 019 applied. The plaintext columns no longer exist, so
 *         writing them would error. Ciphertext and blind indexes only.
 *
 * FAILS CLOSED on anything else. A typo like ENCRYPTION_PHASE=encrypted must not
 * quietly fall back to a phase that writes the wrong columns; on the `enc` side
 * that is a 500 on every write, and on the `off` side it is silent data loss
 * during the window when both columns matter. Validated at import, so the server
 * refuses to boot rather than discovering it on the first request.
 */

export const PHASES = Object.freeze(['off', 'dual', 'enc']);

export function encryptionPhase(env = process.env) {
  const raw = env.ENCRYPTION_PHASE;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'off';
  const value = String(raw).trim().toLowerCase();
  if (!PHASES.includes(value)) {
    throw new Error(
      `ENCRYPTION_PHASE is '${raw}', which is not one of ${PHASES.join(', ')}. ` +
        `Refusing to guess: the phase decides which columns every write touches.`,
    );
  }
  return value;
}

/** Does this phase still write the plaintext column? True until 019 has run. */
export const writesPlaintext = (phase) => phase !== 'enc';

/** Does this phase write the `_enc` / `_hmac` columns? True once 012/018 are applied. */
export const writesCiphertext = (phase) => phase !== 'off';

/** Resolved once at boot, so a bad value stops the server instead of a request. */
export const CURRENT_PHASE = encryptionPhase();
