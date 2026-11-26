// Deploys Blind Panel to Midnight Preprod and runs one judging event on it:
//   deploy (organiser key, maxScore 10) → 3 × addJudge → 2 × addProject → openScoring
//   → 3 ballots on "aurora", 2 on "basalt" → closeScoring → publishTotals × 2 → check one receipt
//
// Every step's tx is written to deployments/preprod.json as soon as it lands, and the
// demo secrets and receipts to deploy/.run-state.preprod.json (gitignored), so a run that
// fails part-way resumes where it stopped.
//
//   npm run deploy:preprod                       full run (resumes if a run state exists)
//   npm run deploy:preprod -- --onchain-receipt  also submit checkReceipt as a transaction
//
// The receipt check is done off-chain by default: it recomputes the receipt's commitment
// with the compiled pure circuit and compares it with the ballot on the ledger. Submitting
// checkReceipt on-chain passes the opening (scores + salt) as a circuit argument, which the
// Muse review flagged (P-01) as possibly public, so it is opt-in.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pureCircuits } from "../build/contract/index.js";
import { hex, projectKey, type Opening, type ScoreCard } from "../lib/panel.js";
import { deploy, join, buildProviders, readLedger, setPrivateState, type Providers } from "./client.js";
import {
  deploymentFile, EXPLORER, loadEnv, preprodConfig, redact, runStateFile, NETWORK_ID,
} from "./config.js";
import { PanelWallet } from "./wallet.js";
import { freshSecret, initialPrivateState, type PS } from "./witnesses.js";

const MAX_SCORE = 10n;
const PROJECTS = ["aurora", "basalt"] as const;
// [judge index, project, five criterion scores]
const BALLOTS: [number, (typeof PROJECTS)[number], number[]][] = [
  [0, "aurora", [8, 7, 9, 6, 8]],
  [1, "aurora", [7, 8, 8, 7, 9]],
  [2, "aurora", [9, 6, 7, 8, 7]],
  [0, "basalt", [5, 6, 7, 5, 6]],
  [1, "basalt", [6, 5, 6, 7, 5]],
];

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${redact(m)}`);
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

// ── persisted state ───────────────────────────────────────────────────────────

interface TxRecord { step: string; circuit: string; txId: string; txHash: string; blockHeight: number; explorer: string }
interface Deployment {
  network: string;
  contractAddress: string | null;
  explorer: { contract: string | null };
  toolchain: Record<string, string>;
  maxScore: number;
  projects: Record<string, string>;
  transactions: TxRecord[];
  results?: unknown;
}
interface SavedOpening { project: string; slot: number; scores: number[]; round: string; salt: string }
interface RunState {
  organizerSecret: string;
  judgeSecrets: string[];
  openings: SavedOpening[];
}

const readJson = <T>(f: string): T | null => (existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : null);
const writeJson = (f: string, v: unknown, mode = 0o644) => {
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(v, null, 2) + "\n", { mode });
};

const run: RunState = readJson<RunState>(runStateFile) ?? {
  organizerSecret: hex(freshSecret()),
  judgeSecrets: [hex(freshSecret()), hex(freshSecret()), hex(freshSecret())],
  openings: [],
};
const saveRun = () => writeJson(runStateFile, run, 0o600);

const dep: Deployment = readJson<Deployment>(deploymentFile) ?? {
  network: NETWORK_ID,
  contractAddress: null,
  explorer: { contract: null },
  toolchain: { compact: "0.36.1", "compact-runtime": "0.21.0", "midnight-js": "5.0.1", "wallet-sdk": "2.0.1", "proof-server": "9.0.2" },
  maxScore: Number(MAX_SCORE),
  projects: Object.fromEntries(PROJECTS.map((p) => [p, hex(projectKey(p))])),
  transactions: [],
};
const saveDep = () => writeJson(deploymentFile, dep);
const done = (step: string) => dep.transactions.find((t) => t.step === step);

function record(step: string, circuit: string, pub: { txId: string; txHash: string; blockHeight: number }) {
  const r: TxRecord = {
    step, circuit, txId: String(pub.txId), txHash: String(pub.txHash), blockHeight: Number(pub.blockHeight),
    explorer: `${EXPLORER}/transactions/${pub.txHash}`,
  };
  dep.transactions.push(r);
  saveDep();
  log(`✓ ${step}  tx ${r.txHash}  block ${r.blockHeight}`);
}

const toOpening = (o: SavedOpening): Opening => ({
  card: { round: BigInt(o.round), project: projectKey(o.project), scores: o.scores.map(BigInt) },
  salt: unhex(o.salt),
});

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  loadEnv();
  const seed = process.env.WALLET_SEED?.trim();
  if (!seed) throw new Error("WALLET_SEED is missing from .env; run npm run wallet:new");
  const cfg = preprodConfig();
  saveRun();

  const wallet = await PanelWallet.start(cfg, seed, log);
  try {
    await wallet.ensureDust(log);
    const providers: Providers = buildProviders(wallet, cfg);

    const organizerSecret = unhex(run.organizerSecret);
    const judgeSecrets = run.judgeSecrets.map(unhex);
    const base: PS = initialPrivateState(organizerSecret);

    // 1. deploy
    let contract;
    if (!dep.contractAddress) {
      log("deploying Blind Panel (organiser key, maxScore 10)…");
      const d = await deploy(providers, pureCircuits.organizerKeyOf(organizerSecret), MAX_SCORE, base);
      const pub = d.deployTxData.public;
      dep.contractAddress = String(pub.contractAddress);
      dep.explorer.contract = `${EXPLORER}/contracts/${dep.contractAddress}`;
      record("deploy", "constructor", pub);
      contract = d;
    } else {
      log(`resuming against ${dep.contractAddress}`);
      contract = await join(providers, dep.contractAddress, base);
    }
    const addr = dep.contractAddress!;
    const call = contract.callTx as unknown as Record<string, (...a: unknown[]) => Promise<{ public: TxRecord & { txId: string } ; private: { result: unknown } }>>;
    const step = async (name: string, circuit: string, ps: Partial<PS>, ...args: unknown[]) => {
      if (done(name)) return log(`- ${name} already done`);
      log(`${name}…`);
      await setPrivateState(providers, addr, { ...base, ...ps });
      const res = await call[circuit](...args);
      record(name, circuit, res.public);
    };

    // 2. organiser setup
    for (let j = 0; j < 3; j++) {
      await step(`addJudge #${j + 1}`, "addJudge", {}, pureCircuits.judgeLeafOf(judgeSecrets[j]));
    }
    for (const p of PROJECTS) await step(`addProject ${p}`, "addProject", {}, projectKey(p));
    await step("openScoring", "openScoring", {});

    // 3. ballots
    for (const [j, p, scores] of BALLOTS) {
      const name = `castBallot judge#${j + 1} → ${p}`;
      if (done(name)) { log(`- ${name} already done`); continue; }
      const l = await readLedger(providers, addr);
      const slot = Number(l.panelSize.lookup(projectKey(p)));
      // Reuse a staged salt if a previous attempt at this ballot failed before landing.
      let saved = run.openings.find((o) => o.project === p && o.slot === slot);
      if (!saved) {
        saved = { project: p, slot, scores, round: String(l.round), salt: hex(freshSecret()) };
        run.openings.push(saved);
        saveRun();
      }
      const { card, salt } = toOpening(saved);
      await step(name, "castBallot", { judgeSecret: judgeSecrets[j], card: card as ScoreCard, salt }, projectKey(p));
    }

    // 4. close and publish
    await step("closeScoring", "closeScoring", {});
    for (const p of PROJECTS) {
      const ops = run.openings.filter((o) => o.project === p).sort((a, b) => a.slot - b.slot).map(toOpening);
      await step(`publishTotals ${p}`, "publishTotals", { openings: ops }, projectKey(p));
    }

    // 5. check one receipt (aurora, slot 0) and the published totals
    const l = await readLedger(providers, addr);
    const r0 = run.openings.find((o) => o.project === "aurora" && o.slot === 0)!;
    const op = toOpening(r0);
    const slot = pureCircuits.slotOf(projectKey("aurora"), 0n);
    const onLedger = l.ballots.member(slot) ? hex(l.ballots.lookup(slot)) : null;
    const recomputed = hex(pureCircuits.commitmentOf(op.card, op.salt));
    const receiptOk = onLedger === recomputed;
    log(`receipt aurora #0: ledger ${onLedger}  recomputed ${recomputed}  → ${receiptOk ? "MATCH" : "MISMATCH"}`);

    if (process.argv.includes("--onchain-receipt")) {
      if (!done("checkReceipt aurora #0")) {
        await setPrivateState(providers, addr, base);
        const res = await call.checkReceipt(projectKey("aurora"), 0n, op);
        record("checkReceipt aurora #0", "checkReceipt", res.public);
        log(`on-chain checkReceipt returned ${String(res.private.result)}`);
      }
    }

    const totals: Record<string, { ballots: number; totals: number[]; expected: number[]; match: boolean }> = {};
    for (const p of PROJECTS) {
      const key = projectKey(p);
      const got = l.totals.member(key) ? l.totals.lookup(key).map(Number) : [];
      const expected = [0, 1, 2, 3, 4].map((c) => BALLOTS.filter((b) => b[1] === p).reduce((s, b) => s + b[2][c], 0));
      totals[p] = { ballots: Number(l.panelSize.lookup(key)), totals: got, expected, match: JSON.stringify(got) === JSON.stringify(expected) };
      log(`totals ${p}: ${JSON.stringify(got)} (expected ${JSON.stringify(expected)}) ${totals[p].match ? "✓" : "✗"}`);
    }
    dep.results = {
      phase: Number(l.phase),
      ballotCount: Number(l.ballotCount),
      judgeCount: Number(l.judgeCount),
      totals,
      receiptCheck: { project: "aurora", slot: 0, mode: "off-chain (pure commitmentOf vs ledger ballots)", ledgerCommitment: onLedger, match: receiptOk },
    };
    saveDep();
    const allOk = receiptOk && Object.values(totals).every((t) => t.match);
    log(allOk ? `done: ${dep.transactions.length} transactions, results verified` : "done, but a check FAILED");
    log(`contract: ${dep.explorer.contract}`);
    if (!allOk) process.exitCode = 1;
  } finally {
    await wallet.stop().catch((e) => log(`wallet stop: ${e}`));
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(redact(e instanceof Error ? `${e.message}\n${e.stack}` : String(e)));
    process.exit(1);
  },
);

