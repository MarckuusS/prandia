/**
 * Le tableau des apports et la carte de cout, pour une portee quelconque.
 *
 * Ils vivaient dans le bloc du jour, avec une colonne "Semaine" en plus. Cette
 * colonne obligeait a OUVRIR UN JOUR pour lire un total de semaine, et
 * melangeait deux portees dans un meme tableau : on comparait sans le vouloir
 * une journee a sept.
 *
 * Chaque ecran porte donc les siens. Le TABLEAU lui-meme a depuis demenage
 * dans `components/TableauNutriments.tsx`, le jour ou la fiche de recette en a
 * eu besoin : cette carte n'est plus qu'un titre autour de lui. Sans ce
 * partage, le format des nombres, le seuil des traces et la regle des parts
 * d'energie auraient fini par diverger d'un ecran a l'autre.
 */

import { formatEuros } from "@prandia/shared";
import type { NutritionTotal } from "@prandia/shared";

import { TableauNutriments } from "../../components/TableauNutriments.js";
import { MacrosRing } from "../../components/MacrosDonut.js";
import { Icon } from "../../icons/index.js";
import { type CostTotal } from "./totals.js";

/**
 * L'anneau PUIS le tableau, dans la meme carte.
 *
 * L'ordre est une regle du projet : la figure montre, le tableau chiffre ce
 * qu'elle montre, et la colonne "Part" du tableau lit exactement la base des
 * arcs. L'ecran du jour posait l'anneau dans une carte SEPAREE et EN DESSOUS
 * du tableau, avec la carte d'objectif entre les deux : la lecture etait
 * inversee et les deux figures ne se rencontraient jamais.
 *
 * `anneau` est OPTIONNEL parce que l'ecran de la semaine affiche ce meme
 * tableau sans anneau. Lui en ajouter un serait une decision d'ecran, pas une
 * consequence de ce correctif.
 */
export function TableauApports({
  titre,
  total,
  entryCount,
  anneau,
}: {
  readonly titre: string;
  readonly total: NutritionTotal;
  /** Zero fait afficher "—" plutot que des zeros, qui passeraient pour mesures. */
  readonly entryCount: number;
  /** Legende sous le nombre central, par exemple « kcal ce jour ». */
  readonly anneau?: string | undefined;
}) {
  return (
    <div className="card">
      <h3 className="card__title">{titre}</h3>
      {anneau !== undefined && entryCount > 0 && (
        <MacrosRing total={total} centerCaption={anneau} />
      )}
      <TableauNutriments total={total} vide={entryCount === 0} />
    </div>
  );
}

export function CarteCout({
  titre,
  cout,
  portee,
}: {
  readonly titre: string;
  readonly cout: CostTotal;
  /** Ce dont on parle dans les avertissements : "de ce jour", "de la semaine". */
  readonly portee: string;
}) {
  return (
    <div className="card">
      <div className="card-entete">
        <h3 className="card__title card-entete__titre">{titre}</h3>
        <span className="card-entete__valeur">{formatEuros(cout.total)}</span>
      </div>

      {/* Un total sous-estime qui ne le dit pas est pire qu'une absence de
          total : on batit un budget dessus. */}
      {cout.missingLines > 0 && (
        <p className="note">
          <Icon name="ui-alert" size={14} className="icon--inline" />{" "}
          {cout.missingLines === 1
            ? `Un ingrédient ${portee} n’a pas de prix`
            : `${cout.missingLines} ingrédients ${portee} n’ont pas de prix`}{" "}
          : le total ci-dessus est <strong>sous-estimé</strong>.
        </p>
      )}

      {cout.orphanCount > 0 && (
        <p className="note">
          <Icon name="ui-alert" size={14} className="icon--inline" />{" "}
          {cout.orphanCount === 1
            ? "Un repas pointe vers une recette ou un ingrédient supprimé"
            : `${cout.orphanCount} repas pointent vers une recette ou un ingrédient supprimé`}{" "}
          : rien n’a pu être chiffré pour{" "}
          {cout.orphanCount === 1 ? "lui" : "eux"}.
        </p>
      )}
    </div>
  );
}
