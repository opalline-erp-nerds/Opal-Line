/**
 * Stale-response guard for type-ahead search.
 *
 * Typing "meera" fires one request per keystroke (debounced); a slow response
 * for "meer" must never overwrite the newer result for "meera". The guard
 * compares the response's query token against the LATEST issued token — only
 * the most recent request wins. Lives in its own module so the race logic is
 * pinned by a unit test without pulling React or rendering the dropdown.
 */
export function shouldApplySearch(issuedToken: number, latestToken: number): boolean {
  return issuedToken === latestToken
}
