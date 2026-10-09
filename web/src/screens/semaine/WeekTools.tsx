/**
 * Les actions qui portent sur la semaine entiere : copier, modeles, vider.
 *
 * Le desktop les alignait en six boutons dans une barre d'outils. Sur 375 px
 * la barre ne tient pas : tout passe par un menu « ⋯ », et chaque action ouvre
 * sa propre feuille. Une seule est ouverte a la fois — d'ou l'etat `tool`,
 * tenu par l'ecran.
 *
 * DIVERGENCE IMPORTANTE avec le desktop, visible dans les libelles : cote
 * serveur, copier une semaine et appliquer un modele REMPLACENT le contenu de
 * la semaine cible (voir worker/src/repos/calendar.ts), la ou le desktop
 * ajoutait. Deux clics de suite ne creent donc plus de doublons — mais il faut
 * le dire clairement avant d'ecraser une semaine deja remplie, et c'est le
 * role des confirmations ci-dessous.
 */

import { useState } from 'react'
import { DAY_LABELS, nextIsoWeek, previousIsoWeek } from '@prandia/shared'

import { TextField } from '../../components/Field.js'
import { ConfirmDialog, Sheet } from '../../components/Sheet.js'
import { useToast } from '../../components/Toast.js'
import { Icon, type IconName } from '../../icons/index.js'
import {
  useApplyTemplate,
  useCalendar,
  useClearDay,
  useClearWeek,
  useCopyWeek,
  useDeleteTemplate,
  useSaveTemplate,
  useTemplates,
} from '../../lib/queries.js'
import '../../styles/week.css'

export type WeekTool = 'menu' | 'copy' | 'save-template' | 'templates' | 'clear-day' | 'clear-week'

export interface WeekToolsProps {
  readonly isoWeek: string
  readonly dayOfWeek: number
  readonly weekEntryCount: number
  readonly dayEntryCount: number
  readonly tool: WeekTool | null
  readonly onTool: (tool: WeekTool | null) => void
}

const mealCount = (count: number): string => `${count} repas`

export function WeekTools({
  isoWeek,
  dayOfWeek,
  weekEntryCount,
  dayEntryCount,
  tool,
  onTool,
}: WeekToolsProps) {
  const close = () => onTool(null)
  const dayLabel = DAY_LABELS[dayOfWeek] ?? 'ce jour'

  switch (tool) {
    case 'menu':
      return (
        <Sheet open onClose={close} title="Outils de la semaine">
          <ul className="tool-list">
            <ToolItem icon="ui-copy" label="Reprendre une autre semaine" hint="Recopie les repas d’une semaine passée." onSelect={() => onTool('copy')} />
            <ToolItem
              icon="ui-save"
              label="Enregistrer comme modèle"
              hint={weekEntryCount === 0 ? 'La semaine est vide.' : `${mealCount(weekEntryCount)} seront mémorisés.`}
              disabled={weekEntryCount === 0}
              onSelect={() => onTool('save-template')}
            />
            <ToolItem icon="ui-folder" label="Appliquer un modèle" hint="Composer la semaine en un geste." onSelect={() => onTool('templates')} />
            <ToolItem
              icon="ui-eraser"
              label={`Vider ${dayLabel.toLowerCase()}`}
              hint={dayEntryCount === 0 ? 'Rien de prévu ce jour-là.' : mealCount(dayEntryCount)}
              disabled={dayEntryCount === 0}
              onSelect={() => onTool('clear-day')}
            />
            <ToolItem
              icon="ui-trash"
              label="Vider la semaine"
              hint={weekEntryCount === 0 ? 'La semaine est déjà vide.' : mealCount(weekEntryCount)}
              disabled={weekEntryCount === 0}
              onSelect={() => onTool('clear-week')}
            />
          </ul>
        </Sheet>
      )

    case 'copy':
      return <CopySheet isoWeek={isoWeek} weekEntryCount={weekEntryCount} onClose={close} />

    case 'save-template':
      return <SaveTemplateSheet isoWeek={isoWeek} weekEntryCount={weekEntryCount} onClose={close} />

    case 'templates':
      return <TemplatesSheet isoWeek={isoWeek} weekEntryCount={weekEntryCount} onClose={close} />

    case 'clear-day':
      return <ClearDayDialog isoWeek={isoWeek} dayOfWeek={dayOfWeek} count={dayEntryCount} onClose={close} />

    case 'clear-week':
      return <ClearWeekDialog isoWeek={isoWeek} count={weekEntryCount} onClose={close} />

    default:
      return null
  }
}

// ---------------------------------------------------------------------------

function ToolItem({
  icon,
  label,
  hint,
  disabled,
  onSelect,
}: {
  icon: IconName
  label: string
  hint: string
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button type="button" className="tool-list__item" onClick={onSelect} disabled={disabled}>
        <span className="tool-list__icon">
          <Icon name={icon} size={20} />
        </span>
        <span className="tool-list__body">
          <span className="tool-list__label">{label}</span>
          <span className="tool-list__hint">{hint}</span>
        </span>
      </button>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Reprendre une autre semaine
// ---------------------------------------------------------------------------

function CopySheet({
  isoWeek,
  weekEntryCount,
  onClose,
}: {
  isoWeek: string
  weekEntryCount: number
  onClose: () => void
}) {
  const toast = useToast()
  const [source, setSource] = useState(() => previousIsoWeek(isoWeek))
  const [confirming, setConfirming] = useState(false)

  // On lit la semaine source pour annoncer ce qu'elle contient AVANT de
  // remplacer quoi que ce soit. Le desktop copiait a l'aveugle et se contentait
  // d'un « rien a copier » apres coup.
  const preview = useCalendar(source)
  const copy = useCopyWeek(isoWeek)

  const sourceCount = preview.data?.entries.length ?? 0
  const ready = preview.isSuccess && sourceCount > 0 && source !== isoWeek

  const run = () => {
    setConfirming(false)
    copy.mutate(source, {
      onSuccess: (week) => {
        toast.show({ message: `${mealCount(week.entries.length)} repris depuis ${source}.` })
        onClose()
      },
    })
  }

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title="Reprendre une autre semaine"
        // Desarme aussi pendant la confirmation posee par-dessus : Echap est
        // ecoute par les deux feuilles et fermerait les deux d'un coup.
        dismissible={!copy.isPending && !confirming}
        actions={
          <>
            <button type="button" className="button button--secondary" onClick={onClose} disabled={copy.isPending}>
              Annuler
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => (weekEntryCount > 0 ? setConfirming(true) : run())}
              disabled={!ready || copy.isPending}
            >
              {copy.isPending ? 'Copie…' : 'Reprendre'}
            </button>
          </>
        }
      >
        <div className="week-source">
          <button
            type="button"
            className="week-source__arrow"
            onClick={() => setSource(previousIsoWeek(source))}
            aria-label="Semaine source précédente"
          >
            <span aria-hidden="true">‹</span>
          </button>
          <span className="week-source__body">
            <span className="week-source__week">Semaine {source.slice(6)}</span>
            <span className="week-source__meta">
              {preview.isPending && 'Lecture…'}
              {preview.isError && 'Semaine illisible.'}
              {preview.isSuccess && (sourceCount === 0 ? 'Aucun repas' : mealCount(sourceCount))}
              {` · ${source.slice(0, 4)}`}
            </span>
          </span>
          <button
            type="button"
            className="week-source__arrow"
            onClick={() => setSource(nextIsoWeek(source))}
            aria-label="Semaine source suivante"
          >
            <span aria-hidden="true">›</span>
          </button>
        </div>

        <p className="note">
          Les repas de cette semaine remplaceront ceux de la semaine affichée. Reprendre deux fois
          de suite ne crée donc pas de doublons.
        </p>

        {source === isoWeek && (
          <p className="text-error" role="alert">
            C’est la semaine que tu consultes : choisis-en une autre.
          </p>
        )}
        {copy.isError && (
          <p className="text-error" role="alert">
            {copy.error.message}
          </p>
        )}
      </Sheet>

      <ConfirmDialog
        open={confirming}
        title="Remplacer cette semaine ?"
        message={`Cette semaine contient déjà ${mealCount(weekEntryCount)}. Ils seront remplacés par les ${sourceCount} de la semaine ${source.slice(6)}.`}
        confirmLabel="Remplacer"
        danger
        onConfirm={run}
        onClose={() => setConfirming(false)}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Modeles
// ---------------------------------------------------------------------------

function SaveTemplateSheet({
  isoWeek,
  weekEntryCount,
  onClose,
}: {
  isoWeek: string
  weekEntryCount: number
  onClose: () => void
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const save = useSaveTemplate()
  const trimmed = name.trim()

  const run = () => {
    if (!trimmed) return
    save.mutate(
      { name: trimmed, isoWeek },
      {
        onSuccess: () => {
          toast.show({ message: `Modèle « ${trimmed} » enregistré (${mealCount(weekEntryCount)}).` })
          onClose()
        },
      },
    )
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Enregistrer comme modèle"
      dismissible={!save.isPending}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose} disabled={save.isPending}>
            Annuler
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={run}
            disabled={trimmed === '' || save.isPending}
          >
            {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </>
      }
    >
      <TextField
        autoFocus
        label="Nom du modèle"
        required
        value={name}
        onChange={setName}
        placeholder="Menu d’hiver"
        maxLength={60}
        enterKeyHint="done"
        hint="Un modèle du même nom sera remplacé."
      />
      {save.isError && (
        <p className="text-error" role="alert">
          {save.error.message}
        </p>
      )}
    </Sheet>
  )
}

function TemplatesSheet({
  isoWeek,
  weekEntryCount,
  onClose,
}: {
  isoWeek: string
  weekEntryCount: number
  onClose: () => void
}) {
  const toast = useToast()
  const templates = useTemplates()
  const apply = useApplyTemplate(isoWeek)
  const remove = useDeleteTemplate()

  const [pendingApply, setPendingApply] = useState<{ id: number; name: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<{ id: number; name: string } | null>(null)

  const run = (id: number, name: string) => {
    setPendingApply(null)
    apply.mutate(id, {
      onSuccess: (week) => {
        toast.show({ message: `« ${name} » appliqué : ${mealCount(week.entries.length)}.` })
        onClose()
      },
    })
  }

  const items = templates.data?.items ?? []

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title="Modèles de semaine"
        dismissible={!apply.isPending && pendingApply === null && pendingDelete === null}
      >
        {templates.isPending && <p className="picker__status">Lecture…</p>}
        {templates.isError && (
          <p className="text-error" role="alert">
            {templates.error.message}
          </p>
        )}
        {templates.isSuccess && items.length === 0 && (
          <p className="picker__status">
            Aucun modèle. Compose une semaine, puis « Enregistrer comme modèle ».
          </p>
        )}

        <ul className="template-list">
          {items.map((template) => (
            <li key={template.id} className="template">
              <button
                type="button"
                className="template__apply"
                disabled={apply.isPending}
                onClick={() =>
                  weekEntryCount > 0
                    ? setPendingApply({ id: template.id, name: template.name })
                    : run(template.id, template.name)
                }
              >
                <span className="template__name">{template.name}</span>
                <span className="template__meta">{mealCount(template.entryCount)}</span>
              </button>
              <button
                type="button"
                className="template__delete"
                onClick={() => setPendingDelete({ id: template.id, name: template.name })}
                aria-label={`Supprimer le modèle ${template.name}`}
              >
                <Icon name="ui-close" size={16} />
              </button>
            </li>
          ))}
        </ul>

        {apply.isError && (
          <p className="text-error" role="alert">
            {apply.error.message}
          </p>
        )}
      </Sheet>

      <ConfirmDialog
        open={pendingApply !== null}
        title="Remplacer cette semaine ?"
        message={`Cette semaine contient déjà ${mealCount(weekEntryCount)}. Le modèle « ${pendingApply?.name ?? ''} » les remplacera.`}
        confirmLabel="Appliquer"
        danger
        onConfirm={() => pendingApply && run(pendingApply.id, pendingApply.name)}
        onClose={() => setPendingApply(null)}
      />

      {/* Le desktop supprimait un modele sans confirmation ni annulation, a un
          pixel du bouton qui l'applique. On confirme : c'est la seule action
          de cet ecran qu'aucun « Annuler » ne rattrape. */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Supprimer ce modèle ?"
        message={`« ${pendingDelete?.name ?? ''} » sera perdu. Les semaines déjà composées avec ne changent pas.`}
        confirmLabel="Supprimer"
        danger
        busy={remove.isPending}
        error={remove.error?.message ?? null}
        onConfirm={() =>
          pendingDelete &&
          remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) })
        }
        onClose={() => setPendingDelete(null)}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Vider
// ---------------------------------------------------------------------------

function ClearDayDialog({
  isoWeek,
  dayOfWeek,
  count,
  onClose,
}: {
  isoWeek: string
  dayOfWeek: number
  count: number
  onClose: () => void
}) {
  const clear = useClearDay(isoWeek)
  const label = DAY_LABELS[dayOfWeek] ?? 'ce jour'

  return (
    <ConfirmDialog
      open
      title={`Vider ${label.toLowerCase()} ?`}
      // Pas d'annulation possible sur un vidage en lot : la confirmation
      // remplace le toast « Annuler » des suppressions a l'unite.
      message={`Les ${mealCount(count)} de ${label.toLowerCase()} seront retirés. Cette action ne peut pas être annulée.`}
      confirmLabel="Vider"
      danger
      busy={clear.isPending}
      error={clear.error?.message ?? null}
      onConfirm={() => clear.mutate(dayOfWeek, { onSuccess: onClose })}
      onClose={onClose}
    />
  )
}

function ClearWeekDialog({
  isoWeek,
  count,
  onClose,
}: {
  isoWeek: string
  count: number
  onClose: () => void
}) {
  const clear = useClearWeek(isoWeek)

  return (
    <ConfirmDialog
      open
      title="Vider la semaine ?"
      message={`Les ${mealCount(count)} de la semaine ${isoWeek.slice(6)} seront retirés. Cette action ne peut pas être annulée.`}
      confirmLabel="Tout vider"
      danger
      busy={clear.isPending}
      error={clear.error?.message ?? null}
      onConfirm={() => clear.mutate(undefined, { onSuccess: onClose })}
      onClose={onClose}
    />
  )
}
