"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/browser";

/**
 * Shown when rendering fails outright. Without it a crash leaves a blank
 * page with nothing to tell the user, or us, what happened.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
        <div className="max-w-md space-y-4 p-8 text-center">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="text-sm text-slate-400">
            The page hit an unexpected error and has been reported. Reloading usually fixes it.
          </p>
          <div className="flex justify-center gap-2">
            <button
              onClick={() => reset()}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
            >
              Try again
            </button>
            <a href="/dashboard" className="rounded-lg bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700">
              Go to dashboard
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
