import { useState } from "react";
import { api2, type PolicyRow } from "../api";
import { Chip, usePoll } from "../components";

export const DECISION_TONE = { allow: "green", require_approval: "amber", block: "darkred" } as const;

export function RuleSummary({ p }: { p: PolicyRow }) {
  return (
    <div className="min-w-0 flex-1 basis-60 space-y-1">
      <p className="break-words font-medium">{p.rule?.description ?? p.rule?.reason ?? p.id}</p>
      <div className="flex flex-wrap items-center gap-2">
        {p.rule && <Chip tone={DECISION_TONE[p.rule.decision as keyof typeof DECISION_TONE] ?? "stone"}>{p.rule.decision.replace("_", " ")}</Chip>}
        {p.seed && <Chip tone="stone">default</Chip>}
        {!p.valid && <Chip tone="red">invalid: ignored</Chip>}
        {!p.enabled && <Chip tone="stone">disabled</Chip>}
      </div>
      <details className="text-xs text-soft">
        <summary className="w-fit">Details</summary>
        <p className="reveal mt-1">Rule id: <code>{p.id}</code></p>
        <pre className="reveal mt-1 overflow-x-auto rounded-xl bg-mist p-2">{JSON.stringify(p.rule?.match, null, 1)}</pre>
      </details>
    </div>
  );
}

/** Read-only view of the rules in force. Editing lives in Settings. */
export default function Rules({ onEdit }: { onEdit: () => void }) {
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  usePoll(async () => setPolicies(await api2.policies()), 5000);
  return (
    <div className="space-y-4">
      <p className="text-sm text-soft">Every action is checked against these. The strictest matching rule wins.</p>
      <div className="rounded-2xl bg-wash p-4 text-sm">
        <p className="font-semibold">Built in, cannot be switched off</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>Sending email always needs your approval.</li>
          <li>A tainted action is never auto-allowed.</li>
          <li>Tainted email to someone outside your contacts is blocked.</li>
          <li>Destructive and financial tools are never available to the agent.</li>
        </ul>
      </div>
      <ul className="panel divide-y divide-line">
        {policies.map((p) => <li key={p.id} className="flex p-4"><RuleSummary p={p} /></li>)}
      </ul>
      <button onClick={onEdit} className="btn-quiet">Edit rules in Settings</button>
    </div>
  );
}
