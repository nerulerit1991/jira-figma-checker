// Which step verifies each acceptance checklist item. Shared by the server and the UI.
//   live          "Check UI": provable from the page as it loads (screenshots + DOM)
//   playwright    a Playwright test: needs typing, clicking, submitting or a server response
//   not-testable  neither step can verify it (time passing, database state, another system); manual QA
export const VERIFY_BY = ['live', 'playwright', 'not-testable'];

/** The item's verifyBy; checklists saved before the field existed fall back on the category. */
export const verifyByOf = (item) =>
  VERIFY_BY.includes(item?.verifyBy) ? item.verifyBy : item?.category === 'behavior' ? 'playwright' : 'live';

export const itemsVerifiedBy = (checklist, verifyBy) => (checklist || []).filter((i) => verifyByOf(i) === verifyBy);

/** Checklist ids a test title covers, from its "[C3]" or "[C3, C4]" prefix. */
export const idsInTitle = (title) =>
  (/^\s*\[([^\]]+)\]/.exec(title || '')?.[1] || '').split(/[\s,]+/).filter((id) => /^C\d+$/i.test(id)).map((id) => id.toUpperCase());

/**
 * One Playwright item's status from the ticket's tests: "passed", "failed", "skipped" (with the skip reason),
 * "not-run" (a test was written but not run since) or "no-test". `tests` is readTests()'s result.
 */
export function testStatusOf(id, tests) {
  const rows = (tests?.results?.rows || []).filter((r) => idsInTitle(r.title).includes(id));
  if (rows.length) {
    const failed = rows.filter((r) => r.status === 'failed');
    const passed = rows.filter((r) => r.status === 'passed');
    if (failed.length) return { status: 'failed', rows, detail: failed[0].error?.split('\n')[0] || `${failed.length} of ${rows.length} tests failed.` };
    if (passed.length) return { status: 'passed', rows, detail: `${passed.length} test${passed.length === 1 ? '' : 's'} passed.` };
    return { status: 'skipped', rows, detail: rows.find((r) => r.skipReason)?.skipReason || 'Test skipped.' };
  }
  const written = (tests?.tests || []).some((t) => (t.checklistIds || []).map((x) => String(x).toUpperCase()).includes(id) || idsInTitle(t.title).includes(id));
  return written
    ? { status: 'not-run', rows: [], detail: 'Test written but not run yet. Run the tests.' }
    : { status: 'no-test', rows: [], detail: tests ? 'No test covers this item. Regenerate the tests.' : 'Generate and run the tests to verify this item.' };
}
