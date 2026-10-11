import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { Logo } from "@/components/shell/logo";
import { OnboardingForm } from "./form";

export const metadata = { title: "Set up workspace" };

export default async function Onboarding() {
  const session = await getSession();
  if (!session) redirect("/login");
  const memberships = await prisma.membership.count({ where: { userId: session.userId } });
  return (
    <main className="flex min-h-dvh items-center justify-center px-5">
      <div className="w-full max-w-md">
        <Logo />
        <h1 className="mt-8 text-xl font-semibold tracking-tight">Create a workspace</h1>
        <p className="mt-1 text-[13px] text-fg-muted">
          A workspace holds your websites, clients, team and integrations. Data is fully isolated between workspaces.
        </p>
        <OnboardingForm />
        {memberships > 0 && (
          <a href="/dashboard" className="mt-4 inline-block text-[13px] text-accent hover:underline">Back to your workspace</a>
        )}
      </div>
    </main>
  );
}
