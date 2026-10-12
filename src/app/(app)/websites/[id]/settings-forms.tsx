"use client";

import { ActionForm, fieldError } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import type { WebsiteSettings } from "@/server/websites";
import { deleteWebsiteAction, setAssignmentsAction, updateSettingsAction } from "../actions";

export function CrawlSettingsForm({ id, settings, disabled }: { id: string; settings: WebsiteSettings; disabled: boolean }) {
  return (
    <ActionForm action={updateSettingsAction} className="space-y-6">
      {({ pending, state }) => (
        <fieldset disabled={disabled} className="space-y-6">
          <input type="hidden" name="id" value={id} />
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-fg-subtle">Crawler</h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Max pages" htmlFor="maxPages" error={fieldError(state, "maxPages")}><Input id="maxPages" name="maxPages" type="number" min={1} max={20000} defaultValue={settings.maxPages} /></Field>
              <Field label="Max depth" htmlFor="maxDepth" error={fieldError(state, "maxDepth")}><Input id="maxDepth" name="maxDepth" type="number" min={1} max={50} defaultValue={settings.maxDepth} /></Field>
              <Field label="Delay between requests (ms)" htmlFor="crawlDelayMs" hint="Min 100ms. A robots.txt Crawl-delay overrides this if larger." error={fieldError(state, "crawlDelayMs")}>
                <Input id="crawlDelayMs" name="crawlDelayMs" type="number" min={100} defaultValue={settings.crawlDelayMs} />
              </Field>
              <Field label="Parallel requests" htmlFor="concurrency"><Select id="concurrency" name="concurrency" defaultValue={settings.concurrency}>{[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</Select></Field>
              <Field label="Include URL patterns" htmlFor="includePatterns" hint="Comma separated path prefixes, e.g. /blog/" className="sm:col-span-2">
                <Input id="includePatterns" name="includePatterns" defaultValue={settings.includePatterns.join(", ")} />
              </Field>
              <Field label="Exclude URL patterns" htmlFor="excludePatterns" hint="Comma separated, e.g. /cart, /account" className="sm:col-span-3">
                <Input id="excludePatterns" name="excludePatterns" defaultValue={settings.excludePatterns.join(", ")} />
              </Field>
            </div>
            <div className="mt-4"><Checkbox name="checkExternalLinks" defaultChecked={settings.checkExternalLinks} label="Check outbound links for errors" hint="Sends one HEAD/GET request per unique external URL." /></div>
          </section>
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-fg-subtle">Schedule</h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Crawl schedule (cron)" htmlFor="crawlSchedule" hint={"e.g. 0 3 * * 1 = Mondays 03:00 UTC. Empty = manual."} error={fieldError(state, "crawlSchedule")} className="sm:col-span-2">
                <Input id="crawlSchedule" name="crawlSchedule" defaultValue={settings.crawlSchedule ?? ""} className="font-mono" placeholder="0 3 * * 1" />
              </Field>
              <Field label="Scheduled crawl mode" htmlFor="crawlMode"><Select id="crawlMode" name="crawlMode" defaultValue={settings.crawlMode}><option value="FULL">Full</option><option value="INCREMENTAL">Incremental</option></Select></Field>
              <Field label="JavaScript rendering" htmlFor="renderMode" hint="Auto renders pages in a headless browser only when content appears after JavaScript runs (React/Vite single-page apps, many Replit sites). Rendered crawls are slower.">
                <Select id="renderMode" name="renderMode" defaultValue={settings.renderMode}><option value="auto">Auto-detect</option><option value="always">Always render</option><option value="off">Off (raw HTML only)</option></Select>
              </Field>
            </div>
          </section>
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-fg-subtle">Change approval & alerts</h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Site change policy" htmlFor="approvalPolicy" className="sm:col-span-3" hint="Applies to CMS changes proposed by automations. Content and internal-link changes always require approval.">
                <Select id="approvalPolicy" name="approvalPolicy" defaultValue={settings.approvalPolicy}>
                  <option value="always">Always require human approval (recommended)</option>
                  <option value="safe-auto">Allow low-risk metadata fixes in AUTOMATIC workflows</option>
                </Select>
              </Field>
              <Field label="Alert on rank drop ≥ (positions)" htmlFor="alertRankDrop"><Input id="alertRankDrop" name="alertRankDrop" type="number" min={1} defaultValue={settings.alertRankDrop} /></Field>
              <Field label="Alert on health drop ≥ (points)" htmlFor="alertHealthDrop"><Input id="alertHealthDrop" name="alertHealthDrop" type="number" min={1} defaultValue={settings.alertHealthDrop} /></Field>
            </div>
          </section>
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-fg-subtle">Data sources</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Search Console property" htmlFor="gscPropertyUrl" hint="Set automatically when you connect GSC; e.g. sc-domain:example.com"><Input id="gscPropertyUrl" name="gscPropertyUrl" defaultValue={settings.gscPropertyUrl ?? ""} /></Field>
              <Field label="GA4 property ID" htmlFor="ga4PropertyId" hint="Numeric ID, e.g. 312345678"><Input id="ga4PropertyId" name="ga4PropertyId" defaultValue={settings.ga4PropertyId ?? ""} /></Field>
              <Field label="Rank tracking location code" htmlFor="rankLocationCode" hint="DataForSEO location code (2840 = United States)"><Input id="rankLocationCode" name="rankLocationCode" type="number" defaultValue={settings.rankLocationCode} /></Field>
              <Field label="Language" htmlFor="rankLanguageCode"><Input id="rankLanguageCode" name="rankLanguageCode" defaultValue={settings.rankLanguageCode} /></Field>
            </div>
          </section>
          {!disabled && <div className="flex justify-end"><Button type="submit" variant="primary" loading={pending}>Save settings</Button></div>}
        </fieldset>
      )}
    </ActionForm>
  );
}

export function AssignmentsForm({ id, members, assigned, disabled }: { id: string; members: { id: string; name: string; email: string }[]; assigned: string[]; disabled: boolean }) {
  return (
    <ActionForm action={setAssignmentsAction} className="space-y-3">
      {({ pending }) => (
        <fieldset disabled={disabled} className="space-y-3">
          <input type="hidden" name="id" value={id} />
          <div className="space-y-2">
            {members.map((m) => <Checkbox key={m.id} name="userId" value={m.id} defaultChecked={assigned.includes(m.id)} label={m.name} hint={m.email} />)}
          </div>
          {!disabled && <Button type="submit" size="sm" loading={pending}>Save assignments</Button>}
        </fieldset>
      )}
    </ActionForm>
  );
}

export function DangerZone({ id, domain }: { id: string; domain: string }) {
  return (
    <ActionForm action={deleteWebsiteAction} refresh={false} className="space-y-3">
      {({ pending, state }) => (
        <>
          <p className="text-xs text-fg-muted">Permanently deletes this website and all of its crawls, findings, keywords, backlinks and history. Prefer archiving if you may need the data.</p>
          <input type="hidden" name="id" value={id} />
          <Field label={`Type ${domain} to confirm`} htmlFor="confirm" error={state && !state.ok ? state.error : undefined}>
            <Input id="confirm" name="confirm" autoComplete="off" />
          </Field>
          <Button type="submit" variant="danger" size="sm" loading={pending}>Delete website permanently</Button>
        </>
      )}
    </ActionForm>
  );
}
