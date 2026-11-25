// One judging event, run against the real compiled Blind Panel circuits in this
// browser tab. The ledger is a local copy: nothing is sent anywhere.
import { Panel, bytes32, hex, projectKey, pureCircuits, Phase, type Opening } from "@contract/lib/panel";

export { Phase, hex };

export const CRITERIA = ["Engineering", "Quality", "Product", "Design", "Communication"];
export const MAX_SCORE = 10;

export const JUDGES = ["Ada", "Ben", "Cy", "Dev"] as const;
export type JudgeName = (typeof JUDGES)[number] | "Outsider";
export const PROJECTS = ["Ferry", "Lantern", "Quill"] as const;
export type ProjectName = (typeof PROJECTS)[number];

const secretOf = (j: JudgeName) => bytes32(`judge:${j}`);
export const keyOf = (p: ProjectName) => projectKey(p);

export interface Receipt {
  project: ProjectName;
  slot: number;
  opening: Opening;
}

export class Refused extends Error {}

const ASSERTS = [
  "organizer only", "judges are added before scoring opens", "projects are added before scoring opens",
  "project already registered", "scoring already opened", "no judges", "scoring is not open", "unknown project",
  "path is not for this judge", "judges only", "already judged this project", "scorecard is for another round",
  "scorecard is for another project", "score above the rubric maximum", "panel is full", "scoring is still open",
  "totals already published", "opening does not match the locked ballot",
];

async function run<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const hit = ASSERTS.find((a) => msg.includes(a));
    if (hit) throw new Refused(hit);
    throw e;
  }
}

export class Event {
  private constructor(public panel: Panel) {}

  static async create(): Promise<Event> {
    const panel = await Panel.deploy(bytes32("organizer"), BigInt(MAX_SCORE));
    for (const j of JUDGES) await panel.addJudge(pureCircuits.judgeLeafOf(secretOf(j)));
    for (const p of PROJECTS) await panel.addProject(keyOf(p));
    await panel.openScoring();
    return new Event(panel);
  }

  get ledger() {
    return this.panel.ledger;
  }

  panelSize(p: ProjectName): number {
    return Number(this.ledger.panelSize.lookup(keyOf(p)));
  }

  /** Runs castBallot. Returns the receipt the team gets, or throws Refused with the contract's message. */
  async cast(judge: JudgeName, project: ProjectName, scores: number[], opts: { forgePath?: boolean } = {}): Promise<Receipt> {
    const slot = this.panelSize(project);
    const opening = await run(() => this.panel.castBallot(secretOf(judge), keyOf(project), scores, { forgePath: opts.forgePath }));
    return { project, slot, opening };
  }

  check(r: Receipt): Promise<boolean> {
    return run(() => this.panel.checkReceipt(keyOf(r.project), r.slot, r.opening));
  }

  close(): Promise<unknown> {
    return run(() => this.panel.closeScoring());
  }

  publish(project: ProjectName, receipts: Receipt[]): Promise<unknown> {
    const ordered = [...receipts].sort((a, b) => a.slot - b.slot).map((r) => r.opening);
    return run(() => this.panel.publishTotals(keyOf(project), ordered));
  }

  publishRaw(project: ProjectName, openings: Opening[]): Promise<unknown> {
    return run(() => this.panel.publishTotals(keyOf(project), openings));
  }

  totals(p: ProjectName): number[] | null {
    const k = keyOf(p);
    return this.ledger.totals.member(k) ? this.ledger.totals.lookup(k).map(Number) : null;
  }

  /** What anyone watching the chain sees. */
  publicView() {
    const l = this.ledger;
    return {
      phase: l.phase,
      judges: Number(l.judgeCount),
      ballots: Number(l.ballotCount),
      commitments: [...l.ballots].map(([slot, c]) => ({ slot: hex(slot), commitment: hex(c) })),
      nullifiers: [...l.spent].map(hex),
      projects: PROJECTS.map((p) => ({ name: p, key: hex(keyOf(p)), panel: this.panelSize(p), totals: this.totals(p) })),
    };
  }
}

export const encodeReceipt = (r: Receipt): string =>
  btoa(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? `0x${hex(v)}` : v)));
