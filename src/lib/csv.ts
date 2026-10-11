/** RFC 4180 CSV with formula-injection protection for spreadsheet apps. */
export function toCsv(rows: unknown[][]): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          if (v == null) return "";
          let s = v instanceof Date ? v.toISOString() : String(v);
          if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
          return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    )
    .join("\r\n");
}

export function csvResponse(rows: unknown[][], filename: string) {
  return new Response(toCsv(rows), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"` },
  });
}
