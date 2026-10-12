"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { ActionForm } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/form";
import { startCrawlAction } from "./actions";

export function RunCrawlDialog({ sites, defaultSite, label = "Run crawl", variant = "primary" }: { sites: { id: string; name: string; domain: string }[]; defaultSite?: string; label?: string; variant?: "primary" | "secondary" }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)} disabled={!sites.length}><Play className="size-3.5" />{label}</Button>
      <Dialog title="Run a crawl" open={open} onClose={() => setOpen(false)} description="Crawls respect robots.txt, the site's rate limits and page caps. Settings are per website.">
        <ActionForm action={startCrawlAction} refresh={false} onSuccess={(d) => { setOpen(false); router.push(`/audits/${d.crawlId}`); }} className="space-y-4">
          {({ pending }) => (
            <>
              <Field label="Website" htmlFor="websiteId">
                <Select id="websiteId" name="websiteId" defaultValue={defaultSite ?? sites[0]?.id}>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.domain})</option>)}
                </Select>
              </Field>
              <Field label="Mode" htmlFor="mode" hint="Incremental re-fetches the homepage, pages with open issues and new/updated sitemap URLs, and carries the rest forward from the last crawl.">
                <Select id="mode" name="mode" defaultValue="FULL"><option value="FULL">Full crawl</option><option value="INCREMENTAL">Incremental crawl</option></Select>
              </Field>
              <div className="flex justify-end"><Button type="submit" variant="primary" loading={pending}>Start crawl</Button></div>
            </>
          )}
        </ActionForm>
      </Dialog>
    </>
  );
}
