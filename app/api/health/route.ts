// GET /api/health — health check minimale (Step 21). Niente versioni di
// infrastruttura, IP, configurazione o presenza di chiavi (per l'health
// approfondita protetta vedi Step 32).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(
    {
      ok: true,
      service: "deep-research",
      time: new Date().toISOString(),
    },
    { status: 200 },
  );
}
