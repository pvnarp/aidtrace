"use client";
import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

function Submit({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending}>{pending ? "Working..." : children}</button>;
}
export function ActionForm({ action, children, button, decisionId, decisionHash, claimId = "C-104" }: { action: string; children?: ReactNode; button: string; decisionId?: string; decisionHash?: string; claimId?: string }) {
  return <form action={`/api/claims/${claimId}/actions`} method="post" className="action-form">
    <input type="hidden" name="action" value={action} />
    {decisionId && <input type="hidden" name="decisionId" value={decisionId} />}
    {decisionHash && <input type="hidden" name="decisionHash" value={decisionHash} />}
    {children}<Submit>{button}</Submit>
  </form>;
}
