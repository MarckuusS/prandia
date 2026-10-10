/**
 * L'editeur de recette — le coeur de l'ecran Recettes.
 *
 * Le desktop montrait la liste et l'editeur cote a cote dans un SplitView
 * 30/70. En 375 px il n'y a qu'une colonne : la liste est un ecran, l'editeur
 * en est un autre, et le bouton Retour du telephone fait la navigation.
 *
 * Le modele d'edition est celui du desktop, volontairement : on modifie un
 * TAMPON local, et rien ne part au serveur avant l'appui sur « Enregistrer ».
 * Une sauvegarde automatique au fil de la frappe serait tentante, mais chaque
 * ecriture REMPLACE integralement les lignes de la recette — la moindre
 * requete perdue en 4G effacerait une ligne qu'on vient d'ajouter. Un
 * enregistrement explicite, atomique, est ce qui protege le mieux les donnees
 * sur un mauvais reseau.
 *
 * En contrepartie, l'etat non enregistre doit etre visible en permanence :
 * c'est le role de la barre fixe en bas d'ecran.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Icon, RayonIcon, type RayonStyle } from '../../icons/index.js'
import type { Ingredient, Recipe } from '@prandia/shared'

import { NumberField, TextArea, TextField } from '../../components/Field.js'
import { ChoixBibliotheque } from '../../components/ChoixBibliotheque.js'
import { QuantityField } from '../../components/QuantityField.js'
import { ConfirmDialog, Sheet } from '../../components/Sheet.js'
import { useToast } from '../../components/Toast.js'
import { MacrosDonut } from '../../components/MacrosDonut.js'
import { ApiError } from '../../lib/api.js'
import { useDeleteRecipe, useSaveRecipe } from '../../lib/queries.js'
import { useRayonStyle } from '../../lib/useRayonStyle.js'
import {
  CostCard,
  NutritionCard,
  useDerived,
} from './RecipeDerived.js'
import { PhotoField } from './PhotoField.js'
import { EtapesEditor } from './EtapesEditor.js'
import { TagRow, TagSheet } from './RecipeTags.js'
import {
  draftProblem,
  draftSignature,
  moveLine,
  newLine,
  plural,
  rayonLabel,
  sortedByRayon,
  toDraft,
  toPayload,
  type DraftLine,
  type RecipeDraft,
} from './draft.js'
import '../../styles/recipes.css'

export function RecipeEditor({
  recipe,
  onDelete,
}: {
  readonly recipe: Recipe
  readonly onDelete: () => void
}) {
  const toast = useToast()
  const save = useSaveRecipe()

  const [draft, setDraft] = useState<RecipeDraft>(() => toDraft(recipe))
  // Deuxieme appel a `toDraft` volontaire : la signature ignore les cles de
  // ligne, les deux tampons produisent donc exactement la meme empreinte.
  const [baseline, setBaseline] = useState<string>(() => draftSignature(toDraft(recipe)))
  const [showProblem, setShowProblem] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  /**
   * Etat de la recette tel qu'il a ete charge. Sert de jeton d'ecriture
   * conditionnelle, et n'est PAS resynchronise depuis le cache : sinon un
   * rafraichissement en arriere-plan validerait a notre place une version que
   * l'utilisateur n'a jamais vue, ce qui reviendrait a n'avoir aucun garde-fou.
   */
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<string | null>(recipe.updatedAt)
  /** Un autre appareil a enregistre entre-temps : on demande quoi faire. */
  const [conflict, setConflict] = useState(false)
  /** La bibliotheque en plein ecran, et ce qui y a ete ajoute depuis son ouverture. */
  const [bibliotheque, setBibliotheque] = useState(false)
  const [ajoutes, setAjoutes] = useState(0)
  const styleOf = useRayonStyle()

  const dirty = useMemo(() => draftSignature(draft) !== baseline, [draft, baseline])
  const problem = draftProblem(draft)
  /*
   * `null` EN DUR, et c'est le point de la separation des deux ecrans.
   *
   * L'editeur portait une carte « Cuisiner pour… » qui mettait les quantites a
   * l'echelle pendant la saisie. Il fallait donc rediviser par le facteur au
   * retour du champ, et poser un bandeau pour expliquer la manoeuvre. La mise
   * a l'echelle vit desormais sur la fiche de lecture, ou rien ne se tape :
   * ici le facteur vaut toujours un, et la regle qu'il fallait expliquer
   * n'existe plus.
   */
  const derived = useDerived(draft, null)

  // Le cache est rafraichi apres chaque ecriture, et TanStack Query relit au
  // retour sur l'onglet : la prop `recipe` peut donc changer pendant l'edition.
  // On l'ignore sciemment — ecraser le tampon effacerait ce que l'utilisateur
  // est en train de taper.

  const patch = (changes: Partial<RecipeDraft>) => setDraft((current) => ({ ...current, ...changes }))

  const patchLine = (key: string, changes: Partial<DraftLine>) =>
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.key === key ? { ...line, ...changes } : line)),
    }))

  /**
   * DOUBLON INTERDIT : la tuile d'un ingredient deja present est inerte, et ce
   * garde-fou tient meme si deux taps partent avant le rendu qui la desactive.
   */
  const addIngredient = (ingredient: Ingredient) =>
    setDraft((current) =>
      current.lines.some((l) => l.ingredient.id !== null && l.ingredient.id === ingredient.id)
        ? current
        : {
            ...current,
            lines: [
              ...current.lines,
              newLine(ingredient, current.lines.reduce((max, l) => Math.max(max, l.ordinal + 1), 0)),
            ],
          },
    )

  const ingredientsPris = useMemo(
    () => new Set(draft.lines.flatMap((l) => (l.ingredient.id === null ? [] : [l.ingredient.id]))),
    [draft.lines],
  )

  /**
   * Envoie le tampon. `force` saute le controle de concurrence.
   *
   * `expectedUpdatedAt` vient de la recette telle qu'elle a ete CHARGEE, et non
   * du cache : c'est bien l'etat que l'utilisateur avait sous les yeux quand il
   * a commence a taper que l'on declare avoir vu.
   */
  const submit = (force = false) => {
    if (problem !== null) {
      setShowProblem(true)
      return
    }
    // L'empreinte est celle du tampon AU MOMENT DE L'ENVOI : si l'utilisateur
    // continue de taper pendant la requete, la recette reste a juste titre
    // marquee comme modifiee.
    const sent = draft
    save.mutate(
      {
        id: recipe.id,
        ...toPayload(sent),
        expectedUpdatedAt: force ? null : loadedUpdatedAt,
      },
      {
        onSuccess: (saved) => {
          setBaseline(draftSignature(sent))
          setShowProblem(false)
          setConflict(false)
          // La recette vient d'etre reecrite : le jeton suivant est le sien.
          setLoadedUpdatedAt(saved.updatedAt)
          toast.show({ message: 'Recette enregistrée.' })
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'stale_recipe') setConflict(true)
        },
      },
    )
  }

  // Ctrl+S, comme sur le desktop. Inutile au doigt, precieux au bureau — et
  // c'est le seul raccourci que l'application ne peut pas se permettre de
  // perdre, puisque le reflexe existe deja chez l'utilisateur.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        submit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Seul garde-fou possible contre la fermeture de l'onglet. La navigation
  // interne, elle, n'est pas interceptable : voir le rapport.
  useEffect(() => {
    if (!dirty) return
    const onLeave = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [dirty])

  const groups = useMemo(() => groupByRayon(draft.lines), [draft.lines])

  return (
    <section className="screen screen--editor">
      <div className="card">
        <div className="form">
          <TextField
            label="Nom"
            value={draft.name}
            onChange={(name) => patch({ name })}
            placeholder="Gratin de courgettes"
            required
            error={showProblem && draft.name.trim() === '' ? problem : null}
          />

          {/* Juste apres le nom : la photo est de l'IDENTITE de la recette,
              comme lui. Les nombres, les tags et les etapes sont de la
              composition. Posee apres les etapes, elle serait derriere un bloc
              qui fait dix ecrans de haut. */}
          {recipe.id !== null && (
            <PhotoField recipeId={recipe.id} imageKey={recipe.imageKey} />
          )}

          <div className="form__row">
            <NumberField
              label="Portions"
              value={draft.defaultPortions}
              onChange={(value) => patch({ defaultPortions: Math.max(1, Math.round(value ?? 1)) })}
              min={1}
              max={50}
              decimals={0}
              required
            />
            <NumberField
              label="Préparation"
              value={draft.prepTimeMin}
              onChange={(prepTimeMin) => patch({ prepTimeMin })}
              min={0}
              max={1440}
              decimals={0}
              emptyOnZero
              suffix="min"
            />
          </div>

          <TagRow
            tagIds={draft.tagIds}
            onOpen={() => setTagsOpen(true)}
            onToggle={(id) =>
              patch({
                tagIds: draft.tagIds.includes(id)
                  ? draft.tagIds.filter((t) => t !== id)
                  : [...draft.tagIds, id],
              })
            }
          />

          <EtapesEditor
            instructions={draft.instructions}
            onChange={(instructions) => patch({ instructions })}
          />
        </div>
      </div>

      <div className="card">
        <h3 className="card__title">
          Ingrédients ({draft.lines.length})
        </h3>

        <button
          type="button"
          className="button button--secondary button--block"
          onClick={() => {
            setAjoutes(0)
            setBibliotheque(true)
          }}
        >
          <Icon name="ui-plus" size={18} className="icon--inline" /> Ajouter un ingrédient
        </button>

        {draft.lines.length === 0 && (
          <p className="card__lead">
            Aucun ingrédient pour l’instant. Ajoute-en depuis ta bibliothèque pour composer la recette.
          </p>
        )}

        {groups.map((group) => (
          <div key={group.rayon} className="editor-group">
            <h4 className="section-header editor-group__titre">
              <Pastille rayon={styleOf(group.categoryL1)} />
              {group.rayon}
            </h4>
            <ul className="editor-lines">
              {group.lines.map((line, index) => (
                <LineEditor
                  key={line.key}
                  line={line}
                  canMoveUp={index > 0}
                  canMoveDown={index < group.lines.length - 1}
                  onChange={(changes) => patchLine(line.key, changes)}
                  onMove={(delta) =>
                    setDraft((current) => ({
                      ...current,
                      lines: moveLine(current.lines, line.key, delta),
                    }))
                  }
                  onRemove={() =>
                    setDraft((current) => ({
                      ...current,
                      lines: current.lines.filter((l) => l.key !== line.key),
                    }))
                  }
                />
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* L'anneau a rejoint `NutritionCard`, au-dessus de son tableau : il en
          etait separe par une carte, et il le SUIVAIT, ce qui inversait la
          lecture. */}
      <NutritionCard derived={derived} />
      <CostCard derived={derived} />


      {recipe.sourceUrl && (
        <p className="note">
          Importée depuis{' '}
          <a href={recipe.sourceUrl} target="_blank" rel="noreferrer noopener">
            {recipe.sourceUrl}
          </a>
        </p>
      )}

      <div className="card">
        <h3 className="card__title">Supprimer</h3>
        <p className="card__lead">
          La recette et son journal de cuisson disparaissent, et les repas déjà planifiés qui
          l’utilisent sont retirés du calendrier.
        </p>
        <button
          type="button"
          className="button button--danger button--block"
          onClick={() => setDeleteOpen(true)}
        >
          Supprimer cette recette
        </button>
      </div>

      {/*
        Conflit d'enregistrement. On ne tranche pas a la place de l'utilisateur :
        lui seul sait si ce qu'il a tape remplace ou complete ce qui a ete
        enregistre ailleurs. Recharger perd sa saisie, ecraser perd celle de
        l'autre appareil ; les deux sont annonces pour ce qu'ils sont.
      */}
      <ConfirmDialog
        open={conflict}
        title="Modifiée sur un autre appareil"
        message={
          'Cette recette a été enregistrée ailleurs pendant que tu la modifiais. ' +
          'Enregistrer maintenant écrasera cette version. Recharger, au contraire, ' +
          'abandonnera ce que tu viens de taper.'
        }
        confirmLabel="Écraser quand même"
        busy={save.isPending}
        error={null}
        onConfirm={() => submit(true)}
        onClose={() => setConflict(false)}
      />

      <SaveBar
        dirty={dirty}
        busy={save.isPending}
        error={save.isError ? save.error.message : showProblem ? problem : null}
        onSave={() => submit()}
        onDiscard={() => {
          setDraft(toDraft(recipe))
          setBaseline(draftSignature(toDraft(recipe)))
          setShowProblem(false)
        }}
      />

      {/* Plusieurs ajouts d'affilee : la feuille reste ouverte, chaque tuile
          ajoutee passe aussitot en "Deja ajoute", et le pied compte ce qui a
          ete pris. */}
      <Sheet
        open={bibliotheque}
        onClose={() => setBibliotheque(false)}
        title="Ajouter des ingrédients"
        variant="plein"
        actions={
          <button type="button" className="button button--primary" onClick={() => setBibliotheque(false)}>
            {ajoutes > 0 ? `Terminé · ${ajoutes} ajouté${ajoutes > 1 ? 's' : ''}` : 'Terminé'}
          </button>
        }
      >
        <ChoixBibliotheque
          ingredientsPris={ingredientsPris}
          onIngredient={(ingredient) => {
            if (ingredient.id !== null && ingredientsPris.has(ingredient.id)) return
            addIngredient(ingredient)
            setAjoutes((n) => n + 1)
          }}
        />
      </Sheet>

      <TagSheet
        open={tagsOpen}
        onClose={() => setTagsOpen(false)}
        tagIds={draft.tagIds}
        onToggle={(id) =>
          patch({
            tagIds: draft.tagIds.includes(id)
              ? draft.tagIds.filter((t) => t !== id)
              : [...draft.tagIds, id],
          })
        }
      />

      <DeleteRecipeDialog
        open={deleteOpen}
        recipe={recipe}
        onClose={() => setDeleteOpen(false)}
        onDeleted={onDelete}
      />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Lignes d'ingredients
// ---------------------------------------------------------------------------

interface RayonGroup {
  readonly rayon: string
  /** Celle de la premiere ligne : de quoi peindre la pastille de l'intertitre. */
  readonly categoryL1: string | null
  readonly lines: DraftLine[]
}

/**
 * Coupe la liste triee en sections. On ne regroupe pas par cle de rayon dans
 * une Map : l'ordre des sections doit rester celui du tri, pas celui des
 * insertions.
 */
function groupByRayon(lines: readonly DraftLine[]): RayonGroup[] {
  const groups: RayonGroup[] = []
  for (const line of sortedByRayon(lines)) {
    const rayon = rayonLabel(line.ingredient.categoryL1)
    const last = groups[groups.length - 1]
    if (last && last.rayon === rayon) last.lines.push(line)
    else groups.push({ rayon, categoryL1: line.ingredient.categoryL1, lines: [line] })
  }
  return groups
}

function LineEditor({
  line,
  canMoveUp,
  canMoveDown,
  onChange,
  onMove,
  onRemove,
}: {
  readonly line: DraftLine
  readonly canMoveUp: boolean
  readonly canMoveDown: boolean
  readonly onChange: (changes: Partial<DraftLine>) => void
  readonly onMove: (delta: number) => void
  readonly onRemove: () => void
}) {
  const [noteOpen, setNoteOpen] = useState(false)
  const rayon = useRayonStyle()(line.ingredient.categoryL1)
  const showNote = noteOpen || (line.notes !== null && line.notes !== '')

  // La quantite AFFICHEE suit la mise a l'echelle ; ce qui est stocke n'en
  // depend pas. Diviser au retour est ce que le bandeau orange annonce.
  const displayed = line.quantityG

  return (
    <li className="editor-line">
      <div className="editor-line__head">
        {/* La pastille du rayon d'abord : on reconnait un legume, un laitage ou
            une epice a sa couleur avant d'avoir lu son nom. Puis le CHEVRON, le
            signe habituel d'un lien vers une fiche : sans lui, rien ne disait
            que le nom s'ouvre. */}
        {line.ingredient.id === null ? (
          <span className="editor-line__name">
            <Pastille rayon={rayon} />
            <span className="editor-line__libelle">{line.ingredient.name}</span>
          </span>
        ) : (
          <Link
            className="editor-line__name lien-surface"
            to={`/ingredients/${line.ingredient.id}`}
            aria-label={`${line.ingredient.name}, ouvrir la fiche`}
          >
            <Pastille rayon={rayon} />
            <span className="editor-line__libelle">{line.ingredient.name}</span>
            <Icon name="ui-chevron-right" size={16} className="editor-line__chevron" />
          </Link>
        )}
        <div className="editor-line__actions">
          <button
            type="button"
            className="icon-action"
            onClick={() => onMove(-1)}
            disabled={!canMoveUp}
            aria-label={`Monter ${line.ingredient.name}`}
          >
            <span aria-hidden="true">↑</span>
          </button>
          <button
            type="button"
            className="icon-action"
            onClick={() => onMove(1)}
            disabled={!canMoveDown}
            aria-label={`Descendre ${line.ingredient.name}`}
          >
            <span aria-hidden="true">↓</span>
          </button>
          <button
            type="button"
            className="icon-action icon-action--danger"
            onClick={onRemove}
            aria-label={`Retirer ${line.ingredient.name}`}
          >
            <Icon name="ui-close" size={16} />
          </button>
        </div>
      </div>

      {/* Pas de rappel du poids en grammes a cote du champ : la liste
          deroulante affiche deja « pièce (60 g) », et une colonne de plus
          reduirait le champ de saisie a une soixantaine de pixels en 375 px. */}
      <div className="editor-line__quantity">
        <QuantityField
          label={`Quantité de ${line.ingredient.name}`}
          value={displayed}
          onChange={(grams) => onChange({ quantityG: grams })}
          pieceWeightG={line.ingredient.pieceWeightG}
          cookedWeightPer100gRaw={line.ingredient.cookedWeightPer100gRaw}
          unit={line.unit}
          onUnitChange={(unit) => onChange({ unit })}
        />
      </div>

      {showNote ? (
        <TextField
          label={`Note pour ${line.ingredient.name}`}
          value={line.notes ?? ''}
          onChange={(notes) => onChange({ notes: notes.trim() === '' ? null : notes })}
          placeholder="égoutter, écraser, à température…"
        />
      ) : (
        <button type="button" className="button button--ghost editor-line__note-add" onClick={() => setNoteOpen(true)}>
          + Ajouter une note
        </button>
      )}
    </li>
  )
}

/** La pastille d'un rayon, en petit : celle des lignes et des intertitres. */
function Pastille({ rayon }: { readonly rayon: RayonStyle }) {
  return (
    <span className="icon-chip icon-chip--sm" {...rayon.tint} aria-hidden="true">
      <RayonIcon glyph={rayon.glyph} size={16} strokeWidth={1.8} />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Barre d'enregistrement et suppression
// ---------------------------------------------------------------------------

function SaveBar({
  dirty,
  busy,
  error,
  onSave,
  onDiscard,
}: {
  readonly dirty: boolean
  readonly busy: boolean
  readonly error: string | null
  readonly onSave: () => void
  readonly onDiscard: () => void
}) {
  if (!dirty && error === null) return null
  return (
    <div className="save-bar">
      {error !== null && (
        <p className="save-bar__error" role="alert">
          {error}
        </p>
      )}
      <div className="save-bar__row">
        <span className="save-bar__state">Modifications non enregistrées</span>
        <div className="save-bar__actions">
          <button type="button" className="button button--ghost" onClick={onDiscard} disabled={busy}>
            Abandonner
          </button>
          <button type="button" className="button button--primary" onClick={onSave} disabled={busy}>
            {busy ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DeleteRecipeDialog({
  open,
  recipe,
  onClose,
  onDeleted,
}: {
  readonly open: boolean
  readonly recipe: Recipe
  readonly onClose: () => void
  readonly onDeleted: () => void
}) {
  const toast = useToast()
  const remove = useDeleteRecipe()

  return (
    <ConfirmDialog
      open={open}
      title={`Supprimer « ${recipe.name} » ?`}
      message="La recette, ses ingrédients et son journal de cuisson sont supprimés définitivement. Les repas déjà planifiés qui l’utilisent disparaissent du calendrier."
      confirmLabel="Supprimer"
      danger
      busy={remove.isPending}
      error={remove.error?.message}
      onClose={onClose}
      onConfirm={() => {
        if (recipe.id === null) return
        remove.mutate(recipe.id, {
          onSuccess: (result) => {
            toast.show({
              message:
                result.plannedEntriesRemoved > 0
                  ? `Recette supprimée, ainsi que ${result.plannedEntriesRemoved} ${plural(result.plannedEntriesRemoved, 'repas', 'repas')} planifié${result.plannedEntriesRemoved > 1 ? 's' : ''}.`
                  : 'Recette supprimée.',
            })
            onDeleted()
          },
        })
      }}
    />
  )
}

