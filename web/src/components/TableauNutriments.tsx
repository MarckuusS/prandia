/**
 * Le tableau des huit nutriments : une quantite, une part.
 *
 * C'EST LA FORME UNIQUE DU PROJET, et elle a ete tranchee une fois pour
 * toutes sur l'ecran du jour. Trois regles en decoulent, et les trois comptent
 * autant l'une que l'autre :
 *
 *   1. LE GRAPHIQUE N'A PAS DE LEGENDE. L'anneau, la tri-barre : ils dessinent,
 *      ils ne nomment pas. Poser sous eux quatre pastilles colorees redirait ce
 *      que la colonne « Part » dit deja, et l'oeil lirait deux fois la meme
 *      chose sans savoir laquelle fait foi. La regle est desormais tenue par le
 *      TYPE : `MacrosDonut` n'a plus de reglage de legende, donc plus de facon
 *      d'en remettre une par omission, ce qui est exactement ainsi qu'elle
 *      revenait sur l'editeur de recette.
 *
 *   2. LA COLONNE « PART » EST EN MASSE, comme les arcs. Elle etait une part
 *      d'energie ; le changement de base a ete demande et il porte sur les
 *      deux, jamais sur un seul. Un anneau en grammes surmontant une colonne en
 *      calories annoncerait deux nombres pour la meme chose, a trois
 *      centimetres d'ecart. Voir `massShare` et `massBreakdown`.
 *
 *   3. DEUX COLONNES SEPAREES, jamais fondues. « 162 g · 35 % » sur une seule
 *      ligne se lit comme un seul nombre : les grammes et la part ont chacun
 *      leur colonne, alignees en chasse tabulaire.
 *
 *   4. LES SOUS-LIGNES N'ONT PAS DE PART. Sucres et acides gras satures sont
 *      deja comptes dans leur famille ; leur en donner une ferait une colonne
 *      qui ne totalise pas 100. Le sel non plus, il n'appartient a aucune des
 *      quatre familles, et l'energie encore moins : elle EST le total.
 *
 * Le composant vivait sous `screens/semaine/`, ou l'ecran du jour l'avait vu
 * naitre. Il est remonte ici le jour ou la fiche de recette en a eu besoin :
 * un troisieme ecran qui l'aurait recopie aurait fini par diverger sur le
 * format des nombres, le seuil des traces ou la regle des parts.
 */

import type { NutritionTotal } from '@prandia/shared'

import { NutrientLabel } from './NutrientLabel.js'
import { NUTRIENT_ROWS, massShare, formatNutrient } from '../screens/semaine/totals.js'

export function TableauNutriments({
  total,
  vide = false,
}: {
  readonly total: NutritionTotal
  /**
   * Rien a totaliser : les valeurs s'affichent « — » plutot que « 0 g ».
   * Un zero se lit comme une mesure, l'absence de mesure n'en est pas une.
   */
  readonly vide?: boolean
}) {
  return (
    <div className="table-scroll">
      <table className="nutrition-table">
        <thead>
          <tr>
            <th scope="col">Nutriment</th>
            <th scope="col">Quantité</th>
            <th scope="col">Part</th>
          </tr>
        </thead>
        <tbody>
          {NUTRIENT_ROWS.map((row) => (
            <tr key={row.key}>
              <th scope="row" className={row.sub ? 'unit' : undefined}>
                <NutrientLabel nutrient={row.key} label={row.label} sub={row.sub ?? false} />
              </th>
              <td>{formatNutrient(vide ? 0 : 1, total[row.key], row)}</td>
              <td className="nutrition-table__part">{vide ? null : massShare(total, row.key)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
