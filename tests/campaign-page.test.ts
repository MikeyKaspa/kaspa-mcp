import { describe, it, expect, beforeEach } from "vitest";
import {
  setCampaignPageContext,
  createCampaignPage,
  getCampaignPage,
  upsertCampaignPledge,
  computeCampaignStatus,
  derivePledgeForBacker,
  campaignFundBuild,
  renderCampaignPageHtml,
} from "../src/campaign-page.js";
import { ownerPkhFromP2pkAddress } from "../src/l1/owner-pkh.js";

const OWNER = "kaspatest:qq8x4g8see6sxhe46zmuwg28cgjauw9csxkxug2gynpfsuszp7kk78yvl9r00";
const B1 = "kaspatest:qza6ey35a278ft60rhvjfna96dznge4qrlw9zgr7zedngjzqvd97u9t9lscq6";
const B2 = "kaspatest:qrs89htrl7hc785tz6r9985xfp7xz3267wn5pr3wd7e863xddqqkcccpth6zv";

describe("campaign share page", () => {
  beforeEach(() => {
    setCampaignPageContext({ kv: null, publicBaseUrl: "https://example.test" });
  });

  it("creates page and HTML has tracker + pledge UI without warning banners", async () => {
    const { record, url } = await createCampaignPage({
      networkId: "kaspa-l1-testnet-10",
      ownerAddress: OWNER,
      campaignTagHex: "aa".repeat(32),
      goalSompi: 500_000_000,
      deadlineMs: Date.now() + 2 * 86_400_000,
    });
    expect(url).toContain("/campaign/");
    const html = renderCampaignPageHtml(record);
    expect(html).toMatch(/Pledge/);
    expect(html).toMatch(/progress|barFill|raisedLabel/i);
    expect(html).toMatch(/btnReclaim/);
    expect(html).not.toMatch(/UNAUDITED|warning flag|⚠/i);
    expect(html).not.toMatch(/cdn\.|unpkg|jsdelivr|googleapis/i);
  });

  it("derive + fund build keeps expectedP2sh binding", async () => {
    const { record } = await createCampaignPage({
      networkId: "kaspa-l1-testnet-10",
      ownerAddress: OWNER,
      ownerPkhHex: ownerPkhFromP2pkAddress(OWNER),
      campaignTagHex: "bb".repeat(32),
      goalSompi: 500_000_000,
      deadlineMs: Date.now() + 86_400_000,
    });
    const d1 = derivePledgeForBacker(record, B1);
    const d2 = derivePledgeForBacker(record, B2);
    expect(d1.p2shAddress).not.toBe(d2.p2shAddress);
    const built = campaignFundBuild(record, B1, 100_000_000);
    expect(built.l1Build.expectedP2shAddress).toBe(d1.p2shAddress);
    expect(built.l1Build.bytecodeHex).toBe(d1.bytecodeHex);
  });

  it("status open → goal_met → refunding heuristics", async () => {
    const future = Date.now() + 86_400_000;
    const past = Date.now() - 86_400_000;
    const { record } = await createCampaignPage({
      networkId: "kaspa-l1-testnet-10",
      ownerAddress: OWNER,
      campaignTagHex: "cc".repeat(32),
      goalSompi: 500_000_000, // unreachable without chain funds
      deadlineMs: future,
    });
    await upsertCampaignPledge(record.id, {
      backerAddress: B1,
      backerPkhHex: ownerPkhFromP2pkAddress(B1),
      p2shAddress: derivePledgeForBacker(record, B1).p2shAddress,
    });
    const recLive = await getCampaignPage(record.id);
    expect(recLive).toBeTruthy();
    const st = await computeCampaignStatus(recLive!);
    expect(st.status).toBe("open");
    expect(st.goalKas).toBeTruthy();
    // past deadline with no raised → refunding
    recLive!.deadlineMs = String(past);
    const st2 = await computeCampaignStatus(recLive!);
    expect(st2.status).toBe("refunding");
  });
});
