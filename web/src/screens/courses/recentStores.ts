/**
 * Les magasins deja frequentes, retenus par le telephone.
 *
 * Ils existent pourtant cote serveur : chaque releve de prix porte son
 * enseigne. Mais AUCUNE route ne les liste aujourd'hui, et en inventer une
 * depasse le cadre de cet ecran — c'est signale dans le rapport. En attendant,
 * le navigateur se souvient de ce qu'on y a tape : c'est le meme telephone qui
 * fait les courses chaque semaine, et taper « Intermarché » au pouce avec un
 * caddie dans l'autre main est exactement ce qu'on cherche a eviter.
 *
 * Consequence assumee : la liste ne suit pas d'un appareil a l'autre et un
 * effacement des donnees du site la vide. C'est un confort de saisie, jamais
 * une donnee — rien ici n'est perdu si tout disparait.
 */

const KEY = 'prandia.courses.stores'

/** Au-dela, la liste de suggestions devient un ecran a elle seule. */
const MAX = 5

/**
 * `localStorage` est indisponible en navigation privee sur d'anciens Safari :
 * la lecture leve au lieu de rendre `null`. Aucune de ces fonctions ne doit
 * pouvoir casser l'ouverture d'une session pour si peu.
 */
export function readRecentStores(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string' && value !== '')
  } catch {
    return []
  }
}

/** Le magasin le plus recent passe en tete : c'est presque toujours le suivant. */
export function rememberStore(store: string): void {
  const name = store.trim()
  if (name === '') return

  // Comparaison insensible a la casse et aux accents : « lidl » et « Lidl »
  // sont le meme magasin, et deux entrees pour un seul rayon de suggestions
  // en gaspillent la moitie.
  const collator = new Intl.Collator('fr', { sensitivity: 'base' })
  const kept = readRecentStores().filter((known) => collator.compare(known, name) !== 0)

  try {
    window.localStorage.setItem(KEY, JSON.stringify([name, ...kept].slice(0, MAX)))
  } catch {
    /* Quota plein ou stockage refuse : on se passe de memoire, pas de session. */
  }
}
