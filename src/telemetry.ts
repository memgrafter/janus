/**
 * Telemetry port: a minimal, backend-agnostic event sink. The default
 * InMemoryTelemetry keeps a bounded ring of events (exposed via GET /v1/telemetry
 * so quota/deadline/rate-limit observations are observable). @earendil-works/pi-telemetry
 * can be plugged in as an adapter later without changing any call site.
 */

export interface TelemetryEvent {
  ts: number;
  name: string;
  attrs: Record<string, unknown>;
}

export interface Telemetry {
  emit(name: string, attrs?: Record<string, unknown>): void;
}

export class InMemoryTelemetry implements Telemetry {
  private ring: TelemetryEvent[] = [];

  constructor(private readonly cap = 1000) {}

  emit(name: string, attrs: Record<string, unknown> = {}): void {
    this.ring.push({ ts: Date.now(), name, attrs });
    if (this.ring.length > this.cap) this.ring.splice(0, this.ring.length - this.cap);
  }

  /** All recorded events, oldest first. */
  events(): TelemetryEvent[] {
    return [...this.ring];
  }

  /** Events whose name matches, oldest first. */
  where(name: string): TelemetryEvent[] {
    return this.ring.filter((e) => e.name === name);
  }

  clear(): void {
    this.ring.length = 0;
  }
}
