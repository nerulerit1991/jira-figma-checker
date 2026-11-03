// Colour group for a Jira status name; workflows name their statuses differently, so match by keyword.
export function statusClass(status) {
  const s = (status || '').toLowerCase();
  if (/done|closed|resolved|complete|released|deployed/.test(s)) return 'done';
  if (/progress|review|qa|test|develop|doing|staging|uat/.test(s)) return 'active';
  if (/block|hold|reject|cancel/.test(s)) return 'blocked';
  return 'todo';
}
