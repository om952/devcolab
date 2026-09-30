/**
 * Runs in the browser before the app itself, so errors from the very first
 * render are caught too. A no-op unless NEXT_PUBLIC_SENTRY_DSN was set at build
 * time (it is inlined into the bundle; see the web Dockerfile).
 */
import * as Sentry from "@sentry/browser";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    // Errors only. Performance tracing would spend the free quota on noise.
    tracesSampleRate: 0,
    // No IP address or other personal data attached to events.
    sendDefaultPii: false,
    beforeSend(event) {
      // The session cookie is httpOnly so the SDK cannot see it, but drop
      // request cookies and headers anyway in case that ever changes.
      if (event.request) {
        delete event.request.cookies;
        delete event.request.headers;
      }
      return event;
    },
  });
}
