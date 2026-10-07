/** Pulls the first JSON object out of a model reply (handles ```json fences and surrounding prose). */
export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidates = [fenced, text].filter((s): s is string => typeof s === "string");
  for (const c of candidates) {
    const start = c.indexOf("{");
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const v = JSON.parse(c.slice(start, i + 1));
            return v && typeof v === "object" && !Array.isArray(v) ? v : null;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}
