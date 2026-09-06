// Form di ricerca (Step 22): domanda con contatore caratteri, opzioni
// profondità/freschezza, validazione client-side accessibile, pulsanti
// avvio/annulla. Componente presentazionale: nessuna logica di rete.

"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { COPY } from "@/lib/ui-copy";
import type { ResearchStartInput } from "@/hooks/use-research";

export interface ResearchFormProps {
  disabled?: boolean;
  onSubmit: (input: ResearchStartInput) => void;
  onCancel?: () => void;
}

const MAX_QUESTION_CHARS = 1_000;
const MIN_QUESTION_CHARS = 10;

export function ResearchForm({ disabled = false, onSubmit, onCancel }: ResearchFormProps) {
  const uid = useId();
  const questionId = `${uid}-question`;
  const depthId = `${uid}-depth`;
  const freshnessId = `${uid}-freshness`;
  const errorId = `${uid}-error`;

  const [question, setQuestion] = useState("");
  const [depth, setDepth] = useState<"1" | "2" | "3">("1");
  const [freshness, setFreshness] = useState<"any" | "recent" | "year">("any");
  const [error, setError] = useState<string | null>(null);

  const trimmed = question.trim();
  const charsLeft = MAX_QUESTION_CHARS - trimmed.length;
  const running = disabled === true;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const value = question.replace(/\s+/g, " ").trim();
    if (value.length < MIN_QUESTION_CHARS) {
      setError(COPY.form.questionTooShort);
      return;
    }
    if (value.length > MAX_QUESTION_CHARS) {
      setError(COPY.form.questionTooLong);
      return;
    }
    setError(null);
    onSubmit({
      question: value,
      options:
        depth === "1" && freshness === "any"
          ? undefined
          : {
              ...(depth !== "1" ? { depth: Number(depth) as 1 | 2 | 3 } : {}),
              ...(freshness !== "any" ? { freshness } : {}),
            },
    });
  };

  const depthOptions = useMemo(
    () =>
      [1, 2, 3].map((n) => (
        <option key={n} value={String(n)}>
          {COPY.form.depthOption(n, COPY.form.depthLabels[n - 1]!)}
        </option>
      )),
    [],
  );

  return (
    <form onSubmit={submit} className="research-form" noValidate>
      <div className="field">
        <label htmlFor={questionId}>{COPY.form.questionLabel}</label>
        <textarea
          id={questionId}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={3}
          maxLength={MAX_QUESTION_CHARS}
          placeholder={COPY.form.questionPlaceholder}
          aria-describedby={error !== null ? errorId : undefined}
          disabled={running}
        />
        <div className="field-meta">
          <span className="chars-left" aria-live="polite">
            {COPY.form.charsLeft(Math.max(0, charsLeft))}
          </span>
          {error !== null ? (
            <span id={errorId} className="field-error" role="alert">
              {error}
            </span>
          ) : null}
        </div>
      </div>

      <div className="form-row">
        <div className="field">
          <label htmlFor={depthId}>{COPY.form.depthLabel}</label>
          <select
            id={depthId}
            value={depth}
            onChange={(event) => setDepth(event.target.value as "1" | "2" | "3")}
            disabled={running}
          >
            {depthOptions}
          </select>
        </div>
        <div className="field">
          <label htmlFor={freshnessId}>{COPY.form.freshnessLabel}</label>
          <select
            id={freshnessId}
            value={freshness}
            onChange={(event) =>
              setFreshness(event.target.value as "any" | "recent" | "year")
            }
            disabled={running}
          >
            <option value="any">{COPY.form.freshnessAny}</option>
            <option value="recent">{COPY.form.freshnessRecent}</option>
            <option value="year">{COPY.form.freshnessYear}</option>
          </select>
        </div>
      </div>

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={running}>
          {running ? COPY.status.running : COPY.form.start}
        </button>
        {running && onCancel !== undefined ? (
          <button
            type="button"
            className="btn"
            onClick={onCancel}
            aria-label="Annulla la ricerca in corso"
          >
            {COPY.form.cancel}
          </button>
        ) : null}
      </div>
    </form>
  );
}
