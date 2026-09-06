"use client";

import { COPY } from "@/lib/ui-copy";
import { ResearchRun } from "@/components/research-run";

export default function Home() {
  return (
    <main className="page">
      <header className="page-header">
        <h1>{COPY.appTitle}</h1>
        <p>{COPY.appSubtitle}</p>
      </header>
      <ResearchRun />
    </main>
  );
}
