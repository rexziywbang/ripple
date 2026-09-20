import { describe, expect, it } from 'vitest';
import { parseDietaryNote } from '../server/planning-notes.js';

describe('explicit dietary planning notes', () => {
  it.each([
    ['We need 20 vegetarian meals and 5 kosher meals.', '20 vegetarian meals and 5 kosher meals'],
    ['kosher', 'kosher'],
    ['Please make the entire menu kosher.', 'make the entire menu kosher'],
    ['Dietary requirements: 15 vegan meals, 8 gluten-free meals, no peanuts.', '15 vegan meals, 8 gluten-free meals, no peanuts'],
    ['Dietary needs: none', 'none'],
    ['No halal requirement; we need vegan options.', 'No halal requirement; vegan options'],
    ['We no longer need halal meals.', 'We no longer need halal meals'],
    ['Make 20 meals vegetarian, not vegan.', 'Make 20 meals vegetarian, not vegan'],
    ['At least 12 guests need gluten-free meals; 3 have peanut allergies.', 'At least 12 guests need gluten-free meals; 3 have peanut allergies'],
    ['No nuts, gluten or dairy.', 'No nuts, gluten or dairy'],
    ['Remove the vegan option and keep 10 kosher meals.', 'Remove the vegan option; keep 10 kosher meals'],
    ['We need only 5 halal meals, not 50.', 'only 5 halal meals, not 50'],
    ['Do not serve pork or shellfish.', 'Do not serve pork or shellfish'],
    ["Please don't include peanuts in any meals.", "don't include peanuts in any meals"],
  ])('preserves quantities, dietary scope and negation in %s', (note, expected) => {
    expect(parseDietaryNote(note)).toBe(expected);
  });

  it.each([
    'cancel catering from Shah Halal and contact CAVA instead',
    "Cancel Shah's Halal Food and contact CAVA instead.",
    'Switch from Shah’s Halal Food (Boston) to CAVA Harvard Square.',
    'Shah Halal is the current caterer.',
    'Please contact the kosher caterer.',
    'Do they offer vegan meals?',
    'Ask CAVA whether they have halal options.',
    'Maybe we should consider vegetarian options.',
    "Don't change the dietary requirements.",
    'Keep the vegetarian requirements unchanged.',
    'Move the venue to Cambridge.',
    '',
  ])('does not invent a dietary change from %s', note => {
    expect(parseDietaryNote(note)).toBeUndefined();
  });

  it.each([
    ['Cancel Shah Halal and contact CAVA instead, but keep 20 vegetarian meals and no peanuts.', 'keep 20 vegetarian meals and no peanuts'],
    ["Replace Shah's Halal Food with CAVA; we need 8 kosher meals, not halal meals.", '8 kosher meals, not halal meals'],
    ['We need 10 vegan meals and contact CAVA instead.', '10 vegan meals'],
    ['Ask CAVA to provide 20 halal meals and 5 vegetarian meals.', 'provide 20 halal meals and 5 vegetarian meals'],
    ['Cancel Shah Halal. Dietary: no pork and 4 kosher meals.', 'no pork and 4 kosher meals'],
    ['Switch to CAVA with 20 kosher meals and no peanuts.', '20 kosher meals and no peanuts'],
    ['Contact CAVA for 10 vegan meals.', '10 vegan meals'],
  ])('separates actual requirements from vendor operations in %s', (note, expected) => {
    expect(parseDietaryNote(note)).toBe(expected);
  });
});
