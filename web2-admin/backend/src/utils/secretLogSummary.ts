export function secretLogSummary(value: string | null | undefined): string {
  if (!value) return '(unset)';
  return `(configured, ${String(value.length)} chars)`;
}
