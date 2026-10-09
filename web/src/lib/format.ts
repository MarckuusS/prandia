/**
 * Formatage d'affichage propre au front.
 *
 * Ce qui touche au DOMAINE (euros, masses, unites) vit dans @prandia/shared et
 * doit y rester : le Worker s'en sert aussi. Ici on ne garde que ce qui n'a de
 * sens qu'a l'ecran.
 *
 * `formatNumber` vivait dans `screens/recettes/draft.ts`. L'anneau de macros
 * etant devenu un composant partage, il aurait fallu qu'un fichier de
 * `components/` importe depuis un dossier d'ecran, ce qui inverse la
 * dependance. `draft.ts` le reexporte, donc aucun appelant n'a bouge.
 */

/** Nombre francais a `decimals` decimales. `—` quand la valeur est inconnue. */
export function formatNumber(value: number | null, decimals: number): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('fr-FR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}
