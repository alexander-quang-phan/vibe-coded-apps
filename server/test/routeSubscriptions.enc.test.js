/**
 * The subscriptions route at ENCRYPTION_PHASE=enc.
 * One file per phase — see helpers/subscriptionsRouteSuite.js.
 */
process.env.ENCRYPTION_PHASE = 'enc';
process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const { runSubscriptionsRouteSuite } = await import('./helpers/subscriptionsRouteSuite.js');
runSubscriptionsRouteSuite('enc');
