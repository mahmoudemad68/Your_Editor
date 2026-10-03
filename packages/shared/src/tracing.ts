import { trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

let started = false;

/**
 * Registers the OpenTelemetry SDK with no span exporter.
 * A later story can add an exporter without changing call sites.
 */
export function startNoopTracing(serviceName: string): void {
  if (started) {
    return;
  }
  started = true;
  const provider = new BasicTracerProvider();
  provider.register();
  trace.getTracer(serviceName);
}
