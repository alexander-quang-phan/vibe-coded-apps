/**
 * The budgets route at ENCRYPTION_PHASE=enc.
 *
 * One file per phase on purpose: `node --test` runs each test file in its own
 * process, and the phase is read once at import. See helpers/budgetsRouteSuite.js.
 */
process.env.ENCRYPTION_PHASE = 'enc';
process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const { runBudgetsRouteSuite } = await import('./helpers/budgetsRouteSuite.js');
runBudgetsRouteSuite('enc');
