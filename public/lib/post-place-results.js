/** Association search: the catalog must be searched even when the provider page omits it. */
export function postPlaceResults(catalog, external, query) {
  const normalize = value => String(value || '').toLocaleLowerCase().replace(/\s+/g, '');
  const matches = catalog.filter(place => normalize(place.name).includes(normalize(query)));
  const catalogIds = new Set(matches.map(place => place.placeId));
  const seen = new Set();
  const places = [...matches, ...external].filter(place => {
    if (!place?.placeId || seen.has(place.placeId)) return false;
    seen.add(place.placeId); return true;
  });
  return { places, catalogIds };
}
