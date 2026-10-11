import { requireOrgContext } from "@/lib/auth/context";
import { prisma } from "@/lib/db/client";
import { PageHeader } from "@/components/ui/page";
import { TabNav } from "@/components/ui/tabs";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Table, THead, TH, TR, TD, Pagination, makeHref } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ROLE_LABELS } from "@/lib/auth/rbac";
import { fmtDate, fmtRelative } from "@/lib/format";
import { OrgForm, InviteForm, MemberRow, ClientForm, ClientArchive, PasswordForm, AppearanceControl, SignOutOthers } from "./forms";

export const metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireOrgContext();
  const tabs = [
    { key: "workspace", label: "Workspace", show: ctx.can("org:manage") },
    { key: "members", label: "Members", show: ctx.role !== "CLIENT" },
    { key: "clients", label: "Clients", show: ctx.role !== "CLIENT" },
    { key: "account", label: "Account & appearance", show: true },
    { key: "audit-log", label: "Audit log", show: ctx.can("audit-log:read") },
  ].filter((t) => t.show);
  const tab = tabs.find((t) => t.key === sp.tab)?.key ?? tabs[0].key;

  return (
    <>
      <PageHeader title="Settings" description="Workspace configuration, team access, clients and your account." />
      <TabNav active={tab} tabs={tabs.map((t) => ({ ...t, href: `/settings?tab=${t.key}` }))} />
      {tab === "workspace" && <WorkspaceTab />}
      {tab === "members" && <MembersTab />}
      {tab === "clients" && <ClientsTab />}
      {tab === "account" && <AccountTab />}
      {tab === "audit-log" && <AuditLogTab page={Number(sp.page ?? 1)} sp={sp} />}
    </>
  );

  async function WorkspaceTab() {
    const s = (ctx.org.settings ?? {}) as { notifyEmail?: string };
    return (
      <Card className="max-w-3xl">
        <CardHeader title="Workspace & white-label branding" description="Brand name, colour and logo appear on reports and the client portal." />
        <CardBody><OrgForm org={{ name: ctx.org.name, brandName: ctx.org.brandName, brandColor: ctx.org.brandColor ?? "#2F5BEA", logoUrl: ctx.org.logoUrl, notifyEmail: s.notifyEmail ?? "" }} /></CardBody>
      </Card>
    );
  }

  async function MembersTab() {
    const [members, invites, clients] = await Promise.all([
      ctx.db.membership.findMany({ include: { user: { select: { name: true, email: true, lastLoginAt: true } }, client: { select: { name: true } } }, orderBy: { createdAt: "asc" } }),
      ctx.db.invitation.findMany({ where: { acceptedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } }),
      ctx.db.client.findMany({ where: { archivedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    const canManage = ctx.can("members:manage");
    return (
      <div className="space-y-5">
        {canManage && (
          <Card>
            <CardHeader title="Invite a team member or client" description="Client accounts only see their client's websites, approved reports and tasks you share with them." />
            <CardBody><InviteForm clients={clients} /></CardBody>
          </Card>
        )}
        <Card>
          <CardHeader title={`Members (${members.length})`} />
          <Table>
            <THead><tr><TH>Name</TH><TH>Role</TH><TH>Last sign-in</TH>{canManage && <TH align="right"><span className="sr-only">Actions</span></TH>}</tr></THead>
            <tbody>
              {members.map((m) => (
                <TR key={m.id}>
                  <TD><div className="font-medium">{m.user.name}{m.userId === ctx.userId && <span className="ml-1.5 text-xs text-fg-subtle">(you)</span>}</div><div className="text-xs text-fg-subtle">{m.user.email}</div></TD>
                  <TD>{canManage && m.userId !== ctx.userId ? <MemberRow membershipId={m.id} role={m.role} clientId={m.clientId} clients={clients} /> : <span>{ROLE_LABELS[m.role]}{m.client && <span className="text-fg-subtle"> · {m.client.name}</span>}</span>}</TD>
                  <TD className="text-xs text-fg-muted">{fmtRelative(m.user.lastLoginAt)}</TD>
                  {canManage && <TD align="right">{m.userId !== ctx.userId && <MemberRow.Remove membershipId={m.id} name={m.user.name} />}</TD>}
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
        {invites.length > 0 && (
          <Card>
            <CardHeader title="Pending invitations" />
            <Table>
              <THead><tr><TH>Email</TH><TH>Role</TH><TH>Expires</TH></tr></THead>
              <tbody>{invites.map((i) => <TR key={i.id}><TD>{i.email}</TD><TD>{ROLE_LABELS[i.role]}</TD><TD className="text-xs text-fg-muted">{fmtDate(i.expiresAt)}</TD></TR>)}</tbody>
            </Table>
          </Card>
        )}
      </div>
    );
  }

  async function ClientsTab() {
    const clients = await ctx.db.client.findMany({ orderBy: [{ archivedAt: "asc" }, { name: "asc" }], include: { _count: { select: { websites: true, memberships: true } } } });
    const canWrite = ctx.can("websites:write");
    return (
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader title="Clients" description="Group websites by client for filtering, reporting and client-portal access." />
          {clients.length === 0 ? <p className="px-4 py-8 text-center text-[13px] text-fg-muted">No clients yet.</p> : (
            <Table>
              <THead><tr><TH>Client</TH><TH align="right">Websites</TH><TH align="right">Portal users</TH><TH>Status</TH>{canWrite && <TH />}</tr></THead>
              <tbody>
                {clients.map((c) => (
                  <TR key={c.id}>
                    <TD><div className="font-medium">{c.name}</div>{c.contactEmail && <div className="text-xs text-fg-subtle">{c.contactEmail}</div>}</TD>
                    <TD align="right">{c._count.websites}</TD>
                    <TD align="right">{c._count.memberships}</TD>
                    <TD>{c.archivedAt ? <Badge>archived</Badge> : <Badge tone="good">active</Badge>}</TD>
                    {canWrite && <TD align="right"><ClientArchive id={c.id} archived={Boolean(c.archivedAt)} /></TD>}
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {canWrite && <Card><CardHeader title="New client" /><CardBody><ClientForm /></CardBody></Card>}
      </div>
    );
  }

  async function AccountTab() {
    const sessions = await prisma.session.findMany({ where: { userId: ctx.userId, expiresAt: { gt: new Date() } }, orderBy: { lastUsedAt: "desc" } });
    return (
      <div className="grid max-w-5xl gap-5 lg:grid-cols-2">
        <Card><CardHeader title="Appearance" description="Follows your system setting unless you pin a theme on this device." /><CardBody><AppearanceControl /></CardBody></Card>
        <Card><CardHeader title="Change password" /><CardBody><PasswordForm /></CardBody></Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Active sessions" actions={sessions.length > 1 && <SignOutOthers />} />
          <Table>
            <THead><tr><TH>Device</TH><TH>IP</TH><TH>Last active</TH></tr></THead>
            <tbody>{sessions.map((s) => (
              <TR key={s.id}>
                <TD className="text-xs"><div className="flex items-center gap-2">{s.id === ctx.sessionId && <Badge tone="good">this device</Badge>}<span className="max-w-md truncate">{s.userAgent ?? "Unknown"}</span></div></TD>
                <TD className="text-xs text-fg-muted">{s.ip ?? "—"}</TD>
                <TD className="text-xs text-fg-muted">{fmtRelative(s.lastUsedAt)}</TD>
              </TR>
            ))}</tbody>
          </Table>
        </Card>
      </div>
    );
  }

  async function AuditLogTab({ page, sp }: { page: number; sp: Record<string, string | undefined> }) {
    const pageSize = 50;
    const [total, rows] = await Promise.all([
      ctx.db.auditLog.count(),
      ctx.db.auditLog.findMany({ orderBy: { createdAt: "desc" }, skip: (Math.max(1, page) - 1) * pageSize, take: pageSize }),
    ]);
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId).filter(Boolean) as string[])] } }, select: { id: true, name: true } });
    const name = new Map(users.map((u) => [u.id, u.name]));
    return (
      <Card>
        <CardHeader title="Audit log" description="Security-relevant actions in this workspace. Retained for 365 days." />
        <Table>
          <THead><tr><TH>When</TH><TH>User</TH><TH>Action</TH><TH>Entity</TH><TH>IP</TH></tr></THead>
          <tbody>{rows.map((r) => (
            <TR key={r.id}>
              <TD className="whitespace-nowrap text-xs text-fg-muted">{fmtDate(r.createdAt, true)}</TD>
              <TD>{r.userId ? name.get(r.userId) ?? "deleted user" : "system"}</TD>
              <TD><code className="font-mono text-xs">{r.action}</code></TD>
              <TD className="text-xs text-fg-muted">{r.entityType ? `${r.entityType} ${r.entityId?.slice(-6) ?? ""}` : "—"}</TD>
              <TD className="text-xs text-fg-muted">{r.ip ?? "—"}</TD>
            </TR>
          ))}</tbody>
        </Table>
        <Pagination page={Math.max(1, page)} pages={Math.max(1, Math.ceil(total / pageSize))} total={total} pageSize={pageSize} href={makeHref("/settings", { ...sp, tab: "audit-log" })} />
      </Card>
    );
  }
}
