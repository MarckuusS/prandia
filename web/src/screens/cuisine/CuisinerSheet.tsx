/**
 * "Je la cuisine" : la recette telle qu'on la fait VRAIMENT (decision du
 * 2026-10-14, shared/src/preparation.ts).
 *
 * La feuille part de la recette, ramenee au nombre de parts qu'on cuisine, et
 * l'on corrige ce qui differe : une autre creme, la sauce tomate faute de
 * pelees, une gousse d'ail de plus. LA RECETTE NE BOUGE PAS : ce qui est
 * enregistre est un PLAT, une fiche maison aux apports figes pour 100 g, qui
 * entre au frigo ; les ingredients utilises en sortent. Lancee depuis un repas
 * du planning, la feuille demande aussi la part de ce repas, qui devient une
 * part du plat.
 *
 * Le poids du plat cuit est ESTIME (le rendement de chaque ligne) tant qu'on
 * ne le corrige pas : peser la casserole donne mieux, l'eau qui s'evapore
 * n'est dans aucune fiche. Les parts DIMENSIONNENT la recette : "pour 6" au
 * lieu de 4 multiplie chaque ligne, comme on le ferait de tete.
 */

import { useMemo, useState } from 'react'
import {
  addDaysIso,
  apportsDuPlat,
  formatGrams,
  nomDuPlat,
  PIECE_UNIT_CODE,
  PLAT_A_FINIR_JOURS,
  poidsCuitEstime,
  todayLocalIsoDate,
  type Ingredient,
  type Recipe,
} from '@prandia/shared'

import { ChoixBibliotheque } from '../../components/ChoixBibliotheque.js'
import { DatePeremption } from '../../components/DatePeremption.js'
import { NumberField } from '../../components/Field.js'
import { QuantityField } from '../../components/QuantityField.js'
import { Sheet } from '../../components/Sheet.js'
import { Icon, RayonIcon } from '../../icons/index.js'
import { usePantry, useCuisiner, useRecipe, type PlatCuisine } from '../../lib/queries.js'
import { useRayonStyle } from '../../lib/useRayonStyle.js'
import { replaceIngredient, type DraftLine } from '../recettes/draft.js'
import '../../styles/recipes.css'
import '../../styles/cuisiner.css'

export interface CuisinerSheetProps {
  readonly recipeId: number
  /** Le repas du planning qui lance la cuisson : il devient une part du plat. */
  readonly entry?: { readonly id: number; readonly portions: number | null } | undefined
  readonly onClose: () => void
  readonly onCuisine: (plat: PlatCuisine, nom: string) => void
}

export function CuisinerSheet({ recipeId, entry, onClose, onCuisine }: CuisinerSheetProps) {
  const recette = useRecipe(recipeId)
  if (recette.data === undefined) {
    return (
      <Sheet open onClose={onClose} title="Je la cuisine" variant="plein">
        <p className="card__lead">{recette.isError ? recette.error.message : 'Chargement de la recette…'}</p>
      </Sheet>
    )
  }
  return <Cuisine recette={recette.data} entry={entry} onClose={onClose} onCuisine={onCuisine} />
}

/** Ce que la cuisson a fait, en une phrase : le plat au frigo, ce qui en est sorti. */
export function messageCuisson(nom: string, sortis: number): string {
  if (sortis === 0) return `${nom} est au frigo.`
  return `${nom} est au frigo. ${sortis === 1 ? 'Un ingrédient en est sorti.' : `${sortis} ingrédients en sont sortis.`}`
}

/** Un nombre a lire, a la francaise : "12,2". */
const decimal = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })
const arrondi = (v: number) => Math.round(v * 100) / 100
const positif = (v: number | null): v is number => v !== null && v > 0

function Cuisine({
  recette,
  entry,
  onClose,
  onCuisine,
}: {
  readonly recette: Recipe
  readonly entry: CuisinerSheetProps['entry']
  readonly onClose: () => void
  readonly onCuisine: CuisinerSheetProps['onCuisine']
}) {
  const aujourdhui = todayLocalIsoDate()
  const cuisiner = useCuisiner()
  const pantry = usePantry()
  const styleOf = useRayonStyle()

  const [parts, setParts] = useState<number | null>(Math.max(recette.defaultPortions, 1))
  const [lignes, setLignes] = useState<DraftLine[]>(() =>
    recette.lines.map((l, i) => ({
      key: `l${i}`,
      ingredient: l.ingredient,
      quantityG: l.quantityG,
      unit: l.unit,
      notes: null,
      ordinal: i,
    })),
  )
  /** `null` : le poids suit l'estimation ; saisi (pese), il ne bouge plus. */
  const [poidsPese, setPoidsPese] = useState<number | null>(null)
  const [finirAvant, setFinirAvant] = useState<string | null>(addDaysIso(aujourdhui, PLAT_A_FINIR_JOURS))
  /** `null` : la part suit les portions prevues au planning. */
  const [maPart, setMaPart] = useState<number | null>(null)
  const [maPartUnite, setMaPartUnite] = useState<string | null>(PIECE_UNIT_CODE)
  const [remplacee, setRemplacee] = useState<string | null>(null)
  const [ajout, setAjout] = useState(false)
  const [erreur, setErreur] = useState<string | null>(null)

  const valides = lignes.filter((l): l is DraftLine & { quantityG: number } => positif(l.quantityG))
  const estime = poidsCuitEstime(valides)
  const poids = poidsPese ?? estime
  const partG = positif(parts) && poids > 0 ? poids / parts : null
  const maPartG =
    entry === undefined
      ? null
      : (maPart ?? (partG === null ? null : Math.min(entry.portions ?? 1, parts ?? 1) * partG))
  const { pour100g, inconnues } = apportsDuPlat(valides, poids)
  const nom = nomDuPlat(recette.name, aujourdhui)

  /** Ce que le frigo contient de chaque produit, tous lots confondus. */
  const auFrigo = useMemo(() => {
    const totaux = new Map<number, number>()
    for (const lot of pantry.data?.items ?? []) totaux.set(lot.ingredientId, (totaux.get(lot.ingredientId) ?? 0) + lot.quantityG)
    return totaux
  }, [pantry.data])

  /** Cuisiner pour plus ou moins de parts : chaque ligne suit, comme de tete. */
  const changerParts = (suivant: number | null) => {
    if (positif(parts) && positif(suivant) && suivant !== parts) {
      const facteur = suivant / parts
      setLignes((avant) => avant.map((l) => (l.quantityG === null ? l : { ...l, quantityG: l.quantityG * facteur })))
    }
    setParts(suivant)
  }

  const changerLigne = (key: string, suite: Partial<DraftLine>) =>
    setLignes((avant) => avant.map((l) => (l.key === key ? { ...l, ...suite } : l)))
  const ligneRemplacee = lignes.find((l) => l.key === remplacee)
  const pris = new Set(lignes.map((l) => l.ingredient.id).filter((id): id is number => id !== null))

  const ajouter = (ingredient: Ingredient) => {
    if (ingredient.id === null || pris.has(ingredient.id)) return
    setLignes((avant) => [
      ...avant,
      { key: `a${Date.now().toString(36)}`, ingredient, quantityG: null, unit: null, notes: null, ordinal: avant.length },
    ])
  }

  const envoyer = () => {
    setErreur(null)
    const lignesAEnvoyer = valides.filter((l) => l.ingredient.id !== null)
    if (lignesAEnvoyer.length === 0) return setErreur('Le plat n’a aucun ingrédient avec une quantité.')
    if (!(poids > 0)) return setErreur('Indique le poids du plat cuit.')
    if (entry !== undefined && !positif(maPartG)) return setErreur('Indique ta part de ce repas.')
    if (maPartG !== null && maPartG > poids) return setErreur('Ta part dépasse le plat.')
    cuisiner.mutate(
      {
        recipeId: recette.id,
        entryId: entry?.id ?? null,
        name: nom,
        cookedOn: aujourdhui,
        cookedWeightG: Math.round(poids),
        parts: positif(parts) ? parts : null,
        expiryDate: finirAvant,
        myPartG: maPartG === null ? null : arrondi(maPartG),
        lines: lignesAEnvoyer.map((l) => ({ ingredientId: l.ingredient.id as number, quantityG: arrondi(l.quantityG), unit: l.unit })),
      },
      { onSuccess: (plat) => onCuisine(plat, nom) },
    )
  }

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={`Je cuisine : ${recette.name}`}
        variant="plein"
        dismissible={!cuisiner.isPending}
        actions={
          <>
            <button type="button" className="button button--secondary" onClick={onClose} disabled={cuisiner.isPending}>
              Annuler
            </button>
            <button type="button" className="button button--primary" onClick={envoyer} disabled={cuisiner.isPending}>
              {cuisiner.isPending ? 'Enregistrement…' : 'C’est cuit'}
            </button>
          </>
        }
      >
        <div className="form cuisiner">
          <p className="card__lead">
            Corrige ce que tu as vraiment mis. La recette ne change pas : le plat entre au frigo, et ce qui a servi en
            sort.
          </p>

          <NumberField
            label="Pour combien de parts ?"
            value={parts}
            onChange={changerParts}
            min={1}
            decimals={0}
            hint="Les quantités suivent. Tu en mangeras des parts ou des grammes."
          />

          <h3 className="cuisiner__titre">Ce que tu mets dedans</h3>
          <ul className="cuisiner__lignes">
            {lignes.map((l) => {
              const rayon = styleOf(l.ingredient.categoryL1)
              const frigo = l.ingredient.id === null ? undefined : auFrigo.get(l.ingredient.id)
              return (
                <li key={l.key} className="editor-line">
                  <div className="editor-line__head">
                    <span className="editor-line__name">
                      <span className="icon-chip icon-chip--sm" {...rayon.tint} aria-hidden="true">
                        <RayonIcon glyph={rayon.glyph} size={16} strokeWidth={1.8} />
                      </span>
                      <span className="editor-line__libelle">{l.ingredient.name}</span>
                    </span>
                    <div className="editor-line__actions">
                      <button
                        type="button"
                        className="icon-action icon-action--danger"
                        onClick={() => setLignes((avant) => avant.filter((x) => x.key !== l.key))}
                        aria-label={`Retirer ${l.ingredient.name}`}
                      >
                        <Icon name="ui-close" size={16} />
                      </button>
                    </div>
                  </div>
                  <div className="editor-line__quantity">
                    <QuantityField
                      label={`Quantité de ${l.ingredient.name}`}
                      value={l.quantityG}
                      onChange={(quantityG) => changerLigne(l.key, { quantityG })}
                      pieceWeightG={l.ingredient.pieceWeightG}
                      cookedWeightPer100gRaw={l.ingredient.cookedWeightPer100gRaw}
                      spoonWeightG={l.ingredient.spoonWeightG}
                      unit={l.unit}
                      onUnitChange={(unit) => changerLigne(l.key, { unit })}
                    />
                  </div>
                  <div className="editor-line__pied">
                    <span className="cuisiner__frigo">
                      {frigo === undefined ? 'Pas au frigo' : `Au frigo : ${formatGrams(frigo)}`}
                    </span>
                    <button
                      type="button"
                      className="button button--ghost editor-line__remplacer"
                      onClick={() => setRemplacee(l.key)}
                      aria-label={`Remplacer ${l.ingredient.name} par un autre ingrédient`}
                    >
                      <Icon name="ui-swap" size={16} className="icon--inline" /> Remplacer
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
          <button type="button" className="button button--ghost cuisiner__ajouter" onClick={() => setAjout(true)}>
            + Ajouter un ingrédient
          </button>

          <NumberField
            label="Poids du plat cuit"
            value={poids > 0 ? Math.round(poids) : null}
            onChange={(v) => setPoidsPese(v)}
            suffix="g"
            min={1}
            decimals={0}
            hint={
              poidsPese === null
                ? 'Estimé d’après les ingrédients. Pèse la casserole (sans elle) pour être précis.'
                : `Pesé. L’estimation donnait ${formatGrams(estime)}.`
            }
          />

          {entry !== undefined && (
            <QuantityField
              label="Ta part de ce repas"
              value={maPartG}
              onChange={setMaPart}
              pieceWeightG={partG}
              nomPiece="part"
              unit={partG === null ? 'g' : maPartUnite}
              onUnitChange={setMaPartUnite}
              hint="Elle compte dans tes apports. Le reste va au frigo."
            />
          )}

          <DatePeremption
            label="À finir avant le"
            value={finirAvant}
            onChange={setFinirAvant}
            lecture={false}
            hint={`${PLAT_A_FINIR_JOURS} jours proposés, comme des restes.`}
          />

          <div className="card cuisiner__bilan">
            <h3 className="card__title">{nom}</h3>
            <p>
              {formatGrams(Math.round(poids))}
              {partG !== null && `, ${parts} part${(parts ?? 0) > 1 ? 's' : ''} de ${formatGrams(Math.round(partG))}`}
              {maPartG !== null && poids > maPartG && `. Au frigo : ${formatGrams(Math.round(poids - maPartG))}`}.
            </p>
            <p>
              Pour 100 g : {Math.round(pour100g.kcal)} kcal, protéines {decimal(pour100g.proteins)} g, glucides{' '}
              {decimal(pour100g.carbs)} g, lipides {decimal(pour100g.fats)} g.
            </p>
            {inconnues > 0 && (
              <p className="field__hint">
                {inconnues === 1 ? 'Un ingrédient n’a pas de valeurs' : `${inconnues} ingrédients n’ont pas de valeurs`} :
                les apports du plat sont sous-estimés.
              </p>
            )}
          </div>

          {(erreur ?? cuisiner.error?.message) !== undefined && (erreur ?? cuisiner.error?.message) !== null && (
            <p className="text-error" role="alert">
              {erreur ?? cuisiner.error?.message}
            </p>
          )}
        </div>
      </Sheet>

      <Sheet
        open={ligneRemplacee !== undefined}
        onClose={() => setRemplacee(null)}
        title={ligneRemplacee === undefined ? 'Remplacer' : `Remplacer ${ligneRemplacee.ingredient.name}`}
        variant="plein"
        actions={
          <button type="button" className="button button--secondary" onClick={() => setRemplacee(null)}>
            Annuler
          </button>
        }
      >
        <ChoixBibliotheque
          ingredientsPris={pris}
          onIngredient={(ingredient) => {
            if (ligneRemplacee === undefined) return
            if (ingredient.id !== null && pris.has(ingredient.id)) return
            // Garde ce qui se lit : trois cuilleres restent trois cuilleres.
            changerLigne(ligneRemplacee.key, replaceIngredient(ligneRemplacee, ingredient))
            setRemplacee(null)
          }}
        />
      </Sheet>

      <Sheet
        open={ajout}
        onClose={() => setAjout(false)}
        title="Ajouter un ingrédient"
        variant="plein"
        actions={
          <button type="button" className="button button--primary" onClick={() => setAjout(false)}>
            Terminé
          </button>
        }
      >
        <ChoixBibliotheque ingredientsPris={pris} onIngredient={ajouter} />
      </Sheet>
    </>
  )
}
