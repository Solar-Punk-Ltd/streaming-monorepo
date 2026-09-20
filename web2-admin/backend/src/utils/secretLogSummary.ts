export function secretLogSummary(value: string): string {
  if (value === '') return '(unset)';
  return `(configured, ${String(value.length)} chars)`;
}
