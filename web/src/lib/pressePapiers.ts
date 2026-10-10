/**
 * Le lien d'une recette dans le presse-papiers.
 *
 * A APPELER DEPUIS UN TOUCHER : iOS ne laisse lire le presse-papiers qu'en
 * reponse a un geste, et affiche alors une bulle "Coller" a confirmer. Un refus,
 * un presse-papiers vide ou un texte sans lien rendent `null`, sans erreur :
 * l'ecran propose alors le champ a remplir a la main.
 */

import { lienRecette } from '@prandia/shared'

export async function lienDuPressePapiers(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText === undefined) return null
    return lienRecette(await navigator.clipboard.readText())
  } catch {
    return null
  }
}
