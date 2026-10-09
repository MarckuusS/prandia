/**
 * Ajouter un repas a un creneau — portage d'AddCalendarEntryDialog.qml.
 *
 * Le desktop ouvrait une vraie fenetre systeme, detachable. Ici c'est une
 * feuille modale : sur un telephone il n'y a qu'un ecran, et le contexte
 * (« Mercredi · midi ») doit donc etre rappele dans le titre.
 *
 * Trois ecarts, tous voulus :
 *
 *   1. Le bouton « Ajouter » est DESACTIVE tant que rien n'est choisi. Le
 *      desktop, lui, fermait la fenetre sans rien creer et sans un mot — vecu
 *      comme une panne.
 *
 *   2. Le titre nomme les cinq creneaux. Celui du desktop n'en connaissait que
 *      trois et annoncait « Ajouter au soir » pour un en-cas de 10 h.
 *
 *   3. La quantite par defaut d'un ingredient est UNE PIECE quand l'ingredient
 *      en a une (un oeuf, un oignon), 100 g sinon. Le desktop proposait 80 g
 *      dans son dialogue et 1 piece / 100 g au glisser-deposer : deux regles
 *      pour la meme action, on garde la plus proche de la facon de penser.
 */

import { useMemo, useState, type ReactNode } from 'react'
import {
  DAY_LABELS,
  MEAL_SLOT_LABELS,
  normalizeName,
  type Ingredient,
  type MealSlot,
} from '@prandia/shared'

import { NumberField, SelectField, TextField } from '../../components/Field.js'
import { Link } from 'react-router'

import { IngredientPicker } from '../../components/IngredientPicker.js'
import { QuantityField } from '../../components/QuantityField.js'
import { Sheet } from '../../components/Sheet.js'
import { Icon } from '../../icons/index.js'
import { useAddEntry, useRecipes, type EntryDraft } from '../../lib/queries.js'
import '../../styles/week.css'

/** Quantite proposee pour un ingredient sans poids unitaire connu. */
const DEFAULT_QUANTITY_G = 100

export interface AddEntrySheetProps {
  readonly isoWeek: string
  readonly dayOfWeek: number
  readonly slot: MealSlot
  readonly onClose: () => void
}

type Tab = 'recipe' | 'ingredient'

export function AddEntrySheet({ isoWeek, dayOfWeek, slot, onClose }: AddEntrySheetProps) {
  const [tab, setTab] = useState<Tab>('recipe')

  // Une entree recette porte des PORTIONS et jamais de grammes ; une entree
  // ingredient l'inverse. Les deux etats sont tenus separement pour qu'un
  // aller-retour entre les onglets ne melange jamais les deux.
  const [recipeId, setRecipeId] = useState<number | null>(null)
  const [portions, setPortions] = useState<number | null>(1)
  const [ingredient, setIngredient] = useState<Ingredient | null>(null)
  const [quantityG, setQuantityG] = useState<number | null>(DEFAULT_QUANTITY_G)
  /** Unite d'affichage retenue, enregistree avec l'entree. Voir migration 0011. */
  const [unit, setUnit] = useState<string | null>(null)

  const add = useAddEntry(isoWeek)

  const valid =
    tab === 'recipe'
      ? recipeId !== null && portions !== null && portions > 0
      : ingredient?.id != null && quantityG !== null && quantityG > 0

  const submit = () => {
    if (!valid) return
    const draft: EntryDraft =
      tab === 'recipe'
        ? { dayOfWeek, slot, recipeId, ingredientId: null, quantityG: null, portions }
        : {
            dayOfWeek,
            slot,
            recipeId: null,
            ingredientId: ingredient?.id ?? null,
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
      dismissible={!add.isPending}
      actions={
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
      }
    >
      <div className="segmented" role="tablist" aria-label="Type de repas">
        <SegmentedTab id="tab-recipe" panelId="panel-recipe" active={tab === 'recipe'} onSelect={() => setTab('recipe')}>
          <Icon name="ui-utensils" size={16} className="icon--inline" /> Recette
        </SegmentedTab>
        <SegmentedTab id="tab-ingredient" panelId="panel-ingredient" active={tab === 'ingredient'} onSelect={() => setTab('ingredient')}>
          <Icon name="ui-basket" size={16} className="icon--inline" /> Ingrédient
        </SegmentedTab>
      </div>

      {tab === 'recipe' ? (
        <div className="form" id="panel-recipe" role="tabpanel" aria-labelledby="tab-recipe">
          <RecipeChoice
            recipeId={recipeId}
            onChange={setRecipeId}
            portions={portions}
            onPortionsChange={setPortions}
          />
          {recipeId !== null && (
            <VersLaFiche to={`/recettes/${recipeId}`} libelle="Ouvrir la recette" />
          )}
        </div>
      ) : (
        <div className="form" id="panel-ingredient" role="tabpanel" aria-labelledby="tab-ingredient">
          {ingredient === null ? (
            <IngredientPicker
              autoFocus
              label="Ingrédient"
              hint="Seule ta bibliothèque personnelle est proposée."
              onPick={(picked) => {
                setIngredient(picked)
                setQuantityG(picked.pieceWeightG ?? DEFAULT_QUANTITY_G)
                // La piece d'un oeuf n'a aucun sens pour un litre de lait :
                // on repart de l'heuristique du champ.
                setUnit(null)
              }}
            />
          ) : (
            <>
              <div className="picked">
                <span className="picked__name">{ingredient.name}</span>
                <button
                  type="button"
                  className="picked__clear"
                  onClick={() => setIngredient(null)}
                  aria-label={`Choisir un autre ingrédient que ${ingredient.name}`}
                >
                  <Icon name="ui-close" size={16} />
                </button>
              </div>
              <QuantityField
                // Remonte le champ a zero quand on change d'ingredient : l'unite
                // « pièce » d'un oeuf n'a aucun sens pour un litre de lait.
                key={ingredient.id ?? ingredient.name}
                label="Quantité"
                value={quantityG}
                onChange={setQuantityG}
                pieceWeightG={ingredient.pieceWeightG}
                unit={unit}
                onUnitChange={setUnit}
                required
              />
              {ingredient.id !== null && (
                <VersLaFiche to={`/ingredients/${ingredient.id}`} libelle="Ouvrir la fiche ingrédient" />
              )}
            </>
          )}
        </div>
      )}

      {add.isError && (
        <p className="text-error" role="alert">
          {add.error.message}
        </p>
      )}
    </Sheet>
  )
}

// ---------------------------------------------------------------------------

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

function SegmentedTab({
  id,
  panelId,
  active,
  onSelect,
  children,
}: {
  id: string
  panelId: string
  active: boolean
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      id={id}
      role="tab"
      aria-selected={active}
      aria-controls={panelId}
      className={`segmented__tab${active ? ' segmented__tab--active' : ''}`}
      onClick={onSelect}
    >
      {children}
    </button>
  )
}

/**
 * Choix de la recette.
 *
 * Le desktop lisait le modele de la page Recettes, filtre compris : choisir
 * dans le calendrier dependait d'une recherche faite ailleurs. Ici la liste
 * vient de l'API et se filtre sur place.
 */
function RecipeChoice({
  recipeId,
  onChange,
  portions,
  onPortionsChange,
}: {
  recipeId: number | null
  onChange: (id: number | null) => void
  portions: number | null
  onPortionsChange: (portions: number | null) => void
}) {
  const [filter, setFilter] = useState('')
  const recipes = useRecipes()

  const items = recipes.data?.items ?? []
  const matches = useMemo(() => {
    const needle = normalizeName(filter)
    if (!needle) return items
    return items.filter((recipe) => normalizeName(recipe.name).includes(needle))
  }, [items, filter])

  const selected = items.find((recipe) => recipe.id === recipeId)

  return (
    <>
      {/* Le filtre ne s'affiche qu'a partir du moment ou derouler la liste
          devient penible au pouce. */}
      {items.length > 8 && (
        <TextField
          label="Filtrer les recettes"
          value={filter}
          onChange={setFilter}
          type="search"
          placeholder="Nom de la recette…"
          enterKeyHint="search"
        />
      )}

      <SelectField
        label="Recette"
        required
        value={recipeId === null ? '' : String(recipeId)}
        onChange={(value) => onChange(value === '' ? null : Number(value))}
        placeholder={matches.length === 0 ? 'Aucune recette' : 'Choisir une recette…'}
        options={matches.map((recipe) => ({ value: String(recipe.id), label: recipe.name }))}
        disabled={recipes.isPending || items.length === 0}
        hint={
          selected
            ? `Prévue pour ${selected.defaultPortions} portion${selected.defaultPortions > 1 ? 's' : ''}.`
            : undefined
        }
      />

      {recipes.isError && (
        <p className="text-error" role="alert">
          {recipes.error.message}
        </p>
      )}
      {recipes.isSuccess && items.length === 0 && (
        <p className="picker__status">Aucune recette enregistrée pour l’instant.</p>
      )}

      <NumberField
        label="Portions"
        required
        value={portions}
        onChange={onPortionsChange}
        min={0.25}
        max={50}
        decimals={2}
        hint="De 0,25 à 50 portions."
      />
    </>
  )
}
