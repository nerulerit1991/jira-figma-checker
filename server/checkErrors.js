// Errors-only view of a UI check, saved as data/<KEY>/check-errors.json. A re-check sends only these
// to the agent (with the matching slice of page and Figma data) instead of the whole page and design.

/** Everything that failed in a check.json. Figma-file mistakes ("source": "figma") are not live errors. */
export function buildCheckErrors(check) {
  if (!check) return null;
  const checklist = (check.results || [])
    .filter((r) => !r.passed)
    .map(({ id, item, evidence }) => ({ id, item, evidence }));
  const design = (check.designChecklist || [])
    .filter((c) => !c.passed)
    .map((c) => ({ category: c.category, issues: (c.issues || []).filter((i) => i.source !== 'figma') }));
  const designRows = (check.designMatch?.rows || []).filter((r) => !r.match);
  const responsive = (check.responsive || [])
    .filter((r) => !r.passed)
    .map(({ viewport, width, issues }) => ({ viewport, width, issues }));
  return {
    url: check.url,
    checkedAt: check.recheckedAt || check.checkedAt,
    compareViewport: check.designMatch?.comparedAt || null,
    count: checklist.length + design.length + responsive.length,
    checklist,
    design,
    designRows,
    responsive,
  };
}

/** Viewports a re-check has to render: the compared one for checklist/design errors, plus failed layouts. */
export function viewportsFor(errors, compareViewport) {
  const names = new Set(errors.responsive.map((r) => r.viewport));
  if (errors.design.length || errors.designRows.length) names.add(compareViewport);
  for (const c of errors.checklist) {
    names.add('desktop');
    const text = `${c.item} ${c.evidence || ''}`;
    if (/mobile|phone/i.test(text)) names.add('mobile');
    if (/tablet/i.test(text)) names.add('tablet');
  }
  return [...names];
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Section names the design errors point at; used to send only those parts of the page and of Figma. */
export function errorSections(errors) {
  return [
    ...new Set([...errors.design.flatMap((c) => c.issues.map((i) => i.section)), ...errors.designRows.map((r) => r.section)].map(norm).filter(Boolean)),
  ];
}

/**
 * Entries in the sections the errors name; everything when nothing matches. Section names differ between Figma
 * ('Hero · "About"') and the page ("our-team"), so an entry whose section, element or text mentions an error
 * section pulls in its whole section.
 */
export function inSections(entries, sections) {
  if (!entries?.length || !sections.length) return entries;
  const mentions = (value) => {
    const v = norm(value);
    return v && sections.some((x) => v.includes(x) || (v.length > 3 && x.includes(v)));
  };
  const matched = new Set(entries.filter((e) => mentions(e.section) || mentions(e.element) || mentions(e.text)).map((e) => norm(e.section)));
  const hit = entries.filter((e) => matched.has(norm(e.section)));
  return hit.length ? hit : entries;
}

/** Writes the re-check's verdicts over the previous check; items that were not re-checked stay as they were. */
export function mergeRecheck(check, recheck, page) {
  const results = new Map((recheck.results || []).map((r) => [r.id, r]));
  const categories = new Map((recheck.designChecklist || []).map((c) => [c.category, c]));
  const viewports = new Map((recheck.responsive || []).map((r) => [r.viewport, r]));
  const captured = new Map(page.viewports.map((v) => [v.name, v]));

  const designChecklist = check.designChecklist?.map((c) => {
    const next = categories.get(c.category);
    if (!next) return c;
    // Figma-file notes are not re-checked; keep them with the new live issues.
    const figmaNotes = (c.issues || []).filter((i) => i.source === 'figma');
    return { ...c, passed: next.passed, issues: [...(next.issues || []).filter((i) => i.source !== 'figma'), ...figmaNotes] };
  });
  // A failed row is replaced only by a re-checked row for the same property; one the re-check left out stays failed.
  const rowKey = (r) => [r.section, r.element, r.property].map(norm).join('|');
  const recheckedRows = new Map((recheck.designMatch?.rows || []).map((r) => [rowKey(r), r]));
  const designMatch = check.designMatch && {
    ...check.designMatch,
    rows: [
      ...check.designMatch.rows.map((r) => (r.match ? r : recheckedRows.get(rowKey(r)) || r)),
      ...[...recheckedRows.values()].filter((r) => !check.designMatch.rows.some((old) => rowKey(old) === rowKey(r))),
    ],
  };

  return {
    ...check,
    results: check.results?.map((r) => (results.has(r.id) ? { ...r, ...results.get(r.id), id: r.id, item: r.item } : r)),
    designChecklist,
    designMatch,
    responsive: check.responsive?.map((r) => (viewports.has(r.viewport) ? { ...r, ...viewports.get(r.viewport) } : r)),
    screenshots: check.screenshots?.map((s) =>
      captured.has(s.viewport) ? { viewport: s.viewport, width: captured.get(s.viewport).width, pageHeight: captured.get(s.viewport).pageHeight } : s,
    ),
    layoutScan: { ...check.layoutScan, ...Object.fromEntries(page.viewports.map((v) => [v.name, v.layout])) },
    summary: recheck.summary || check.summary,
    warning: page.warning,
  };
}
