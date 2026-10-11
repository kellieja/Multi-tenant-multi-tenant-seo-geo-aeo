import Link from "next/link";
import { Bell, ChevronsUpDown, Check, LogOut, Plus, UserRound, Activity } from "lucide-react";
import { requireOrgContext } from "@/lib/auth/context";
import { prisma } from "@/lib/db/client";
import { Sidebar } from "@/components/shell/sidebar";
import { navFor } from "@/components/shell/nav";
import { PopoverMenu, MenuItem, MenuLabel, MenuSeparator } from "@/components/shell/menu";
import { ROLE_LABELS } from "@/lib/auth/rbac";
import { fmtRelative } from "@/lib/format";
import { logoutAction } from "../(auth)/actions";
import { switchOrgAction, markNotificationsReadAction } from "./shell-actions";
import { isDemoMode } from "@/lib/env";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgContext();
  const [orgs, notifications, unread, activeJobs, pendingApprovals] = await Promise.all([
    prisma.membership.findMany({ where: { userId: ctx.userId }, include: { organization: { select: { id: true, name: true } } } }),
    ctx.db.notification.findMany({ where: { OR: [{ userId: ctx.userId }, { userId: null }] }, orderBy: { createdAt: "desc" }, take: 8 }),
    ctx.db.notification.count({ where: { OR: [{ userId: ctx.userId }, { userId: null }], readAt: null } }),
    ctx.role === "CLIENT" ? 0 : ctx.db.job.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } }),
    ctx.can("approvals:decide") ? ctx.db.approval.count({ where: { status: "PENDING" } }) : 0,
  ]);

  const orgSwitcher = (
    <PopoverMenu
      label="Switch workspace"
      align="start"
      triggerClassName="flex w-full items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-left hover:border-border-strong"
      trigger={
        <>
          <span className="flex size-6 shrink-0 items-center justify-center rounded bg-fg text-2xs font-semibold text-bg">{ctx.org.name.slice(0, 2).toUpperCase()}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{ctx.org.name}</span>
            <span className="block text-2xs text-fg-subtle">{ROLE_LABELS[ctx.role]}</span>
          </span>
          <ChevronsUpDown className="size-3.5 text-fg-subtle" />
        </>
      }
    >
      <MenuLabel>Workspaces</MenuLabel>
      {orgs.map((m) => (
        <form key={m.organizationId} action={switchOrgAction}>
          <input type="hidden" name="organizationId" value={m.organizationId} />
          <MenuItem>
            <span className="flex-1 truncate">{m.organization.name}</span>
            {m.organizationId === ctx.org.id && <Check className="size-3.5 text-accent" />}
          </MenuItem>
        </form>
      ))}
      <MenuSeparator />
      <MenuItem href="/onboarding"><Plus className="size-3.5" /> New workspace</MenuItem>
    </PopoverMenu>
  );

  return (
    <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <Sidebar groups={navFor(ctx.role)} orgSwitcher={orgSwitcher} badges={{ "/automation": pendingApprovals }} />
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-end gap-1 border-b border-border bg-bg/85 px-4 backdrop-blur-md lg:px-6">
          {isDemoMode() && <span className="mr-auto ml-10 rounded bg-warn-soft px-2 py-0.5 text-2xs font-medium text-warn lg:ml-0">DEMO ENVIRONMENT · sample data</span>}
          {ctx.role !== "CLIENT" && (
            <Link href="/automation?tab=jobs" className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg" title="Background jobs">
              <Activity className={activeJobs ? "size-4 text-info" : "size-4"} />
              <span className="tabular">{activeJobs ? `${activeJobs} running` : "Idle"}</span>
            </Link>
          )}
          <PopoverMenu
            label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
            className="w-80"
            triggerClassName="relative flex size-8 items-center justify-center rounded-md text-fg-muted hover:bg-surface-hover hover:text-fg"
            trigger={
              <>
                <Bell className="size-4" />
                {unread > 0 && <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-accent" />}
              </>
            }
          >
            <div className="flex items-center justify-between px-2.5 py-1.5">
              <span className="text-xs font-semibold">Notifications</span>
              {unread > 0 && (
                <form action={markNotificationsReadAction}><button className="text-2xs text-accent hover:underline">Mark all read</button></form>
              )}
            </div>
            {notifications.length === 0 ? (
              <p className="px-2.5 py-6 text-center text-xs text-fg-subtle">No notifications yet. Alerts from audits, rankings and automations appear here.</p>
            ) : (
              <ul className="max-h-96 overflow-y-auto">
                {notifications.map((n) => (
                  <li key={n.id}>
                    <a href={n.link ?? "#"} className="block rounded-md px-2.5 py-2 hover:bg-surface-hover">
                      <div className="flex items-center gap-1.5">
                        {!n.readAt && <span className="size-1.5 rounded-full bg-accent" />}
                        <span className="truncate text-xs font-medium">{n.title}</span>
                      </div>
                      {n.body && <p className="mt-0.5 line-clamp-2 text-2xs text-fg-muted">{n.body}</p>}
                      <p className="mt-0.5 text-2xs text-fg-subtle">{fmtRelative(n.createdAt)}</p>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </PopoverMenu>
          <PopoverMenu
            label="Account"
            triggerClassName="ml-1 flex size-8 items-center justify-center rounded-full bg-surface-hover text-xs font-semibold text-fg"
            trigger={ctx.userName.split(" ").map((s) => s[0]).join("").slice(0, 2).toUpperCase()}
          >
            <div className="px-2.5 py-2">
              <div className="text-xs font-medium">{ctx.userName}</div>
              <div className="text-2xs text-fg-subtle">{ctx.userEmail}</div>
            </div>
            <MenuSeparator />
            <MenuItem href="/settings?tab=account"><UserRound className="size-3.5" /> Account settings</MenuItem>
            <form action={logoutAction}>
              <MenuItem><LogOut className="size-3.5" /> Sign out</MenuItem>
            </form>
          </PopoverMenu>
        </header>
        <main className="mx-auto w-full max-w-[1440px] px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
