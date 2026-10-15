import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import {
  datesOfIsoWeek,
  formatAsText,
  formatEuros,
  formatGrams,
  formatShoppingQuantity,
  groupByCategory,
  type ShoppingItem,
} from '@prandia/shared'

import { Sheet } from '../components/Sheet.js'
import { EmptyState, ErrorState, LoadingRows } from '../components/States.js'
import { WeekPicker } from '../components/WeekPicker.js'
import {
  useShoppingList,
  useShoppingSession,
  useToggleChecked,
  type CommitResult,
  type ShoppingListResponse,
} from '../lib/queries.js'
import { useIsoWeekParam } from '../lib/useIsoWeekParam.js'
import { useScanParam, type ScanRequest } from '../lib/useScanParam.js'
import { Icon, RayonIcon } from '../icons/index.js'
import { useRayonStyle } from '../lib/useRayonStyle.js'
import {
  isFiltering,
  pantryCandidates,
  remainingItems,
  sumCents,
  visibleItems,
} from './courses/derive.js'
import { CostHistorySheet } from './courses/CostHistorySheet.js'
import { LineDetailSheet } from './courses/LineDetailSheet.js'
import { SessionBar } from './courses/SessionBar.js'
import { SessionScreen, SessionSummary } from './courses/SessionScreen.js'
import { useStoreMode, type StoreMode } from './courses/useStoreMode.js'
import '../styles/shopping.css'

/**
 * Liste de courses — l'ecran utilise DEBOUT, EN MAGASIN, A UNE MAIN.
 *
 * C'est l'usage numero un de l'application sur telephone, et le seul qui soit
 * strictement meilleur en mobile qu'en desktop : on l'a dans la main, dans les
 * rayons. Toute l'ergonomie en decoule — grandes cibles, sections collantes,
 * total toujours visible, cases qui survivent a un rafraichissement, aucune
 * action qui demande de la precision.
 *
 * Ce que le desktop ne savait pas faire et qui est ajoute ici :
 *   - les cases cochees sont persistees (le desktop les effacait a chaque
 *     recalcul, ce qui rendait la liste inutilisable des qu'on changeait de
 *     semaine) ;
 *   - la liste se recalcule seule apres une modification du planning ou du
 *     frigo, par invalidation de cache — le desktop demandait un clic sur
 *     « Synchroniser avec calendrier » que personne ne devinait ;
 *   - chaque ligne explique d'ou vient sa quantite et accepte un prix ;
 *   - le cout de la semaine s'archive et se compare ;
 *   - un mode courses garde l'ecran allume ;
 *   - on entre en session de courses depuis cet ecran (voir courses/).
 */
export function ShoppingScreen() {
  const week = useIsoWeekParam()
  const query = useShoppingList(week.isoWeek)
  const store = useStoreMode()

  /*
   * La session de courses partage cet onglet, et prend la main quand elle est
   * ouverte : en magasin, le chariot est ce qu'on vient faire, la liste n'en
   * est que la reference. Une route separee aurait ete plus propre, mais elle
   * aurait aussi laisse l'utilisateur revenir sur `/courses` sans plus voir
   * son chariot — exactement ce qu'on cherche a eviter.
   *
   * L'etat vit sur le SERVEUR : rouvrir l'application apres qu'iOS a decharge
   * l'onglet retrouve le chariot, sans rien de local a restaurer.
   */
  const session = useShoppingSession()
  const [showList, setShowList] = useState(false)
  /** "Ranger mes courses" vient d'etre touche : le scan en chaine s'ouvre aussitot. */
  const [ouvrirChaine, setOuvrirChaine] = useState(false)
  /*
   * Code arrive par `/courses?scan=…`, depuis le point d'entree de scan.
   *
   * `useScanParam` RETIENT sa valeur — elle doit survivre a l'effacement de
   * l'URL et, ici, a l'ouverture d'une session. On en garde donc une copie
   * locale qu'on efface des que le chariot l'a prise, sinon la demande
   * ressurgit a chaque remontage.
   */
  const scan = useScanParam()
  const [scanEnCours, setScanEnCours] = useState<ScanRequest | null>(null)
  /** Bilan de la derniere validation. Il survit a la session, qui vient de disparaitre. */
  const [summary, setSummary] = useState<CommitResult | null>(null)

  // Un code qui arrive doit trouver le CHARIOT, pas le bilan de la derniere
  // validation ni la liste. Ce n'est pas theorique : naviguer vers
  // `/courses?scan=…` alors qu'on est deja sur `/courses` ne remonte pas
  // l'ecran, et les deux etats ci-dessous garderaient leur valeur.
  useEffect(() => {
    if (scan === null) return
    setScanEnCours(scan)
    setSummary(null)
    setShowList(false)
  }, [scan])

  const state = session.data
  const live =
    state !== undefined && state.active && state.session !== null
      ? { state, session: state.session }
      : null

  if (summary !== null) {
    return <SessionSummary result={summary} onClose={() => setSummary(null)} />
  }

  if (live !== null && !showList) {
    return (
      <SessionScreen
        state={live.state}
        session={live.session}
        onShowList={() => {
          setOuvrirChaine(false)
          setShowList(true)
        }}
        ouvrirChaine={ouvrirChaine}
        onCommitted={setSummary}
        scan={scanEnCours}
        onScanTraite={() => setScanEnCours(null)}
      />
    )
  }

  return (
    <section className={`screen screen--shopping${store.active ? ' screen--store' : ''}`}>
      <SessionBar
        isoWeek={week.isoWeek}
        onEnterCart={(chaine) => {
          setOuvrirChaine(chaine)
          setShowList(false)
        }}
        pendingScan={scanEnCours}
      />

      <WeekPicker {...week} />

      <p className="shopping-head">
        <span className="shopping-head__dates">{weekRangeLabel(week.isoWeek)}</span>
        {/* Le desktop n'avait aucun rafraichissement : il fallait faire un
            aller-retour de semaine. Ici l'invalidation de cache s'en charge,
            mais le bouton reste — en magasin, on veut pouvoir forcer. */}
        <button
          type="button"
          className="shopping-head__refresh"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          {query.isFetching ? 'Actualisation…' : 'Actualiser'}
        </button>
      </p>

      {query.isPending && <LoadingRows rows={6} />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}

      {query.isSuccess && query.data.items.length === 0 && (
        <EmptyState title="Rien à acheter">
          Aucun repas n’est prévu cette semaine.{' '}
          <Link to={planningLink(week.isoWeek, week.currentWeek)}>Planifie tes repas</Link> et la
          liste se remplira toute seule.
        </EmptyState>
      )}

      {query.isSuccess && query.data.items.length > 0 && (
        <ShoppingContent isoWeek={week.isoWeek} list={query.data} store={store} />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Contenu
// ---------------------------------------------------------------------------

function ShoppingContent({
  isoWeek,
  list,
  store,
}: {
  isoWeek: string
  list: ShoppingListResponse
  store: StoreMode
}) {
  const toggle = useToggleChecked(isoWeek)
  const styleOf = useRayonStyle()
  const checked = useMemo(() => new Set(list.checkedIngredientIds), [list.checkedIngredientIds])

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [onlyMissingPrice, setOnlyMissingPrice] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [sheet, setSheet] = useState<'none' | 'actions' | 'cost'>('none')
  const [flash, setFlash] = useState<string | null>(null)

  // Le filtre se desarme tout seul quand il n'y a plus rien a filtrer : sinon,
  // renseigner le dernier prix manquant laisserait une liste vide et muette.
  const filtering = isFiltering(onlyMissingPrice, list.missingPriceCount)

  const sections = useMemo(
    () => groupByCategory(visibleItems(list.items, filtering)),
    [list.items, filtering],
  )

  // On repart de la ligne fraiche du cache et non d'une copie figee : ajouter
  // un prix depuis la feuille doit mettre a jour ce qu'elle affiche.
  const detailItem = detailId === null ? null : (list.items.find((i) => i.ingredientId === detailId) ?? null)

  const setChecked = (ingredientId: number, next: boolean) => {
    const ids = new Set(checked)
    if (next) ids.add(ingredientId)
    else ids.delete(ingredientId)
    toggle.mutate([...ids])
  }

  // Les quatre derivations vivent dans `courses/derive.ts`, testees a part :
  // enfouies dans ce composant, elles partaient avec lui le jour ou on le
  // remplace.
  const candidatsFrigo = pantryCandidates(list.items, checked)
  const remaining = remainingItems(list.items, checked)
  const remainingCents = sumCents(remaining)

  return (
    <>
      <Progression
        total={list.items.length}
        coches={list.items.length - remaining.length}
        resteEur={remainingCents / 100}
        sansPrix={list.missingPriceCount}
      />

      <div className="shopping-tools">
        <button
          type="button"
          className={`chip-toggle${store.active ? ' chip-toggle--on' : ''}`}
          aria-pressed={store.active}
          onClick={store.toggle}
        >
          {/* Nomme par ce qu'il FAIT, et non « mode courses » : ce nom laissait
              attendre une session de scan en magasin, alors qu'il ne s'agit que
              d'un confort de lecture. Le grossissement seul, sans explication,
              passait pour un zoom parasite. */}
          <Icon name="ui-screen-awake" size={16} className="icon--inline" /> Écran allumé
        </button>

        {list.missingPriceCount > 0 && (
          <button
            type="button"
            className={`chip-toggle${filtering ? ' chip-toggle--on' : ''}`}
            aria-pressed={filtering}
            onClick={() => setOnlyMissingPrice((value) => !value)}
          >
            <Icon name="ui-alert" size={16} className="icon--inline" /> {list.missingPriceCount} sans
            prix
          </button>
        )}
      </div>

      {/* Le verrou d'ecran est invisible par nature. Sans un mot pour le dire,
          activer le mode ne se manifeste que par des lignes plus grandes — donc
          par une gene, sans la contrepartie. */}
      {store.active && store.screenAwake && (
        <p className="shopping-note">
          L’écran reste allumé et les lignes sont agrandies : plus besoin de déverrouiller entre
          deux rayons.
        </p>
      )}

      {store.active && store.supported && !store.screenAwake && (
        <p className="shopping-note">
          Lignes agrandies. En revanche l’écran n’est pas maintenu allumé : le système a refusé
          (mode économie d’énergie ?).
        </p>
      )}

      {store.active && !store.supported && (
        <p className="shopping-note">
          Lignes agrandies. Ce navigateur ne sait pas maintenir l’écran allumé.
        </p>
      )}

      {/* Le desktop cochait TOUT SEUL ce que couvrait le frigo, sans rien dire.
          Sur telephone, une case cochee qu'on n'a pas cochee soi-meme se lit
          comme une erreur : on propose, l'utilisateur decide, et le resultat
          est persiste comme n'importe quelle autre case. */}
      {candidatsFrigo.length > 0 && !filtering && (
        <div className="pantry-hint">
          <p className="pantry-hint__text">
            {candidatsFrigo.length} article{candidatsFrigo.length > 1 ? 's sont' : ' est'} déjà
            au frigo en quantité suffisante.
          </p>
          <button
            type="button"
            className="button button--secondary pantry-hint__action"
            onClick={() => toggle.mutate([...checked, ...candidatsFrigo.map((i) => i.ingredientId)])}
          >
            Cocher
          </button>
        </div>
      )}

      {sections.map((section) => {
        const done = section.items.filter((i) => checked.has(i.ingredientId)).length
        const isCollapsed = collapsed.has(section.category)
        return (
          <div className="shopping-section" key={section.category}>
            <h2 className="shopping-section__header">
              {/* Replier un rayon termine raccourcit la liste a mesure qu'on
                  avance dans le magasin. Absent du desktop, ou la souris
                  survole une liste entiere sans effort. */}
              <button
                type="button"
                className="shopping-section__toggle"
                aria-expanded={!isCollapsed}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current)
                    if (!next.delete(section.category)) next.add(section.category)
                    return next
                  })
                }
              >
                <span className="shopping-section__chevron">
                  <Icon name={isCollapsed ? 'ui-chevron-right' : 'ui-chevron-down'} size={16} />
                </span>
                <span className="icon-chip icon-chip--sm" {...styleOf(section.category).tint}>
                  <RayonIcon glyph={styleOf(section.category).glyph} size={18} strokeWidth={1.8} />
                </span>
                <span className="shopping-section__name">{section.category}</span>
                <span className="shopping-section__count">
                  {done}/{section.items.length}
                </span>
              </button>
            </h2>

            {!isCollapsed && (
              <ul className="shopping-list">
                {section.items.map((item) => (
                  <ShoppingRow
                    key={item.ingredientId}
                    item={item}
                    checked={checked.has(item.ingredientId)}
                    onToggle={(next) => setChecked(item.ingredientId, next)}
                    onOpenDetail={() => setDetailId(item.ingredientId)}
                  />
                ))}
              </ul>
            )}
          </div>
        )
      })}

      <ShoppingFooter
        list={list}
        remainingCount={remaining.length}
        remainingEur={(remainingCents / 100).toFixed(2)}
        anyChecked={checked.size > 0}
        flash={flash}
        onFlash={setFlash}
        error={toggle.isError ? toggle.error.message : null}
        onOpenActions={() => setSheet('actions')}
      />

      {sheet === 'actions' && (
        <ActionsSheet
          list={list}
          checkedCount={checked.size}
          pantryCount={candidatsFrigo.length}
          onClose={() => setSheet('none')}
          onFlash={setFlash}
          onCheckPantry={() =>
            toggle.mutate([...checked, ...candidatsFrigo.map((i) => i.ingredientId)])
          }
          onUncheckAll={() => toggle.mutate([])}
          onOpenCost={() => setSheet('cost')}
        />
      )}

      {sheet === 'cost' && (
        <CostHistorySheet
          isoWeek={isoWeek}
          totalEur={list.totalEur}
          missingPriceCount={list.missingPriceCount}
          onClose={() => setSheet('none')}
        />
      )}

      {detailItem !== null && (
        <LineDetailSheet
          isoWeek={isoWeek}
          item={detailItem}
          checked={checked.has(detailItem.ingredientId)}
          onToggle={(next) => setChecked(detailItem.ingredientId, next)}
          onClose={() => setDetailId(null)}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Ligne
// ---------------------------------------------------------------------------

function ShoppingRow({
  item,
  checked,
  onToggle,
  onOpenDetail,
}: {
  item: ShoppingItem
  checked: boolean
  onToggle: (next: boolean) => void
  onOpenDetail: () => void
}) {
  return (
    <li className={`shopping-row${checked ? ' shopping-row--checked' : ''}`}>
      {/* Le <label> englobe la quasi-totalite de la ligne : la zone de tap fait
          la largeur de l'ecran, pas les 24 px de la case. Decisif avec un
          panier au bras. Le detail a son propre bouton a droite, sans quoi il
          n'y aurait aucun moyen de l'atteindre sans cocher au passage. */}
      <label className="shopping-row__label">
        <input
          type="checkbox"
          className="shopping-row__checkbox"
          checked={checked}
          onChange={(event) => onToggle(event.target.checked)}
        />
        {/* Pas de pastille sur la ligne : elle est DEJA dans l'en-tete de la
            section, et la liste est groupee par rayon. La repeter a l'identique
            sur chacun des articles du rayon n'ajouterait aucune information,
            seulement du bruit sous le pouce. */}
        <span className="shopping-row__body">
          <span className="shopping-row__name">{item.name}</span>
          <span className="shopping-row__meta">
            <span>{formatShoppingQuantity(item)}</span>
            {/* Le stock est ecrit en toutes lettres, pas seulement suggere par
                une pastille verte : le desktop cochait la ligne sans rien dire
                et l'utilisateur croyait avoir coche par erreur. Le mot
                « déjà » distingue la couverture complete du stock partiel —
                la couleur seule ne suffirait pas. */}
            {item.inPantryG > 0 && (
              <span
                className={`badge badge--pantry${item.isCoveredByPantry ? '' : ' badge--partial'}`}
              >
                {item.isCoveredByPantry ? 'déjà ' : ''}
                {formatGrams(item.inPantryG)} au frigo
              </span>
            )}
          </span>
        </span>
        <span
          className={`shopping-row__cost${item.costEur === null ? ' shopping-row__cost--missing' : ''}`}
        >
          {item.costEur === null ? 'sans prix' : formatEuros(item.costEur)}
        </span>
      </label>

      <button
        type="button"
        className="shopping-row__detail"
        onClick={onOpenDetail}
        aria-label={`Détail de ${item.name}`}
      >
        <Icon name="ui-chevron-right" size={18} />
      </button>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Pied fixe
// ---------------------------------------------------------------------------

function ShoppingFooter({
  list,
  remainingCount,
  remainingEur,
  anyChecked,
  flash,
  onFlash,
  error,
  onOpenActions,
}: {
  list: ShoppingListResponse
  remainingCount: number
  remainingEur: string
  anyChecked: boolean
  flash: string | null
  onFlash: (message: string | null) => void
  error: string | null
  onOpenActions: () => void
}) {
  useFlashTimeout(flash, onFlash)

  return (
    <div className="shopping-footer">
      {error !== null && (
        <p className="shopping-footer__error" role="alert">
          {error}
        </p>
      )}
      {flash !== null && (
        <p className="shopping-footer__flash" role="status">
          {flash}
        </p>
      )}

      <div className="shopping-footer__row">
        <div className="shopping-footer__totals">
          {/* Le desktop n'affichait que le total de la liste entiere, coches
              compris. En magasin, la seule question est « combien me reste-t-il
              a prendre ». Le total complet reste lisible juste en dessous. */}
          <span className="shopping-footer__label">
            {anyChecked ? 'Reste à acheter' : 'Total de la liste'}
          </span>
          <strong className="shopping-footer__amount">{formatEuros(remainingEur)}</strong>
          <span className="shopping-footer__detail">
            {remainingCount === 0
              ? 'tout est coché'
              : `${remainingCount} sur ${list.items.length} article${list.items.length > 1 ? 's' : ''}`}
            {anyChecked && ` · liste ${formatEuros(list.totalEur)}`}
            {list.missingPriceCount > 0 && ` · ${list.missingPriceCount} sans prix`}
          </span>
        </div>

        <div className="shopping-footer__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={() => void shareList(list, onFlash)}
          >
            Partager
          </button>
          <button
            type="button"
            className="icon-button shopping-footer__more"
            onClick={onOpenActions}
            aria-label="Autres actions"
          >
            <span aria-hidden="true">⋯</span>
          </button>
        </div>
      </div>
    </div>
  )
}

/** Le message de confirmation s'efface seul : rien a fermer d'un doigt occupe. */
function useFlashTimeout(flash: string | null, onFlash: (message: string | null) => void): void {
  useEffect(() => {
    if (flash === null) return
    const timer = setTimeout(() => onFlash(null), 3000)
    return () => clearTimeout(timer)
  }, [flash, onFlash])
}

// ---------------------------------------------------------------------------
// Feuille d'actions
// ---------------------------------------------------------------------------

function ActionsSheet({
  list,
  checkedCount,
  pantryCount,
  onClose,
  onFlash,
  onCheckPantry,
  onUncheckAll,
  onOpenCost,
}: {
  list: ShoppingListResponse
  checkedCount: number
  pantryCount: number
  onClose: () => void
  onFlash: (message: string | null) => void
  onCheckPantry: () => void
  onUncheckAll: () => void
  onOpenCost: () => void
}) {
  const run = (action: () => void) => () => {
    action()
    onClose()
  }

  return (
    <Sheet open onClose={onClose} title="Actions" variant="dialog">
      <ul className="action-list">
        <li>
          <button
            type="button"
            className="action-list__item"
            onClick={() => {
              // Pas de `run()` ici : l'appel au presse-papiers doit partir dans
              // le geste lui-meme (voir copyList), et fermer la feuille avant
              // demonterait le bouton au milieu du traitement.
              void copyList(list, onFlash).then(onClose)
            }}
          >
            <Icon name="ui-copy" size={18} /> Copier la liste
          </button>
        </li>
        <li>
          <button type="button" className="action-list__item" onClick={onOpenCost}>
            <Icon name="ui-price" size={18} /> Coût &amp; historique
          </button>
        </li>
        {pantryCount > 0 && (
          <li>
            <button type="button" className="action-list__item" onClick={run(onCheckPantry)}>
              <Icon name="ui-fridge" size={18} /> Cocher ce qui est déjà au frigo ({pantryCount})
            </button>
          </li>
        )}
        {checkedCount > 0 && (
          <li>
            <button type="button" className="action-list__item" onClick={run(onUncheckAll)}>
              <Icon name="ui-refresh" size={18} /> Tout décocher ({checkedCount})
            </button>
          </li>
        )}
      </ul>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Partage
// ---------------------------------------------------------------------------

/**
 * Partage natif, repli sur le presse-papiers.
 *
 * Le desktop copiait un texte aligne sur 40 colonnes a chasse fixe, illisible
 * dans Messages ou Notes. `formatAsText` rend desormais un texte a puces, et le
 * chemin normal sur telephone est la feuille de partage : envoyer la liste a
 * quelqu'un vaut mieux que la coller quelque part.
 *
 * Deux contraintes iOS respectees ici : l'appel doit partir d'un geste
 * utilisateur direct, et rien ne doit etre attendu avant lui — d'ou l'absence
 * de `await` en amont de `share` comme de `writeText`.
 */
async function shareList(
  list: ShoppingListResponse,
  onFlash: (message: string) => void,
): Promise<void> {
  const text = formatAsText(list)

  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: `Liste de courses ${list.isoWeek}`, text })
      return
    } catch {
      // Partage annule : on ne bascule pas sur la copie, ce serait faire
      // quelque chose que l'utilisateur vient de refuser.
      return
    }
  }

  await copyList(list, onFlash)
}

async function copyList(
  list: ShoppingListResponse,
  onFlash: (message: string) => void,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(formatAsText(list))
    onFlash('Liste copiée.')
  } catch {
    // Presse-papiers refuse : contexte non securise, ou permission niee.
    onFlash('Copie impossible depuis ce navigateur.')
  }
}

// ---------------------------------------------------------------------------
// Formatage
// ---------------------------------------------------------------------------

/** « 27 avr. → 3 mai » — la cle ISO brute du desktop ne dit rien a personne. */
function weekRangeLabel(isoWeek: string): string {
  const days = datesOfIsoWeek(isoWeek)
  const monday = days[0]
  const sunday = days[6]
  if (!monday || !sunday) return ''
  // Fuseau UTC impose : les dates sont construites a midi UTC, les lire en
  // heure locale ferait basculer d'un jour aux antipodes.
  const format = (date: Date) =>
    date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  return `${format(monday)} → ${format(sunday)}`
}

/**
 * Lien vers le planning de la MEME semaine, sans parametre inutile si c'est
 * celle en cours.
 *
 * Il visait `/semaine`, devenu un alias de compatibilite. Or `<Navigate>` avec
 * une chaine sans `search` ecrase la localisation entiere : la semaine
 * consultee etait jetee, et on composait ses repas dans la mauvaise semaine
 * sans que rien ne le signale. On vise donc l'adresse reelle.
 */
function planningLink(isoWeek: string, currentWeek: string): string {
  return isoWeek === currentWeek ? '/planning' : `/planning?semaine=${isoWeek}`
}




/**
 * Ou en est-on, et combien cela coute.
 *
 * LE TOTAL DIT CE QU'IL VAUT. Le mockup annonce "Total estime : 38,90 EUR" sans
 * rien de plus ; or deux tiers seulement des ingredients de la bibliotheque ont
 * un prix, et un total nu se lirait comme complet. Le nombre est juste, c'est
 * le libelle qui mentait : il porte donc son nombre de lignes sans prix, comme
 * la carte de nutrition dit "3 ingredients ont des valeurs manquantes".
 *
 * "Environ" et non un montant sec : les prix sont les DERNIERS RELEVES, tous
 * magasins confondus, et le projet n'a pas de prix par magasin.
 */
function Progression({
  total,
  coches,
  resteEur,
  sansPrix,
}: {
  readonly total: number
  readonly coches: number
  readonly resteEur: number
  readonly sansPrix: number
}) {
  if (total === 0) return null
  const part = Math.round((coches / total) * 100)

  return (
    <div className="card progression">
      <div className="progression__haut">
        <span className="progression__gauche">
          <span className="chiffre">{coches}</span> / {total} dans le panier
        </span>
        {/* AUCUN PRIX CONNU N'EST PAS ZERO EURO. Avec six articles sans prix,
            "Environ 0,00 EUR" se lit comme "c'est gratuit". On ne montre alors
            aucun montant : c'est la meme regle que le tableau de nutrition, qui
            ecrit un tiret plutot qu'un zero quand il n'y a rien a totaliser. */}
        <span className="progression__droite">
          {sansPrix >= total
            ? 'Prix inconnus'
            : `${sansPrix > 0 ? 'Environ ' : ''}${formatEuros(String(resteEur))} à prendre`}
        </span>
      </div>

      <span
        className="progression__piste"
        role="img"
        aria-label={`${coches} sur ${total} articles cochés`}
      >
        <span className="progression__part" style={{ width: `${part}%` }} />
      </span>

      {/* Dit une fois, sous le nombre, plutot qu'accole a lui : accole, il
          transformait le montant en avertissement. */}
      {sansPrix > 0 && (
        <p className="progression__note">
          {sansPrix} article{sansPrix > 1 ? 's' : ''} sans prix ne compte
          {sansPrix > 1 ? 'nt' : ''} pas dans ce montant.
        </p>
      )}
    </div>
  )
}
