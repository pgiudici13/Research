// ProgressSink: il motore emette ProgressEvent senza conoscere il trasporto
// (l'API farà la serializzazione NDJSON nello Step 20; qui solo il contratto).
// Nessuna dipendenza runtime: importabile ovunque.

import type { ProgressEvent } from "@/lib/types";

export interface ProgressSink {
  /** Emette un evento di progresso. Mai sincrono-bloccante per il motore. */
  emit(event: ProgressEvent): void;
}

export interface MemoryProgress {
  events: ProgressEvent[];
  sink: ProgressSink;
}

/** Sink di raccolta per test e debug (nessuno stato globale). */
export function createMemorySink(): MemoryProgress {
  const events: ProgressEvent[] = [];
  const sink: ProgressSink = {
    emit(event: ProgressEvent): void {
      events.push(event);
    },
  };
  return { events, sink };
}

/** Filtra gli eventi raccolti per tipo (comodo nei test). */
export function eventsOfType<T extends ProgressEvent["type"]>(
  events: readonly ProgressEvent[],
  type: T,
): Array<Extract<ProgressEvent, { type: T }>> {
  return events.filter((e): e is Extract<ProgressEvent, { type: T }> => e.type === type);
}
