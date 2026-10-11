import Link from "next/link";
import { LoginForm } from "./form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-[13px] text-fg-muted">Welcome back. Enter your details to continue.</p>
      <LoginForm next={next} />
      <p className="mt-6 text-[13px] text-fg-muted">
        New here?{" "}
        <Link href={`/register${next ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-medium text-accent hover:underline">
          Create an account
        </Link>
      </p>
    </>
  );
}
