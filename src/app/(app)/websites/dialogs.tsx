"use client";

import { useState } from "react";
import { Plus, Upload } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { ActionForm } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Notice } from "@/components/ui/page";
import type { CsvImportResult } from "@/server/websites";
import { WebsiteForm, type WebsiteFormValues } from "./website-form";
import { importCsvAction } from "./actions";

export function AddWebsiteDialog({ clients, label = "Add website", variant = "primary" }: { clients: { id: string; name: string }[]; label?: string; variant?: "primary" | "secondary" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}><Plus className="size-3.5" />{label}</Button>
      <Dialog title="Add a website" description="We'll normalise the URL and set safe default crawl settings you can change later." open={open} onClose={() => setOpen(false)} size="lg">
        <WebsiteForm clients={clients} onDone={() => setOpen(false)} />
      </Dialog>
    </>
  );
}

export function EditWebsiteDialog({ clients, initial }: { clients: { id: string; name: string }[]; initial: WebsiteFormValues }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Edit details</Button>
      <Dialog title="Edit website" open={open} onClose={() => setOpen(false)} size="lg">
        <WebsiteForm clients={clients} initial={initial} onDone={() => setOpen(false)} />
      </Dialog>
    </>
  );
}

export function ImportCsvDialog() {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<CsvImportResult | null>(null);
  return (
    <>
      <Button onClick={() => { setResult(null); setOpen(true); }}><Upload className="size-3.5" />Import CSV</Button>
      <Dialog title="Import websites from CSV" open={open} onClose={() => setOpen(false)} size="lg"
        description={<>Header row required. Columns: <code className="font-mono text-xs">url</code> (required), <code className="font-mono text-xs">name, client, project, industry, folder, tags, cms</code>. Separate multiple tags with semicolons. Existing domains are skipped, never overwritten.</>}>
        <ActionForm action={importCsvAction} onSuccess={(d) => setResult(d)} className="space-y-4">
          {({ pending }) => (
            <>
              <Field label="CSV file" htmlFor="file"><Input id="file" name="file" type="file" accept=".csv,text/csv" className="py-1.5" /></Field>
              <Field label="…or paste CSV" htmlFor="csv">
                <Textarea id="csv" name="csv" rows={5} className="font-mono text-xs" placeholder={"name,url,client,tags,cms\nAcme Store,acme.com,Acme Inc,retail;uk,wordpress"} />
              </Field>
              {result && (
                <Notice tone={result.skipped.length ? "warn" : "good"} title={`${result.created} created, ${result.skipped.length} skipped`}>
                  {result.skipped.length > 0 && (
                    <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs">
                      {result.skipped.map((s) => <li key={s.row}>Row {s.row}: {s.reason}</li>)}
                    </ul>
                  )}
                </Notice>
              )}
              <div className="flex justify-end gap-2">
                <a href="/api/websites/csv-template" className="mr-auto self-center text-xs text-accent hover:underline">Download template</a>
                <Button type="submit" variant="primary" loading={pending}>Import</Button>
              </div>
            </>
          )}
        </ActionForm>
      </Dialog>
    </>
  );
}
