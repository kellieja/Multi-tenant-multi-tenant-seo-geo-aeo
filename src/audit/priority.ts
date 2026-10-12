import type { Severity } from "@prisma/client";
import { ISSUES, type IssueType } from "./catalog";

const SEV = { CRITICAL: 1, HIGH: 0.8, MEDIUM: 0.55, LOW: 0.3, INFO: 0.1 } satisfies Record<Severity, number>;
const CONF = { high: 1, medium: 0.75, low: 0.5 };
const EFFORT = { low: 1, medium: 0.75, high: 0.5 };

export interface PriorityInput {
  issueType: IssueType;
  /** How many URLs on the site have this same issue type. */
  affectedPages: number;
  /** GSC impressions for this URL over the last 28 days; null when GSC isn't connected. */
  impressions: number | null;
  depth: number | null;
  inlinks: number | null;
  isHomepage: boolean;
}

export interface PriorityFactor {
  key: string;
  label: string;
  value: number;
  weight: number;
  explanation: string;
}

/**
 * Transparent opportunity score (0–100). Internal prioritisation aid, not a Google metric.
 *   base   = Σ(weight × factor) over severity, reach, business impact and search performance
 *   score  = 100 × base × confidence × effort-ease
 * When Search Console data is unavailable its weight is redistributed proportionally.
 */
export function scoreFinding(i: PriorityInput): { score: number; factors: PriorityFactor[] } {
  const def = ISSUES[i.issueType];
  const sev = SEV[def.severity];
  const reach = Math.min(1, Math.log10(i.affectedPages + 1) / 2); // 1 page≈0.15, 10≈0.52, 100≈1
  const business = i.isHomepage ? 1 : Math.max(0.15, Math.min(1, 1 / (1 + Math.max(0, (i.depth ?? 3) - 1) * 0.35) * 0.7 + Math.min(0.3, Math.log10((i.inlinks ?? 0) + 1) * 0.15)));
  const traffic = i.impressions == null ? null : Math.min(1, Math.log10(i.impressions + 1) / 4); // 10k impressions ≈ 1

  const weights = { severity: 0.4, reach: 0.2, business: 0.2, traffic: 0.2 };
  if (traffic == null) {
    const t = weights.traffic;
    weights.traffic = 0;
    const rest = weights.severity + weights.reach + weights.business;
    weights.severity += (t * weights.severity) / rest;
    weights.reach += (t * weights.reach) / rest;
    weights.business += (t * weights.business) / rest;
  }
  const base = weights.severity * sev + weights.reach * reach + weights.business * business + weights.traffic * (traffic ?? 0);
  const confidence = CONF[def.confidence];
  const ease = EFFORT[def.effort];
  const score = Math.round(100 * base * confidence * ease * 10) / 10;

  const factors: PriorityFactor[] = [
    { key: "severity", label: "Severity", value: sev, weight: weights.severity, explanation: `${def.severity.toLowerCase()} severity issue` },
    { key: "reach", label: "Affected pages", value: round(reach), weight: weights.reach, explanation: `${i.affectedPages} page${i.affectedPages === 1 ? "" : "s"} on this site have this issue` },
    { key: "business", label: "Page importance", value: round(business), weight: weights.business, explanation: i.isHomepage ? "Homepage" : `Click depth ${i.depth ?? "unknown"}, ${i.inlinks ?? 0} internal inlinks` },
    {
      key: "traffic", label: "Search performance", value: round(traffic ?? 0), weight: weights.traffic,
      explanation: traffic == null ? "Search Console not connected; weight redistributed" : `${i.impressions} GSC impressions in the last 28 days`,
    },
    { key: "confidence", label: "Evidence confidence", value: confidence, weight: 1, explanation: `${def.confidence} confidence detector (multiplier)` },
    { key: "effort", label: "Implementation effort", value: ease, weight: 1, explanation: `${def.effort} effort (lower effort ranks higher; multiplier)` },
  ];
  return { score, factors };
}

const round = (n: number) => Math.round(n * 100) / 100;
