import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Console = lazy(() => import("@/app/Console"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ASTRO-CARE — Astronaut health console" },
      { name: "description", content: "Offline health monitoring for Artemis crews: live NEWS2, care log and GO / NO-GO readiness test." },
      { property: "og:title", content: "ASTRO-CARE — Astronaut health console" },
      { property: "og:description", content: "Live vitals, NEWS2 and a GO / NO-GO readiness test for lunar-surface tasks." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const fallback = <div className="min-h-screen bg-background" />;
  return (
    <ClientOnly fallback={fallback}>
      <Suspense fallback={fallback}>
        <Console />
      </Suspense>
    </ClientOnly>
  );
}
