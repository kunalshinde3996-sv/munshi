import { useEffect, useState } from "react";
import { evalApi, type EvalResult } from "../api";
import { Banner, Chip } from "../components";

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "n/a");

function Stat({ label, value, sub, tone = "stone" }: { label: string; value: string; sub?: string; tone?: "green" | "red" | "amber" | "stone" }) {
  const color = { green: "text-emerald-700", red: "text-red-700", amber: "text-amber-700", stone: "text-ink" }[tone];
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <div className={`text-3xl font-bold tabular-nums ${color}`}>{value}</div>
      <div className="mt-1 text-sm font-medium">{label}</div>
      {sub && <div className="text-xs text-stone-500">{sub}</div>}
    </div>
  );
}

/** Latest `npm run eval:attacks` results, shown exactly as the run wrote them. */
export default function Eval() {
  const [state, setState] = useState<{ loading: boolean; error?: string; hint?: string; result?: EvalResult }>({ loading: true });
  useEffect(() => {
    evalApi
      .latest()
      .then((r) => setState({ loading: false, result: r.result, hint: r.hint }))
      .catch((e: Error) => setState({ loading: false, error: e.message }));
  }, []);

  if (state.loading) return <p className="text-sm text-stone-500">Loading evaluation results…</p>;
  if (state.error) return <Banner tone="red">{state.error}</Banner>;
  const r = state.result;
  if (!r)
    return (
      <div className="rounded-xl border border-dashed border-stone-300 p-8 text-center text-sm text-stone-600">
        <p className="font-medium text-ink">No evaluation results yet.</p>
        <p className="mt-1">{state.hint ?? "Run `npm run eval:attacks` in the repo, then reload this tab."}</p>
      </div>
    );
  const a = r.attacks;
  const b = r.benign;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Attack evaluation</h1>
        <p className="text-sm text-stone-600">
          {a.total} prompt-injection emails and {b.total} benign emails that look suspicious, run through the real pipeline with a worst-case agent that tries to obey every injection. <b>SANDBOX DATA.</b>
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
          <span>{new Date(r.date).toLocaleString()}</span>
          <Chip tone={r.mode === "live" ? "green" : "amber"}>{r.mode === "live" ? "real LLM extractor" : "scripted worst-case extractor"}</Chip>
          <span>
            extractor: <code>{r.extractorModel}</code>
          </span>
          {r.commit && (
            <span>
              commit <code>{r.commit}</code>
            </span>
          )}
        </p>
        {r.mode === "scripted-worst-case" && (
          <p className="mt-2 text-xs text-stone-600">
            This run measures the deterministic layers (sanitiser, vetting, provenance, Guard). It does not measure how well a real model resists injection; run <code>npm run eval:attacks -- --live</code> for that.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Blocked or flagged" value={pct(a.defended, a.total)} sub={`${a.defended}/${a.total} attacks (either layer)`} tone="green" />
        <Stat label="Attacker actions executed" value={String(a.executedAttackerActions)} sub="without the user; target 0" tone={a.executedAttackerActions === 0 ? "green" : "red"} />
        <Stat label="Benign emails flagged" value={pct(b.flagged, b.total)} sub={`${b.flagged}/${b.total} false-positive flags`} tone={b.flagged ? "amber" : "green"} />
        <Stat label="Benign tasks completed" value={`${b.tasksCompleted}/${b.total}`} sub="reminder created and verified" tone={b.tasksCompleted === b.total ? "green" : "amber"} />
      </div>
      <p className="text-xs text-stone-600">
        Flagged at ingestion: {a.flagged}/{a.total}. Guard blocked or held for approval: {a.guardStopped}/{a.total}. Stress test: if a user approves every pending attacker action including tainted ones, {r.stress.effectsCreated} of{" "}
        {r.stress.pendingAttackerActions} would take effect ({r.stress.stillBlocked} stay blocked and cannot be approved).
      </p>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">Attack emails</h2>
        <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="bg-stone-50 text-stone-500">
              <tr>
                <th className="p-2">Style</th>
                <th className="p-2">Flagged</th>
                <th className="p-2">Call</th>
                <th className="p-2">Guard</th>
                <th className="p-2">Rule</th>
                <th className="p-2">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {a.rows.map((x) => (
                <tr key={x.id} className="border-t border-stone-100">
                  <td className="p-2">{x.style}</td>
                  <td className="p-2">{x.flagged ? <Chip tone="amber">flagged</Chip> : <Chip tone="stone">not flagged</Chip>}</td>
                  <td className="p-2 font-mono">{x.tool}</td>
                  <td className="p-2">
                    {x.guardDecision}
                    {x.tainted ? " (tainted)" : ""}
                  </td>
                  <td className="p-2 font-mono">{x.rule ?? "-"}</td>
                  <td className="p-2">
                    <Chip tone={x.outcome === "blocked" ? "darkred" : x.outcome === "gated" ? "amber" : "red"}>{x.outcome}</Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">Benign emails that look suspicious</h2>
        <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="bg-stone-50 text-stone-500">
              <tr>
                <th className="p-2">Style</th>
                <th className="p-2">Flagged</th>
                <th className="p-2">Extracted</th>
                <th className="p-2">Task completed</th>
                <th className="p-2">Note</th>
              </tr>
            </thead>
            <tbody>
              {b.rows.map((x) => (
                <tr key={x.id} className="border-t border-stone-100">
                  <td className="p-2">{x.style}</td>
                  <td className="p-2">{x.flagged ? <Chip tone="amber">flagged</Chip> : "no"}</td>
                  <td className="p-2">{x.expectedObligationExtracted ? "yes" : "no"}</td>
                  <td className="p-2">{x.taskCompleted ? <Chip tone="green">yes</Chip> : <Chip tone="red">no</Chip>}</td>
                  <td className="p-2 text-stone-600">{x.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
