/**
 * Single source of truth for the User-Agent of outbound research requests.
 *
 * Contract D19 (docs/decisions.md): every outbound research request must
 * identify the crawler as `GeneRaptorResearchBot`. Before this module the
 * string was copy-pasted into the search clients, so the contract was enforced
 * in several places — a fix had to be applied several times and no single test
 * could prove it.
 *
 * The scope suffix keeps the per-source attribution the clients already
 * shipped, while the identification prefix stays byte-identical to the old
 * strings.
 */
export const RESEARCH_USER_AGENT_ID = 'GeneRaptorResearchBot/1.0';
export const RESEARCH_USER_AGENT_CONTACT = '+https://generaptor.local';

/**
 * Build the User-Agent for a research client.
 *
 * @param {string} scope — short, human-readable source attribution
 *   (e.g. 'research evidence gathering', 'web search (keyless)').
 * @returns {string} e.g. 'GeneRaptorResearchBot/1.0 (+https://generaptor.local; research evidence gathering)'
 */
export function researchUserAgent(scope) {
  return `${RESEARCH_USER_AGENT_ID} (${RESEARCH_USER_AGENT_CONTACT}; ${scope})`;
}
