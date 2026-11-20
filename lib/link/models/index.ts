/**
 * UGOKI LINK v2 — Wave 6 ML Models Barrel Export (`lib/link/models`)
 *
 * Covers Bundles:
 *   - 6-A: LP excess-loss detection, 5 proposal sources, learned segments (`centroid_ml` & `density_ml`),
 *          aggregate replay Tier 0 & k>=50 identifier-free long-term sequences
 *   - 6-F: Pop-up timing ("When" S0/S1/S2 <= 50KB + counterfactual randomization) & selection
 *          ("Whether/Which" P0/P1/P2/P2.5/P3 + unified allocator constants & 10k IPS replay)
 *   - 6-D: Multi-rung recommender (R0/R1/R1.5/R2 + Plackett-Luce + Yen expected value),
 *          full EC recommender (pre-draw exclusions + full-set Plackett-Luce + directed co-purchase
 *          + censored repurchase hazard + signed proof & dual-consent member join + zero-leak DTO),
 *          3-tier Assistant (Tier 1/2/3 + >=200 faithfulness LCB gate + A3 sandbox contract),
 *          and unified `POST /v1/recommend` + MCP tool descriptor.
 */

export * from './detection';
export * from './segments';
export * from './popup';
export * from './recommend';
export * from './assistant';
export * from './recommend-service';
