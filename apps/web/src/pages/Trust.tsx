import { useState } from "react";
import type { Action } from "../api";
import { EmailDrawer } from "../drawers";
import { stagger, useEntrance } from "../motion";
import SlidingNav from "../SlidingNav";
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

/** "Behind the scenes": the full technical record, with rule ids and evaluation numbers. */
export default function Trust({ actions, mode, refresh, onEditRules }: {
  actions: Action[];
  mode: "sandbox" | "google" | undefined;
  refresh: () => void;
  onEditRules: () => void;
}) {
  const [tab, setTab] = useState<TrustTab>("security");
  const [email, setEmail] = useState<string | null>(null);
  const entrance = useEntrance("trust");
  return (
    <div className="space-y-4" data-entrance={entrance}>
      <div className="panel enter flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5" style={stagger(0)}>
        <h1 className="font-display text-2xl font-semibold sm:text-3xl">Behind the scenes</h1>
        <SlidingNav items={TABS} current={tab} onSelect={setTab} label="Trust sections" tone="ink" className="gap-1" />
      </div>
      <div className="enter" style={stagger(1)}>
        {tab === "security" && <Security onOpenEmail={setEmail} />}
        {tab === "activity" && <div className="panel p-4 sm:p-5"><Activity actions={actions} refresh={refresh} onOpenEmail={setEmail} /></div>}
        {tab === "policies" && <div className="panel p-4 sm:p-5"><Rules onEdit={onEditRules} /></div>}
        {tab === "eval" && <div className="panel p-4 sm:p-5"><Eval /></div>}
      </div>
      {email && <EmailDrawer id={email} mode={mode} onClose={() => setEmail(null)} />}
    </div>
  );
}
