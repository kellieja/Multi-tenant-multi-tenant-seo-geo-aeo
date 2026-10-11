import { Search } from "lucide-react";
import { Input, Select } from "@/components/ui/form";
import { Button } from "@/components/ui/button";

export interface FilterDef {
  name: string;
  label: string;
  options: { value: string; label: string }[];
}

/** GET form so filters live in the URL, are shareable and work without JS. */
export function FilterBar({
  q, qPlaceholder = "Search…", filters = [], values, preserve = {}, children,
}: {
  q?: string;
  qPlaceholder?: string;
  filters?: FilterDef[];
  values: Record<string, string | undefined>;
  preserve?: Record<string, string | undefined>;
  children?: React.ReactNode;
}) {
  return (
    <form method="get" className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
      {Object.entries(preserve).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <div className="relative min-w-48 flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
        <Input name="q" defaultValue={q} placeholder={qPlaceholder} className="pl-8" aria-label="Search" />
      </div>
      {filters.map((f) => (
        <Select key={f.name} name={f.name} defaultValue={values[f.name] ?? ""} aria-label={f.label} className="w-auto min-w-36">
          <option value="">{f.label}: all</option>
          {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      ))}
      {children}
      <Button type="submit" size="md">Apply</Button>
    </form>
  );
}
