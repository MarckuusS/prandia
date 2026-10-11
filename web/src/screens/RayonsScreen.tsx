/**
 * Gestionnaire de rayons — Parametres → Rayons.
 *
 * Ce que l'ecran doit dire, et que le desktop ne disait pas : un rayon n'est
 * pas qu'un libelle, c'est aussi ce qui range la liste de courses. Chaque ligne
 * porte donc son effectif, et la suppression annonce ce qu'elle deplace avant
 * de le faire.
 *
 * LE PIEGE DU MODELE. `ingredient.category_l1` est du TEXTE : le lien vers le
 * rayon est le nom. Renommer « Epicerie » en « Épicerie » n'est donc pas une
 * retouche cosmetique, c'est une ecriture sur tous les ingredients concernes.
 * Le serveur s'en charge en une transaction (voir worker/src/repos/rayons.ts),
 * mais l'interface doit le DIRE — d'ou la mention du nombre d'ingredients sous
 * le champ de nom des qu'il change.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import { CheckboxField, TextField } from '../components/Field.js'
import { Savarin } from '../components/Savarin.js'
import { SavarinFlottant } from '../components/SavarinFlottant.js'
import { ConfirmDialog, Sheet } from '../components/Sheet.js'
import { EmptyState, ErrorState, LoadingRows } from '../components/States.js'
import { useToast } from '../components/Toast.js'
import {
  Icon,
  ICON_PATHS,
  RayonIcon,
  customIconRef,
  makeRayonStyle,
  type IconName,
} from '../icons/index.js'
import {
  useCreateRayon,
  useCreerRayonPropose,
  useCustomIcons,
  useDeleteRayon,
  useRayons,
  useRayonsProposes,
  useRefuserRayonPropose,
  useUpdateRayon,
  type RayonItem,
  type RayonPropose,
} from '../lib/queries.js'
import '../styles/rayons.css'

/**
 * Icones proposees.
 *
 * Les dix rayons d'abord, puis une poignee d'icones d'interface qui decrivent
 * un rayon sans etre un rayon — le panier pour un fourre-tout, la flamme pour
 * la nutrition sportive, la feuille pour un rayon bio. Proposer les 67 icones
 * du jeu serait une grille de defilement infinie ou l'on ne trouve rien.
 */
const ICON_CHOICES: readonly IconName[] = [
  'rayon-fruits-legumes',
  'rayon-boulangerie',
  'rayon-boucherie',
  'rayon-poissonnerie',
  'rayon-produits-laitiers',
  'rayon-boissons',
  'rayon-surgeles',
  'rayon-epicerie',
  'rayon-snacks-confiseries',
  'rayon-autre',
  'ui-basket',
  'ui-flame',
  'ui-leaf',
  'ui-scale',
  'ui-heart',
  'ui-price',
  'ui-camera',
  'ui-fridge',
]

/**
 * Palette proposee.
 *
 * Ce sont les dix teintes par defaut du jeu d'icones, plus deux, toutes
 * verifiees au contraste dans les deux themes. La variante sombre n'est pas
 * demandee : elle est derivee en CSS (voir styles/icons.css).
 */
const COLOR_CHOICES: readonly string[] = [
  '#16a34a', '#65a30d', '#b45309', '#dc2626', '#db2777', '#7c3aed',
  '#4f46e5', '#2563eb', '#0891b2', '#0d9488', '#ea580c', '#64748b',
]

export function RayonsScreen() {
  const rayons = useRayons()
  const [editing, setEditing] = useState<RayonItem | 'new' | null>(null)
  const [idee, setIdee] = useState<RayonPropose | null>(null)
  // La meme requete que la bulle (cache partage) : l'ecran se reserve la place de Savarin.
  const savarinParle = (useRayonsProposes().data?.propositions.length ?? 0) > 0

  const items = rayons.data?.items ?? []
  const custom = useCustomIcons()
  const styleOf = useMemo(
    () => makeRayonStyle(items, custom.data?.items ?? []),
    [items, custom.data],
  )

  return (
    <section className={`screen${savarinParle ? ' screen--savarin' : ''}`}>
      <div className="card">
        <h2 className="card__title">Rayons</h2>
        <p className="card__lead">
          Ils rangent la liste de courses et la bibliothèque. Un rayon sans icône ni couleur choisie
          prend celles que son nom suggère.
        </p>
        <button type="button" className="button button--primary" onClick={() => setEditing('new')}>
          <Icon name="ui-plus" size={16} className="icon--inline" /> Nouveau rayon
        </button>
      </div>

      <IdeeDeSavarin onVoir={setIdee} />

      {rayons.isPending && <LoadingRows rows={6} />}
      {rayons.isError && (
        <ErrorState error={rayons.error} onRetry={() => void rayons.refetch()} />
      )}

      {rayons.isSuccess && items.length === 0 && (
        <EmptyState title="Aucun rayon">
          Crée-en un, ou donne un rayon à un ingrédient depuis sa fiche.
        </EmptyState>
      )}

      {items.length > 0 && (
        <ul className="row-list">
          {items.map((rayon) => {
            const { glyph, tint } = styleOf(rayon.name)
            return (
              <li className="row" key={rayon.id}>
                <button
                  type="button"
                  className="row--static rayon-row"
                  onClick={() => setEditing(rayon)}
                >
                  <span className="icon-chip" {...tint}>
                    <RayonIcon glyph={glyph} size={22} />
                  </span>
                  <span className="row__body">
                    <span className="row__title">{rayon.name}</span>
                    <span className="row__meta">
                      {rayon.ingredientCount === 0
                        ? 'aucun ingrédient'
                        : `${rayon.ingredientCount} ingrédient${rayon.ingredientCount > 1 ? 's' : ''}`}
                      {rayon.colorHex === null && rayon.icon === null && ' · aspect déduit du nom'}
                    </span>
                  </span>
                  <span className="row__chevron">
                    <Icon name="ui-chevron-right" size={18} />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {editing !== null && (
        <RayonSheet
          rayon={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}

      {idee !== null && <PropositionSheet proposition={idee} onClose={() => setIdee(null)} />}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Les idees de Savarin
// ---------------------------------------------------------------------------

/**
 * Une idee de rayon, que Savarin garde pour lui jusqu'a ce qu'on l'appelle
 * (`SavarinFlottant`, en bas a gauche, avec un "!"). Une idee a la fois, et
 * RIEN quand il n'a rien a proposer, ni pendant qu'il reflechit : un Savarin
 * qui appelle pour dire "rien" apprendrait a ne plus l'ecouter.
 */
function IdeeDeSavarin({ onVoir }: { readonly onVoir: (idee: RayonPropose) => void }) {
  const idees = useRayonsProposes()
  const refuser = useRefuserRayonPropose()
  const propositions = idees.data?.propositions ?? []
  const idee = propositions[0]
  if (idee === undefined) return null
  const autres = propositions.length - 1

  return (
    <SavarinFlottant cle={idee.nom} label="Savarin a une idée pour tes rayons">
      {(fermer) => (
        <>
          <p className="savarin-bulle__titre">
            D’après ta bibliothèque, un rayon <strong>{idee.nom}</strong> pourrait t’aider.
          </p>
          <p className="savarin-bulle__texte">{idee.raison}</p>
          <div className="savarin-bulle__actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                fermer()
                onVoir(idee)
              }}
            >
              Voir les {idee.produits.length} produits
            </button>
            <button
              type="button"
              className="button button--ghost"
              disabled={refuser.isPending}
              onClick={() => {
                refuser.mutate(idee.nom)
                fermer()
              }}
            >
              Non merci
            </button>
          </div>
          {autres > 0 && (
            <p className="savarin-bulle__suite">
              {autres === 1 ? 'Il a une autre idée, il te la dira ensuite.' : `Il a ${autres} autres idées, il te les dira ensuite.`}
            </p>
          )}
        </>
      )}
    </SavarinFlottant>
  )
}

/**
 * La proposition, relue avant d'ecrire : le nom se retouche, chaque produit se
 * decoche. Rien ne bouge avant "Creer le rayon", et seuls les produits COCHES
 * changent de rayon.
 */
function PropositionSheet({ proposition, onClose }: { readonly proposition: RayonPropose; readonly onClose: () => void }) {
  const toast = useToast()
  const creer = useCreerRayonPropose()
  const [nom, setNom] = useState(proposition.nom)
  const [retenus, setRetenus] = useState<ReadonlySet<number>>(() => new Set(proposition.produits.map((p) => p.id)))
  const [erreur, setErreur] = useState<string | null>(null)

  const basculer = (id: number, coche: boolean) =>
    setRetenus((avant) => {
      const apres = new Set(avant)
      if (coche) apres.add(id)
      else apres.delete(id)
      return apres
    })

  const valider = async () => {
    setErreur(null)
    const propre = nom.trim()
    if (propre === '') return setErreur('Le nom du rayon ne peut pas être vide.')
    if (retenus.size === 0) return setErreur('Coche au moins un produit à y ranger.')
    try {
      const { ranges } = await creer.mutateAsync({ proposition: proposition.nom, nom: propre, produits: [...retenus] })
      toast.show({ message: `Rayon "${propre}" créé : ${ranges} produit${ranges > 1 ? 's y sont rangés' : ' y est rangé'}.` })
      onClose()
    } catch (cause) {
      setErreur(cause instanceof Error ? cause.message : 'Le rayon n’a pas pu être créé.')
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Rayon proposé par Savarin"
      actions={
        <>
          <button type="button" className="button button--ghost" onClick={onClose}>
            Annuler
          </button>
          <button type="button" className="button button--primary" disabled={creer.isPending} onClick={() => void valider()}>
            {creer.isPending ? 'Création…' : 'Créer le rayon'}
          </button>
        </>
      }
    >
      <div className="form">
        <p className="savarin-proposition__raison">
          <Savarin size={18} className="icon--inline" /> {proposition.raison}
        </p>
        <TextField label="Nom du rayon" value={nom} onChange={setNom} required />
        <fieldset className="savarin-proposition__produits">
          <legend className="field__label">
            Produits à y ranger · {retenus.size} sur {proposition.produits.length}
          </legend>
          {proposition.produits.map((p) => (
            <CheckboxField
              key={p.id}
              label={p.nom}
              hint={p.rayon === null ? 'Sans rayon aujourd’hui' : `Aujourd’hui dans ${p.rayon}`}
              checked={retenus.has(p.id)}
              onChange={(coche) => basculer(p.id, coche)}
            />
          ))}
        </fieldset>
        {erreur !== null && <p className="status status--error">{erreur}</p>}
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Edition
// ---------------------------------------------------------------------------

function RayonSheet({ rayon, onClose }: { rayon: RayonItem | null; onClose: () => void }) {
  const toast = useToast()
  const create = useCreateRayon()
  const update = useUpdateRayon()
  const remove = useDeleteRayon()

  const [name, setName] = useState(rayon?.name ?? '')
  const [icon, setIcon] = useState<string | null>(rayon?.icon ?? null)
  const [colorHex, setColorHex] = useState<string | null>(rayon?.colorHex ?? null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = name.trim()
  const renaming = rayon !== null && trimmed !== '' && trimmed !== rayon.name
  const pending = create.isPending || update.isPending

  // Apercu : le meme resolveur que le reste de l'application, nourri de ce qui
  // est en train d'etre saisi. Ce que montre la pastille EST ce que montreront
  // les listes, sans code d'apercu parallele qui pourrait diverger.
  const custom = useCustomIcons()
  const customIcons = custom.data?.items ?? []
  const preview = makeRayonStyle([{ name: trimmed, icon, colorHex }], customIcons)(trimmed)

  const submit = async () => {
    setError(null)
    if (trimmed === '') {
      setError('Le nom du rayon ne peut pas être vide.')
      return
    }
    try {
      if (rayon === null) {
        await create.mutateAsync({ name: trimmed, icon, colorHex, ordinal: 0 })
        toast.show({ message: `Rayon « ${trimmed} » créé.` })
      } else {
        await update.mutateAsync({ id: rayon.id, name: trimmed, icon, colorHex, ordinal: rayon.ordinal })
        toast.show({ message: `Rayon « ${trimmed} » enregistré.` })
      }
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Enregistrement impossible.')
    }
  }

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={rayon === null ? 'Nouveau rayon' : 'Modifier le rayon'}
        actions={
          <>
            <button type="button" className="button button--ghost" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={pending}
              onClick={() => void submit()}
            >
              {pending ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </>
        }
      >
        <div className="form">
          <div className="rayon-preview">
            <span className="icon-chip" {...preview.tint}>
              <RayonIcon glyph={preview.glyph} size={22} />
            </span>
            <span className="rayon-preview__name">{trimmed === '' ? 'Sans nom' : trimmed}</span>
          </div>

          <TextField label="Nom" value={name} onChange={setName} autoFocus required />

          {/* Le renommage n'est pas cosmetique : il reecrit le rayon de chaque
              ingredient concerne. Le dire AVANT, pas apres. */}
          {renaming && rayon.ingredientCount > 0 && (
            <p className="field__hint">
              {rayon.ingredientCount} ingrédient{rayon.ingredientCount > 1 ? 's' : ''} passeront de
              « {rayon.name} » à « {trimmed} ».
            </p>
          )}

          <fieldset className="rayon-choices">
            <legend className="field__label">Icône</legend>
            <div className="rayon-icons">
              <button
                type="button"
                className={`rayon-icons__cell${icon === null ? ' rayon-icons__cell--on' : ''}`}
                aria-pressed={icon === null}
                onClick={() => setIcon(null)}
                title="Déduite du nom"
              >
                <Icon name="ui-refresh" size={20} />
              </button>
              {ICON_CHOICES.filter((name) => name in ICON_PATHS).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className={`rayon-icons__cell${icon === choice ? ' rayon-icons__cell--on' : ''}`}
                  aria-pressed={icon === choice}
                  aria-label={choice}
                  onClick={() => setIcon(choice)}
                >
                  <Icon name={choice} size={20} />
                </button>
              ))}
            </div>
            {/* Les icones collees viennent APRES celles du jeu : elles sont
                moins nombreuses et se cherchent, la ou les dix rayons se
                reconnaissent. */}
            {customIcons.length > 0 && (
              <div className="rayon-icons">
                {customIcons.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`rayon-icons__cell${icon === customIconRef(item.id) ? ' rayon-icons__cell--on' : ''}`}
                    aria-pressed={icon === customIconRef(item.id)}
                    aria-label={item.name}
                    title={item.name}
                    onClick={() => setIcon(customIconRef(item.id))}
                  >
                    <RayonIcon
                      glyph={{
                        kind: 'custom',
                        markup: item.markup,
                        viewBox: item.viewBox,
                        keepColors: item.keepColors,
                      }}
                      size={20}
                    />
                  </button>
                ))}
              </div>
            )}
            <p className="field__hint">
              La première case rend l’icône déduite du nom, celle d’avant le gestionnaire.{' '}
              <Link to="/parametres/mes-icones">Ajouter une icône</Link> pour enrichir cette grille.
            </p>
          </fieldset>

          <fieldset className="rayon-choices">
            <legend className="field__label">Couleur</legend>
            <div className="rayon-colors">
              <button
                type="button"
                className={`rayon-colors__cell${colorHex === null ? ' rayon-colors__cell--on' : ''}`}
                aria-pressed={colorHex === null}
                onClick={() => setColorHex(null)}
                title="Déduite du nom"
              >
                <Icon name="ui-refresh" size={16} />
              </button>
              {COLOR_CHOICES.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  className={`rayon-colors__cell${colorHex === hex ? ' rayon-colors__cell--on' : ''}`}
                  style={{ background: hex }}
                  aria-pressed={colorHex === hex}
                  aria-label={hex}
                  onClick={() => setColorHex(hex)}
                />
              ))}
              {/* Sortie de secours vers le selecteur natif. `<input type=color>`
                  n'accepte QUE #rrggbb : la valeur est donc toujours au format
                  attendu par le schema partage, sans normalisation a faire. */}
              <label
                className={`rayon-colors__cell rayon-colors__cell--custom${
                  colorHex !== null && !COLOR_CHOICES.includes(colorHex)
                    ? ' rayon-colors__cell--on'
                    : ''
                }`}
                style={colorHex !== null ? { background: colorHex } : undefined}
                title="Autre couleur"
              >
                <Icon name="ui-edit" size={14} />
                <input
                  type="color"
                  className="rayon-colors__input"
                  value={colorHex ?? '#64748b'}
                  onChange={(event) => setColorHex(event.target.value)}
                  aria-label="Choisir une autre couleur"
                />
              </label>
            </div>
          </fieldset>

          {error !== null && <p className="status status--error">{error}</p>}

          {rayon !== null && (
            // Sans aplat (`.button--retrait`) : la confirmation qu'il ouvre porte
            // le rouge plein.
            <button
              type="button"
              className="button button--retrait button--block"
              onClick={() => setConfirmDelete(true)}
            >
              <Icon name="ui-trash" size={16} className="icon--inline" /> Supprimer ce rayon
            </button>
          )}
        </div>
      </Sheet>

      {confirmDelete && rayon !== null && (
        <ConfirmDialog
          open
          title={`Supprimer « ${rayon.name} » ?`}
          confirmLabel="Supprimer"
          danger
          busy={remove.isPending}
          error={remove.isError ? remove.error.message : null}
          message={
            rayon.ingredientCount === 0
              ? 'Ce rayon ne contient aucun ingrédient.'
              : `Ses ${rayon.ingredientCount} ingrédients ne seront pas supprimés : ils passeront « sans rayon », et tu pourras leur en attribuer un autre depuis leur fiche.`
          }
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => {
            void remove.mutateAsync(rayon.id).then(() => {
              toast.show({
                message:
                  rayon.ingredientCount === 0
                    ? `Rayon « ${rayon.name} » supprimé.`
                    : `Rayon supprimé. ${rayon.ingredientCount} ingrédient${rayon.ingredientCount > 1 ? 's sont' : ' est'} maintenant sans rayon.`,
              })
              onClose()
            })
          }}
        />
      )}
    </>
  )
}
