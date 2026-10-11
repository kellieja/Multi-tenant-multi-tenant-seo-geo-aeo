"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import type { Role } from "@prisma/client";
import { ActionForm, ActionButton, fieldError } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Notice } from "@/components/ui/page";
import { cn } from "@/lib/cn";
import {
  archiveClientAction, changePasswordAction, changeRoleAction, inviteAction, removeMemberAction, saveClientAction, signOutOthersAction, updateOrgAction,
} from "./actions";

export function OrgForm({ org }: { org: { name: string; brandName: string | null; brandColor: string; logoUrl: string | null; notifyEmail: string } }) {
  return (
    <ActionForm action={updateOrgAction} className="grid gap-4 sm:grid-cols-2">
      {({ pending, state }) => (
        <>
          <Field label="Workspace name" htmlFor="name" error={fieldError(state, "name")}><Input id="name" name="name" defaultValue={org.name} required /></Field>
          <Field label="Report brand name" htmlFor="brandName" hint="Shown on white-label reports"><Input id="brandName" name="brandName" defaultValue={org.brandName ?? ""} /></Field>
          <Field label="Brand colour" htmlFor="brandColor" error={fieldError(state, "brandColor")}>
            <div className="flex gap-2"><input type="color" aria-label="Pick colour" defaultValue={org.brandColor} onChange={(e) => { const t = document.getElementById("brandColor") as HTMLInputElement; t.value = e.target.value; }} className="h-8.5 w-10 cursor-pointer rounded border border-border bg-surface" /><Input id="brandColor" name="brandColor" defaultValue={org.brandColor} className="font-mono" /></div>
          </Field>
          <Field label="Logo URL (https)" htmlFor="logoUrl" error={fieldError(state, "logoUrl")}><Input id="logoUrl" name="logoUrl" defaultValue={org.logoUrl ?? ""} placeholder="https://…/logo.png" /></Field>
          <Field label="Alert email" htmlFor="notifyEmail" hint="Receives threshold alerts and failed-job notices (requires SMTP)." error={fieldError(state, "notifyEmail")} className="sm:col-span-2"><Input id="notifyEmail" name="notifyEmail" type="email" defaultValue={org.notifyEmail} /></Field>
          <div className="sm:col-span-2 flex justify-end"><Button type="submit" variant="primary" loading={pending}>Save</Button></div>
        </>
      )}
    </ActionForm>
  );
}

export function InviteForm({ clients }: { clients: { id: string; name: string }[] }) {
  const [role, setRole] = useState("ANALYST");
  const [link, setLink] = useState<string | null>(null);
  return (
    <ActionForm action={inviteAction} onSuccess={(d) => setLink(d.acceptUrl)} resetOnSuccess className="space-y-4">
      {({ pending, state }) => (
        <>
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
            <Field label="Email" htmlFor="inv-email" error={fieldError(state, "email")}><Input id="inv-email" name="email" type="email" required /></Field>
            <Field label="Role" htmlFor="inv-role">
              <Select id="inv-role" name="role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="ADMIN">Admin</option><option value="MANAGER">Manager</option><option value="ANALYST">Analyst</option><option value="CLIENT">Client (portal)</option>
              </Select>
            </Field>
            <Field label="Client" htmlFor="inv-client">
              <Select id="inv-client" name="clientId" disabled={role !== "CLIENT"}><option value="">—</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
            </Field>
            <Button type="submit" variant="primary" loading={pending}>Create invite</Button>
          </div>
          {link && (
            <Notice tone="good" title="Invite link (valid 7 days, single use)">
              <div className="mt-1 flex gap-2"><Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" /><Button size="sm" onClick={() => navigator.clipboard.writeText(link)}>Copy</Button></div>
            </Notice>
          )}
        </>
      )}
    </ActionForm>
  );
}

export function MemberRow({ membershipId, role, clientId, clients }: { membershipId: string; role: Role; clientId: string | null; clients: { id: string; name: string }[] }) {
  const [r, setR] = useState<string>(role);
  return (
    <ActionForm action={changeRoleAction} className="flex flex-wrap items-center gap-2">
      {({ pending }) => (
        <>
          <input type="hidden" name="membershipId" value={membershipId} />
          <Select name="role" value={r} onChange={(e) => setR(e.target.value)} aria-label="Role" className="w-auto">
            <option value="OWNER">Owner</option><option value="ADMIN">Admin</option><option value="MANAGER">Manager</option><option value="ANALYST">Analyst</option><option value="CLIENT">Client</option>
          </Select>
          {r === "CLIENT" && <Select name="clientId" defaultValue={clientId ?? ""} aria-label="Client" className="w-auto">{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
          {(r !== role || r === "CLIENT") && <Button type="submit" size="sm" loading={pending}>Save</Button>}
        </>
      )}
    </ActionForm>
  );
}
MemberRow.Remove = function Remove({ membershipId, name }: { membershipId: string; name: string }) {
  return <ActionButton action={removeMemberAction} fields={{ membershipId }} size="sm" variant="ghost" confirm={`Remove ${name} from this workspace?`}>Remove</ActionButton>;
};

export function ClientForm() {
  return (
    <ActionForm action={saveClientAction} resetOnSuccess className="space-y-3">
      {({ pending, state }) => (
        <>
          <Field label="Name" htmlFor="c-name" error={fieldError(state, "name")}><Input id="c-name" name="name" required /></Field>
          <Field label="Contact email" htmlFor="c-email" error={fieldError(state, "contactEmail")}><Input id="c-email" name="contactEmail" type="email" /></Field>
          <Field label="Notes" htmlFor="c-notes"><Textarea id="c-notes" name="notes" rows={3} /></Field>
          <Button type="submit" variant="primary" loading={pending}>Create client</Button>
        </>
      )}
    </ActionForm>
  );
}

export function ClientArchive({ id, archived }: { id: string; archived: boolean }) {
  return <ActionButton action={archiveClientAction} fields={{ id, archived: archived ? "0" : "1" }} size="sm" variant="ghost">{archived ? "Restore" : "Archive"}</ActionButton>;
}

export function PasswordForm() {
  return (
    <ActionForm action={changePasswordAction} resetOnSuccess className="space-y-3">
      {({ pending, state }) => (
        <>
          <Field label="Current password" htmlFor="pw-current"><Input id="pw-current" name="current" type="password" autoComplete="current-password" required /></Field>
          <Field label="New password" htmlFor="pw-next" error={fieldError(state, "_")} hint="At least 10 characters with a number or symbol."><Input id="pw-next" name="next" type="password" autoComplete="new-password" required minLength={10} /></Field>
          <Button type="submit" loading={pending}>Update password</Button>
        </>
      )}
    </ActionForm>
  );
}

export function SignOutOthers() {
  return <ActionButton action={signOutOthersAction} size="sm">Sign out other sessions</ActionButton>;
}

type Scheme = "light dark" | "light" | "dark";

/** Three-state colour scheme control (System / Light / Dark) stored per device. */
export function AppearanceControl() {
  const [scheme, setScheme] = useState<Scheme>("light dark");
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    try { setScheme((localStorage.getItem("color-scheme") as Scheme) ?? "light dark"); } catch {}
    const mq = matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    const onStorage = (e: StorageEvent) => { if (e.key === "color-scheme") apply((e.newValue as Scheme) ?? "light dark", false); };
    window.addEventListener("storage", onStorage);
    return () => { mq.removeEventListener("change", onChange); window.removeEventListener("storage", onStorage); };
  }, []);
  function apply(next: Scheme, persist = true) {
    setScheme(next);
    const meta = document.querySelector('meta[name="color-scheme"]') as HTMLMetaElement | null;
    if (meta) meta.content = next;
    if (persist) try { if (next === "light dark") localStorage.removeItem("color-scheme"); else localStorage.setItem("color-scheme", next); } catch {}
  }
  const opts: { v: Scheme; label: string; icon: React.ReactNode }[] = [
    { v: "light dark", label: `System (currently ${systemDark ? "dark" : "light"})`, icon: <Monitor className="size-4" /> },
    { v: "light", label: "Light", icon: <Sun className="size-4" /> },
    { v: "dark", label: "Dark", icon: <Moon className="size-4" /> },
  ];
  return (
    <div role="radiogroup" aria-label="Colour scheme" className="grid gap-2 sm:grid-cols-3">
      {opts.map((o) => (
        <button key={o.v} role="radio" aria-checked={scheme === o.v} onClick={() => apply(o.v)}
          className={cn("flex flex-col items-start gap-2 rounded-lg border px-3 py-2.5 text-left text-[13px] transition-colors", scheme === o.v ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-hover")}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}
