/** Extracts the first JSON object/array from model text (tolerates code fences and prose). */
export function parseJsonLoose<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try { return JSON.parse(candidate.slice(start, i + 1)) as T; } catch { return null; }
    }
  }
  return null;
}

export const FACT_GUARDRAIL =
  "Use ONLY facts present in the supplied page content. Never invent statistics, prices, awards, dates, credentials, locations, guarantees or claims. " +
  "If the content doesn't support a detail, leave it out. Output is a draft for human review.";
