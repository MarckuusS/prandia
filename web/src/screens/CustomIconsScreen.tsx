/**
 * Mes icones — Parametres → Mes icônes.
 *
 * On colle le contenu d'un fichier `.svg`, on le nomme, il rejoint la grille de
 * choix de tous les rayons.
 *
 * L'APERCU EST ASSAINI COTE NAVIGATEUR, mais ce n'est PAS ce qui protege : le
 * serveur repart du texte brut et refait le travail (`worker/src/routes/
 * icons.ts`). L'assainissement d'ici ne sert qu'a montrer honnetement ce qui
 * sera enregistre — coller un SVG et voir l'apercu differer du resultat serait
 * la pire des surprises.
 *
 * Ce que l'ecran refuse de taire : la liste de ce qui a ete retire. Une icone
 * amputee en silence donne un dessin faux sans explication, et l'utilisateur
 * accuse le dessin plutot que le filtre.
 */

import { useMemo, useState } from 'react'

import { TextField } from '../components/Field.js'
import { ConfirmDialog, Sheet } from '../components/Sheet.js'
import { EmptyState, ErrorState, LoadingRows } from '../components/States.js'
import { useToast } from '../components/Toast.js'
import { sanitizeSvg } from '@prandia/shared'
import { Icon, RayonIcon } from '../icons/index.js'
import {
  useCreateIcon,
  useCustomIcons,
  useDeleteIcon,
  type CustomIconItem,
} from '../lib/queries.js'
import '../styles/rayons.css'

export function CustomIconsScreen() {
  const icons = useCustomIcons()
  const [adding, setAdding] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<CustomIconItem | null>(null)

  const remove = useDeleteIcon()
  const toast = useToast()
  const items = icons.data?.items ?? []

  return (
    <section className="screen">
      <div className="card">
        <h2 className="card__title">Mes icônes</h2>
        <p className="card__lead">
          Colle le code d’un fichier <code>.svg</code> pour l’ajouter aux icônes proposées lors du
          choix d’un rayon. Le code est filtré à l’enregistrement : seules les formes de dessin sont
          conservées.
        </p>
        <button type="button" className="button button--primary" onClick={() => setAdding(true)}>
          <Icon name="ui-plus" size={16} className="icon--inline" /> Ajouter une icône
        </button>
      </div>

      {icons.isPending && <LoadingRows rows={3} />}
      {icons.isError && <ErrorState error={icons.error} onRetry={() => void icons.refetch()} />}

      {icons.isSuccess && items.length === 0 && (
        <EmptyState title="Aucune icône personnelle">
          Les 67 icônes du jeu restent disponibles pour tous les rayons.
        </EmptyState>
      )}

      {items.length > 0 && (
        <ul className="row-list">
          {items.map((item) => (
            <li className="row row--static" key={item.id}>
              <span className="icon-chip">
                <RayonIcon
                  glyph={{
                    kind: 'custom',
                    markup: item.markup,
                    viewBox: item.viewBox,
                    keepColors: item.keepColors,
                  }}
                  size={22}
                />
              </span>
              <span className="row__body">
                <span className="row__title">{item.name}</span>
                <span className="row__meta">
                  {item.keepColors ? 'couleurs d’origine' : 'suit la couleur du rayon'} · grille{' '}
                  {item.viewBox}
                </span>
              </span>
              <button
                type="button"
                className="icon-action icon-action--danger"
                onClick={() => setPendingDelete(item)}
                aria-label={`Supprimer ${item.name}`}
              >
                <Icon name="ui-trash" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding && <AddIconSheet onClose={() => setAdding(false)} />}

      {pendingDelete !== null && (
        <ConfirmDialog
          open
          danger
          title={`Supprimer « ${pendingDelete.name} » ?`}
          confirmLabel="Supprimer"
          busy={remove.isPending}
          error={remove.isError ? remove.error.message : null}
          // Le repli est deja en place cote resolveur : le dire evite que
          // l'utilisateur croie devoir corriger ses rayons a la main.
          message="Les rayons qui l’utilisaient reprendront l’icône déduite de leur nom. Aucun rayon n’est supprimé."
          onClose={() => setPendingDelete(null)}
          onConfirm={() => {
            void remove.mutateAsync(pendingDelete.id).then(() => {
              toast.show({ message: `Icône « ${pendingDelete.name} » supprimée.` })
              setPendingDelete(null)
            })
          }}
        />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------

function AddIconSheet({ onClose }: { onClose: () => void }) {
  const create = useCreateIcon()
  const toast = useToast()

  const [name, setName] = useState('')
  const [svg, setSvg] = useState('')
  const [keepColors, setKeepColors] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Meme fonction que le serveur, sur le meme texte : l'apercu ne peut pas
  // diverger de ce qui sera enregistre.
  const preview = useMemo(() => (svg.trim() === '' ? null : sanitizeSvg(svg)), [svg])
  const drawable = preview !== null && preview.markup !== ''

  const submit = async () => {
    setError(null)
    if (name.trim() === '') return setError('Donne un nom à cette icône.')
    if (!drawable) return setError('Rien de dessinable dans ce code.')
    try {
      const saved = await create.mutateAsync({ name: name.trim(), svg, keepColors })
      toast.show({
        message:
          saved.removed.length === 0
            ? `Icône « ${saved.name} » ajoutée.`
            : `Icône « ${saved.name} » ajoutée, ${saved.removed.length} élément(s) filtré(s).`,
      })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Enregistrement impossible.')
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Ajouter une icône"
      actions={
        <>
          <button type="button" className="button button--ghost" onClick={onClose}>
            Annuler
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={create.isPending}
            onClick={() => void submit()}
          >
            {create.isPending ? 'Enregistrement…' : 'Ajouter'}
          </button>
        </>
      }
    >
      <div className="form">
        <TextField label="Nom" value={name} onChange={setName} autoFocus required />

        <label className="field">
          <span className="field__label">Code SVG</span>
          <textarea
            className="field__textarea"
            rows={6}
            value={svg}
            onChange={(event) => setSvg(event.target.value)}
            placeholder='<svg viewBox="0 0 24 24">…</svg>'
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <span className="field__hint">
            Ouvre le fichier .svg dans un éditeur de texte et colle tout son contenu.
          </span>
        </label>

        <label className="field field--inline">
          <input
            type="checkbox"
            checked={keepColors}
            onChange={(event) => setKeepColors(event.target.checked)}
          />
          <span>
            Garder les couleurs d’origine
            <span className="field__hint">
              Décoché, l’icône prend la couleur du rayon et suit le thème sombre.
            </span>
          </span>
        </label>

        {preview !== null && (
          <div className="rayon-preview">
            {drawable ? (
              <span className="icon-chip" data-rayon="autre">
                <RayonIcon
                  glyph={{
                    kind: 'custom',
                    markup: preview.markup,
                    viewBox: preview.viewBox,
                    keepColors,
                  }}
                  size={22}
                />
              </span>
            ) : (
              <span className="icon-chip" data-rayon="autre">
                <Icon name="ui-alert" size={22} />
              </span>
            )}
            <span className="rayon-preview__name">
              {drawable ? name.trim() || 'Aperçu' : 'Rien de dessinable'}
            </span>
          </div>
        )}

        {preview !== null && preview.removed.length > 0 && (
          <p className="field__hint">
            Retiré du code : {preview.removed.join(', ')}. C’est volontaire — ces éléments peuvent
            exécuter du code ou appeler un serveur extérieur.
          </p>
        )}

        {error !== null && <p className="status status--error">{error}</p>}
      </div>
    </Sheet>
  )
}
