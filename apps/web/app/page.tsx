"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./lib/auth-context";

export default function HomePage() {
  const router = useRouter();
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      if (user) {
        router.push("/dashboard");
      } else {
        router.push("/login");
      }
    }
  }, [user, isLoading, router]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      <div className="max-w-2xl text-center">
        <p className="mb-4 text-sm font-medium uppercase tracking-widest text-emerald-400">
          DevColab
        </p>
        <h1 className="mb-4 text-4xl font-bold tracking-tight sm:text-5xl">
          AI-Powered Real-Time Code Review
        </h1>
        <p className="text-lg text-slate-400">Loading...</p>
      </div>
    </main>
  );
}
