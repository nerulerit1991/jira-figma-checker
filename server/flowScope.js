// Which interaction-flow screens Check UI checks. Shared by the server and the UI.
//
// No switches to set: a screen is checked when the Jira checklist has items about it (flow.json checklistScreens,
// split at the start of each check), so screens the ticket does not mention cost nothing. A screen behind a click that
// may change data (Pay, Submit, Delete…) is checked only after the person allows it (screen.allowRisky).

/** Checklist items the split put on this screen, or null before the first split. */
export function itemsOnScreen(flow, id) {
  const assignments = flow?.checklistScreens?.assignments;
  return assignments ? Object.values(assignments).filter((s) => s === id).length : null;
}

/**
 * 'start' (the ticket's frame), 'checked', 'not-in-ticket' (no checklist items), 'risky' (has items, waiting for
 * the person to allow its clicks) or 'pending' (the checklist is split on the next check).
 */
export function screenState(flow, screen) {
  if (screen.kind === 'start') return 'start';
  const items = itemsOnScreen(flow, screen.id);
  if (items == null) return 'pending';
  if (!items) return 'not-in-ticket';
  return screen.risky && !screen.allowRisky ? 'risky' : 'checked';
}

/** The screens a flow run clicks through and checks. */
export const checkedScreens = (flow) => (flow?.screens || []).filter((s) => screenState(flow, s) === 'checked');
