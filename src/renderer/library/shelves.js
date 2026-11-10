/**
 * Turns the flat game list into the shelves that are shown. Pure functions,
 * no DOM and no three.js, so the rules can be unit-tested directly.
 *
 * Shelf order: Favourites, Recently played, the user's collections, then one
 * shelf per system. Empty shelves are left out.
 */

export const SORTS = ['title', 'recent', 'played', 'year'];
export const SORT_LABELS = { title: 'Title', recent: 'Recently played', played: 'Most played', year: 'Release year' };
export const REGIONS = ['all', 'USA', 'Europe', 'Japan'];

export const DEFAULT_VIEW = {
  sort: 'title',
  region: 'all',
  favoritesOnly: false,
  collapseDuplicates: false,
  showHidden: false,
};

const RECENT_LIMIT = 24;
// When regional variants are collapsed, the copy kept is the first available in this order.
const REGION_RANK = { USA: 0, World: 1, Europe: 2, Japan: 3 };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byTitle = (a, b) => collator.compare(a.sortTitle, b.sortTitle) || collator.compare(a.title, b.title);

const SORTERS = {
  title: byTitle,
  recent: (a, b) => (b.user.lastPlayed - a.user.lastPlayed) || byTitle(a, b),
  played: (a, b) => (b.user.playCount - a.user.playCount) || byTitle(a, b),
  // Unknown years sort last rather than first.
  year: (a, b) => (((a.meta && a.meta.year) || 9999) - ((b.meta && b.meta.year) || 9999)) || byTitle(a, b),
};

/** "A".."Z", or "#" for digits and symbols. Groups the letter jump. */
export function letterOf(game) {
  const c = (game.sortTitle || game.title || '').trim().charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
}

/** Keeps one copy of each title per system, preferring the user's region. */
function collapseDuplicates(games, preferred) {
  const rank = (g) => (g.region === preferred ? -1 : REGION_RANK[g.region] ?? 4);
  const best = new Map();
  for (const g of games) {
    const key = `${g.systemId}|${g.sortTitle}`;
    const current = best.get(key);
    if (!current || rank(g) < rank(current)) best.set(key, g);
  }
  return games.filter((g) => best.get(`${g.systemId}|${g.sortTitle}`) === g);
}

/**
 * @param systems     public system records, in shelf order
 * @param games       public game records (each gets a `system` reference)
 * @param collections [{ id, name, games: [gameId] }]
 * @param view        see DEFAULT_VIEW
 * @returns [{ id, name, short, accent, kind, collectionId?, games }]
 */
export function buildShelves({ systems, games, collections = [], view = DEFAULT_VIEW }) {
  const systemById = new Map(systems.map((s) => [s.id, s]));

  let visible = [];
  for (const g of games) {
    const system = systemById.get(g.systemId);
    if (!system) continue;
    g.system = system;
    if (g.user.hidden && !view.showHidden) continue;
    visible.push(g);
  }

  let filtered = visible;
  if (view.favoritesOnly) filtered = filtered.filter((g) => g.user.favorite);
  if (view.region !== 'all') {
    // Region-free entries (PC games, untagged ROMs) and "World" releases always pass.
    filtered = filtered.filter((g) => !g.region || g.region === view.region || g.region === 'World');
  }
  if (view.collapseDuplicates) filtered = collapseDuplicates(filtered, view.region);

  const sorter = SORTERS[view.sort] || byTitle;
  const shelves = [];

  const favorites = filtered.filter((g) => g.user.favorite).sort(byTitle);
  if (favorites.length) {
    shelves.push({ id: '@favorites', name: 'Favourites', short: 'Favourites', accent: '#f2c94c', kind: 'virtual', games: favorites });
  }

  const recent = visible.filter((g) => g.user.lastPlayed > 0).sort(SORTERS.recent).slice(0, RECENT_LIMIT);
  if (recent.length) {
    shelves.push({ id: '@recent', name: 'Recently played', short: 'Recent', accent: '#5fd0b2', kind: 'virtual', games: recent });
  }

  const visibleById = new Map(visible.map((g) => [g.id, g]));
  for (const c of collections) {
    const list = c.games.map((id) => visibleById.get(id)).filter(Boolean);
    if (!list.length) continue;
    shelves.push({
      id: `@collection:${c.id}`, name: c.name, short: c.name, accent: '#e79ad6',
      kind: 'collection', collectionId: c.id, games: list,
    });
  }

  for (const system of systems) {
    const list = filtered.filter((g) => g.systemId === system.id).sort(sorter);
    if (!list.length) continue;
    shelves.push({ id: system.id, name: system.name, short: system.short, accent: system.accent, kind: 'system', games: list });
  }
  return shelves;
}

/**
 * Title search across the whole library. Every word must appear; titles that
 * start with the query rank above ones that merely contain it.
 */
export function searchGames(games, query, limit = 8) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const phrase = words.join(' ');
  const scored = [];
  for (const g of games) {
    if (g.user && g.user.hidden) continue;
    const title = g.title.toLowerCase();
    if (!words.every((w) => title.includes(w))) continue;
    let score = 2;
    if (title.startsWith(phrase)) score = 0;
    else if (new RegExp(`(^|[^a-z0-9])${words[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(title)) score = 1;
    scored.push({ g, score });
  }
  scored.sort((a, b) => a.score - b.score || byTitle(a.g, b.g));
  return scored.slice(0, limit).map((s) => s.g);
}
