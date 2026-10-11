/**
 * Dessins maison, qui l'emportent sur ceux de Lucide.
 *
 * CE FICHIER N'EST PAS GENERE — c'est tout son interet. `paths/ui.ts` et
 * `paths/rayons.ts` sont reecrits par `scripts/import-lucide.mjs`, donc toute
 * retouche a la main y serait perdue au prochain import. Ce qu'on veut dessiner
 * soi-meme vit ici, et `registry.ts` le fusionne EN DERNIER : la cle qui
 * apparait des deux cotes prend la version maison.
 *
 * L'entree Lucide correspondante est volontairement CONSERVEE dans `MAP`. Elle
 * ne sert plus a rien tant que l'override existe, mais elle redevient le repli
 * le jour ou on retire une ligne d'ici — plutot qu'une icone qui disparait.
 *
 * A n'utiliser que lorsque Lucide ne dit pas la bonne chose. Chaque dessin
 * ajoute ici est un dessin qu'il faudra maintenir seul, ce qui est exactement
 * la raison pour laquelle le jeu maison a ete abandonne.
 *
 * Memes regles que le reste : grille 24, trait seul, aucune couleur litterale
 * (`none` ou `currentColor`), masse dans le carre 3 → 21. Les tests de
 * `resolve.test.ts` parcourent le registre fusionne et s'appliquent donc ici.
 */

import { SAVARIN_FIXE } from '../savarin.js'

export const OVERRIDE_PATHS = {
  /*
   * Savarin, la signature de l'IA : lunettes rondes et moustache en guidon.
   * Remplace l'etincelle de Lucide (`sparkles`), restee en repli dans `MAP`.
   * Le trace vit dans icons/savarin.ts, partage avec la version animee
   * (components/Savarin.tsx). Seule entorse au "trait seul" : la moustache
   * est pleine, en `currentColor`, sans quoi elle se brouillait des 20 px.
   */
  'ui-ia': SAVARIN_FIXE,

  /*
   * Pot de yaourt, opercule souleve.
   *
   * Seul dessin d'OBJET de ce fichier (Savarin est un personnage). La brique de lait qui s'y trouvait a ete
   * retiree : Tabler en a une, mieux dessinee que la mienne, et un dessin qu'on
   * n'a pas a maintenir vaut mieux qu'un dessin qu'on maintient mal.
   *
   * Ni Lucide ni Tabler n'ont de pot a opercule — c'est le seul objet du jeu
   * qu'il a fallu dessiner.
   *
   * TROIS SERIES D'ESSAIS, treize constructions, rendues a 24, 32 et 96 px. Ce
   * qui en ressort, et qui vaut pour tout dessin ajoute ici :
   *
   *   - le pot suit le squelette de `tabler:cup` — bande de bord droite, corps
   *     tronconique large de treize unites, deux traits. Mes premieres versions
   *     etaient etroites et bavardes : quatre traits pour un objet plus petit,
   *     et tout se brouillait des 24 px ;
   *   - l'opercule doit etre AUSSI GRAND que le pot. Toutes les versions ou il
   *     etait un appendice — rabat en pointe, languette, drapeau — se lisaient
   *     comme une feuille de plante ou un fanion ;
   *   - il doit etre PLAT et ANGULAIRE. Une feuille d'aluminium n'a pas de
   *     courbe organique ; la moindre en fait un vegetal.
   */
  'rayon-frais':
    '<path d="M18.4 10.4 17 20.6a1.4 1.4 0 0 1-1.4 1.2H8.4A1.4 1.4 0 0 1 7 20.6L5.6 10.4"/>' +
    '<path d="M4.6 10.4h14.8"/>' +
    '<path d="M6.6 8.4 9.4 2.8l10 2.2-1.6 3.4"/>',
} as const
