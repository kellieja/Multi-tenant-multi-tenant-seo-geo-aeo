import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { sha256 } from "@/lib/crypto";
import { Logo } from "@/components/shell/logo";
import { Notice } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import { AcceptInvite } from "./accept";

export const metadata = { title: "Accept invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await prisma.invitation.findUnique({ where: { tokenHash: sha256(token) }, include: { organization: true } });
  const session = await getSession();
  const valid = invite && !invite.acceptedAt && invite.expiresAt > new Date();
  if (valid && !session) redirect(`/register?next=${encodeURIComponent(`/invite/${token}`)}`);
  return (
    <main className="flex min-h-dvh items-center justify-center px-5">
      <div className="w-full max-w-md space-y-6">
        <Logo />
        {!valid ? (
          <Notice tone="bad" title="Invitation unavailable">This invitation is invalid, already used, or expired. Ask the workspace admin for a new link.</Notice>
        ) : session!.user.email !== invite.email ? (
          <>
            <Notice tone="warn" title="Signed in as a different user">
              This invitation is for <b>{invite.email}</b>, but you are signed in as <b>{session!.user.email}</b>.
            </Notice>
            <ButtonLink href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>Switch account</ButtonLink>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold tracking-tight">Join {invite.organization.name}</h1>
            <p className="text-[13px] text-fg-muted">You were invited as <b>{invite.role.toLowerCase()}</b>.</p>
            <AcceptInvite token={token} />
          </>
        )}
      </div>
    </main>
  );
}
