// @vitest-environment jsdom
// Test del form di ricerca (Step 22): validazione inline accessibile, payload
// del submit, stati disabilitati e pulsante di annullamento.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResearchForm } from "@/components/research-form";
import { COPY } from "@/lib/ui-copy";

const QUESTION = "In quale anno fu fondata l'Università di Pisa e da chi?";

afterEach(() => {
  cleanup();
});

describe("ResearchForm", () => {
  it("domanda corta → errore inline (aria-live) e nessun submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ResearchForm onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: COPY.form.start }));
    const error = await screen.findByText(COPY.form.questionTooShort);
    expect(error).toBeDefined();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submit valido → payload corretto (senza opzioni se default)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ResearchForm onSubmit={onSubmit} />);

    const textarea = screen.getByLabelText(COPY.form.questionLabel);
    await user.type(textarea, QUESTION);
    await user.click(screen.getByRole("button", { name: COPY.form.start }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ question: QUESTION, options: undefined });
  });

  it("submit con freschezza recente → options coerenti", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ResearchForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(COPY.form.questionLabel), QUESTION);
    await user.selectOptions(
      screen.getByLabelText(COPY.form.freshnessLabel),
      "recent",
    );
    await user.click(screen.getByRole("button", { name: COPY.form.start }));

    expect(onSubmit).toHaveBeenCalledWith({
      question: QUESTION,
      options: { freshness: "recent" },
    });
  });

  it("in running: campi disabilitati e pulsante Annulla visibile", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ResearchForm onSubmit={vi.fn()} onCancel={onCancel} disabled />);

    // in running il pulsante di submit mostra il testo "Ricerca in corso…"
    expect(
      screen.getByRole("button", { name: COPY.status.running }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByLabelText(COPY.form.questionLabel)).toHaveProperty(
      "disabled",
      true,
    );

    const cancel = screen.getByRole("button", { name: /annulla la ricerca/i });
    await user.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("mostra il contatore caratteri rimasti", async () => {
    render(<ResearchForm onSubmit={vi.fn()} />);
    expect(
      screen.getByText(COPY.form.charsLeft(1000)),
    ).toBeDefined();
  });
});
