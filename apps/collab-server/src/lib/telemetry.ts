/**
 * OpenTelemetry bootstrap.
 *
 * Import this FIRST, before any instrumented library (http, express, pg,
 * ioredis). Auto-instrumentation works by patching those modules as they load,
 * so anything required earlier is never traced.
 *
 * A no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set, so development and tests
 * pay nothing.
 */

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  // Required lazily so the SDK is not loaded at all when tracing is disabled.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { NodeSDK } = require("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || "collab-server",
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Health probes fire constantly and would swamp the trace backend.
        "@opentelemetry/instrumentation-http": {
          ignoreIncomingRequestHook: (req: { url?: string }) =>
            Boolean(req.url && req.url.startsWith("/health")),
        },
        // Noisy and rarely useful here.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  try {
    sdk.start();
    // eslint-disable-next-line no-console
    console.log(`[telemetry] OpenTelemetry started, exporting to ${endpoint}`);

    const stop = () => {
      sdk.shutdown().catch(() => undefined);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } catch (err) {
    // Tracing must never prevent the service from starting.
    // eslint-disable-next-line no-console
    console.error("[telemetry] Failed to start OpenTelemetry, continuing without it", err);
  }
}

export {};
