// Drives the compiler-generated Blind Panel contract through @midnight-ntwrk/compact-runtime:
// real persistentHash/persistentCommit, real Merkle tree, real ledger transitions.
// Run `npm run compile:fast` first.
import * as rt from "@midnight-ntwrk/compact-runtime";

import {
  Contract, ledger, pureCircuits, Phase,
  type Ledger, type Opening, type ScoreCard, type Witnesses,
} from "../build/contract/index.js";

export { Phase, pureCircuits };
export type { Opening, ScoreCard, Ledger };

export const COIN_PK = "0".repeat(64);
export const CRITERIA = 5;

export const bytes32 = (seed: string): Uint8Array => {
  const b = new Uint8Array(32);
  const s = new TextEncoder().encode(seed);
  b.set(s.subarray(0, 32));
  return b;
};
export const randomSalt = (): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(32));
export const projectKey = (name: string): Uint8Array => bytes32(`project:${name}`);

export interface PS {
  organizerSecret: Uint8Array;
  judgeSecret: Uint8Array;
  card: ScoreCard | null;
  salt: Uint8Array;
  openings: Opening[];
  /** Attack switch: hand the circuit a self-made path whose leaf is the caller's own. */
  forgePath?: boolean;
}

/** Shared by the local engine and the Preprod deploy script (contract/deploy). */
export const witnesses: Witnesses<PS> = {
  organizerSecret: ({ privateState }) => [privateState, privateState.organizerSecret],
  judgeSecret: ({ privateState }) => [privateState, privateState.judgeSecret],
  judgePath: ({ privateState, ledger: l }, leaf) => {
    // An outsider has no path; hand back a path for a different leaf so the
    // circuit's own assert refuses, rather than throwing here.
    if (privateState.forgePath) {
      // A well-formed path for this leaf, computed in a tree the outsider controls:
      // it hashes to a root the contract never saw.
      const real = l.judges.pathForLeaf(0n, new Uint8Array(32));
      return [privateState, { ...real, leaf }];
    }
    const path = l.judges.findPathForLeaf(leaf) ?? l.judges.pathForLeaf(0n, new Uint8Array(32));
    return [privateState, path];
  },
  ballotCard: ({ privateState }) => {
    if (!privateState.card) throw new Error("no scorecard staged");
    return [privateState, privateState.card];
  },
  ballotSalt: ({ privateState }) => [privateState, privateState.salt],
  projectOpenings: ({ privateState }) => {
    const pad: Opening = { card: { round: 0n, project: new Uint8Array(32), scores: [0n, 0n, 0n, 0n, 0n] }, salt: new Uint8Array(32) };
    const ops = [...privateState.openings];
    while (ops.length < 3) ops.push(pad);
    return [privateState, ops.slice(0, 3)];
  },
};

export class Panel {
  contract = new Contract(witnesses);
  address = rt.sampleContractAddress();
  state!: rt.ContractState | rt.StateValue | rt.ChargedState;
  ps!: PS;

  static async deploy(organizerSecret = bytes32("organizer"), maxScore = 10n): Promise<Panel> {
    const p = new Panel();
    p.ps = { organizerSecret, judgeSecret: new Uint8Array(32), card: null, salt: new Uint8Array(32), openings: [] };
    const init = await p.contract.initialState(
      rt.createConstructorContext(p.ps, COIN_PK), pureCircuits.organizerKeyOf(organizerSecret), maxScore);
    p.state = init.currentContractState;
    return p;
  }

  get ledger(): Ledger {
    return ledger(this.state as rt.StateValue);
  }

  private async call<R>(name: keyof Panel["contract"]["impureCircuits"], patch: Partial<PS>, ...args: unknown[]): Promise<R> {
    const ps = { ...this.ps, ...patch };
    const ctx = rt.createCircuitContext({
      circuitId: name, contractAddress: this.address, coinPublicKeyOrZswapState: COIN_PK,
      contractState: this.state, privateState: ps,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (this.contract.impureCircuits[name] as any)(ctx, ...args);
    this.state = res.context.callContext.currentQueryContext.state;
    return res.result as R;
  }

  addJudge(leaf: Uint8Array, as: Uint8Array = this.ps.organizerSecret) { return this.call("addJudge", { organizerSecret: as }, leaf); }
  addProject(project: Uint8Array, as: Uint8Array = this.ps.organizerSecret) { return this.call("addProject", { organizerSecret: as }, project); }
  openScoring(as: Uint8Array = this.ps.organizerSecret) { return this.call("openScoring", { organizerSecret: as }); }
  closeScoring(as: Uint8Array = this.ps.organizerSecret) { return this.call("closeScoring", { organizerSecret: as }); }

  /** A judge locks a scorecard. Returns the opening the team receives as its receipt. */
  async castBallot(judgeSecret: Uint8Array, project: Uint8Array, scores: number[], opts: { card?: Partial<ScoreCard>; salt?: Uint8Array; forgePath?: boolean } = {}): Promise<Opening> {
    const card: ScoreCard = { round: this.ledger.round, project, scores: scores.map(BigInt), ...opts.card };
    const salt = opts.salt ?? randomSalt();
    await this.call("castBallot", { judgeSecret, card, salt, forgePath: opts.forgePath ?? false }, project);
    return { card, salt };
  }

  checkReceipt(project: Uint8Array, i: number, opening: Opening) {
    return this.call<boolean>("checkReceipt", {}, project, BigInt(i), opening);
  }

  publishTotals(project: Uint8Array, openings: Opening[]) {
    return this.call("publishTotals", { openings }, project);
  }

  /** Organiser setup: judges and projects registered, scoring opened. */
  static async ready(judges: string[], projects: string[], maxScore = 10n): Promise<Panel> {
    const p = await Panel.deploy(bytes32("organizer"), maxScore);
    for (const j of judges) await p.addJudge(pureCircuits.judgeLeafOf(bytes32(j)));
    for (const pr of projects) await p.addProject(projectKey(pr));
    await p.openScoring();
    return p;
  }
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
