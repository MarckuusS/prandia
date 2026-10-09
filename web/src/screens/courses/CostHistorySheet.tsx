/**
 * Cout de la semaine : archivage et comparaison.
 *
 * Le desktop affichait un total et l'oubliait aussitot : changer de semaine
 * l'ecrasait, et rien ne permettait de savoir si l'on depensait plus ce
 * mois-ci que le mois dernier. La table `weekly_cost_snapshot` existe pour ca.
 *
 * Pourquoi un instantane explicite plutot qu'un calcul a la demande : recalculer
 * le cout d'une semaine passee donnerait les prix D'AUJOURD'HUI. Seul un montant
 * fige au moment des courses rend la comparaison honnete.
 */

import { formatEuros } from '@prandia/shared'

import { Sheet } from '../../components/Sheet.js'
import { EmptyState, ErrorState, LoadingRows } from '../../components/States.js'
import { useShoppingHistory, useSnapshotWeek, type WeekCost } from '../../lib/queries.js'

export interface CostHistorySheetProps {
  readonly isoWeek: string
  /** Total courant de la semaine affichee, chaine decimale. */
  readonly totalEur: string
  readonly missingPriceCount: number
  readonly onClose: () => void
}

export function CostHistorySheet({
  isoWeek,
  totalEur,
  missingPriceCount,
  onClose,
}: CostHistorySheetProps) {
  const snapshot = useSnapshotWeek(isoWeek)
  const history = useShoppingHistory()

  const items = history.data?.items ?? []
  const alreadyArchived = items.some((entry) => entry.isoWeek === isoWeek)

  return (
    <Sheet
      open
      onClose={onClose}
      title="Coût des semaines"
      dismissible={!snapshot.isPending}
      actions={
        <button type="button" className="button button--secondary" onClick={onClose}>
          Fermer
        </button>
      }
    >
      <section className="line-detail__section">
        <h3 className="line-detail__title">Semaine {isoWeek.slice(6)} · {isoWeek.slice(0, 4)}</h3>
        <p className="cost-history__current">
          <strong className="cost-history__amount">{formatEuros(totalEur)}</strong>
          {missingPriceCount > 0 && (
            <span className="cost-history__warning">
              {missingPriceCount} ingrédient{missingPriceCount > 1 ? 's' : ''} sans prix — le total
              est donc un minimum.
            </span>
          )}
        </p>
        <button
          type="button"
          className="button button--primary button--block"
          onClick={() => snapshot.mutate()}
          disabled={snapshot.isPending}
        >
          {snapshot.isPending
            ? 'Archivage…'
            : alreadyArchived
              ? 'Mettre à jour l’archive'
              : 'Archiver ce coût'}
        </button>
        {snapshot.isError && (
          <p className="text-error" role="alert">
            {snapshot.error.message}
          </p>
        )}
        {snapshot.isSuccess && (
          <p className="cost-history__done" role="status">
            Coût archivé.
          </p>
        )}
      </section>

      <section className="line-detail__section">
        <h3 className="line-detail__title">Semaines archivées</h3>

        {history.isPending && <LoadingRows rows={3} />}
        {history.isError && (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} />
        )}
        {history.isSuccess && items.length === 0 && (
          <EmptyState title="Rien d’archivé">
            Archive le coût d’une semaine et tu pourras comparer les suivantes.
          </EmptyState>
        )}

        {items.length > 0 && (
          <ul className="row-list row-list--flush">
            {items.map((entry, index) => (
              <HistoryRow
                key={entry.isoWeek}
                entry={entry}
                // La liste vient triee de la plus recente a la plus ancienne :
                // la semaine a laquelle comparer est donc la SUIVANTE du tableau.
                previous={items[index + 1] ?? null}
                current={entry.isoWeek === isoWeek}
              />
            ))}
          </ul>
        )}
      </section>
    </Sheet>
  )
}

function HistoryRow({
  entry,
  previous,
  current,
}: {
  entry: WeekCost
  previous: WeekCost | null
  current: boolean
}) {
  const delta = previous === null ? null : cents(entry.totalEur) - cents(previous.totalEur)

  return (
    <li className="row row--static">
      <span className="row__body">
        <span className="row__title">
          Semaine {entry.isoWeek.slice(6)} · {entry.isoWeek.slice(0, 4)}
          {current && <span className="cost-history__tag"> en cours</span>}
        </span>
        <span className="row__meta">
          {entry.missingCount > 0 && <span>{entry.missingCount} sans prix</span>}
          {delta !== null && delta !== 0 && (
            <span className={delta > 0 ? 'cost-history__up' : 'cost-history__down'}>
              {/* Le signe moins est un vrai U+2212 : le trait d'union se
                  confond avec un tiret de liste a cette taille. */}
              {delta > 0 ? '+' : '−'}
              {formatEuros((Math.abs(delta) / 100).toFixed(2))}
            </span>
          )}
        </span>
      </span>
      <span className="row__value">{formatEuros(entry.totalEur)}</span>
    </li>
  )
}

/**
 * Montant en centimes entiers.
 *
 * Les totaux arrivent deja arrondis au centime par le serveur (`formatAmount`
 * les rend a deux decimales) : les comparer en entiers evite d'embarquer une
 * bibliotheque decimale dans le front pour une simple soustraction.
 */
function cents(amount: string): number {
  return Math.round(Number(amount) * 100)
}
