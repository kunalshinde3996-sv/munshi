import { useState } from "react";
import type { Action } from "../api";
import { EmailDrawer } from "../drawers";
import Activity from "./Activity";
import Eval from "./Eval";
import Rules from "./Rules";
import Security from "./Security";

export type TrustTab = "security" | "activity" | "policies" | "eval";
const TABS: { id: TrustTab; label: string }[] = [
  { id: "security", label: "Security" },
  { id: "activity", label: "Activity" },
  { id: "policies", label: "Policies" },
  { id: "eval", label: "Eval" },
];

/** "Behind the scenes": the full technical record, with rule ids, the audit log and evaluation numbers. */
export default function Trust({ actions, mode, refresh, onEditRules }: {
  actions: Action[];
  mode: "sandbox" | "google" | undefined;
  refresh: () => void;
  onEditRules: () => void;
}) {
  const [tab, setTab] = useState<TrustTab>("security");
  const [email, setEmail] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl font-semibold">Behind the scenes</h1>
      <nav className="flex flex-wrap gap-1" aria-label="Trust sections">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} aria-current={tab === t.id ? "page" : undefined} className={`rounded-full px-4 py-1.5 text-sm font-semibold ${tab === t.id ? "bg-ink text-white" : "text-soft hover:bg-white"}`}>
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "security" && <Security actions={actions} onOpenEmail={setEmail} />}
      {tab === "activity" && <Activity actions={actions} refresh={refresh} onOpenEmail={setEmail} />}
      {tab === "policies" && <Rules onEdit={onEditRules} />}
      {tab === "eval" && <Eval />}
      {email && <EmailDrawer id={email} mode={mode} onClose={() => setEmail(null)} />}
    </div>
  );
}
