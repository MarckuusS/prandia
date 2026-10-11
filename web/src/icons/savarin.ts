/**
 * Savarin : la signature de l'IA dans Prandia. Des lunettes rondes et une
 * moustache en guidon, au trait, sur la grille 24 des autres icones.
 *
 * LE TRACE EST ECRIT ICI, UNE FOIS. L'icone fixe (`ui-ia`, paths/overrides.ts)
 * et la version animee (components/Savarin.tsx) le lisent toutes les deux :
 * deux copies auraient fini par ne plus porter la meme moustache.
 *
 * Ce qui a ete regle a l'oeil, et qu'il ne faut pas defaire sans le revoir a
 * 16 px comme a 180 :
 *   - la moustache ne touche JAMAIS les verres : bas des verres a y = 12, haut
 *     des crochets a 14,4, y compris quand elle fremit ;
 *   - elle est PLEINE, seul aplat du dessin avec les pupilles : au trait, ses
 *     deux bords se confondaient des 20 px ;
 *   - deux lobes qui se rejoignent au centre sur un creux, des branches qui
 *     s'affinent, des pointes enroulees en crochet ouvert vers le centre. Un
 *     dessin maison, pas le calque d'une image de banque ;
 *   - la moitie droite est le MIROIR exact de la gauche, calcule (x -> 24 - x)
 *     et non retrace.
 *
 * Aucune couleur litterale : `currentColor` partout, comme le reste du jeu.
 */

/** Les verres, le pont et les branches : du trait seul. */
export const SAVARIN_VERRES =
  '<circle cx="7.3" cy="8.4" r="3.6"/>' +
  '<circle cx="16.7" cy="8.4" r="3.6"/>' +
  '<path d="M10.9 8Q12 7.2 13.1 8"/>' +
  '<path d="M3.7 7.6 2.6 6.1"/>' +
  '<path d="M20.3 7.6 21.4 6.1"/>'

export const SAVARIN_MOUSTACHE_GAUCHE =
  'M12 15.06C11.5 14.5 10.9 14.38 10.45 14.4C9.6 14.45 8.6 15.4 7.6 15.75C7.35 15.85 7.15 15.9 7.04 15.86' +
  'C6.75 15.75 6.6 15.5 6.69 15.3C6.78 15 7 14.8 7.16 14.75C7.35 14.72 7.55 14.8 7.58 14.92' +
  'C7.5 14.6 7.3 14.45 7.04 14.45C6.6 14.45 6.3 14.55 6.1 14.75C5.85 15 5.75 15.3 5.8 15.6' +
  'C5.85 16.1 6.1 16.45 6.5 16.75C7.2 17.25 8.2 17.6 9.27 17.55C10.2 17.5 10.9 17.2 11.4 16.75' +
  'C11.7 16.45 11.9 16.15 12 15.93Z'

export const SAVARIN_MOUSTACHE_DROITE =
  'M12 15.06C12.5 14.5 13.1 14.38 13.55 14.4C14.4 14.45 15.4 15.4 16.4 15.75C16.65 15.85 16.85 15.9 16.96 15.86' +
  'C17.25 15.75 17.4 15.5 17.31 15.3C17.22 15 17 14.8 16.84 14.75C16.65 14.72 16.45 14.8 16.42 14.92' +
  'C16.5 14.6 16.7 14.45 16.96 14.45C17.4 14.45 17.7 14.55 17.9 14.75C18.15 15 18.25 15.3 18.2 15.6' +
  'C18.15 16.1 17.9 16.45 17.5 16.75C16.8 17.25 15.8 17.6 14.73 17.55C13.8 17.5 13.1 17.2 12.6 16.75' +
  'C12.3 16.45 12.1 16.15 12 15.93Z'

/** L'icone fixe, telle que la rend `<Icon name="ui-ia">`. */
export const SAVARIN_FIXE =
  SAVARIN_VERRES +
  `<path fill="currentColor" stroke="none" d="${SAVARIN_MOUSTACHE_GAUCHE}"/>` +
  `<path fill="currentColor" stroke="none" d="${SAVARIN_MOUSTACHE_DROITE}"/>`
