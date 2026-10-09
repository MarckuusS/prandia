/**
 * Bibliotheque personnelle d'ingredients — liste et fiche.
 *
 * Le desktop affichait les deux cote a cote dans un SplitView 42/58. En 375 px
 * on empile : la liste, puis la fiche, avec le bouton Retour du telephone pour
 * revenir. La fiche gagne au passage une vraie adresse — /ingredients/42 est
 * partageable et navigable — ce qui remplace le `navigateToIngredient(id)`
 * global du desktop.
 *
 * Ce qui est different, et volontairement :
 *
 *   - Tri, groupement et filtres vivent dans l'URL, pas dans un `useState` ni
 *     dans QSettings. Un rafraichissement en magasin ne remet donc pas la vue
 *     a plat, le lien est partageable, et surtout le bouton Retour ANNULE un
 *     filtre — impossible avec un etat persistant silencieux, qui pouvait
 *     rouvrir le desktop sur une bibliotheque en apparence vide.
 *
 *   - Les quatre bascules les plus utiles (saison, prix, poids unitaire,
 *     marque) sont directement sous la recherche plutot qu'enterrees dans une
 *     fenetre de filtres avancés.
 *
 *   - La suppression est annulable. Le DELETE ne rend pas d'instantane ; c'est
 *     la fiche deja chargee qui voyage dans l'etat de navigation, et la liste
 *     la rejoue si l'utilisateur revient en arriere.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { formatGrams, isInSeasonNow, type Ingredient } from '@prandia/shared'

import { Sheet } from '../components/Sheet.js'
import { EmptyState, ErrorState, LoadingRows, SourceBadge } from '../components/States.js'
import {
  useAddToLibrary,
  useCreateIngredient,
  useIngredient,
  useIngredients,
} from '../lib/queries.js'
import { CriteriaFields } from './ingredients/CriteriaFields.js'
import { ImportSheet } from './ingredients/ImportSheet.js'
import { IngredientForm } from './ingredients/IngredientForm.js'
import {
  GROUP_MODES,
  NO_FILTERS,
  QUICK_TOGGLES,
  SORT_FIELDS,
  activeFilterCount,
  directionLabel,
  filterIngredients,
  groupIngredients,
  readViewOptions,
  sortIngredients,
  toggleLabel,
  toggleQuickFilter,
  toggleRayon,
  toggleSource,
  CRITERION_FIELDS,
  viewOptionsToParams,
  type GroupMode,
  type LibraryFilters,
  toggleSection,
  type SortField,
  type ViewOptions,
} from './ingredients/model.js'
import { Icon, RayonIcon, iconForRayon, type IconName } from '../icons/index.js'
import { useRayonStyle } from '../lib/useRayonStyle.js'
import '../styles/ingredients.css'

const SOURCE_CHOICES = [
  { value: 'ciqual', label: 'CIQUAL' },
  { value: 'openfoodfacts', label: 'OpenFoodFacts' },
  { value: 'manual', label: 'Manuel' },
] as const

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

export function IngredientsScreen() {
  const [params, setParams] = useSearchParams()
  const view = useMemo(() => readViewOptions(params), [params])

  // Le champ de recherche garde son propre tampon : l'URL n'est reecrite qu'au
  // bout de 200 ms, sinon chaque lettre creerait une entree d'historique et
  // relancerait une requete reseau.
  const [text, setText] = useState(view.query)
  const [seenQuery, setSeenQuery] = useState(view.query)
  const [sortOpen, setSortOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // Onglet et camera sont decides par le bouton qui ouvre la feuille : « Scanner »
  // doit tomber directement sur l'objectif, sans deux taps de plus.
  const [importTab, setImportTab] = useState<'ciqual' | 'off'>('ciqual')
  const [autoScan, setAutoScan] = useState(false)

  // L'URL peut changer sans nous : bouton Retour, lien partage, reinitialisation
  // des filtres. Sans cette resynchronisation pendant le rendu, le tampon de
  // saisie reecrirait l'ancienne recherche 200 ms plus tard et le bouton Retour
  // ne fonctionnerait pas sur la recherche.
  if (seenQuery !== view.query) {
    setSeenQuery(view.query)
    setText(view.query)
  }

  const setView = (next: Partial<ViewOptions>) => {
    // `replace` : regler un tri ne doit pas obliger a taper cinq fois sur
    // Retour pour sortir de l'ecran.
    setParams(viewOptionsToParams({ ...view, ...next }), { replace: true })
  }

  useEffect(() => {
    if (text === view.query) return
    const timer = setTimeout(
      () => setParams(viewOptionsToParams({ ...view, query: text }), { replace: true }),
      200,
    )
    return () => clearTimeout(timer)
  }, [text, view, setParams])

  const list = useIngredients(view.query)
  const filterCount = activeFilterCount(view.filters)
  const rayons = useRayonChoices(list.data?.items)
  const styleOf = useRayonStyle()

  const sections = useMemo(() => {
    const items = list.data?.items ?? []
    return groupIngredients(
      sortIngredients(filterIngredients(items, view.filters), view.sort, view.desc),
      view.group,
    )
  }, [list.data, view.filters, view.sort, view.desc, view.group])

  const shown = sections.reduce((total, section) => total + section.items.length, 0)
  const loaded = list.data?.items.length ?? 0

  /**
   * Recherche ou filtre en cours : on deplie tout, quoi qu'ait choisi
   * l'utilisateur.
   *
   * Sans cette regle, taper "tomate" repondrait par une pile d'en-tetes replies
   * et rien d'autre. L'ecran aurait l'air cassé alors qu'il a trouve. Le
   * repliage sert a lire une bibliotheque entiere, pas a cacher un resultat.
   */
  const expandAll = view.query.trim() !== '' || filterCount > 0

  return (
    <section className="screen">
      <UndoBanner />

      <input
        type="search"
        className="search-field"
        placeholder="Rechercher dans ma bibliothèque…"
        value={text}
        onChange={(event) => setText(event.target.value)}
        // Le clavier iOS affiche « rechercher » plutot que « entrée », et
        // l'absence d'autocorrection evite les corrections parasites sur des
        // noms d'aliments.
        enterKeyHint="search"
        autoCorrect="off"
        autoCapitalize="off"
        aria-label="Rechercher dans ma bibliothèque"
      />

      {/* Trois entrees pour peupler la bibliotheque, de la plus rapide a la
          plus laborieuse. « Scanner » ouvre l'import camera allumee : devant un
          produit en main, c'est le chemin le plus court, et il etait absent.
          Les glyphes decoratifs sont partis — le « ＋ » pleine chasse et la
          fleche ⇩ ne s'accordaient ni entre eux ni avec le reste. */}
      <div className="ing-toolbar">
        <button
          type="button"
          className="button button--primary ing-toolbar__action"
          onClick={() => {
            setImportTab('off')
            setAutoScan(true)
            setImportOpen(true)
          }}
        >
          Scanner
        </button>
        <button
          type="button"
          className="button button--secondary ing-toolbar__action"
          onClick={() => {
            setImportTab('ciqual')
            setAutoScan(false)
            setImportOpen(true)
          }}
        >
          Importer
        </button>
        <Link to="/ingredients/nouveau" className="button button--secondary ing-toolbar__action lien-surface">
          Nouveau
        </Link>
      </div>

      <div className="ing-chips" role="group" aria-label="Filtres rapides">
        {QUICK_TOGGLES.map((toggle) => (
          <button
            key={toggle.code}
            type="button"
            className={`ing-chip ing-chip--${view.filters[toggle.code]}`}
            aria-pressed={view.filters[toggle.code] !== 'indifferent'}
            onClick={() => setView({ filters: toggleQuickFilter(view.filters, toggle.code) })}
          >
            <Icon name={toggle.icon} size={14} className="icon--inline" />{' '}
            {toggleLabel(toggle, view.filters[toggle.code])}
          </button>
        ))}
        <button
          type="button"
          className={`ing-chip${filterCount > 0 ? ' ing-chip--on' : ''}`}
          onClick={() => setFiltersOpen(true)}
        >
          <Icon name="ui-filter" size={16} className="icon--inline" /> Filtres
          {filterCount > 0 ? ` · ${filterCount}` : ''}
        </button>
        <button type="button" className="ing-chip" onClick={() => setSortOpen(true)}>
          <Icon name="ui-sort" size={16} className="icon--inline" />{' '}
          {SORT_FIELDS.find((field) => field.code === view.sort)?.label ?? 'Nom'}
        </button>
      </div>

      {list.isPending && <LoadingRows />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}

      {list.isSuccess && loaded === 0 && (
        <EmptyState title={view.query ? 'Aucun résultat' : 'Bibliothèque vide'}>
          {view.query
            ? `Rien ne correspond à « ${view.query} » dans ta bibliothèque.`
            : 'Crée un ingrédient avec « Nouveau », ou importe-en depuis CIQUAL et OpenFoodFacts.'}
        </EmptyState>
      )}

      {/* Le desktop ne disait RIEN quand les filtres masquaient tout : la liste
          restait simplement vide, sans explication. C'est le trou le plus
          couteux a combler en tactile, ou l'on ne voit pas les filtres actifs
          d'un coup d'oeil. */}
      {list.isSuccess && loaded > 0 && shown === 0 && (
        <EmptyState title="Tout est masqué">
          {filterCount} filtre{filterCount > 1 ? 's' : ''} cache{filterCount > 1 ? 'nt' : ''} les{' '}
          {loaded} ingrédients chargés.{' '}
          <button
            type="button"
            className="button button--ghost"
            onClick={() => setView({ filters: NO_FILTERS })}
          >
            Réinitialiser les filtres
          </button>
        </EmptyState>
      )}

      {list.isSuccess && shown > 0 && (
        <>
          <p className="list-count">
            {shown} ingrédient{shown > 1 ? 's' : ''}
            {shown !== loaded && ` sur ${loaded}`}
          </p>
          {sections.map((section) => {
            // Une section sans cle est le mode "Aucun groupement" : elle n'a
            // pas d'en-tete, donc rien pour la rouvrir. Toujours depliee.
            const collapsible = section.key !== ''
            const open = !collapsible || expandAll || view.open.includes(section.key)
            return (
              <div key={section.key} className="ing-section">
                {collapsible && (
                  <button
                    type="button"
                    className="section-header ing-section__header"
                    aria-expanded={open}
                    // Ne teinte QUE le groupement par rayon : les autres modes
                    // groupent par source, saison ou tranche de calories, ou
                    // une couleur de rayon ne voudrait rien dire.
                    {...(view.group === 'rayon' ? styleOf(section.key).tint : {})}
                    onClick={() => setView({ open: toggleSection(view.open, section.key) })}
                  >
                    <span className="ing-section__chevron">
                      <Icon name={open ? 'ui-chevron-down' : 'ui-chevron-right'} size={16} />
                    </span>
                    <span className="icon-chip ing-section__icon">
                      {view.group === 'rayon' ? (
                        <RayonIcon glyph={styleOf(section.key).glyph} size={22} />
                      ) : (
                        <Icon name={groupIcon(view.group, section.key)} size={22} strokeWidth={1.7} />
                      )}
                    </span>
                    <span className="ing-section__name">{section.key}</span>
                    {/* Le compte reste visible repliee : sinon une section
                        fermee ne dit rien de ce qu'elle contient. */}
                    <span className="ing-section__count">{section.items.length}</span>
                  </button>
                )}
                {open && (
                  <ul className="row-list">
                    {section.items.map((ingredient) => (
                      <IngredientRow key={ingredient.id ?? ingredient.name} ingredient={ingredient} />
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </>
      )}

      <SortSheet
        open={sortOpen}
        onClose={() => setSortOpen(false)}
        view={view}
        onChange={(sort, desc, group) => setView({ sort, desc, group })}
      />

      <FiltersSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        filters={view.filters}
        rayons={rayons}
        onChange={(filters) => setView({ filters })}
      />

      <ImportSheet
        open={importOpen}
        onClose={() => setImportOpen(false)}
        initialTab={importTab}
        autoScan={autoScan}
      />
    </section>
  )
}

/** Rayons reellement presents dans la bibliotheque — pas ceux du catalogue entier. */
function useRayonChoices(items: readonly Ingredient[] | undefined): string[] {
  return useMemo(() => {
    const names = new Set<string>()
    for (const item of items ?? []) if (item.categoryL1) names.add(item.categoryL1)
    return [...names].sort((a, b) => a.localeCompare(b, 'fr'))
  }, [items])
}

/**
 * Icone de l'en-tete de groupe.
 *
 * Elle depend du MODE et pas seulement de la cle : « Boissons » designe un
 * rayon en mode rayon, et rien du tout en mode saisonnalite. Les trois autres
 * modes prennent donc un symbole de leur critere, jamais un dessin de rayon
 * qui serait faux.
 */
function groupIcon(mode: GroupMode, key: string): IconName {
  switch (mode) {
    case 'rayon':
      // « Sans rayon » ne correspond a aucune regle : la cagette tombe d'elle-meme.
      return iconForRayon(key)
    case 'source':
      return 'ui-tag'
    case 'season':
      return 'ui-leaf'
    case 'kcal':
      return 'ui-flame'
    default:
      return 'rayon-autre'
  }
}

function IngredientRow({ ingredient }: { ingredient: Ingredient }) {
  const styleOf = useRayonStyle()
  // Une macro inconnue fait disparaitre son etiquette — pas de « P — » qui
  // occuperait la place sans rien dire. Les couleurs sont des codes de lecture
  // partages avec le reste de l'application : elles ne suivent pas le theme.
  const macros: Array<{ key: string; label: string; value: number }> = []
  if (ingredient.proteins !== null) macros.push({ key: 'proteins', label: 'P', value: ingredient.proteins })
  if (ingredient.carbs !== null) macros.push({ key: 'carbs', label: 'G', value: ingredient.carbs })
  if (ingredient.fats !== null) macros.push({ key: 'fats', label: 'L', value: ingredient.fats })

  return (
    <li className="row">
      <Link to={`/ingredients/${ingredient.id}`} className="row__link lien-surface">
        {/* La liste est triee par nom par defaut, donc les rayons y sont
            melanges : la pastille est le seul endroit ou l'on voit d'un coup
            d'oeil a quel rayon appartient chaque ingredient. */}
        <span className="icon-chip" {...styleOf(ingredient.categoryL1).tint}>
          <RayonIcon glyph={styleOf(ingredient.categoryL1).glyph} size={22} />
        </span>
        <span className="row__body">
          <span className="row__title">{ingredient.name}</span>
          <span className="row__meta">
            <SourceBadge source={ingredient.source} />
            {isInSeasonNow(ingredient) && (
              <span className="badge badge--season">
                <Icon name="ui-leaf" size={12} />
                saison
              </span>
            )}
            {ingredient.kcal !== null && <span>{Math.round(ingredient.kcal)} kcal</span>}
            {macros.map((macro) => (
              <span key={macro.key} className={`ing-macro ing-macro--${macro.key}`}>
                {macro.label} {macro.value.toLocaleString('fr-FR')} g
              </span>
            ))}
            {ingredient.pieceWeightG !== null && (
              <span className="ing-piece">1 pc = {formatGrams(ingredient.pieceWeightG)}</span>
            )}
          </span>
        </span>
        <span className="row__chevron">
          <Icon name="ui-chevron-right" size={18} />
        </span>
      </Link>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Tri et groupement
// ---------------------------------------------------------------------------

/**
 * Les 18 tris du desktop, decomposes.
 *
 * Un menu deroulant de 18 entrees se rate au pouce. Critere et sens sont donc
 * separes, ce qui ramene chaque changement a un tap sur une cible pleine
 * largeur — et divise par deux la longueur de la liste a parcourir.
 */
function SortSheet({
  open,
  onClose,
  view,
  onChange,
}: {
  open: boolean
  onClose: () => void
  view: ViewOptions
  onChange: (sort: SortField, desc: boolean, group: GroupMode) => void
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Trier et grouper">
      <fieldset className="ing-choices">
        <legend className="ing-choices__legend">Trier par</legend>
        {SORT_FIELDS.map((field) => (
          <button
            key={field.code}
            type="button"
            className={`ing-choice${view.sort === field.code ? ' ing-choice--on' : ''}`}
            aria-pressed={view.sort === field.code}
            onClick={() => onChange(field.code, view.desc, view.group)}
          >
            {field.label}
          </button>
        ))}
      </fieldset>

      <fieldset className="ing-choices">
        <legend className="ing-choices__legend">Sens</legend>
        {[false, true].map((desc) => (
          <button
            key={String(desc)}
            type="button"
            className={`ing-choice${view.desc === desc ? ' ing-choice--on' : ''}`}
            aria-pressed={view.desc === desc}
            onClick={() => onChange(view.sort, desc, view.group)}
          >
            {directionLabel(view.sort, desc)}
          </button>
        ))}
      </fieldset>

      <fieldset className="ing-choices">
        <legend className="ing-choices__legend">Grouper par</legend>
        {GROUP_MODES.map((mode) => (
          <button
            key={mode.code}
            type="button"
            className={`ing-choice${view.group === mode.code ? ' ing-choice--on' : ''}`}
            aria-pressed={view.group === mode.code}
            onClick={() => onChange(view.sort, view.desc, mode.code)}
          >
            {mode.label}
          </button>
        ))}
      </fieldset>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Filtres
// ---------------------------------------------------------------------------

/**
 * Aucune case cochee = toutes les valeurs. Jamais « aucune ».
 *
 * C'est la semantique du desktop et elle merite d'etre dite a l'ecran : sans
 * la mention, une section vide se lit comme un filtre qui masque tout.
 */
function FiltersSheet({
  open,
  onClose,
  filters,
  rayons,
  onChange,
}: {
  open: boolean
  onClose: () => void
  filters: LibraryFilters
  rayons: readonly string[]
  onChange: (filters: LibraryFilters) => void
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Filtres"
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={() => onChange(NO_FILTERS)}>
            <Icon name="ui-refresh" size={16} className="icon--inline" /> Réinitialiser
          </button>
          <button type="button" className="button button--primary" onClick={onClose}>
            Voir les résultats
          </button>
        </>
      }
    >
      <fieldset className="ing-choices">
        <legend className="ing-choices__legend">Source</legend>
        {SOURCE_CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className={`ing-choice${filters.sources.includes(choice.value) ? ' ing-choice--on' : ''}`}
            aria-pressed={filters.sources.includes(choice.value)}
            onClick={() => onChange(toggleSource(filters, choice.value))}
          >
            {choice.label}
          </button>
        ))}
        <p className="field__hint">Aucune case cochée : toutes les sources sont affichées.</p>
      </fieldset>

      {rayons.length > 0 && (
        <fieldset className="ing-choices">
          <legend className="ing-choices__legend">Rayon</legend>
          {rayons.map((rayon) => (
            <button
              key={rayon}
              type="button"
              className={`ing-choice${filters.rayons.includes(rayon) ? ' ing-choice--on' : ''}`}
              aria-pressed={filters.rayons.includes(rayon)}
              onClick={() => onChange(toggleRayon(filters, rayon))}
            >
              {rayon}
            </button>
          ))}
          <p className="field__hint">Aucun rayon coché : tous les rayons sont affichés.</p>
        </fieldset>
      )}

      <fieldset className="ing-choices">
        <legend className="ing-choices__legend">Filtres rapides</legend>
        {QUICK_TOGGLES.map((toggle) => (
          <button
            key={toggle.code}
            type="button"
            className={`ing-choice ing-choice--${filters[toggle.code]}`}
            aria-pressed={filters[toggle.code] !== 'indifferent'}
            onClick={() => onChange(toggleQuickFilter(filters, toggle.code))}
          >
            <Icon name={toggle.icon} size={14} className="icon--inline" />{' '}
            {toggleLabel(toggle, filters[toggle.code])}
          </button>
        ))}
        <p className="field__hint">
          Trois positions : indifférent, puis « avec », puis « sans ». Le troisième état est celui
          qui sert à compléter sa bibliothèque — « sans prix » montre ce qu’il reste à renseigner.
        </p>
      </fieldset>

      <fieldset className="ing-choices">
        <legend className="ing-choices__legend">Marque</legend>
        <input
          type="text"
          className="search-field"
          value={filters.brand}
          onChange={(e) => onChange({ ...filters, brand: e.target.value })}
          placeholder="Une partie du nom suffit"
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Filtrer par marque"
        />
        <p className="field__hint">Accents et majuscules sont ignorés.</p>
      </fieldset>

      <CriteriaFields
        criteria={filters.criteria}
        onChange={(criteria) => onChange({ ...filters, criteria: criteria as LibraryFilters['criteria'] })}
        fields={CRITERION_FIELDS}
      />
    </Sheet>
  )
}


// ---------------------------------------------------------------------------
// Annulation d'une suppression
// ---------------------------------------------------------------------------

interface DeletionSnapshot {
  readonly removed: 'library' | 'permanent'
  readonly ingredient: Ingredient
}

/** L'etat de navigation est du JSON non type : on le verifie avant de s'en servir. */
function readSnapshot(state: unknown): DeletionSnapshot | null {
  if (typeof state !== 'object' || state === null) return null
  const deleted = (state as { deleted?: unknown }).deleted
  if (typeof deleted !== 'object' || deleted === null) return null
  const { removed, ingredient } = deleted as { removed?: unknown; ingredient?: unknown }
  if (removed !== 'library' && removed !== 'permanent') return null
  if (typeof ingredient !== 'object' || ingredient === null) return null
  return { removed, ingredient: ingredient as Ingredient }
}

/**
 * « Annuler » apres une suppression.
 *
 * Le desktop gardait l'instantane en memoire du viewmodel. Il n'y a pas
 * d'equivalent en web : c'est la fiche deja chargee qui voyage dans l'etat de
 * navigation. Deux restaurations differentes, comme sur le desktop — une ligne
 * de catalogue retrouve son drapeau et son identifiant, une fiche manuelle est
 * RECREEE et repart avec un nouvel identifiant. Les references qui pointaient
 * sur l'ancien sont alors perdues : c'est pourquoi le message le dit.
 */
function UndoBanner() {
  const location = useLocation()
  const navigate = useNavigate()
  const addToLibrary = useAddToLibrary()
  const create = useCreateIngredient()

  const snapshot = readSnapshot(location.state)
  const [dismissed, setDismissed] = useState(false)

  // Huit secondes : la cible a atteindre fait un aller-retour reseau, et le
  // telephone se lit a bout de bras.
  useEffect(() => {
    if (snapshot === null || dismissed) return
    const timer = setTimeout(() => setDismissed(true), 8000)
    return () => clearTimeout(timer)
  }, [snapshot, dismissed])

  if (snapshot === null || dismissed) return null

  const restore = () => {
    const done = () => {
      setDismissed(true)
      // On efface l'etat de navigation, sinon un retour arriere reproposerait
      // d'annuler une suppression deja annulee.
      void navigate('/ingredients', { replace: true })
    }
    const { ingredient } = snapshot
    if (snapshot.removed === 'library' && ingredient.id !== null) {
      addToLibrary.mutate(ingredient.id, { onSuccess: done })
      return
    }
    create.mutate(
      {
        name: ingredient.name,
        source: ingredient.source,
        sourceRef: ingredient.sourceRef,
        brand: ingredient.brand,
        kcal: ingredient.kcal,
        proteins: ingredient.proteins,
        carbs: ingredient.carbs,
        sugars: ingredient.sugars,
        fats: ingredient.fats,
        saturatedFats: ingredient.saturatedFats,
        fiber: ingredient.fiber,
        salt: ingredient.salt,
        pieceWeightG: ingredient.pieceWeightG,
        cookedWeightPer100gRaw: ingredient.cookedWeightPer100gRaw,
        categoryL1: ingredient.categoryL1,
        categoryL2: null,
        seasonMonths: ingredient.seasonMonths,
      },
      { onSuccess: done },
    )
  }

  const busy = addToLibrary.isPending || create.isPending
  const error = snapshot.removed === 'library' ? addToLibrary.error : create.error

  return (
    <div className="ing-undo" role="status">
      <p className="ing-undo__message">
        « {snapshot.ingredient.name} »{' '}
        {snapshot.removed === 'library' ? 'retiré de ta bibliothèque' : 'supprimé'}
      </p>
      <button type="button" className="ing-undo__action" onClick={restore} disabled={busy}>
        {busy ? '…' : 'Annuler'}
      </button>
      {error && (
        <p className="ing-undo__error" role="alert">
          {error.message}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fiche
// ---------------------------------------------------------------------------

/** Segment d'URL qui ouvre le formulaire vide. */
const NEW_SEGMENT = 'nouveau'

export function IngredientDetailScreen() {
  const params = useParams()
  const raw = params['id'] ?? ''

  if (raw === NEW_SEGMENT) {
    return (
      <section className="screen screen--ingredient">
        <h2 className="card__title">Nouvel ingrédient</h2>
        <IngredientForm ingredient={null} />
      </section>
    )
  }

  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    return (
      <section className="screen">
        <EmptyState title="Ingrédient introuvable">
          Cette adresse ne correspond à aucun ingrédient.{' '}
          <Link to="/ingredients">Revenir à la bibliothèque</Link>
        </EmptyState>
      </section>
    )
  }

  return <LoadedIngredient id={id} />
}

function LoadedIngredient({ id }: { id: number }) {
  const query = useIngredient(id)

  if (query.isPending) {
    return (
      <section className="screen">
        <LoadingRows />
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

  return (
    <section className="screen screen--ingredient">
      {/* `key` sur l'identifiant : passer d'une fiche a l'autre remonte un
          formulaire neuf, plutot que de reinjecter les valeurs dans un
          brouillon deja modifie. */}
      <IngredientForm key={query.data.id ?? 0} ingredient={query.data} />
    </section>
  )
}
