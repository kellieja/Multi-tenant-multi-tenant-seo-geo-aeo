import Link from "next/link";
import { RegisterForm } from "./form";

export const metadata = { title: "Create account" };

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1 text-[13px] text-fg-muted">You&apos;ll set up a workspace for your sites next.</p>
      <RegisterForm next={next} />
      <p className="mt-6 text-[13px] text-fg-muted">
        Already have an account? <Link href="/login" className="font-medium text-accent hover:underline">Sign in</Link>
      </p>
    </>
  );
}
