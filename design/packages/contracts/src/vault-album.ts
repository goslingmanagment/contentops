import type { CatalogEntry } from './domain/catalog'

/** The one vault album every life frame goes to (DESIGN §4.5, §9.6). */
export const LIFE_VAULT_ALBUM = 'Lifestyle'

/**
 * Vault album by the norm (DESIGN §4.4, §4.11): «PPV-076 Нейлон и каблуки»; a life object
 * has no album of its own — its frames go to «Lifestyle»; a custom's album is its ID only.
 * An album with an old name on the platform is shown as it stands, not through this.
 */
export function vaultAlbumName(entry: Pick<CatalogEntry, 'id' | 'title' | 'type'>): string {
  switch (entry.type) {
    case 'life':
      return LIFE_VAULT_ALBUM
    case 'custom':
      return entry.id
    default:
      return `${entry.id} ${entry.title}`.trim()
  }
}
