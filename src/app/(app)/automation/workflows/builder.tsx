"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Clock, Filter, Plus, Trash2, Zap, Hand, ShieldCheck, FlaskConical, Bot } from "lucide-react";
import { ActionForm } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input, Select, Textarea, Checkbox } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { Notice } from "@/components/ui/page";
import { cn } from "@/lib/cn";
import { ACTIONS, CONDITION_FIELDS, EVENTS, type ActionType, type ConditionField, type WorkflowInput } from "@/server/workflow-schema";
import { saveWorkflowAction, deleteWorkflowAction } from "../actions";

const OPS = [["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"], ["eq", "="], ["neq", "≠"], ["contains", "contains"]] as const;
const CRON_PRESETS = [["0 3 * * 1", "Weekly, Monday 03:00"], ["0 6 * * *", "Daily 06:00"], ["0 7 1 * *", "Monthly, 1st 07:00"], ["0 */6 * * *", "Every 6 hours"]] as const;

function Block({ icon, title, tone, children, aside }: { icon: React.ReactNode; title: string; tone: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <Card className="relative">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
        <span className={cn("flex size-6 items-center justify-center rounded-md text-white", tone)}>{icon}</span>
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="ml-auto">{aside}</span>
      </div>
      <div className="p-4">{children}</div>
    </Card>
  );
}

const Connector = () => <div className="mx-auto h-6 w-px bg-border-strong" aria-hidden />;

export function WorkflowBuilder({
  id, initial, sites, clients, templates,
}: {
  id?: string;
  initial: WorkflowInput;
  sites: { id: string; name: string }[];
  clients: { id: string; name: string }[];
  templates?: { name: string; description: string; input: WorkflowInput }[];
}) {
  const [wf, setWf] = useState<WorkflowInput>(initial);
  const router = useRouter();
  const set = <K extends keyof WorkflowInput>(k: K, v: WorkflowInput[K]) => setWf((w) => ({ ...w, [k]: v }));
  const externalActions = wf.actions.filter((a) => ACTIONS[a.type].risk === "external");

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div>
        {templates && templates.length > 0 && (
          <div className="mb-5">
            <div className="mb-2 text-xs font-medium text-fg-muted">Start from a template</div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {templates.map((t) => (
                <button key={t.name} type="button" onClick={() => setWf(t.input)} className="rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:border-accent">
                  <div className="text-[13px] font-medium">{t.name}</div>
                  <div className="mt-0.5 text-xs text-fg-muted">{t.description}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        <Block icon={wf.trigger.type === "schedule" ? <Clock className="size-3.5" /> : wf.trigger.type === "event" ? <Zap className="size-3.5" /> : <Hand className="size-3.5" />} title="Trigger" tone="bg-[var(--chart-1)]">
          <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
            <Select aria-label="Trigger type" value={wf.trigger.type} onChange={(e) => {
              const t = e.target.value;
              set("trigger", t === "schedule" ? { type: "schedule", cron: "0 3 * * 1" } : t === "event" ? { type: "event", event: "crawl.completed" } : { type: "manual" });
            }}>
              <option value="schedule">On a schedule</option><option value="event">When something happens</option><option value="manual">Manually</option>
            </Select>
            {wf.trigger.type === "schedule" && (
              <div className="flex flex-wrap gap-2">
                <Input aria-label="Cron expression" className="w-40 font-mono" value={wf.trigger.cron} onChange={(e) => set("trigger", { type: "schedule", cron: e.target.value })} />
                <Select aria-label="Schedule preset" className="w-auto" value="" onChange={(e) => e.target.value && set("trigger", { type: "schedule", cron: e.target.value })}>
                  <option value="">Presets…</option>{CRON_PRESETS.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
                </Select>
                <span className="self-center text-2xs text-fg-subtle">Times are UTC</span>
              </div>
            )}
            {wf.trigger.type === "event" && (
              <Select aria-label="Event" value={wf.trigger.event} onChange={(e) => set("trigger", { type: "event", event: e.target.value as keyof typeof EVENTS })}>
                {Object.entries(EVENTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            )}
            {wf.trigger.type === "manual" && <p className="self-center text-xs text-fg-muted">Runs only when someone clicks “Run now”.</p>}
          </div>
        </Block>
        <Connector />

        <Block icon={<Filter className="size-3.5" />} title="Conditions" tone="bg-[var(--chart-4)]" aside={<span className="text-2xs text-fg-subtle">All must pass, per website</span>}>
          {wf.conditions.length === 0 && <p className="mb-3 text-xs text-fg-muted">No conditions: actions always run.</p>}
          <div className="space-y-2">
            {wf.conditions.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Select aria-label="Field" className="w-auto min-w-56" value={c.field} onChange={(e) => set("conditions", wf.conditions.map((x, j) => (j === i ? { ...x, field: e.target.value as ConditionField } : x)))}>
                  {Object.entries(CONDITION_FIELDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </Select>
                <Select aria-label="Operator" className="w-auto" value={c.op} onChange={(e) => set("conditions", wf.conditions.map((x, j) => (j === i ? { ...x, op: e.target.value as typeof c.op } : x)))}>
                  {OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
                <Input aria-label="Value" className="w-32" value={String(c.value)} onChange={(e) => {
                  const raw = e.target.value;
                  const value = CONDITION_FIELDS[c.field].type === "number" && raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
                  set("conditions", wf.conditions.map((x, j) => (j === i ? { ...x, value } : x)));
                }} />
                <Button variant="ghost" size="icon" aria-label="Remove condition" onClick={() => set("conditions", wf.conditions.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
              </div>
            ))}
          </div>
          <Button size="sm" className="mt-3" onClick={() => set("conditions", [...wf.conditions, { field: "openCritical", op: "gt", value: 0 }])}><Plus className="size-3" />Add condition</Button>
        </Block>
        <Connector />

        {wf.actions.map((a, i) => {
          const def = ACTIONS[a.type];
          return (
            <div key={i}>
              <Block icon={<Bot className="size-3.5" />} title={`Action ${i + 1}`} tone={def.risk === "external" ? "bg-[var(--chart-3)]" : "bg-[var(--chart-2)]"}
                aside={<div className="flex items-center gap-1">
                  {def.risk === "external" && <Badge tone="warn">affects live site</Badge>}
                  <Button variant="ghost" size="icon" aria-label="Move up" disabled={i === 0} onClick={() => { const n = [...wf.actions]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; set("actions", n); }}><ArrowUp className="size-3.5" /></Button>
                  <Button variant="ghost" size="icon" aria-label="Move down" disabled={i === wf.actions.length - 1} onClick={() => { const n = [...wf.actions]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; set("actions", n); }}><ArrowDown className="size-3.5" /></Button>
                  <Button variant="ghost" size="icon" aria-label="Remove action" onClick={() => set("actions", wf.actions.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
                </div>}>
                <Select aria-label="Action" value={a.type} onChange={(e) => set("actions", wf.actions.map((x, j) => (j === i ? { type: e.target.value as ActionType, params: {} } : x)))}>
                  {Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </Select>
                {Object.entries(def.params).length > 0 && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {Object.entries(def.params).map(([pk, spec]) => (
                      <Field key={pk} label={pk.replace(/([A-Z])/g, " $1").toLowerCase()}>
                        {Array.isArray(spec) ? (
                          <Select value={String(a.params[pk] ?? spec[0])} onChange={(e) => set("actions", wf.actions.map((x, j) => (j === i ? { ...x, params: { ...x.params, [pk]: e.target.value } } : x)))}>
                            {spec.map((o) => <option key={o} value={o}>{o.toLowerCase()}</option>)}
                          </Select>
                        ) : spec === "number" ? (
                          <Input type="number" min={1} value={String(a.params[pk] ?? "")} onChange={(e) => set("actions", wf.actions.map((x, j) => (j === i ? { ...x, params: { ...x.params, [pk]: Number(e.target.value) } } : x)))} />
                        ) : (
                          <Input value={String(a.params[pk] ?? "")} onChange={(e) => set("actions", wf.actions.map((x, j) => (j === i ? { ...x, params: { ...x.params, [pk]: e.target.value } } : x)))} />
                        )}
                      </Field>
                    ))}
                  </div>
                )}
              </Block>
              <Connector />
            </div>
          );
        })}
        <div className="flex justify-center">
          <Button onClick={() => set("actions", [...wf.actions, { type: "create_tasks", params: { minSeverity: "HIGH", limit: 20 } }])}><Plus className="size-3.5" />Add action</Button>
        </div>
      </div>

      <div className="space-y-4 xl:sticky xl:top-20 xl:self-start">
        <Card className="space-y-4 p-4">
          <Field label="Name" htmlFor="wf-name"><Input id="wf-name" value={wf.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Description" htmlFor="wf-desc"><Textarea id="wf-desc" rows={2} value={wf.description ?? ""} onChange={(e) => set("description", e.target.value)} /></Field>
          <div>
            <div className="mb-1.5 text-xs font-medium">Execution mode</div>
            <div className="space-y-1.5">
              {([["DRY_RUN", <FlaskConical key="d" className="size-4" />, "Dry run", "Logs what would happen. No changes, no jobs."], ["APPROVAL", <ShieldCheck key="a" className="size-4" />, "Approval", "Internal actions run; live-site and outreach actions wait for approval."], ["AUTOMATIC", <Zap key="z" className="size-4" />, "Automatic", "Internal actions run. Live-site actions still need approval unless the site's policy is “safe-auto”."]] as const).map(([v, icon, l, d]) => (
                <label key={v} className={cn("flex cursor-pointer gap-2.5 rounded-lg border p-2.5", wf.mode === v ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-hover")}>
                  <input type="radio" name="mode" className="sr-only" checked={wf.mode === v} onChange={() => set("mode", v)} />
                  <span className="mt-0.5 text-fg-muted">{icon}</span>
                  <span><span className="block text-[13px] font-medium">{l}</span><span className="block text-2xs text-fg-muted">{d}</span></span>
                </label>
              ))}
            </div>
          </div>
          <Field label="Website scope">
            <Select value={wf.scope.type} onChange={(e) => set("scope", e.target.value === "all" ? { type: "all" } : { type: e.target.value as "websites", ids: [] })}>
              <option value="all">All active websites</option><option value="websites">Selected websites</option>{clients.length > 0 && <option value="clients">Websites of selected clients</option>}
            </Select>
          </Field>
          {wf.scope.type !== "all" && (
            <div className="scroll-thin max-h-48 space-y-1.5 overflow-y-auto rounded-md border border-border p-2.5">
              {(wf.scope.type === "websites" ? sites : clients).map((s) => {
                const scope = wf.scope as { type: "websites" | "clients"; ids: string[] };
                return <Checkbox key={s.id} label={s.name} checked={scope.ids.includes(s.id)} onChange={(e) => set("scope", { type: scope.type, ids: e.target.checked ? [...scope.ids, s.id] : scope.ids.filter((x) => x !== s.id) })} />;
              })}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Retries on failure"><Select value={String(wf.maxRetries)} onChange={(e) => set("maxRetries", Number(e.target.value))}>{[0, 1, 2, 3, 5].map((n) => <option key={n}>{n}</option>)}</Select></Field>
            <div>
              <div className="mb-1.5 text-xs font-medium">Notify on</div>
              {(["FAILED", "SUCCEEDED"] as const).map((n) => <Checkbox key={n} label={n.toLowerCase()} checked={wf.notifyOn.includes(n)} onChange={(e) => set("notifyOn", e.target.checked ? [...wf.notifyOn, n] : wf.notifyOn.filter((x) => x !== n))} />)}
            </div>
          </div>
          {externalActions.length > 0 && wf.mode !== "DRY_RUN" && (
            <Notice tone="warn">This workflow includes actions that change live websites. They are routed through approval{wf.mode === "AUTOMATIC" ? " unless a site uses the safe-auto policy (low-risk metadata only, from human-approved drafts)" : ""}.</Notice>
          )}
          <ActionForm action={saveWorkflowAction} onSuccess={(d) => router.push(`/automation/workflows/${d.id}`)} refresh={false}>
            {({ pending, state }) => (
              <>
                {id && <input type="hidden" name="id" value={id} />}
                <input type="hidden" name="definition" value={JSON.stringify(wf)} />
                {state && !state.ok && <Notice tone="bad" className="mb-2">{state.error}</Notice>}
                <Button type="submit" variant="primary" className="w-full" loading={pending}>{id ? "Save workflow" : "Create workflow"}</Button>
              </>
            )}
          </ActionForm>
          {id && (
            <ActionForm action={deleteWorkflowAction} onSuccess={() => router.push("/automation")} refresh={false}>
              {({ pending }) => (<><input type="hidden" name="id" value={id} /><Button type="submit" variant="ghost" size="sm" className="w-full text-bad" loading={pending} onClick={(e) => { if (!confirm("Delete this workflow and its execution history?")) e.preventDefault(); }}>Delete workflow</Button></>)}
            </ActionForm>
          )}
        </Card>
      </div>
    </div>
  );
}
