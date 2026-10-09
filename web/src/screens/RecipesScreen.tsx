/**
 * Ecran Recettes : la liste, puis l'editeur.
 *
 * Le desktop tenait les deux dans un SplitView 30/70 redimensionnable. En
 * 375 px il n'y a qu'une colonne : la liste est un ecran, chaque recette en est
 * un autre (/recettes/:id), et le bouton Retour du telephone fait la
 * navigation. La poignee de separation n'a pas d'equivalent tactile et
 * disparait sans regret.
 *
 * La liste est ici RICHE : le desktop n'affichait que le nom et deux
 * compteurs, alors que ce qui aide a choisir un dimanche soir, c'est de voir
 * les tags, le temps de preparation et la derniere fois qu'on l'a cuisinee.
 * Ces informations sont deja calculees par l'API (`cookCount30d`,
 * `lastCookedAt`), il aurait ete dommage de les laisser dans le tuyau.
 *
 * Les photos de recette EXISTENT desormais, contrairement a ce que disait ce
 * commentaire : le bucket R2 est en place et trois routes le servent. La cle
 * ne transite plus par l'enregistrement de la recette, elle s'ecrit toute
 * seule au moment ou l'on choisit la photo. Voir `PhotoField`.
 */

import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import type { Recipe } from '@prandia/shared'

import { NumberField, TextField } from '../components/Field.js'
import { Sheet } from '../components/Sheet.js'
import { EmptyState, ErrorState, LoadingRows } from '../components/States.js'
import { useRecipe, useRecipes, useSaveRecipe, useTags, type RecipeSummary } from '../lib/queries.js'
import { RecipeEditor } from './recettes/RecipeEditor.js'
import { formatDay, plural } from './recettes/draft.js'
import '../styles/recipes.css'

/**
 * Creation en deux temps : un nom et des portions ici, tout le reste dans
 * l'editeur.
 *
 * Le desktop ouvrait un formulaire vide et ne creait la ligne qu'a
 * l'enregistrement. Impossible a reproduire tel quel : le journal de cuisson et
 * les futures photos ont besoin d'un identifiant stable. On cree donc tout de
 * suite, avec le strict minimum que le schema exige, puis on bascule sur
 * l'editeur de la recette reelle.
 */
export function NewRecipeSheet({
  open,
  onClose,
}: {
  readonly open: boolean
  readonly onClose: () => void
}) {
  const navigate = useNavigate()
  const save = useSaveRecipe()
  const [name, setName] = useState('')
  const [portions, setPortions] = useState<number | null>(2)
  const [touched, setTouched] = useState(false)

  const problem = name.trim() === '' ? 'Le nom de la recette ne peut pas être vide.' : null

  const submit = () => {
    setTouched(true)
    if (problem !== null) return
    save.mutate(
      {
        id: null,
        name: name.trim(),
        instructions: '',
        defaultPortions: Math.max(1, Math.round(portions ?? 1)),
        // Pas de `imageKey` : une recette nait sans photo, et la colonne ne
        // s'ecrit que par la route dediee. Voir `recipeWriteSchema`.
        sourceUrl: null,
        prepTimeMin: null,
        lines: [],
        tagIds: [],
      },
      {
        onSuccess: (recipe) => {
          setName('')
          setTouched(false)
          onClose()
          void navigate(`/recettes/${recipe.id}`)
        },
      },
    )
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Nouvelle recette"
      dismissible={!save.isPending}
      actions={
        <>
          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
            disabled={save.isPending}
          >
            Annuler
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={submit}
            disabled={save.isPending}
          >
            {save.isPending ? 'Création…' : 'Créer'}
          </button>
        </>
      }
    >
      <div className="form">
        <TextField
          label="Nom"
          value={name}
          onChange={setName}
          placeholder="Gratin de courgettes"
          required
          autoFocus
          error={touched ? problem : null}
        />
        <NumberField
          label="Portions"
          value={portions}
          onChange={setPortions}
          min={1}
          max={50}
          decimals={0}
        />
        {save.isError && (
          <p className="text-error" role="alert">
            {save.error.message}
          </p>
        )}
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------

export function RecipeDetailScreen() {
  const params = useParams()
  const navigate = useNavigate()
  const raw = params['id']
  const id = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null

  const query = useRecipe(id)

  if (id === null) {
    return (
      <section className="screen">
        <EmptyState title="Recette introuvable">Cette adresse ne correspond à rien.</EmptyState>
      </section>
    )
  }

  if (query.isPending) {
    return (
      <section className="screen">
        <LoadingRows rows={6} />
      </section>
    )
  }

  if (query.isError) {
    return (
      <section className="screen">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </section>
    )
  }

  return <RecipeEditorHost recipe={query.data} onDeleted={() => void navigate('/recettes')} />
}

/**
 * `key` sur l'identifiant : passer d'une recette a l'autre doit repartir d'un
 * tampon neuf. Sans cela, l'editeur garderait l'etat de saisie de la
 * precedente — et le drapeau « modifie » avec.
 */
function RecipeEditorHost({
  recipe,
  onDeleted,
}: {
  readonly recipe: Recipe
  readonly onDeleted: () => void
}) {
  return <RecipeEditor key={recipe.id ?? 'nouvelle'} recipe={recipe} onDelete={onDeleted} />
}
