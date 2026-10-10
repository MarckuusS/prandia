/**
 * Ajouter un repas a un creneau — portage d'AddCalendarEntryDialog.qml.
 *
 * Le desktop ouvrait une vraie fenetre systeme, detachable. Ici c'est une
 * feuille modale : sur un telephone il n'y a qu'un ecran, et le contexte
 * (« Mercredi · midi ») doit donc etre rappele dans le titre.
 *
 * Quatre ecarts, tous voulus :
 *
 *   1. Le bouton « Ajouter » n'existe qu'une fois le repas choisi. Le desktop,
 *      lui, fermait la fenetre sans rien creer et sans un mot — vecu comme une
 *      panne.
 *
 *   2. Le titre nomme les cinq creneaux. Celui du desktop n'en connaissait que
 *      trois et annoncait « Ajouter au soir » pour un en-cas de 10 h.
 *
 *   3. La quantite par defaut d'un ingredient est UNE PIECE quand l'ingredient
 *      en a une (un oeuf, un oignon), 100 g sinon. Le desktop proposait 80 g
 *      dans son dialogue et 1 piece / 100 g au glisser-deposer : deux regles
 *      pour la meme action, on garde la plus proche de la facon de penser.
 *
 *   4. DEUX TEMPS, en plein ecran : choisir parmi la bibliotheque entiere en
 *      tuiles (`ChoixBibliotheque`), puis doser. Le choix se faisait dans un menu
 *      deroulant pour les recettes et dans une liste ecrasee par le clavier
 *      pour les ingredients.
 */

import { useState } from 'react'
import { Link } from 'react-router'
import {
  DAY_LABELS,
  MEAL_SLOT_LABELS,
  formatGrams,
  photoPath,
  type Ingredient,
  type MealSlot,
} from '@prandia/shared'

import { ChoixBibliotheque } from '../../components/ChoixBibliotheque.js'
import { QuantityField } from '../../components/QuantityField.js'
import { Sheet } from '../../components/Sheet.js'
import { Icon, RayonIcon } from '../../icons/index.js'
import { useAddEntry, useRecipe, type EntryDraft, type RecipeSummary } from '../../lib/queries.js'
import { useRayonStyle } from '../../lib/useRayonStyle.js'
import { PortionsOuGrammes } from './PortionsOuGrammes.js'
import '../../styles/week.css'

/** Quantite proposee pour un ingredient sans poids unitaire connu. */
const DEFAULT_QUANTITY_G = 100

export interface AddEntrySheetProps {
  readonly isoWeek: string
  readonly dayOfWeek: number
  readonly slot: MealSlot
  readonly onClose: () => void
}

type Choix =
  | { readonly type: 'recette'; readonly recette: RecipeSummary }
  | { readonly type: 'ingredient'; readonly ingredient: Ingredient }

export function AddEntrySheet({ isoWeek, dayOfWeek, slot, onClose }: AddEntrySheetProps) {
  const [choix, setChoix] = useState<Choix | null>(null)

  // Une entree recette porte des PORTIONS et jamais de grammes ; une entree
  // ingredient l'inverse. Chaque choix repart de ses propres valeurs.
  const [portions, setPortions] = useState<number | null>(1)
  const [quantityG, setQuantityG] = useState<number | null>(DEFAULT_QUANTITY_G)
  /** Unite d'affichage retenue, enregistree avec l'entree. Voir migration 0011. */
  const [unit, setUnit] = useState<string | null>(null)

  const add = useAddEntry(isoWeek)
  // La recette COMPLETE, pour son poids cuit : le resume du choix n'a que les
  // identifiants des ingredients, pas leur rendement a la cuisson.
  const recetteComplete = useRecipe(choix?.type === 'recette' ? choix.recette.id : null)

  const valid =
    choix?.type === 'recette'
      ? portions !== null && portions > 0
      : choix?.type === 'ingredient'
        ? choix.ingredient.id !== null && quantityG !== null && quantityG > 0
        : false

  const submit = () => {
    if (!valid || choix === null) return
    const draft: EntryDraft =
      choix.type === 'recette'
        ? { dayOfWeek, slot, recipeId: choix.recette.id, ingredientId: null, quantityG: null, portions, unit }
        : {
            dayOfWeek,
            slot,
            recipeId: null,
            ingredientId: choix.ingredient.id,
            quantityG,
            portions: null,
            unit,
          }
    add.mutate(draft, { onSuccess: onClose })
  }

  const title = `${DAY_LABELS[dayOfWeek] ?? 'Jour'} · ${MEAL_SLOT_LABELS[slot].toLowerCase()}`

  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      variant="plein"
      dismissible={!add.isPending}
      actions={
        choix === null ? undefined : (
          <>
            <button
              type="button"
              className="button button--secondary"
              onClick={onClose}
              disabled={add.isPending}
            >
              Annuler
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={submit}
              disabled={!valid || add.isPending}
            >
              {add.isPending ? 'Ajout…' : 'Ajouter'}
            </button>
          </>
        )
      }
    >
      {choix === null ? (
        <ChoixBibliotheque
          onRecette={(recette) => {
            setPortions(1)
            setUnit(null)
            setChoix({ type: 'recette', recette })
          }}
          onIngredient={(ingredient) => {
            setQuantityG(ingredient.pieceWeightG ?? DEFAULT_QUANTITY_G)
            // La piece d'un oeuf n'a aucun sens pour un litre de lait : on
            // repart de l'heuristique du champ.
            setUnit(null)
            setChoix({ type: 'ingredient', ingredient })
          }}
        />
      ) : (
        <div className="form">
          <Retenu choix={choix} onChanger={() => setChoix(null)} disabled={add.isPending} />

          {choix.type === 'recette' ? (
            <>
              <PortionsOuGrammes
                recipe={recetteComplete.data}
                defaultPortions={choix.recette.defaultPortions}
                portions={portions}
                onPortions={setPortions}
                unit={unit}
                onUnit={setUnit}
                disabled={add.isPending}
              />
              <VersLaFiche to={`/recettes/${choix.recette.id}`} libelle="Ouvrir la recette" />
            </>
          ) : (
            <>
              <QuantityField
                // Remonte le champ a zero quand on change d'ingredient : l'unite
                // « pièce » d'un oeuf n'a aucun sens pour un litre de lait.
                key={choix.ingredient.id ?? choix.ingredient.name}
                label="Quantité"
                value={quantityG}
                onChange={setQuantityG}
                pieceWeightG={choix.ingredient.pieceWeightG}
                cookedWeightPer100gRaw={choix.ingredient.cookedWeightPer100gRaw}
                unit={unit}
                onUnitChange={setUnit}
                required
              />
              {choix.ingredient.id !== null && (
                <VersLaFiche
                  to={`/ingredients/${choix.ingredient.id}`}
                  libelle="Ouvrir la fiche ingrédient"
                />
              )}
            </>
          )}

          {add.isError && (
            <p className="text-error" role="alert">
              {add.error.message}
            </p>
          )}
        </div>
      )}
    </Sheet>
  )
}

// ---------------------------------------------------------------------------

/**
 * Ce qui a ete choisi, en tete du second temps, avec de quoi revenir au choix.
 *
 * Le meme visuel que la tuile : on doit reconnaitre d'un coup d'oeil ce qu'on
 * vient de toucher, pas relire un nom.
 */
function Retenu({
  choix,
  onChanger,
  disabled,
}: {
  readonly choix: Choix
  readonly onChanger: () => void
  readonly disabled: boolean
}) {
  const styleOf = useRayonStyle()
  const [echecPhoto, setEchecPhoto] = useState(false)

  let visuel
  let nom: string
  let meta: string
  if (choix.type === 'recette') {
    const { recette } = choix
    nom = recette.name
    const kcal = recette.nutrition.kcal / Math.max(recette.defaultPortions, 1)
    meta = kcal > 0 ? `${Math.round(kcal)} kcal / portion` : 'Sans ingrédient'
    visuel =
      recette.imageKey === null || echecPhoto ? (
        <span className="retenu__visuel" data-rayon="autre" aria-hidden="true">
          <Icon name="ui-utensils" size={24} strokeWidth={1.6} />
        </span>
      ) : (
        <img
          className="retenu__visuel retenu__photo"
          src={photoPath(recette.id, recette.imageKey, 'thumb')}
          alt=""
          decoding="async"
          onError={() => setEchecPhoto(true)}
        />
      )
  } else {
    const { ingredient } = choix
    const rayon = styleOf(ingredient.categoryL1)
    nom = ingredient.name
    meta = [
      ingredient.kcal !== null ? `${Math.round(ingredient.kcal)} kcal / 100 g` : null,
      ingredient.pieceWeightG !== null ? `1 pièce = ${formatGrams(ingredient.pieceWeightG)}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
    visuel = (
      <span className="retenu__visuel" {...rayon.tint} aria-hidden="true">
        <RayonIcon glyph={rayon.glyph} size={26} strokeWidth={1.6} />
      </span>
    )
  }

  return (
    <div className="retenu">
      {visuel}
      <span className="retenu__corps">
        <span className="retenu__nom">{nom}</span>
        {meta !== '' && <span className="retenu__meta">{meta}</span>}
      </span>
      <button
        type="button"
        className="button button--secondary retenu__changer"
        onClick={onChanger}
        disabled={disabled}
      >
        Changer
      </button>
    </div>
  )
}

/**
 * Le lien vers la fiche de ce qu'on vient de choisir.
 *
 * On decouvre au moment d'ajouter que le poids d'une piece est faux, ou qu'il
 * manque une macro : la correction se faisait en abandonnant l'ajout, en
 * cherchant la fiche dans la bibliotheque, puis en revenant. Le meme bouton
 * existe deja sur la feuille d'un repas DEJA planifie ; il manquait a celle qui
 * le cree.
 *
 * IL QUITTE LA FEUILLE, et le dit. Ouvrir la fiche est une navigation, pas une
 * sous-fenetre : le choix en cours n'est pas conserve. Le taire ferait passer
 * une consequence connue pour une perte inexpliquee — d'autant qu'on revient
 * souvent d'avoir corrige le poids unitaire, celui-la meme qui donne la
 * quantite proposee au moment de rechoisir.
 */
function VersLaFiche({ to, libelle }: { readonly to: string; readonly libelle: string }) {
  return (
    <>
      <Link to={to} className="button button--secondary button--block lien-surface">
        <Icon name="ui-edit" size={16} className="icon--inline" /> {libelle}
      </Link>
      <p className="field__hint">L’ajout en cours n’est pas conservé.</p>
    </>
  )
}
