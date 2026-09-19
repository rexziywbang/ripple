"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import type { AreaId } from "@/lib/domain/areas";
import { AREA_BY_ID } from "@/lib/domain/areas";
import { ActivityPanel } from "./activity";
import { AreaPanel, AreaTiles } from "./area-panel";
import { Dashboard } from "./dashboard";
import { ProjectHeader } from "./header";
import { Spinner } from "./ui";
import { useSnapshot } from "./use-snapshot";
import { WorkflowPanel } from "./workflow-panel";

export function Workspace({ projectId }: { projectId: string }) {
  const { snap, error, offline, refresh } = useSnapshot(projectId);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const areaParam = params.get("area");
  const area: AreaId = areaParam && areaParam in AREA_BY_ID ? (areaParam as AreaId) : "brief";
  const wfParam = params.get("wf");

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  const selectedWorkflow = useMemo(() => {
    if (!snap) return null;
    if (wfParam) return snap.workflows.find((w) => w.id === wfParam) ?? null;
    return snap.workflows.find((w) => !["completed", "superseded", "failed"].includes(w.status)) ?? snap.workflows[0] ?? null;
  }, [snap, wfParam]);

  if (error) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger-soft p-4 text-danger">
          {error}
        </p>
      </main>
    );
  }
  if (!snap) {
    return (
      <main className="p-8">
        <Spinner label="Loading project" />
      </main>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <ProjectHeader snap={snap} offline={offline} refresh={refresh} />
      <main className="mx-auto grid w-full max-w-[1500px] flex-1 gap-4 px-4 py-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Dashboard snap={snap} onSelectWorkflow={(id) => setParams({ wf: id })} />
          <AreaTiles snap={snap} selected={area} onSelect={(a) => setParams({ area: a })} />
          <AreaPanel snap={snap} area={area} refresh={refresh} onWorkflowCreated={(id) => setParams({ wf: id })} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <WorkflowPanel snap={snap} workflow={selectedWorkflow} refresh={refresh} onSelectWorkflow={(id) => setParams({ wf: id })} />
          <ActivityPanel snap={snap} refresh={refresh} onSelectWorkflow={(id) => setParams({ wf: id })} />
        </div>
      </main>
    </div>
  );
}
