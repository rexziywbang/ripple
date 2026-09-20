import { Suspense } from "react";
import { Workspace } from "@/components/workspace";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted">Loading workspace…</p>}>
      <Workspace projectId={id} />
    </Suspense>
  );
}
