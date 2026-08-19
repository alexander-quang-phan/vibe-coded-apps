/**
 * The transactions route at ENCRYPTION_PHASE=enc.
 * One file per phase — `node --test` gives each file its own process, and the
 * phase is read once at import. See helpers/transactionsRouteSuite.js.
 */
process.env.ENCRYPTION_PHASE = 'enc';
process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const { runTransactionsRouteSuite } = await import('./helpers/transactionsRouteSuite.js');
runTransactionsRouteSuite('enc');
