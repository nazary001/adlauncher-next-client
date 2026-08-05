import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = {
  title: "Sign in — Ad Launcher",
};

export default async function LoginPage() {
  const jar = await cookies();
  if (verifySession(jar.get(SESSION_COOKIE)?.value)) redirect("/");

  return (
    <main className="relative flex min-h-full flex-1 items-center justify-center px-4 py-10">
      {/* ambient backdrop */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
        <div className="absolute left-1/2 top-1/4 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-accent/[0.08] blur-[120px]" />
        <div className="absolute bottom-[10%] right-[15%] h-[300px] w-[400px] rounded-full bg-accent2/[0.06] blur-[110px]" />
        <div
          className={
            "absolute inset-0 " +
            "bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] " +
            "bg-[size:44px_44px] [mask-image:radial-gradient(ellipse_50%_50%_at_50%_50%,black,transparent)]"
          }
        />
      </div>

      <LoginForm />
    </main>
  );
}
