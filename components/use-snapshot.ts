"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectSnapshot } from "@/lib/api/snapshot";
import { api } from "./api";

/** Polls the project snapshot; faster while work is in flight, slower when idle. */
export function useSnapshot(projectId: string) {
  const [snap, setSnap] = useState<ProjectSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api<ProjectSnapshot>(`/api/projects/${projectId}`);
      setSnap(data);
      setError(null);
      setOffline(false);
      busyRef.current = data.workflows.some((w) => w.status === "planning" || w.status === "executing") || data.worker.queued > 0;
    } catch (e) {
      if (e instanceof Error && /not found/i.test(e.message)) setError(e.message);
      else setOffline(true);
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    const loop = async () => {
      await refresh();
      if (cancelled) return;
      timer.current = setTimeout(loop, busyRef.current ? 1000 : 3000);
    };
    loop();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh]);

  return { snap, error, offline, refresh };
}
