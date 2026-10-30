import { loadSilArtifact, type LoadedArtifact } from "./artifact.js";
import { TEMPLATE_BUNDLES } from "./templates-data.js";

export interface TemplateInfo {
  id: string;
  title: string;
  description: string;
  sourceFile: string;
  source: string;
  recommendedEntry: string;
  exampleArtifact: unknown;
  exampleMeta: Record<string, unknown>;
  loadedExample: LoadedArtifact;
}

const META: Record<string, { title: string; description: string; recommendedEntry: string }> = {
  tipjar: {
    title: "TipJar",
    description: "Anyone funds the P2SH; owner withdraws with pubkey+sig (blake2b pkh constructor).",
    recommendedEntry: "withdraw",
  },
  timeout_vault: {
    title: "TimeoutVault",
    description: "Recipient claims via transfer; sender reclaims after temporal timeout.",
    recommendedEntry: "transfer",
  },
  escrow: {
    title: "Escrow",
    description:
      "Arbiter (pkh) releases exact amount minus baked minerFee (300000 sompi) to buyer or seller P2PK.",
    recommendedEntry: "spend",
  },
};

let cache: TemplateInfo[] | null = null;

export function listTemplates(): TemplateInfo[] {
  if (cache) return cache;
  cache = TEMPLATE_BUNDLES.map((b) => {
    const m = META[b.id]!;
    const wrapped = b.wrapped as { meta: Record<string, unknown>; artifact: unknown };
    return {
      id: b.id,
      title: m.title,
      description: m.description,
      sourceFile: `${b.id}.sil`,
      source: b.source,
      recommendedEntry: m.recommendedEntry,
      exampleArtifact: wrapped.artifact,
      exampleMeta: wrapped.meta,
      loadedExample: loadSilArtifact(wrapped.artifact),
    };
  });
  return cache;
}

export function getTemplate(id: string): TemplateInfo {
  const t = listTemplates().find((x) => x.id === id);
  if (!t) {
    throw new Error(`unknown template "${id}". have: ${listTemplates().map((x) => x.id).join(", ")}`);
  }
  return t;
}
