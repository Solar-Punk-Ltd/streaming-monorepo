/** Whether `value` has exactly the named own keys, in any order on either side. */
export function hasExactlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  const expected = new Set(fields);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}
