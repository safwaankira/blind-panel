import { describe, expect, it } from "vitest";
import { Panel, Phase, bytes32, hex, projectKey, pureCircuits, randomSalt, type Opening } from "./harness.js";

const A = projectKey("tally");
const B = projectKey("nightpoll");
const [ADA, BEN, CY, DEV] = ["judge-ada", "judge-ben", "judge-cy", "judge-dev"].map(bytes32);

describe("happy path: three judges, receipts, team publishes its own totals", () => {
  it("locks three ballots, every receipt checks, totals equal the sum", async () => {
    const p = await Panel.ready(["judge-ada", "judge-ben", "judge-cy"], ["tally", "nightpoll"]);
    const r: Opening[] = [
      await p.castBallot(ADA, A, [8, 7, 9, 6, 5]),
      await p.castBallot(BEN, A, [6, 6, 7, 8, 9]),
      await p.castBallot(CY, A, [9, 9, 8, 7, 10]),
    ];
    expect(p.ledger.panelSize.lookup(A)).toBe(3n);
    expect(p.ledger.ballotCount).toBe(3n);
    for (let i = 0; i < 3; i++) expect(await p.checkReceipt(A, i, r[i])).toBe(true);

    await p.closeScoring();
    expect(p.ledger.phase).toBe(Phase.closed);
    await p.publishTotals(A, r);
    expect(p.ledger.totals.lookup(A)).toEqual([23n, 22n, 24n, 21n, 24n]);
  });

  it("a project with fewer than three ballots publishes over the ballots it has", async () => {
    const p = await Panel.ready(["judge-ada", "judge-ben"], ["tally"]);
    const r = [await p.castBallot(ADA, A, [1, 2, 3, 4, 5]), await p.castBallot(BEN, A, [5, 4, 3, 2, 1])];
    await p.closeScoring();
    await p.publishTotals(A, r);
    expect(p.ledger.totals.lookup(A)).toEqual([6n, 6n, 6n, 6n, 6n]);
  });
});

describe("refusals (each guard, matched by its message)", () => {
  it("only the organiser sets up the event", async () => {
    const p = await Panel.deploy();
    const mallory = bytes32("mallory");
    await expect(p.addJudge(pureCircuits.judgeLeafOf(ADA), mallory)).rejects.toThrow(/organizer only/);
    await expect(p.addProject(A, mallory)).rejects.toThrow(/organizer only/);
    await expect(p.openScoring(mallory)).rejects.toThrow(/organizer only/);
    await p.addJudge(pureCircuits.judgeLeafOf(ADA));
    await p.openScoring();
    await expect(p.closeScoring(mallory)).rejects.toThrow(/organizer only/);
  });

  it("scoring cannot open with no judges, or twice", async () => {
    const p = await Panel.deploy();
    await expect(p.openScoring()).rejects.toThrow(/no judges/);
    await p.addJudge(pureCircuits.judgeLeafOf(ADA));
    await p.openScoring();
    await expect(p.openScoring()).rejects.toThrow(/scoring already opened/);
  });

  it("the panel and project list freeze once scoring opens", async () => {
    const p = await Panel.ready(["judge-ada"], ["tally"]);
    await expect(p.addJudge(pureCircuits.judgeLeafOf(DEV))).rejects.toThrow(/judges are added before scoring opens/);
    await expect(p.addProject(B)).rejects.toThrow(/projects are added before scoring opens/);
  });

  it("a project is registered once", async () => {
    const p = await Panel.deploy();
    await p.addProject(A);
    await expect(p.addProject(A)).rejects.toThrow(/project already registered/);
  });

  it("no ballots before scoring opens or after it closes; close only while open", async () => {
    const p = await Panel.deploy();
    await p.addJudge(pureCircuits.judgeLeafOf(ADA));
    await p.addProject(A);
    await expect(p.castBallot(ADA, A, [1, 1, 1, 1, 1])).rejects.toThrow(/scoring is not open/);
    await expect(p.closeScoring()).rejects.toThrow(/scoring is not open/);
    await p.openScoring();
    await p.closeScoring();
    await expect(p.castBallot(ADA, A, [1, 1, 1, 1, 1])).rejects.toThrow(/scoring is not open/);
  });

  it("an outsider cannot cast a ballot", async () => {
    const p = await Panel.ready(["judge-ada"], ["tally"]);
    await expect(p.castBallot(bytes32("outsider"), A, [10, 10, 10, 10, 10])).rejects.toThrow(/path is not for this judge/);
  });

  it("an outsider with a self-made Merkle path for their own leaf is refused", async () => {
    const p = await Panel.ready(["judge-ada"], ["tally"]);
    await expect(p.castBallot(bytes32("outsider"), A, [10, 10, 10, 10, 10], { forgePath: true })).rejects.toThrow(/judges only/);
  });

  it("a judge scores a project once and cannot change it", async () => {
    const p = await Panel.ready(["judge-ada"], ["tally"]);
    await p.castBallot(ADA, A, [5, 5, 5, 5, 5]);
    await expect(p.castBallot(ADA, A, [10, 10, 10, 10, 10])).rejects.toThrow(/already judged this project/);
    expect(p.ledger.panelSize.lookup(A)).toBe(1n);
  });

  it("a fourth ballot is refused", async () => {
    const p = await Panel.ready(["judge-ada", "judge-ben", "judge-cy", "judge-dev"], ["tally"]);
    for (const j of [ADA, BEN, CY]) await p.castBallot(j, A, [5, 5, 5, 5, 5]);
    await expect(p.castBallot(DEV, A, [5, 5, 5, 5, 5])).rejects.toThrow(/panel is full/);
  });

  it("unknown projects are refused", async () => {
    const p = await Panel.ready(["judge-ada"], ["tally"]);
    await expect(p.castBallot(ADA, B, [5, 5, 5, 5, 5])).rejects.toThrow(/unknown project/);
    await p.closeScoring();
    await expect(p.publishTotals(B, [])).rejects.toThrow(/unknown project/);
  });

  it("scores are bounded by the rubric maximum, boundary included", async () => {
    const p = await Panel.ready(["judge-ada", "judge-ben"], ["tally"], 10n);
    await expect(p.castBallot(ADA, A, [10, 10, 10, 10, 11])).rejects.toThrow(/score above the rubric maximum/);
    await p.castBallot(BEN, A, [10, 10, 10, 10, 10]);
  });

  it("a scorecard must name this project and this round", async () => {
    const p = await Panel.ready(["judge-ada"], ["tally", "nightpoll"]);
    await expect(p.castBallot(ADA, A, [5, 5, 5, 5, 5], { card: { project: B } })).rejects.toThrow(/scorecard is for another project/);
    await expect(p.castBallot(ADA, A, [5, 5, 5, 5, 5], { card: { round: 2n } })).rejects.toThrow(/scorecard is for another round/);
  });

  it("totals wait for scoring to close and are published once", async () => {
    const p = await Panel.ready(["judge-ada", "judge-ben"], ["tally"]);
    const r = [await p.castBallot(ADA, A, [5, 5, 5, 5, 5]), await p.castBallot(BEN, A, [6, 6, 6, 6, 6])];
    await expect(p.publishTotals(A, r)).rejects.toThrow(/scoring is still open/);
    await p.closeScoring();
    await p.publishTotals(A, r);
    await expect(p.publishTotals(A, r)).rejects.toThrow(/totals already published/);
  });

  it("a single judge's scores are never published as totals", async () => {
    const p = await Panel.ready(["judge-ada", "judge-ben"], ["tally"]);
    const r = [await p.castBallot(ADA, A, [7, 3, 9, 2, 8])];
    await p.closeScoring();
    await expect(p.publishTotals(A, r)).rejects.toThrow(/at least two ballots before totals/);
    expect(p.ledger.totals.member(A)).toBe(false);
  });

  it("zero-ballot totals are refused", async () => {
    const p = await Panel.ready(["judge-ada"], ["tally"]);
    await p.closeScoring();
    await expect(p.publishTotals(A, [])).rejects.toThrow(/at least two ballots before totals/);
    expect(p.ledger.totals.member(A)).toBe(false);
  });
});

describe("attacks on results", () => {
  const setup = async () => {
    const p = await Panel.ready(["judge-ada", "judge-ben", "judge-cy"], ["tally"]);
    const r = [
      await p.castBallot(ADA, A, [4, 4, 4, 4, 4]),
      await p.castBallot(BEN, A, [5, 5, 5, 5, 5]),
      await p.castBallot(CY, A, [6, 6, 6, 6, 6]),
    ];
    await p.closeScoring();
    return { p, r };
  };

  it("a team cannot inflate its totals by editing a receipt", async () => {
    const { p, r } = await setup();
    const forged = r.map((o) => ({ ...o, card: { ...o.card, scores: [...o.card.scores] } }));
    forged[0].card.scores[0] = 10n;
    await expect(p.publishTotals(A, forged)).rejects.toThrow(/opening does not match the locked ballot/);
  });

  it("a low ballot cannot be dropped or swapped for a copy of a high one", async () => {
    const { p, r } = await setup();
    await expect(p.publishTotals(A, [r[2], r[1], r[2]])).rejects.toThrow(/opening does not match the locked ballot/);
    await expect(p.publishTotals(A, [r[1], r[2]])).rejects.toThrow(/opening does not match the locked ballot/);
  });

  it("a receipt with the wrong salt or scores does not check", async () => {
    const { p, r } = await setup();
    expect(await p.checkReceipt(A, 0, { ...r[0], salt: randomSalt() })).toBe(false);
    expect(await p.checkReceipt(A, 0, r[1])).toBe(false);
    expect(await p.checkReceipt(A, 1, r[1])).toBe(true);
  });
});

describe("privacy: what an observer of the public ledger can recover", () => {
  it("no judge identity appears on the ledger outside the judge tree", async () => {
    const p = await Panel.ready(["judge-ada", "judge-ben"], ["tally", "nightpoll"]);
    await p.castBallot(ADA, A, [7, 7, 7, 7, 7]);
    await p.castBallot(ADA, B, [7, 7, 7, 7, 7]);
    const leafAda = hex(pureCircuits.judgeLeafOf(ADA));
    const spent = [...p.ledger.spent].map(hex);
    const commitments = [...p.ledger.ballots].map(([, c]) => hex(c));
    expect(spent).not.toContain(leafAda);
    expect(commitments).not.toContain(leafAda);
    // The same judge's two ballots share nothing an observer can link: different
    // nullifiers, different commitments, even with identical scores.
    expect(new Set(spent).size).toBe(2);
    expect(new Set(commitments).size).toBe(2);
  });

  it("a dictionary attack on every possible 0-10 scorecard recovers nothing", async () => {
    const p = await Panel.ready(["judge-ada"], ["tally"]);
    await p.castBallot(ADA, A, [3, 1, 4, 1, 5]);
    const onChain = hex([...p.ledger.ballots][0][1]);
    // 11^5 = 161,051 possible cards. Without the salt none of them opens the
    // commitment, so the observer learns nothing about the scores.
    let hits = 0;
    const zero = new Uint8Array(32);
    for (let n = 0; n < 11 ** 5; n += 1) {
      let k = n;
      const scores = Array.from({ length: 5 }, () => { const s = BigInt(k % 11); k = Math.floor(k / 11); return s; });
      const guess = pureCircuits.commitmentOf({ round: 1n, project: A, scores }, zero);
      if (hex(guess) === onChain) hits += 1;
    }
    expect(hits).toBe(0);
  }, 120_000);

  it("the same scores under two salts give unrelated commitments", () => {
    const card = { round: 1n, project: A, scores: [5n, 5n, 5n, 5n, 5n] };
    expect(hex(pureCircuits.commitmentOf(card, randomSalt()))).not.toBe(hex(pureCircuits.commitmentOf(card, randomSalt())));
  });
});
