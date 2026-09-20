const dietaryWord = /\b(?:vegetarian|vegan|pescatarian|halal|kosher|gluten|dairy|nuts?|peanuts?|shellfish|pork|allerg(?:y|ies|ic)|celiac|coeliac|lactose)\b/i;
const shahBrand = /\bshah(?:['’]?s)?\s+halal(?:\s+food)?\b/gi;
const instruction = /^(?:(?:we|i)\s+(?:need|want|require)\b|(?:please\s+)?(?:(?:do\s+not|don't|don’t)\s+)?(?:need|require|provide|include|add|keep|remove|drop|exclude|avoid|serve|prepare|make|ensure|accommodate)\b)/i;
const clauseBoundary = /\s*(?:;|\n|[.!](?=\s|$))\s*|(?:,\s*|\s+(?:and|but|then|also)\s+)(?=(?:please\s+)?(?:cancel|contact|switch|change|replace|book|email|ask|tell|need|require|provide|include|add|keep|remove|drop|exclude|avoid|serve|prepare|make|ensure|accommodate)\b)/i;

/** Extract explicit meal requirements, never dietary assumptions from a vendor name. */
export function parseDietaryNote(note: string): string | undefined {
  const requirements: string[] = [];
  for (const raw of note.replace(/\r\n?/g, '\n').split(clauseBoundary)) {
    let clause = raw.trim().replace(/^(?:and|but|then|also)\s+/i, '').replace(/[,.;]+$/, '').trim();
    if (!clause) continue;
    // Questions and tentative possibilities do not establish a new requirement.
    if (/\?|^(?:can|could|would|does|do(?!\s+not\b)|is|are|should)\b|\b(?:maybe|might|wondering|consider(?:ing)?)\b/i.test(clause)) continue;
    if (/\b(?:do not|don't|don’t)\s+(?:change|update|remove|drop)\b|\b(?:unchanged|as before|same as before)\b/i.test(clause)) continue;

    const labeled = /^(?:dietary(?:\s+(?:requirements?|needs?|restrictions?|preferences?))?|meal\s+requirements?)\s*[:=]\s*(.+)$/i.exec(clause);
    if (labeled) clause = labeled[1].trim();
    // "Ask CAVA to provide 20 vegan meals" contains an explicit requirement;
    // "Ask CAVA whether they offer vegan meals" is merely an inquiry.
    const directed = /^(?:please\s+)?(?:ask|tell)\s+.+?\s+to\s+((?:provide|include|prepare|serve|make|keep|ensure)\s+.+)$/i.exec(clause);
    if (directed) clause = directed[1];
    const vendorWithMeals = /^(?:please\s+)?(?:switch|change|replace|contact)\b.+?\s+(?:with|for)\s+(.+)$/i.exec(clause);
    if (vendorWithMeals && /^(?:\d+\b|all\b|no\b|(?:vegan|vegetarian|kosher|halal)\b.*\b(?:meals?|options?)\b)/i.test(vendorWithMeals[1])) clause = vendorWithMeals[1];
    const requirementText = clause.replace(shahBrand, '[vendor]');
    if (!dietaryWord.test(requirementText)) {
      if (labeled && /^(?:none|no dietary (?:requirements|restrictions|needs))$/i.test(clause)) requirements.push(clause);
      continue;
    }
    if (/\b(?:ask|contact|cancel|switch|replace|book|email)\b|\b(?:caterer|vendor|restaurant)\b/i.test(requirementText)) continue;
    const explicit = !!labeled || instruction.test(clause)
      || /\b(?:need|needs|require|requires|must|allerg(?:y|ies|ic))\b/i.test(requirementText)
      || /^(?:\d+\b|all\b|everyone\b|no\b|not\b|without\b)/i.test(requirementText)
      || /\b(?:meals?|options?|menu|food|guests?)\b/i.test(requirementText)
      || /^(?:vegetarian|vegan|pescatarian|halal|kosher|gluten[- ]free|dairy[- ]free|nut[- ]free|peanut[- ]free)(?:\s+(?:and|or)\s+(?:vegetarian|vegan|halal|kosher))?$/i.test(requirementText);
    if (!explicit) continue;
    // Remove conversational framing, while keeping operators such as "no longer",
    // "remove", "only", "at least", and "not" together with their quantities.
    clause = clause.replace(/^please\s+/i, '').replace(/^(?:we|i)\s+(?:need|require)\s+/i, '').trim();
    if (!requirements.some(value => value.toLowerCase() === clause.toLowerCase())) requirements.push(clause);
  }
  return requirements.length ? requirements.join('; ') : undefined;
}
