/**
 * affordability, projections and specialGroups at ENCRYPTION_PHASE=dual.
 * One file per phase — see helpers/affordProjGroupsRouteSuite.js.
 */
process.env.ENCRYPTION_PHASE = 'dual';
process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const { runAffordProjGroupsSuite } = await import('./helpers/affordProjGroupsRouteSuite.js');
runAffordProjGroupsSuite('dual');
