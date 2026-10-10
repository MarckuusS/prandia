/**
 * Tags d'une recette : la rangee de pastilles du formulaire, et la feuille qui
 * ouvre le catalogue complet.
 *
 * Le web a longtemps ouvert la CREATION sans ouvrir la CORRECTION, ce que le
 * desktop ne faisait pas non plus mais ou il ne risquait rien : son catalogue
 * etait en lecture seule. Ici, une faute de frappe ou une couleur mal choisie
 * s'installait pour toujours dans la rangee de filtres de l'ecran Recettes, et
 * le seul recours etait de detacher le tag recette par recette. `PUT` et
 * `DELETE /api/tags/:id` existaient pourtant depuis le debut, sans appelant.
 *
 * Deux ecarts avec le desktop, tous deux dictes par l'API :
 *
 *   1. Le desktop persistait un tag AU CLIC, hors du tampon d'edition. Ici il
 *      n'existe pas de route dediee (`PUT /api/recipes/:id/tags`) : les tags
 *      partent dans la charge utile d'enregistrement, comme le reste. C'est
 *      d'ailleurs plus previsible — « Abandonner » abandonne vraiment tout.
 *
 *   2. Le catalogue de tags etait en lecture seule : impossible d'en creer un
 *      sans passer par la base. `POST /api/tags` existe, la creation se fait
 *      donc ici, la ou le besoin nait.
 */

import { useState } from 'react'

import { TextField } from '../../components/Field.js'
import { Sheet } from '../../components/Sheet.js'
import { Icon } from '../../icons/index.js'
import {
  useCreateTag,
  useDeleteTag,
  useTags,
  useUpdateTag,
  type TagItem,
} from '../../lib/queries.js'
import '../../styles/recipes.css'

/**
 * La couleur d'un tag est saisie par l'utilisateur et stockee en base : c'est
 * une DONNEE, pas un choix de mise en forme. Elle ne peut donc pas venir des
 * jetons de theme.css — d'ou le style en ligne, ici et nulle part ailleurs.
 */
export function TagChip({
  tag,
  selected,
  onClick,
}: {
  readonly tag: Pick<TagItem, 'id' | 'name' | 'colorHex'>
  readonly selected: boolean
  readonly onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`recipe-chip${selected ? ' recipe-chip--on' : ''}`}
      style={
        selected
          ? { background: tag.colorHex, borderColor: tag.colorHex }
          : { borderColor: tag.colorHex, color: tag.colorHex }
      }
      aria-pressed={selected}
      onClick={onClick}
    >
      {tag.name}
    </button>
  )
}

export function TagRow({
  tagIds,
  onToggle,
  onOpen,
}: {
  readonly tagIds: readonly number[]
  readonly onToggle: (id: number) => void
  readonly onOpen: () => void
}) {
  const tags = useTags()
  const attached = (tags.data?.items ?? []).filter((tag) => tagIds.includes(tag.id))

  return (
    <div className="field">
      {/* Un <span> et non un <label> : la rangee n'a pas un controle unique a
          designer, chaque pastille est un bouton a part entiere. */}
      <span className="field__label">Tags</span>
      <div className="recipe-chips">
        {attached.map((tag) => (
          <TagChip key={tag.id} tag={tag} selected onClick={() => onToggle(tag.id)} />
        ))}
        <button
          type="button"
          className="recipe-chip recipe-chip--add"
          onClick={onOpen}
          aria-label="Choisir les tags de la recette"
        >
          {attached.length === 0 ? '+ Ajouter un tag' : '+'}
        </button>
      </div>
    </div>
  )
}

export function TagSheet({
  open,
  onClose,
  tagIds,
  onToggle,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly tagIds: readonly number[]
  readonly onToggle: (id: number) => void
}) {
  const tags = useTags()
  const create = useCreateTag()
  const update = useUpdateTag()
  const remove = useDeleteTag()
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(TAG_COLORS[0])
  /** Tag en cours de correction. `null` = le formulaire cree un nouveau tag. */
  const [editing, setEditing] = useState<TagItem | null>(null)
  /** La suppression se confirme sur place : imbriquer une feuille dans une feuille ne tient pas. */
  const [confirmDelete, setConfirmDelete] = useState(false)

  const pending = create.isPending || update.isPending || remove.isPending
  const error = create.error ?? update.error ?? remove.error

  const resetForm = () => {
    setEditing(null)
    setConfirmDelete(false)
    setName('')
    setColor(TAG_COLORS[0])
  }

  const startEdit = (tag: TagItem) => {
    setEditing(tag)
    setConfirmDelete(false)
    setName(tag.name)
    setColor(tag.colorHex)
  }

  const submit = () => {
    if (name.trim() === '') return
    if (editing !== null) {
      update.mutate(
        { id: editing.id, name: name.trim(), colorHex: color },
        { onSuccess: resetForm },
      )
      return
    }
    create.mutate(
      { name: name.trim(), colorHex: color },
      {
        onSuccess: (tag) => {
          setName('')
          // Un tag cree depuis une recette est evidemment destine a cette
          // recette : on l'attache sans le redemander.
          onToggle(tag.id)
        },
      },
    )
  }

  const destroy = () => {
    if (editing === null) return
    const { id } = editing
    remove.mutate(id, {
      onSuccess: () => {
        // Le serveur a detache le tag de toutes les recettes, y compris celle
        // en cours d'edition : son tampon local doit suivre, sans quoi
        // l'enregistrement suivant renverrait un identifiant devenu inconnu.
        if (tagIds.includes(id)) onToggle(id)
        resetForm()
      },
    })
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Tags"
      actions={
        <button type="button" className="button button--secondary" onClick={onClose}>
          Terminé
        </button>
      }
    >
      <p className="card__lead">
        Les tags s’enregistrent avec la recette : pense à valider en bas de l’écran.
      </p>

      <div className="recipe-chips recipe-chips--sheet">
        {(tags.data?.items ?? []).map((tag) => (
          <span key={tag.id} className="tag-row">
            <TagChip
              tag={tag}
              selected={tagIds.includes(tag.id)}
              onClick={() => onToggle(tag.id)}
            />
            {/* Le crayon est un bouton a part, et non un appui long sur la
                pastille : un appui long ne se devine pas, et il entrerait en
                conflit avec le menu de selection du navigateur. */}
            <button
              type="button"
              className="tag-row__edit"
              aria-label={`Modifier le tag ${tag.name}`}
              onClick={() => startEdit(tag)}
            >
              <Icon name="ui-edit" size={14} />
            </button>
          </span>
        ))}
      </div>

      <div className="form tag-create">
        <TextField
          label={editing === null ? 'Nouveau tag' : `Modifier "${editing.name}"`}
          value={name}
          onChange={setName}
          placeholder="Végétarien"
          maxLength={40}
          error={error !== null ? error.message : null}
        />
        <div className="field">
          <span className="field__label" id="tag-color-label">
            Couleur
          </span>
          <div className="tag-palette" role="group" aria-labelledby="tag-color-label">
            {TAG_COLORS.map((hex) => (
              <button
                key={hex}
                type="button"
                className={`tag-palette__swatch${hex === color ? ' tag-palette__swatch--on' : ''}`}
                style={{ background: hex }}
                aria-label={`Couleur ${hex}`}
                aria-pressed={hex === color}
                onClick={() => setColor(hex)}
              />
            ))}
          </div>
        </div>
        <button
          type="button"
          className="button button--primary button--block"
          onClick={submit}
          disabled={name.trim() === '' || pending}
        >
          {editing === null
            ? create.isPending
              ? 'Création…'
              : 'Créer le tag'
            : update.isPending
              ? 'Enregistrement…'
              : 'Enregistrer'}
        </button>

        {editing !== null && (
          <>
            <button
              type="button"
              className="button button--secondary button--block"
              onClick={resetForm}
              disabled={pending}
            >
              Annuler
            </button>
            {/* Du texte rouge et non un aplat (`.button--retrait`), dans ses deux
                temps : le libelle qui change ("Confirmer la suppression") et la
                note dessous disent deja que le second toucher detruit. */}
            <button
              type="button"
              className="button button--retrait button--block"
              onClick={() => (confirmDelete ? destroy() : setConfirmDelete(true))}
              disabled={pending}
            >
              <Icon name="ui-trash" size={16} className="icon--inline" />{' '}
              {remove.isPending
                ? 'Suppression…'
                : confirmDelete
                  ? 'Confirmer la suppression'
                  : 'Supprimer ce tag'}
            </button>
            {confirmDelete && (
              <p className="note">
                {editing.recipeCount === 0
                  ? 'Ce tag n’est utilisé par aucune recette.'
                  : editing.recipeCount === 1
                    ? 'Ce tag sera retiré de la recette qui le porte.'
                    : `Ce tag sera retiré des ${editing.recipeCount} recettes qui le portent.`}{' '}
                Les recettes, elles, ne sont pas touchées.
              </p>
            )}
          </>
        )}
      </div>
    </Sheet>
  )
}

/**
 * Palette fixe. Un selecteur de couleur libre au doigt produit des tags
 * illisibles sur fond clair comme sur fond sombre ; ces huit teintes sont
 * celles du theme, verifiees contre du texte blanc.
 */
const TAG_COLORS = [
  '#2563eb',
  '#16a34a',
  '#ea580c',
  '#dc2626',
  '#7c3aed',
  '#0891b2',
  '#ca8a04',
  '#64748b',
] as const
