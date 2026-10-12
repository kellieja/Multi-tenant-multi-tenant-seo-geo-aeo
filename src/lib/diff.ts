/**
 * The changed region between two strings: the common prefix and suffix are trimmed to a
 * little context, and the removed/added middle is returned in full. Used on approval
 * screens so the approver sees exactly what a change does, however long the field is.
 */
export function changeRegion(before: string, after: string, context = 160) {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const prefixFull = before.slice(0, start);
  const suffixFull = before.slice(before.length - end);
  return {
    prefix: prefixFull.slice(-context),
    prefixTruncated: prefixFull.length > context,
    removed: before.slice(start, before.length - end),
    added: after.slice(start, after.length - end),
    suffix: suffixFull.slice(0, context),
    suffixTruncated: suffixFull.length > context,
  };
}
export type ChangeRegion = ReturnType<typeof changeRegion>;
