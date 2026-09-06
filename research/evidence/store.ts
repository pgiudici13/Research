// Accumulatore di evidenze IMMUTABILE usato dal motore di ricerca.
// Nessuno stato globale: ogni operazione restituisce una nuova EvidenceStore
// e non modifica mai l'istanza precedente (i test lo verificano).
// Il budget totale (default: limits.maxEvidencesTotal) fa scartare le evidenze
// in eccesso contandole: il report dichiarerà i limiti (step successivi).

import { getLimits } from "@/lib/config/limits";
import type { Evidence } from "@/lib/types";

export interface EvidenceStoreOptions {
  /** Massimo totale di evidenze conservate. Default: limits.maxEvidencesTotal. */
  maxTotal?: number;
}

export class EvidenceStore {
  private constructor(
    private readonly items: readonly Evidence[],
    readonly maxTotal: number,
    readonly droppedCount: number,
  ) {}

  static empty(options: EvidenceStoreOptions = {}): EvidenceStore {
    const maxTotal = options.maxTotal ?? getLimits().maxEvidencesTotal;
    return new EvidenceStore([], maxTotal, 0);
  }

  /** Restituisce una nuova store con l'evidenza aggiunta (se c'è budget). */
  addEvidence(evidence: Evidence): EvidenceStore {
    if (this.items.length >= this.maxTotal) {
      return new EvidenceStore(this.items, this.maxTotal, this.droppedCount + 1);
    }
    return new EvidenceStore([...this.items, evidence], this.maxTotal, this.droppedCount);
  }

  /** Copia in ordine di inserimento. */
  all(): Evidence[] {
    return [...this.items];
  }

  count(): number {
    return this.items.length;
  }

  /** Evidenze di una singola fonte. */
  bySource(sourceId: string): Evidence[] {
    return this.items.filter((e) => e.sourceId === sourceId);
  }

  /** Evidenze associate a una sotto-domanda (matching dello Step 14). */
  bySubQuestion(subQuestionId: string): Evidence[] {
    return this.items.filter((e) => e.subQuestionId === subQuestionId);
  }

  /**
   * Tiene le migliori `max` evidenze per rilevanza (a parità, per indice di
   * passaggio); le altre vengono scartate e contate. L'ordine restituito resta
   * quello di inserimento. Funzione pura: non muta questa store.
   */
  removeBeyondBudget(max: number): EvidenceStore {
    if (this.items.length <= max) return this;
    const ranked = this.items
      .map((e, position) => ({ e, position }))
      .sort((a, b) => {
        const ra = a.e.relevance ?? 0;
        const rb = b.e.relevance ?? 0;
        if (rb !== ra) return rb - ra;
        if (a.e.passageIndex !== b.e.passageIndex) return a.e.passageIndex - b.e.passageIndex;
        return a.position - b.position;
      });
    const keptPositions = new Set(ranked.slice(0, max).map((r) => r.position));
    const kept = this.items.filter((_e, position) => keptPositions.has(position));
    return new EvidenceStore(kept, this.maxTotal, this.droppedCount + (this.items.length - max));
  }
}
