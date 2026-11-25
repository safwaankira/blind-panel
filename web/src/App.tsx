import { useEffect, useRef, useState } from "react";
import {
  CRITERIA, Event, JUDGES, MAX_SCORE, PROJECTS, Phase, Refused, encodeReceipt,
  type JudgeName, type ProjectName, type Receipt,
} from "./event";

type Outcome = { kind: "ok"; text: string } | { kind: "refused"; reason: string } | null;

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function App() {
  const ev = useRef<Event | null>(null);
  const [, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"judge" | "team" | "cheat">("judge");
  const [inbox, setInbox] = useState<Receipt[]>([]);
  const [proveMs, setProveMs] = useState<number | null>(null);

  useEffect(() => {
    Event.create().then((e) => { ev.current = e; setReady(true); });
  }, []);

  const withBusy = async <T,>(f: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try { return await f(); } finally { setBusy(false); refresh(); }
  };

  const demo = () => withBusy(async () => {
    const e = ev.current!;
    const plan: [JudgeName, ProjectName, number[]][] = [
      ["Ada", "Ferry", [8, 7, 9, 6, 7]], ["Ben", "Ferry", [7, 8, 8, 7, 6]], ["Cy", "Ferry", [9, 7, 8, 8, 9]],
      ["Ada", "Lantern", [6, 6, 7, 9, 8]], ["Ben", "Lantern", [5, 7, 6, 8, 9]],
    ];
    const got: Receipt[] = [];
    for (const [j, p, s] of plan) {
      if (e.ledger.phase !== Phase.scoring) break;
      try { got.push(await e.cast(j, p, s)); } catch (err) { if (!(err instanceof Refused)) throw err; }
    }
    setInbox((prev) => [...prev, ...got]);
    if (e.ledger.phase === Phase.scoring) await e.close();
    for (const p of ["Ferry", "Lantern"] as ProjectName[]) {
      const mine = [...inbox, ...got].filter((r) => r.project === p);
      if (!e.totals(p) && mine.length === e.panelSize(p)) await e.publish(p, mine).catch(() => undefined);
    }
    setTab("team");
  });

  const restart = () => withBusy(async () => {
    ev.current = await Event.create();
    setInbox([]);
    setTab("judge");
  });

  if (!ready) {
    return <main className="loading"><p>Loading the contract's circuits…</p></main>;
  }
  const e = ev.current!;
  const view = e.publicView();

  return (
    <div className="page">
      <header className="hero">
        <h1>Blind Panel</h1>
        <p className="lede">Hackathon judging where judges stay anonymous, scores lock, and every team gets a receipt it can check.</p>
        <div className="hero-actions">
          {view.phase === Phase.scoring ? (
            <button className="primary" disabled={busy} onClick={demo}>Run a demo round</button>
          ) : (
            <button className="primary" disabled={busy} onClick={restart}>Start a new round</button>
          )}
          <span className="muted">Runs the Midnight contract's compiled circuits in this tab. No wallet, no sign-in.</span>
        </div>
      </header>

      <div className="layout">
        <section className="work">
          <nav className="tabs" role="tablist">
            {(["judge", "team", "cheat"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "tab on" : "tab"} onClick={() => setTab(t)}>
                {t === "judge" ? "Judge" : t === "team" ? "Team" : "Try to cheat"}
              </button>
            ))}
          </nav>
          {tab === "judge" && (
            <JudgeView e={e} busy={busy} withBusy={withBusy} proveMs={proveMs} setProveMs={setProveMs}
              onReceipt={(r) => setInbox((prev) => [...prev, r])} />
          )}
          {tab === "team" && <TeamView e={e} busy={busy} withBusy={withBusy} inbox={inbox} />}
          {tab === "cheat" && <CheatView />}
        </section>

        <aside className="ledger" aria-label="Public ledger">
          <h2>Public ledger</h2>
          <dl className="facts">
            <div><dt>Phase</dt><dd>{["Setup", "Scoring", "Closed"][view.phase]}</dd></div>
            <div><dt>Judges</dt><dd>{view.judges}</dd></div>
            <div><dt>Ballots</dt><dd>{view.ballots}</dd></div>
          </dl>
          <table className="grid">
            <thead><tr><th>Project</th><th>Ballots</th><th>Total</th></tr></thead>
            <tbody>
              {view.projects.map((p) => (
                <tr key={p.name}><td>{p.name}</td><td>{p.panel} / 3</td><td>{p.totals ? sum(p.totals) : "—"}</td></tr>
              ))}
            </tbody>
          </table>
          <h3>Locked ballots</h3>
          {view.commitments.length === 0 ? <p className="muted">None yet.</p> : (
            <ul className="hashes">{view.commitments.map((c) => <li key={c.slot}><code>{short(c.commitment)}</code></li>)}</ul>
          )}
          <h3>Never on the ledger</h3>
          <ul className="never">
            <li>Which judge cast a ballot</li>
            <li>Any individual score</li>
            <li>Receipt salts</li>
          </ul>
          {view.phase === Phase.scoring && (
            <button className="secondary" disabled={busy} onClick={() => withBusy(() => e.close())}>Close scoring</button>
          )}
        </aside>
      </div>

      <footer>
        <p>
          Contract and app: Apache-2.0. Judging model and score sliders adapted from{" "}
          <a href="https://github.com/HackGT/timber">HackGT timber</a> and{" "}
          <a href="https://github.com/HackGT/api">HackGT api</a> (MIT).
        </p>
      </footer>
    </div>
  );
}

function Stamp({ outcome }: { outcome: Outcome }) {
  if (!outcome) return null;
  return outcome.kind === "ok"
    ? <p className="stamp ok" role="status">{outcome.text}</p>
    : <p className="stamp refused" role="alert"><strong>Refused by the contract:</strong> {outcome.reason}</p>;
}

function JudgeView({ e, busy, withBusy, onReceipt, proveMs, setProveMs }: {
  e: Event; busy: boolean; withBusy: <T>(f: () => Promise<T>) => Promise<T>;
  onReceipt: (r: Receipt) => void; proveMs: number | null; setProveMs: (n: number) => void;
}) {
  const [judge, setJudge] = useState<JudgeName>("Ada");
  const [project, setProject] = useState<ProjectName>("Quill");
  const [scores, setScores] = useState<number[]>(CRITERIA.map(() => 5));
  const [outcome, setOutcome] = useState<Outcome>(null);

  const lock = () => withBusy(async () => {
    const t0 = performance.now();
    try {
      const r = await e.cast(judge, project, scores);
      setProveMs(Math.round(performance.now() - t0));
      onReceipt(r);
      setOutcome({ kind: "ok", text: `Locked as ballot ${r.slot + 1} of 3 for ${project}. Receipt sent to the team.` });
    } catch (err) {
      if (err instanceof Refused) setOutcome({ kind: "refused", reason: err.message });
      else throw err;
    }
  });

  return (
    <div className="panel">
      <div className="row">
        <label>Judge
          <select value={judge} onChange={(x) => setJudge(x.target.value as JudgeName)}>
            {[...JUDGES, "Outsider" as const].map((j) => <option key={j}>{j}</option>)}
          </select>
        </label>
        <label>Project
          <select value={project} onChange={(x) => setProject(x.target.value as ProjectName)}>
            {PROJECTS.map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
      </div>
      <div className="sliders">
        {CRITERIA.map((c, i) => (
          <label key={c} className="slider">
            <span>{c}</span>
            <input type="range" min={0} max={MAX_SCORE} value={scores[i]}
              onChange={(x) => setScores(scores.map((s, k) => (k === i ? Number(x.target.value) : s)))} />
            <output>{scores[i]}</output>
          </label>
        ))}
      </div>
      <button className="primary" disabled={busy} onClick={lock}>Lock score</button>
      {proveMs !== null && <p className="muted">Last ballot ran its circuit in {proveMs} ms.</p>}
      <Stamp outcome={outcome} />
    </div>
  );
}

function TeamView({ e, busy, withBusy, inbox }: {
  e: Event; busy: boolean; withBusy: <T>(f: () => Promise<T>) => Promise<T>; inbox: Receipt[];
}) {
  const [project, setProject] = useState<ProjectName>("Ferry");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [outcome, setOutcome] = useState<Outcome>(null);
  const mine = inbox.filter((r) => r.project === project).sort((a, b) => a.slot - b.slot);
  const totals = e.totals(project);
  const closed = e.ledger.phase === Phase.closed;

  const check = (r: Receipt) => withBusy(async () => {
    const ok = await e.check(r);
    setChecked((c) => ({ ...c, [`${r.project}:${r.slot}`]: ok }));
  });

  const publish = () => withBusy(async () => {
    try {
      await e.publish(project, mine);
      setOutcome({ kind: "ok", text: `Totals for ${project} are on the ledger.` });
    } catch (err) {
      if (err instanceof Refused) setOutcome({ kind: "refused", reason: err.message });
      else throw err;
    }
  });

  return (
    <div className="panel">
      <label>Your project
        <select value={project} onChange={(x) => { setProject(x.target.value as ProjectName); setOutcome(null); }}>
          {PROJECTS.map((p) => <option key={p}>{p}</option>)}
        </select>
      </label>
      {mine.length === 0 ? <p className="muted">No receipts for {project} yet.</p> : (
        <table className="grid">
          <thead><tr><th>Ballot</th>{CRITERIA.map((c) => <th key={c}>{c}</th>)}<th>On ledger</th></tr></thead>
          <tbody>
            {mine.map((r) => {
              const k = `${r.project}:${r.slot}`;
              return (
                <tr key={k}>
                  <td title={encodeReceipt(r)}>{r.slot + 1}</td>
                  {r.opening.card.scores.map((s, i) => <td key={i}>{Number(s)}</td>)}
                  <td>{k in checked ? (checked[k] ? "Matches" : "No match")
                    : <button className="link" disabled={busy} onClick={() => check(r)}>Check</button>}</td>
                </tr>
              );
            })}
            {totals && (
              <tr className="total"><td>Total</td>{totals.map((t, i) => <td key={i}>{t}</td>)}<td>{sum(totals)}</td></tr>
            )}
          </tbody>
        </table>
      )}
      {!totals && (
        <button className="primary" disabled={busy || !closed || mine.length === 0} onClick={publish}>
          Publish totals
        </button>
      )}
      {!closed && !totals && <p className="muted">Totals can be published once scoring closes.</p>}
      <Stamp outcome={outcome} />
    </div>
  );
}

// Each attack runs on its own fresh event, so the round above stays clean.
const ATTACKS: { name: string; what: string; run: () => Promise<void> }[] = [
  {
    name: "Change a locked score", what: "Ada scores Ferry 4, then tries 10.",
    run: async () => { const e = await Event.create(); await e.cast("Ada", "Ferry", [4, 4, 4, 4, 4]); await e.cast("Ada", "Ferry", [10, 10, 10, 10, 10]); },
  },
  {
    name: "Outsider casts a ballot", what: "A non-judge brings their own Merkle path.",
    run: async () => { const e = await Event.create(); await e.cast("Outsider", "Ferry", [10, 10, 10, 10, 10], { forgePath: true }); },
  },
  {
    name: "Score above the rubric", what: "Ben gives 11 out of 10.",
    run: async () => { const e = await Event.create(); await e.cast("Ben", "Ferry", [10, 10, 10, 10, 11]); },
  },
  {
    name: "Pack the panel", what: "A fourth judge scores a full panel.",
    run: async () => {
      const e = await Event.create();
      for (const j of ["Ada", "Ben", "Cy"] as const) await e.cast(j, "Ferry", [5, 5, 5, 5, 5]);
      await e.cast("Dev", "Ferry", [10, 10, 10, 10, 10]);
    },
  },
  {
    name: "Inflate a receipt", what: "The team edits a 4 into a 10 before publishing.",
    run: async () => {
      const e = await Event.create();
      const r = [await e.cast("Ada", "Ferry", [4, 4, 4, 4, 4]), await e.cast("Ben", "Ferry", [6, 6, 6, 6, 6])];
      await e.close();
      r[0].opening.card.scores[0] = 10n;
      await e.publish("Ferry", r);
    },
  },
  {
    name: "Drop the low ballot", what: "The team swaps its worst ballot for a copy of its best.",
    run: async () => {
      const e = await Event.create();
      const lo = await e.cast("Ada", "Ferry", [2, 2, 2, 2, 2]);
      const hi = await e.cast("Ben", "Ferry", [9, 9, 9, 9, 9]);
      await e.close();
      void lo;
      await e.publishRaw("Ferry", [hi.opening, hi.opening]);
    },
  },
];

function CheatView() {
  const [results, setResults] = useState<Record<string, Outcome>>({});
  const [running, setRunning] = useState<string | null>(null);

  const attempt = async (a: (typeof ATTACKS)[number]) => {
    setRunning(a.name);
    try {
      await a.run();
      setResults((r) => ({ ...r, [a.name]: { kind: "ok", text: "Went through. This is a bug." } }));
    } catch (err) {
      setResults((r) => ({ ...r, [a.name]: err instanceof Refused ? { kind: "refused", reason: err.message } : { kind: "ok", text: String(err) } }));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="panel">
      <ul className="attacks">
        {ATTACKS.map((a) => (
          <li key={a.name}>
            <div>
              <strong>{a.name}</strong>
              <p className="muted">{a.what}</p>
            </div>
            <button className="secondary" disabled={running !== null} onClick={() => attempt(a)}>
              {running === a.name ? "Running…" : "Try it"}
            </button>
            <Stamp outcome={results[a.name] ?? null} />
          </li>
        ))}
      </ul>
    </div>
  );
}
