import { requireOrgContext } from "@/lib/auth/context";
import { listConnections, PROVIDERS } from "@/server/integrations";
import { missingEnv } from "@/integrations/registry";
import { PageHeader, Notice } from "@/components/ui/page";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge, connectionTone } from "@/components/ui/badge";
import { Table, THead, TH, TR, TD } from "@/components/ui/table";
import { ActionButton } from "@/components/ui/action-form";
import { fmtDate, fmtRelative } from "@/lib/format";
import { ConnectDialog, PropertyPicker } from "./connect";
import { disconnectAction, syncAction, testAction } from "./actions";

export const metadata = { title: "Integrations" };

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireOrgContext();
  const [conns, sites, logs] = await Promise.all([
    listConnections(ctx),
    ctx.db.website.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ctx.db.syncLog.findMany({ orderBy: { startedAt: "desc" }, take: 40, include: { connection: { select: { provider: true } } } }),
  ]);
  const canManage = ctx.can("integrations:manage");
  const categories = [...new Set(PROVIDERS.map((p) => p.category))];
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const siteName = new Map(sites.map((s) => [s.id, s.name]));

  return (
    <>
      <PageHeader title="Integrations" description="Connect data sources, CMSs, AI models and notification channels. Status reflects real verification. Nothing is shown as connected until a live API call succeeds." />
      {sp.error && <Notice tone="bad" title="Connection failed" className="mb-4">{sp.error}</Notice>}

      {conns.length > 0 && (
        <Card className="mb-6">
          <CardHeader title="Connections" description="Credentials are encrypted at rest and only used server-side." />
          <Table>
            <THead><tr><TH>Integration</TH><TH>Scope</TH><TH>Status</TH><TH>Account</TH><TH>Last sync</TH>{canManage && <TH align="right"><span className="sr-only">Actions</span></TH>}</tr></THead>
            <tbody>
              {conns.map((c) => {
                const def = PROVIDERS.find((p) => p.id === c.provider)!;
                const needsProperty = c.provider.startsWith("GOOGLE_") && c.hasSecret && c.status !== "CONNECTED" && !c.lastError?.startsWith("Permission");
                const syncable = ["GOOGLE_SEARCH_CONSOLE", "GOOGLE_ANALYTICS_4"].includes(c.provider) && c.status === "CONNECTED";
                return (
                  <TR key={c.id}>
                    <TD><div className="font-medium">{def.name}</div><div className="text-2xs text-fg-subtle">{def.category}</div></TD>
                    <TD className="text-xs">{c.website?.name ?? "Workspace-wide"}</TD>
                    <TD>
                      <Badge tone={connectionTone(c.status)}>{c.status.toLowerCase()}</Badge>
                      {c.lastError && <div className="mt-1 max-w-xs text-2xs text-bad">{c.lastError}</div>}
                    </TD>
                    <TD className="text-xs text-fg-muted">{c.externalAccountId ?? "—"}{(c.config as { property?: string }).property && <div className="text-2xs">{(c.config as { property: string }).property}</div>}{(c.config as { propertyId?: string }).propertyId && <div className="text-2xs">GA4 {(c.config as { propertyId: string }).propertyId}</div>}</TD>
                    <TD className="text-xs text-fg-muted" >{fmtRelative(c.lastSyncAt)}</TD>
                    {canManage && (
                      <TD align="right">
                        <div className="flex flex-wrap justify-end gap-1">
                          {needsProperty && <PropertyPicker connectionId={c.id} provider={c.provider} autoOpen={sp.select === c.id} />}
                          {syncable && <ActionButton action={syncAction} fields={{ id: c.id }} size="sm">Sync now</ActionButton>}
                          {c.hasSecret && <ActionButton action={testAction} fields={{ id: c.id }} size="sm" variant="ghost">Test</ActionButton>}
                          {c.status !== "DISCONNECTED" && <ActionButton action={disconnectAction} fields={{ id: c.id }} size="sm" variant="ghost" confirm={`Disconnect ${def.name}? Stored credentials will be deleted.`}>Disconnect</ActionButton>}
                        </div>
                      </TD>
                    )}
                  </TR>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

      {categories.map((cat) => (
        <section key={cat} className="mb-6">
          <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-fg-subtle">{cat}</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {PROVIDERS.filter((p) => p.category === cat).map((p) => {
              const mine = conns.filter((c) => c.provider === p.id && c.status !== "DISCONNECTED");
              const missing = missingEnv(p);
              const status = mine.some((c) => c.status === "CONNECTED") ? "CONNECTED" : mine.some((c) => c.status === "ERROR") ? "ERROR" : mine.some((c) => c.status === "PENDING") ? "PENDING" : missing.length ? "UNAVAILABLE" : "DISCONNECTED";
              return (
                <Card key={p.id} className="flex flex-col p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">{p.name}</h3>
                      <p className="mt-0.5 text-2xs text-fg-subtle">{p.level === "website" ? "Connected per website" : "Workspace-wide"}</p>
                    </div>
                    <Badge tone={connectionTone(status)} title={status === "UNAVAILABLE" ? `Server is missing ${missing.join(", ")}` : undefined}>{status.toLowerCase()}{p.level === "website" && mine.length > 0 ? ` · ${mine.length} site${mine.length === 1 ? "" : "s"}` : ""}</Badge>
                  </div>
                  <p className="mt-2 flex-1 text-[13px] text-fg-muted">{p.description}</p>
                  <ul className="mt-2 flex flex-wrap gap-1">{p.powers.map((x) => <li key={x}><Badge>{x}</Badge></li>)}</ul>
                  {canManage && <div className="mt-3"><ConnectDialog def={p} sites={sites} missingEnv={missing} appUrl={appUrl} /></div>}
                </Card>
              );
            })}
          </div>
        </section>
      ))}

      <Card>
        <CardHeader title="Sync history" description="Every verification and data sync, with item counts and cost/quota units where the provider reports them." />
        {logs.length === 0 ? <p className="px-4 py-6 text-[13px] text-fg-muted">No syncs yet.</p> : (
          <Table>
            <THead><tr><TH>When</TH><TH>Integration</TH><TH>Website</TH><TH>Operation</TH><TH>Status</TH><TH align="right">Items</TH><TH align="right">Cost/quota</TH><TH>Message</TH></tr></THead>
            <tbody>
              {logs.map((l) => (
                <TR key={l.id}>
                  <TD className="whitespace-nowrap text-xs text-fg-muted">{fmtDate(l.startedAt, true)}</TD>
                  <TD className="text-xs">{PROVIDERS.find((p) => p.id === l.connection.provider)?.name}</TD>
                  <TD className="text-xs">{l.websiteId ? siteName.get(l.websiteId) ?? "—" : "—"}</TD>
                  <TD><code className="font-mono text-2xs">{l.operation}</code></TD>
                  <TD><Badge tone={l.status === "SUCCEEDED" ? "good" : l.status === "FAILED" ? "bad" : "info"}>{l.status.toLowerCase()}</Badge></TD>
                  <TD align="right">{l.itemsProcessed}</TD>
                  <TD align="right">{l.quotaUsed ?? "—"}</TD>
                  <TD className="max-w-sm truncate text-xs text-fg-muted" >{l.message}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
