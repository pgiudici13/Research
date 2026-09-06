import { describe, expect, it } from "vitest";
import {
  PROMPT_VERSION,
  buildPlannerMessages,
} from "@/research/planning/prompt";

const QUESTION = "Qual è lo stato della ricerca sulla fusione nucleare nel 2026?";

describe("buildPlannerMessages", () => {
  it("restituisce system + user con la domanda nel messaggio utente", () => {
    const messages = buildPlannerMessages(QUESTION);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain(QUESTION);
  });

  it("il system prompt definisce il ruolo e lo schema, senza la domanda", () => {
    const system = buildPlannerMessages(QUESTION)[0].content;
    expect(system).toContain("research planner");
    expect(system).toContain("objective");
    expect(system).toContain("subQuestions");
    expect(system).toContain("queries");
    expect(system).toContain("sub-question");
    expect(system).not.toContain(QUESTION); // la domanda è un dato, mai istruzioni
  });

  it("include le opzioni solo se presenti", () => {
    const withoutOptions = buildPlannerMessages(QUESTION)[1].content;
    expect(withoutOptions).not.toContain("freschezza richiesta");

    const withOptions = buildPlannerMessages(QUESTION, {
      freshness: "recent",
      lang: "it",
    })[1].content;
    expect(withOptions).toContain('freschezza richiesta dei dati: "recent"');
    expect(withOptions).toContain('lingua preferita dei risultati: "it"');
  });

  it("PROMPT_VERSION è stabile e versionato", () => {
    expect(PROMPT_VERSION).toMatch(/^planner-v\d+$/);
  });
});
