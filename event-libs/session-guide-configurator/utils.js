// Display title for a row: componentName is the deliberate identifying label here
// (not a fallback) — an event can have multiple configs (widget/page variants, test
// copies; see PLAN.md §2/§5), so unlike Tier 1 Event Configurator, the linked event's
// own title alone isn't unique per row.
export function getDisplayTitle(row) {
  return row?.componentName || row?.backendEventTitle || row?.eventId || '';
}

export function formatUpdatedTime(isoString) {
  if (!isoString) return '';
  try {
    return new Date(isoString).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}
