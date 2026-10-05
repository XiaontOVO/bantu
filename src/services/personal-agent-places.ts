import type { DemoPlace } from '../demo/demo-data.js';
import type { PlaceProvider, PlaceSearchInput } from '../providers/travel.js';
import type { ModelMessage } from '../providers/model.js';

/** A task may reuse provider-verified coordinates; explicit detail reads still refresh. */
export class PersonalAgentPlaces {
  private readonly known = new Map<string, DemoPlace>();

  constructor(private readonly provider: PlaceProvider, private readonly now: () => string) {}

  private remember(place: DemoPlace): void {
    if (place?.placeId && place.name) this.known.set(place.placeId, structuredClone(place));
  }

  async search(input: PlaceSearchInput) {
    const result = await this.provider.search(input);
    result.places.forEach(place => this.remember(place));
    return { ...result, readAt: this.now() };
  }

  async detail(id: string) {
    const place = await this.provider.detail(id);
    if (place) this.remember(place);
    else this.known.delete(id);
    return place;
  }

  async resolve(id: string) {
    const known = this.known.get(id);
    return known ? structuredClone(known) : this.detail(id);
  }

  /** Restore only recent successful provider receipts belonging to this exact task. */
  restore(messages: ModelMessage[]): void {
    for (const message of messages) {
      if (message.role !== 'tool' || !['places.search', 'places.nearby'].includes(message.toolName || '')) continue;
      try {
        const receipt = JSON.parse(message.content || '{}');
        const age = Date.parse(this.now()) - Date.parse(receipt.result?.readAt);
        if (receipt.ok && age >= 0 && age <= 300_000 && Array.isArray(receipt.result?.places)) {
          receipt.result.places.forEach((place: DemoPlace) => this.remember(place));
        }
      } catch { /* Old or incomplete checkpoints require a fresh provider read. */ }
    }
  }
}
