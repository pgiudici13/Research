// Prompt del research planner (server-only) — shim di compatibilità.
// Dal Step 25 il costruttore dei messaggi è CENTRALIZZATO in
// `lib/server/llm/prompts.ts` (`buildMessages("planner", …)` con recinzione
// dati `<research_evidence version="1">`). Questo file mantiene i nomi storici
// (PLANNER_SYSTEM_PROMPT, PROMPT_VERSION, buildPlannerMessages) per non toccare
// i consumatori; nessun prompt viene costruito qui.
//
// Policy (Step 25): il prompt è codice, NON dati. La domanda dell'utente è un
// INPUT non attendibile: entra solo nella recinzione dati del messaggio user,
// mai nel system prompt.

export {
  PLANNER_PROMPT_VERSION as PROMPT_VERSION,
  PLANNER_SYSTEM_PROMPT,
  buildPlannerMessages,
} from "@/lib/server/llm/prompts";
