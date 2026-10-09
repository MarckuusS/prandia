/**
 * Chez moi — l'inventaire physique du foyer, en quatre espaces.
 *
 * TROIS IDEES LE PORTENT, et rien d'autre ne devrait s'y ajouter :
 *
 *   1. Le LOT est l'unite. Deux briques de lait ouvertes a une semaine d'ecart
 *      ne se confondent pas : elles ont deux peremptions, on consomme la plus
 *      urgente. La liste est donc une liste de lots, pas d'ingredients.
 *   2. CHAQUE ESPACE A SA LOGIQUE. Le frigo compte des jours, le placard un
 *      niveau, le congelateur du temps passe. Appliquer un compte a rebours
 *      rouge a un paquet de riz serait absurde, et un niveau de stock ne dit
 *      rien d'un yaourt entame. Voir `espaces.ts`.
 *   3. Ce qui est range ici est SIGNALE sur la liste de courses. C'est la
 *      raison d'etre de l'ecran, et elle n'a rien d'evident : elle est ecrite
 *      en toutes lettres, avec un lien.
 *
 * "A RANGER" N'EST PAS UN LIEU, c'est l'absence de lieu. Tout ce qui arrive des
 * courses y atterrit, parce que l'application ne sait pas ou l'on a pose le
 * paquet et qu'elle ne le devinera pas. L'onglet disparait une fois vide.
 *
 * Le desktop offrait un panneau lateral de chips a glisser-deposer. Il n'est
 * pas porte : le glisser-deposer HTML5 ne fonctionne pas au doigt sous iOS, et
 * le geste equivalent, chercher puis taper, est deja celui de la feuille
 * d'ajout. La regle metier qu'il portait (quantite par defaut = 1 piece si
 * l'ingredient en a une, 100 g sinon) est conservee la-bas.
 *
 * Le tri, le groupement, le filtre ET l'onglet vivent dans l'URL : debout
 * devant le frigo, un rafraichissement accidentel ne doit pas tout remettre a
 * zero.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  STORAGE_SPACES,
  expiringLotCount,
  formatGrams,
  restockRatio,
  type StorageSpace,
} from '@prandia/shared'

import { SelectField } from '../components/Field.js'
import { EmptyState, ErrorState, LoadingRows } from '../components/States.js'
import { Icon } from '../icons/index.js'
import { RayonIcon } from '../icons/RayonIcon.js'
import { useRayonStyle } from '../lib/useRayonStyle.js'
import { useMovements, usePantry, useSetStorage } from '../lib/queries.js'
import { useScanParam, type ScanRequest } from '../lib/useScanParam.js'
import { AddStockSheet } from './frigo/AddStockSheet.js'
import { LotSheet } from './frigo/LotSheet.js'
import {
  ESPACE_PARAM,
  espaceLabel,
  espaceParDefaut,
  espaceToParam,
  formatDepuis,
  joursDepuisEntree,
  lotsOf,
  onglets,
  type EspaceTab,
} from './frigo/espaces.js'
import {
  GROUPS,
  SORTS,
  buildLots,
  filterLots,
  formatExpiryLabel,
  formatJours,
  formatLotQuantity,
  formatLotTotal,
  groupLots,
  readOption,
  sortLots,
  type GroupValue,
  type Lot,
  type LotSection,
  type SortValue,
} from './frigo/lots.js'
import '../styles/pantry.css'

/**
 * Repli qui ne correspond a AUCUN onglet : l'espace choisi s'ecrit donc
 * toujours dans l'adresse, meme quand c'est celui par defaut. Sans cela,
 * revenir a l'onglet par defaut effacerait le parametre et un
 * rafraichissement rouvrirait ailleurs.
 */
const JAMAIS = '\u0000'

/** Seuil du seau "a consommer vite", en jours. Il inclut les lots deja perimes. */
const SOON_THRESHOLD_DAYS = 5

export function PantryScreen() {
  const query = usePantry()
  const today = useToday()

  const [params, setParams] = useSearchParams()
  const filter = params.get('q') ?? ''
  const sort = readOption<SortValue>(params.get('tri'), SORTS, 'urgence')
  /*
   * LE DEFAUT EST "AUCUN", c'est-a-dire UNE SEULE CARTE.
   *
   * Groupe par urgence, l'ecran rendait trois cartes blanches separees par du
   * vide pour six produits, et le tri "a consommer d'abord" perdait son sens :
   * il triait DANS chaque section, alors qu'on veut la liste entiere du plus
   * pressant au moins pressant. Le groupement reste offert par les chips.
   */
  const group = readOption<GroupValue>(params.get('groupe'), GROUPS, 'aucun')

  const setParam = (key: string, value: string, fallback: string) => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        // La valeur par defaut ne s'ecrit pas : l'adresse reste courte et
        // partageable tant qu'on n'a rien change.
        if (value === fallback) next.delete(key)
        else next.set(key, value)
        return next
      },
      // `replace` : filtrer lettre par lettre n'a pas a remplir l'historique,
      // le bouton Retour du telephone doit ramener a l'ecran precedent.
      { replace: true },
    )
  }

  const [addingStock, setAddingStock] = useState(false)

  /*
   * Un code arrive par `/frigo?scan=…`, depuis le point d'entree de scan.
   *
   * La cle de remontage porte le compteur : deux arrivees du MEME code doivent
   * reconstruire une feuille vierge, pas reprendre le brouillon precedent
   * (quantite, prix, date). C'est le motif deja en place cote chariot.
   */
  const scan = useScanParam()
  /*
   * Copie LOCALE du code, effacee a la fermeture.
   *
   * `useScanParam` retient sa valeur pour qu'elle survive a l'effacement de
   * l'URL, elle reste donc posee apres usage. Sans cette copie, rouvrir la
   * feuille par le bouton "+" y re-injecterait le produit deja range.
   */
  const [scanEnCours, setScanEnCours] = useState<ScanRequest | null>(null)
  useEffect(() => {
    if (scan === null) return
    setScanEnCours(scan)
    setAddingStock(true)
  }, [scan])

  const fermerAjout = () => {
    setAddingStock(false)
    setScanEnCours(null)
  }
  const [editingId, setEditingId] = useState<number | null>(null)

  const lots = useMemo(
    () => (query.data ? buildLots(query.data.items, query.data.ingredients, today) : []),
    [query.data, today],
  )

  const tabs = useMemo(() => onglets(lots), [lots])
  /*
   * L'onglet demande, s'il existe encore.
   *
   * Il peut disparaitre sous les doigts : ranger le dernier article de "A
   * ranger" supprime son onglet. On retombe alors sur le defaut plutot que
   * d'afficher une liste vide sans onglet actif.
   */
  const demande = params.get('ou')
  const espace: EspaceTab = useMemo(() => {
    const lu = demande !== null && demande in ESPACE_PARAM ? ESPACE_PARAM[demande] : undefined
    if (lu === undefined) return espaceParDefaut(lots)
    return tabs.some((t) => t.espace === lu) ? lu : espaceParDefaut(lots)
  }, [demande, lots, tabs])

  const duLieu = useMemo(() => lotsOf(lots, espace), [lots, espace])
  const visible = useMemo(() => sortLots(filterLots(duLieu, filter), sort), [duLieu, filter, sort])
  /*
   * Le groupement par urgence n'a de sens QUE la ou les dates comptent. Au
   * placard et au congelateur, il ferait une section "En stock" contenant tout,
   * ce qui est un titre pour rien.
   */
  const groupeEffectif: GroupValue = espace === 'frigo' ? group : group === 'urgence' ? 'aucun' : group
  const sections = useMemo(() => groupLots(visible, groupeEffectif), [visible, groupeEffectif])

  // Le lot en cours d'edition est relu a chaque rendu dans la liste complete :
  // la feuille suit ainsi les ecritures (une consommation change la quantite)
  // et se ferme d'elle-meme quand le lot disparait. On cherche dans `lots` et
  // non dans `visible`, sans quoi filtrer pendant l'edition la refermerait.
  const editing = editingId === null ? null : (lots.find((lot) => lot.id === editingId) ?? null)

  // L'alerte porte sur le FRIGO seul : c'est le seul espace ou une date presse.
  const pressent = useMemo(
    () =>
      query.data
        ? expiringLotCount(
            query.data.items.filter((s) => s.storage === 'frigo'),
            today,
            SOON_THRESHOLD_DAYS,
          )
        : 0,
    [query.data, today],
  )

  return (
    <section className="screen screen--pantry">
      <header className="chezmoi-entete">
        <div>
          <p className="chezmoi-entete__surtitre">
            {lots.length} produit{lots.length > 1 ? 's' : ''} suivi{lots.length > 1 ? 's' : ''}
          </p>
          <h2>Chez moi</h2>
        </div>
      </header>

      {/*
        UNE LIGNE, PAS CINQ. Le texte precedent disait vrai mais mangeait le
        tiers superieur de l'ecran avant la premiere donnee, et sur un
        telephone c'est tout ce qu'on voit en arrivant. Ce qu'il doit porter
        tient en une phrase : il se passe quelque chose sur la liste, et voici
        le lien.

        Il promettait par ailleurs deux choses fausses, que le stock etait
        RETRANCHE de la liste et qu'un ingredient couvert y arrivait COCHE. Le
        pre-cochage a ete retire apres incident et la phrase n'avait pas suivi.
      */}
      <p className="chezmoi-lien">
        Ce que tu ranges ici est signalé sur ta liste.{' '}
        <Link to="/courses">Voir la liste</Link>
      </p>

      {query.isPending && <LoadingRows />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}

      {query.isSuccess && lots.length > 0 && (
        <>
          <nav className="espaces" aria-label="Espaces de rangement">
            {tabs.map((tab) => (
              <button
                key={espaceToParam(tab.espace)}
                type="button"
                className={`espace${tab.espace === espace ? ' espace--on' : ''}`}
                aria-pressed={tab.espace === espace}
                onClick={() => setParam('ou', espaceToParam(tab.espace), JAMAIS)}
              >
                {tab.label} <span className="espace__compte">{tab.count}</span>
              </button>
            ))}
          </nav>

          {espace === null && <ARangerBandeau count={duLieu.length} />}

          {espace === 'frigo' && pressent > 0 && <UrgenceBandeau count={pressent} />}

          <PantryToolbar
            filter={filter}
            sort={sort}
            group={group}
            showGroup={espace === 'frigo'}
            onFilterChange={(value) => setParam('q', value, '')}
            onSortChange={(value) => setParam('tri', value, 'urgence')}
            onGroupChange={(value) => setParam('groupe', value, 'aucun')}
          />

          {/* Ne s'affiche QUE si un filtre masque quelque chose. Sans filtre,
              elle repetait mot pour mot le compteur de l'onglet, deux
              centimetres plus haut. */}
          {visible.length !== duLieu.length && (
            <p className="pantry-summary">
              <span>
                {visible.length} article{visible.length > 1 ? 's' : ''} sur {duLieu.length}
              </span>
            </p>
          )}
        </>
      )}

      {query.isSuccess && lots.length === 0 && (
        <EmptyState title="Rien chez toi">
          Rien en stock pour l’instant. Ajoute ce que tu as sous la main : la liste de courses en
          tiendra compte dès le prochain calcul.{' '}
          <button type="button" className="button button--ghost" onClick={() => setAddingStock(true)}>
            Ajouter au stock
          </button>
        </EmptyState>
      )}

      {/* Trois etats vides distincts, la ou le desktop n'en avait qu'un : rien
          nulle part, rien DANS CET ESPACE, et rien qui corresponde au filtre.
          Le message unique laissait croire a un frigo vide alors qu'un mot
          restait dans le champ. */}
      {query.isSuccess && lots.length > 0 && duLieu.length === 0 && (
        <EmptyState title={`${espaceLabel(espace)} vide`}>
          Rien de rangé ici pour l’instant.
        </EmptyState>
      )}

      {query.isSuccess && duLieu.length > 0 && visible.length === 0 && (
        <EmptyState title="Aucun résultat">
          Rien ne correspond à « {filter} » dans {espaceLabel(espace).toLowerCase()}.{' '}
          <button type="button" className="button button--ghost" onClick={() => setParam('q', '', '')}>
            Effacer le filtre
          </button>
        </EmptyState>
      )}

      {sections.map((section) => (
        <PantrySection
          key={section.key}
          section={section}
          espace={espace}
          today={today}
          onOpen={setEditingId}
        />
      ))}

      {query.isSuccess && lots.length > 0 && <BilanSorties />}

      {query.isSuccess && (
        <button
          type="button"
          className="pantry-fab"
          onClick={() => setAddingStock(true)}
          aria-label="Ajouter au stock"
        >
          <span aria-hidden="true">+</span>
        </button>
      )}

      {addingStock && (
        <AddStockSheet
          key={scanEnCours === null ? 'manuel' : `${scanEnCours.ean}-${scanEnCours.nonce}`}
          initialScan={scanEnCours?.ean}
          onClose={fermerAjout}
        />
      )}
      {editing && <LotSheet key={editing.id} lot={editing} onClose={() => setEditingId(null)} />}
    </section>
  )
}

// ---------------------------------------------------------------------------

function ARangerBandeau({ count }: { readonly count: number }) {
  return (
    <p className="bandeau bandeau--ranger">
      <Icon name="ui-cart" size={18} className="icon--inline" />
      <span>
        <strong>
          {count} article{count > 1 ? 's' : ''}
        </strong>{' '}
        {count > 1 ? 'arrivent' : 'arrive'} des courses. Donne-leur une place, et la date lue sur
        l’emballage.
      </span>
    </p>
  )
}

function UrgenceBandeau({ count }: { readonly count: number }) {
  return (
    <p className="bandeau bandeau--urgence">
      <Icon name="ui-alert" size={18} className="icon--inline" />
      <span>
        <strong>
          {count} produit{count > 1 ? 's' : ''}
        </strong>{' '}
        à consommer sous {SOON_THRESHOLD_DAYS} jours.
      </span>
      {/* Le repertoire sait deja croiser recettes et frigo : on y renvoie plutot
          que de recalculer ici une liste de recettes possibles. */}
      <Link to="/recettes?frigo=1" className="bandeau__lien lien-surface">
        Que cuisiner ?
      </Link>
    </p>
  )
}

/**
 * Le bilan des sorties de la semaine.
 *
 * IL N'EXISTE QUE PARCE QUE LA QUESTION EST POSEE AU MOMENT DU GESTE. Un bilan
 * deduit de differences de stock compterait comme "jete" tout ce qui a ete
 * mange. Ce n'est ni une note, ni une tendance, et cela ne modifie aucune liste
 * de courses : c'est un chiffre, et il est vrai.
 *
 * Rien ne s'affiche tant qu'aucune sortie n'a ete saisie : une ligne a
 * "0 g jeté" se lirait comme un satisfecit alors qu'elle ne dit rien.
 */
function BilanSorties() {
  const depuis = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return d.toISOString().slice(0, 10)
  }, [])
  const bilan = useMovements(depuis)

  if (!bilan.isSuccess) return null
  const { consommeG, jeteG } = bilan.data
  if (consommeG === 0 && jeteG === 0) return null

  return (
    <p className="bilan-sorties">
      Ces 7 jours : <strong>{formatGrams(consommeG)}</strong> consommés
      {jeteG > 0 && (
        <>
          , <strong>{formatGrams(jeteG)}</strong> jetés
        </>
      )}
      .
    </p>
  )
}

function PantryToolbar({
  filter,
  sort,
  group,
  showGroup,
  onFilterChange,
  onSortChange,
  onGroupChange,
}: {
  filter: string
  sort: SortValue
  group: GroupValue
  /** Le groupement par urgence n'a de sens qu'au frigo. */
  showGroup: boolean
  onFilterChange: (value: string) => void
  onSortChange: (value: SortValue) => void
  onGroupChange: (value: GroupValue) => void
}) {
  return (
    <div className="pantry-toolbar">
      <div className="pantry-toolbar__search">
        {/* Filtrage cote client : le frigo d'un foyer tient en quelques dizaines
            de lignes, et une requete HTTP par frappe, ce que faisait le
            desktop en SQL local, est inacceptable en 4G. */}
        <input
          type="search"
          className="search-field"
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
          placeholder="Filtrer par nom…"
          aria-label="Filtrer par nom"
          autoComplete="off"
          enterKeyHint="search"
        />
        {filter !== '' && (
          <button
            type="button"
            className="pantry-toolbar__clear"
            onClick={() => onFilterChange('')}
            aria-label="Effacer le filtre"
          >
            <Icon name="ui-close" size={16} />
          </button>
        )}
      </div>

      {/*
        DES CHIPS, PAS UN MENU DEROULANT.
        Un menu cache le choix actif derriere un appui et n'en montre qu'un a la
        fois ; les chips disent d'un coup d'oeil ce qui est actif et ce qui est
        possible, et se tapent sans dialogue. C'est ce que fait deja le
        repertoire de recettes, et c'est ce que montre la maquette.

        Les CINQ tris restent atteignables : les trois premiers en chips, les
        deux autres derriere le dernier chip, qui fait defiler la rangee. Aucun
        n'a disparu, ils sont seulement hierarchises par usage.
      */}
      {/* UNE SEULE RANGEE, qui defile. Deux rangees prenaient trente-six pixels
          de plus avant la premiere donnee, sur un ecran ou l'on en compte huit
          cent : le groupement suit les tris apres un separateur, et rien n'est
          perdu. */}
      <div className="tris">
        <span className="tris__groupe" role="group" aria-label="Trier">
          {SORTS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`tri${sort === option.value ? ' tri--on' : ''}`}
              aria-pressed={sort === option.value}
              onClick={() => onSortChange(option.value)}
            >
              {option.court}
            </button>
          ))}
        </span>

        {showGroup && (
          <>
            <span className="tris__separateur" aria-hidden="true" />
            <span className="tris__groupe" role="group" aria-label="Grouper">
              {GROUPS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`tri tri--groupe${group === option.value ? ' tri--on' : ''}`}
                  aria-pressed={group === option.value}
                  onClick={() => onGroupChange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

function PantrySection({
  section,
  espace,
  today,
  onOpen,
}: {
  section: LotSection
  espace: EspaceTab
  today: Date
  onOpen: (id: number) => void
}) {
  return (
    <div className="pantry-section">
      {section.title !== null && (
        <h2
          className={`section-header pantry-section__header${
            section.bucket ? ` section-header--${section.bucket}` : ''
          }`}
        >
          {section.title}
          {section.hint && <span className="section-header__hint"> · {section.hint}</span>}
        </h2>
      )}
      {/* UNE carte pour toute la section, et des FILETS entre les lignes.
          Une carte par lot donnait une pile de rectangles blancs separes par du
          vide : a six produits on ne voyait plus une liste, mais six objets
          sans rapport les uns avec les autres. */}
      <ul className="carte-lots">
        {section.lots.map((lot) => (
          <LotRow key={lot.id} lot={lot} espace={espace} today={today} onOpen={onOpen} />
        ))}
      </ul>
    </div>
  )
}

/**
 * Une ligne, dont la SECONDE information change avec l'espace.
 *
 * Le nom, la quantite et la fratrie sont communs. Ce qui suit ne l'est pas :
 * le frigo montre l'echeance, le placard le niveau face au seuil, le
 * congelateur le temps passe. C'est la traduction en pixels de la regle qui
 * fonde ces trois espaces.
 */
function LotRow({
  lot,
  espace,
  today,
  onOpen,
}: {
  lot: Lot
  espace: EspaceTab
  today: Date
  onOpen: (id: number) => void
}) {
  const styleOf = useRayonStyle()
  const seuil = lot.ingredient?.restockThresholdG ?? null

  return (
    <li className={`lot${espace === 'frigo' ? ` lot--${lot.bucket}` : ''}`}>
      {/* Toute la ligne ouvre la fiche du lot. Sur le desktop, cliquer une
          ligne ne faisait rien : le seul geste possible etait la croix de
          suppression, et modifier une quantite imposait de tout ressaisir. */}
      <button type="button" className="lot__open" onClick={() => onOpen(lot.id)}>
        {/* La pastille porte l'icone du RAYON, pas de l'aliment : c'est une
            regle du projet, et elle tient a une donnee que l'ingredient a
            deja. Le mockup y met un emoji, que la ligne visuelle interdit
            depuis que 67 icones les ont remplaces : un emoji ne se teinte pas,
            ne suit pas le theme sombre et se pixellise a l'agrandissement. */}
        <span className="lot__pastille icon-chip" {...styleOf(lot.categoryL1).tint}>
          <RayonIcon glyph={styleOf(lot.categoryL1).glyph} size={20} strokeWidth={1.8} />
        </span>

        <span className="lot__body">
          <span className="lot__name">{lot.name}</span>
          <span className="lot__meta">
            <span>{formatLotQuantity(lot)}</span>

            {/* Le congelateur compte le temps PASSE. "Encore 3 mois"
                supposerait une table de durees par aliment que personne ne
                publie, et on la croirait. */}
            {espace === 'congelateur' && formatDepuis(joursDepuisEntree(lot, today)) !== null && (
              <span className="lot__depuis">{formatDepuis(joursDepuisEntree(lot, today))}</span>
            )}

            {lot.siblingCount > 1 && (
              <span className="lot__siblings">
                {lot.siblingCount} lots · {formatLotTotal(lot)}
              </span>
            )}
          </span>

          {/* La barre se lit PAR RAPPORT AU SEUIL, jamais a un "plein" que
              personne n'a saisi, et le texte donne les grammes pour qu'aucune
              proportion ne soit a deviner. */}
          {espace === 'placard' && seuil !== null && (
            <span className="lot__niveau">
              <span className="lot__niveau-piste" aria-hidden="true">
                <span
                  className={`lot__niveau-part${lot.totalG < seuil ? ' lot__niveau-part--bas' : ''}`}
                  style={{ width: `${restockRatio(lot.totalG, seuil) * 100}%` }}
                />
              </span>
              <span className="lot__niveau-texte">
                {formatGrams(lot.totalG)} pour un seuil de {formatGrams(seuil)}
                {lot.totalG < seuil && ' · ajouté aux courses'}
              </span>
            </span>
          )}

          {lot.stock.notes && <span className="lot__notes">{lot.stock.notes}</span>}
        </span>

        {/*
          LE BADGE D'ECHEANCE, A DROITE, EN PASTILLE.
          "J-1", "J-15" tient en deux caracteres la ou "Périme demain" en prend
          treize, ce qui laisse la place au nom du produit sur une seule ligne.
          Le texte long reste dans la fiche du lot, ou il y a la place.

          Il ne s'affiche QUE si une date existe, et JAMAIS au congelateur, qui
          compte le temps passe et non ce qui reste. Au placard il s'affiche
          sans couleur d'alarme : une date sur un produit sec est indicative.
        */}
        {espace !== 'congelateur' && lot.daysLeft !== null && (
          <span
            className={`badge-echeance badge-echeance--${espace === 'frigo' ? lot.bucket : 'neutre'}`}
            // Deux caracteres ne se lisent pas a voix haute : le libelle long
            // est celui de la fiche, mot pour mot.
            aria-label={formatExpiryLabel(lot.daysLeft)}
          >
            {formatJours(lot.daysLeft)}
          </span>
        )}

        <span className="lot__chevron" aria-hidden="true">
          ›
        </span>
      </button>

      {/* Ranger en UN geste, sans ouvrir la fiche : c'est le seul geste utile
          sur un article qui vient d'arriver, et il se repete huit fois de
          suite. Passer par la fiche pour chacun rendrait la file decourageante,
          et une file qu'on ne vide pas ne sert a rien. */}
      {espace === null && <BoutonsRangement lotId={lot.id} />}
    </li>
  )
}

function BoutonsRangement({ lotId }: { readonly lotId: number }) {
  const ranger = useSetStorage()
  return (
    <div className="ranger-actions">
      {STORAGE_SPACES.map((espace: StorageSpace) => (
        <button
          key={espace}
          type="button"
          className="ranger-action"
          disabled={ranger.isPending}
          onClick={() => ranger.mutate({ id: lotId, storage: espace })}
        >
          {espaceLabel(espace)}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * La date du jour, renouvelee au retour au premier plan.
 *
 * Les seaux d'urgence se calculent par rapport a aujourd'hui. Une PWA reste
 * ouverte des jours entiers en arriere-plan : sans ce reveil, "perime demain"
 * resterait affiche une semaine. On ne remplace l'objet que si le JOUR a
 * change, sinon chaque retour d'onglet recalculerait toute la liste.
 */
function useToday(): Date {
  const [today, setToday] = useState(() => new Date())

  useEffect(() => {
    const sync = () => {
      if (document.visibilityState !== 'visible') return
      setToday((previous) =>
        previous.toDateString() === new Date().toDateString() ? previous : new Date(),
      )
    }
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])

  return today
}
