"""OpenTelemetry SDK with an exporter that drops spans."""

from __future__ import annotations

from collections.abc import Sequence

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult


class _NoopExporter(SpanExporter):
    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        del spans
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        return None


_started = False


def start_noop_tracing(service_name: str) -> None:
    global _started
    if _started:
        return
    _started = True
    provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
    provider.add_span_processor(SimpleSpanProcessor(_NoopExporter()))
    trace.set_tracer_provider(provider)
    trace.get_tracer(service_name)
