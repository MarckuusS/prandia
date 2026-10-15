/**
 * Scanner un produit et le poser dans le chariot.
 *
 * C'est le geste repete de la session : on met l'article dans le caddie, on
 * vise son code-barres, on confirme quatre champs. Trente fois. Tout ce qui
 * suit est ecrit sous cette contrainte — debout, une main sur le chariot, un
 * reseau de magasin qui traine.
 *
 * TROIS SOURCES DE PRE-REMPLISSAGE, dans cet ordre :
 *
 *   1. la bibliotheque personnelle, deja en cache. C'est le cas le plus
 *      frequent — on rachete toujours les memes choses — et il est resolu SANS
 *      RESEAU : le formulaire est rempli avant meme que la feuille s'ouvre ;
 *   2. OpenFoodFacts pour un code inconnu de la bibliotheque : nom, marque,
 *      macros et contenance ;
 *   3. Open Prices pour un ordre de grandeur du prix, toujours accompagne de
 *      son etendue et de son nombre de releves.
 *
 * Aucune de ces trois ne bloque la saisie : elles remplissent des champs vides
 * a mesure qu'elles arrivent, et n'ecrasent jamais ce qui a ete tape. Un
 * reseau mort ne doit pas empecher d'ajouter un article — le nom et le prix se
 * tapent tres bien a la main.
 *
 * CE QUI A ETE ECARTE : rouvrir la camera automatiquement apres chaque ajout.
 * Ca economisait un tap par produit, au prix d'une camera qui s'ouvre toute
 * seule quand on voulait juste verifier son chariot. Le gros bouton reste sous
 * le pouce : le tap de trop est un prix honnete pour un ecran previsible.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { lastPaidPrice, todayLocalIsoDate, type Ingredient } from '@prandia/shared'

import { BoutonRafale } from '../../components/ScanEtiquette.js'
import { Icon } from '../../icons/index.js'
import { Sheet } from '../../components/Sheet.js'
import type { ScanRequest } from '../../lib/useScanParam.js'
import { useToast } from '../../components/Toast.js'
import { ApiError } from '../../lib/api.js'
import {
  useAddSessionItem,
  useBarcode,
  useIngredients,
  useObservedPrice,
  usePriceHistory,
  useShoppingSession,
} from '../../lib/queries.js'
import { formatPriceSource } from '../frigo/PricePaid.js'
import { LectureSavarin } from './LectureSavarin.js'
import { ScanEnChaine } from './ScanEnChaine.js'
import {
  detacher,
  lancerLecture,
  quitterFeuille,
  rattacher,
  reprendre,
  useLectures,
  type Ecouteur,
} from './lecturesArticle.js'
import { SessionItemFields } from './SessionItemFields.js'
import {
  appliquerArticle,
  draftFromProduct,
  emptyDraft,
  mergeProduct,
  readDraft,
  type ChampLu,
  type ItemDraft,
} from './sessionDraft.js'

export interface ScanToCartProps {
  /** Ingredients de la liste de courses : sert a annoncer la correspondance. */
  readonly listIngredientIds: ReadonlySet<number>
  /**
   * Code venu de l'URL, via le point d'entree de scan global.
   *
   * Il passe par `openDraft`, exactement comme un code lu par la camera :
   * meme compteur, meme feuille, meme resolution bibliotheque puis
   * OpenFoodFacts puis Open Prices. Rien de ce chemin n'est duplique.
   */
  readonly scan: ScanRequest | null
  /**
   * Appele une fois le code pris en charge, pour que l'appelant l'OUBLIE.
   *
   * Sans cela, la demande restait posee : chaque remontage de ce composant —
   * et il en survient un a chaque aller-retour entre le chariot et la liste —
   * rouvrait la feuille et pouvait creer une seconde ligne pour le meme
   * article. Une session validee remettait meme la feuille de demarrage a
   * l'ecran, un code fantome attendant un chariot qui venait de fermer.
   */
  readonly onScanTraite: () => void
  /** Ouvre le scan en chaine des l'arrivee : on vient de dire "Ranger mes courses". */
  readonly ouvrirAuDepart?: boolean | undefined
}

/** Un code en attente de confirmation. Le compteur force une feuille NEUVE. */
interface Pending {
  readonly ean: string | null
  readonly nonce: number
}

export function ScanToCart({ listIngredientIds, scan, onScanTraite, ouvrirAuDepart = false }: ScanToCartProps) {
  /*
   * LE SCAN EN CHAINE (ScanEnChaine.tsx) : code-barres, photos, produit
   * suivant, sans quitter la camera ni ouvrir de feuille. "Sans code" y entre
   * directement par les photos. La feuille d'un article ne sert plus qu'a un
   * code arrive d'ailleurs (l'entree de scan globale) et a corriger une ligne.
   */
  const [chaine, setChaine] = useState<'fermee' | 'code' | 'sans-code'>(ouvrirAuDepart ? 'code' : 'fermee')
  const [pending, setPending] = useState<Pending | null>(null)
  const toast = useToast()

  // Deux articles identiques scannes de suite sont deux lignes distinctes :
  // sans ce compteur, la cle de la feuille serait la meme et React reprendrait
  // le brouillon precedent, prix compris.
  const nonce = useRef(0)
  const openDraft = (ean: string | null) => {
    nonce.current += 1
    setPending({ ean, nonce: nonce.current })
  }

  // Dans un effet et non pendant le rendu : `openDraft` mute une ref et pose
  // un etat. L'effet couvre les DEUX arrivees possibles d'un seul coup — le
  // composant deja monte (l'identite de `scan` change) et le composant qui
  // vient de monter parce qu'une session vient d'etre ouverte pour ce code.
  useEffect(() => {
    if (scan === null) return
    openDraft(scan.ean)
    onScanTraite()
    // `openDraft` est recree a chaque rendu et n'a pas a relancer l'effet :
    // seule une nouvelle demande de scan doit le faire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan])

  return (
    <>
      <div className="session-scan">
        <button
          type="button"
          className="button button--primary session-scan__main"
          onClick={() => setChaine('code')}
        >
          <Icon name="ui-camera" size={18} className="icon--inline" /> Scanner les produits
        </button>
        {/* Le vrac, la boucherie et le marche n'ont pas de code-barres, et ils
            pesent lourd dans un chariot. Sans cette porte, la session ne
            couvrirait que les produits emballes. */}
        <button
          type="button"
          className="button button--secondary session-scan__manual"
          onClick={() => setChaine('sans-code')}
          aria-label="Ajouter un article sans code-barres"
        >
          Sans code
        </button>
      </div>

      {chaine !== 'fermee' && <ScanEnChaine sansCode={chaine === 'sans-code'} onClose={() => setChaine('fermee')} />}

      {pending !== null && (
        <ScannedItemSheet
          key={`${pending.ean ?? 'sans-code'}-${pending.nonce}`}
          ean={pending.ean}
          listIngredientIds={listIngredientIds}
          onClose={() => setPending(null)}
          onAdded={(name, savarinLit) => {
            setPending(null)
            toast.show({
              message: savarinLit ? `✓ ${name} dans le chariot. Savarin lit tes photos.` : `✓ ${name} dans le chariot.`,
            })
          }}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Ce que la bibliotheque connait deja
// ---------------------------------------------------------------------------

/**
 * La bibliotheque personnelle indexee par code-barres.
 *
 * Meme cle de cache que partout ailleurs (`useIngredients('')`) : ce hook ne
 * declenche AUCUNE requete supplementaire, il relit ce qui est deja charge.
 * C'est ce qui rend le cas frequent instantane, et utilisable dans un rayon
 * sans reseau.
 *
 * L'ecran du frigo tient le meme index, mais prive a son module et dans un
 * dossier qui n'appartient pas a cette fonctionnalite. Le partager demanderait
 * de deplacer les deux — un remaniement pour douze lignes.
 */
export function useLibraryByBarcode(): ReadonlyMap<string, Ingredient> {
  const library = useIngredients('')
  const items = library.data?.items

  return useMemo(() => {
    const byRef = new Map<string, Ingredient>()
    for (const item of items ?? []) {
      if (item.id === null || item.sourceRef === null) continue
      // Premiere arrivee gagnante : deux fiches pour un meme code sont une
      // anomalie, en choisir une au hasard a chaque rendu en serait une autre.
      if (!byRef.has(item.sourceRef)) byRef.set(item.sourceRef, item)
    }
    return byRef
  }, [items])
}

// ---------------------------------------------------------------------------
// La confirmation
// ---------------------------------------------------------------------------

function ScannedItemSheet({
  ean,
  listIngredientIds,
  onAdded,
  onClose,
}: {
  ean: string | null
  listIngredientIds: ReadonlySet<number>
  /** `savarinLit` : l'article part avant la fin de la lecture de ses photos. */
  onAdded: (name: string, savarinLit: boolean) => void
  onClose: () => void
}) {
  const library = useLibraryByBarcode()
  const known = ean === null ? undefined : library.get(ean)

  // Le reseau n'est sollicite que si la bibliotheque ne reconnait pas le code.
  const barcode = useBarcode(known === undefined ? ean : null)
  const observed = useObservedPrice(ean)
  const add = useAddSessionItem()

  const [draft, setDraft] = useState<ItemDraft>(() =>
    known === undefined ? emptyDraft(ean) : draftFromProduct(ean, known),
  )
  const [error, setError] = useState<string | null>(null)
  const [productApplied, setProductApplied] = useState(known !== undefined)
  const [contenanceAppliquee, setContenanceAppliquee] = useState(false)

  /*
   * Pre-remplissage PENDANT le rendu, et non dans un effet.
   *
   * Un effet afficherait d'abord une image avec les champs vides, puis les
   * remplirait — visible a l'oeil, et suffisant pour qu'on commence a taper
   * par-dessus. Les sentinelles garantissent une seule application.
   */
  // La bibliotheque peut arriver APRES l'ouverture (scan recu au demarrage de
  // l'application) : la recherche en ligne s'arrete alors, et sans ce repli la
  // feuille restait vide sur un produit pourtant connu.
  const product = barcode.data ?? known
  if (product !== undefined && !productApplied) {
    setProductApplied(true)
    setDraft((previous) => mergeProduct(previous, product))
  }

  // La contenance d'Open Prices sert de repli quand OpenFoodFacts n'en a pas,
  // le cas du Nutella, vide chez OFF et connu a 400 g ici. Le PRIX, lui, n'est
  // jamais ecrit ici : voir plus bas.
  const observe = observed.data
  if (observe?.found === true && !contenanceAppliquee) {
    setContenanceAppliquee(true)
    setDraft((previous) => ({
      ...previous,
      quantityG: previous.quantityG ?? observe.quantityG ?? null,
      pieceWeightG: previous.pieceWeightG ?? observe.quantityG ?? null,
    }))
  }

  /*
   * LE PRIX EST PROPOSE, JAMAIS PRE-REMPLI. Il l'a ete (ton dernier prix,
   * sinon la mediane d'Open Prices) : en magasin, on touche "Ajouter" sans
   * relire, et un prix d'il y a trois semaines partait pour celui du jour.
   * Taux d'erreur constate par l'utilisateur le 2026-10-11. Le champ reste
   * vide ; un bouton "Reprendre 1,89 EUR" le remplit d'un geste.
   *
   * TON DERNIER PRIX passe avant la mediane : dans le meme magasin d'abord,
   * sinon le dernier paye ailleurs (`lastPaidPrice`). Un produit jamais achete
   * n'a pas d'historique : la mediane d'Open Prices est proposee a sa place.
   */
  const historique = usePriceHistory(draft.ingredientId)
  const magasin = useShoppingSession().data?.session?.store ?? null
  const dernier =
    historique.data === undefined
      ? null
      : lastPaidPrice(historique.data.items, { store: magasin, quantityG: draft.quantityG })
  const proposition =
    dernier !== null
      ? { priceEur: Number(dernier.priceEur), source: formatPriceSource(dernier) }
      : observe?.found === true && observe.priceEur !== undefined
        ? { priceEur: Number(observe.priceEur), source: 'Prix médian relevé par Open Prices.' }
        : null

  const change = (next: ItemDraft) => {
    if (error !== null) setError(null)
    setDraft(next)
  }

  /*
   * LES PHOTOS DE SAVARIN, LUES EN ARRIERE-PLAN (lecturesArticle.ts). La
   * reponse va dans ce brouillon si la feuille est encore ouverte, sinon dans
   * l'article une fois au chariot. Le brouillon est relu par une ref : la
   * reponse arrive des secondes apres l'envoi, sur un brouillon qui a pu bouger.
   */
  const cle = useRef(`ajout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`).current
  const lecture = useLectures().find((l) => l.cle === cle)
  const [lusSavarin, setLusSavarin] = useState<readonly ChampLu[]>([])
  const draftRef = useRef(draft)
  draftRef.current = draft
  const appliquerIci: Ecouteur = (lu, avant) => {
    const applique = appliquerArticle(draftRef.current, avant, lu, todayLocalIsoDate())
    setDraft(applique.draft)
    setLusSavarin(applique.champs)
  }
  // Annulee, la feuille emporte sa lecture ; ajoutee, la lecture suit l'article.
  useEffect(() => () => quitterFeuille(cle), [cle])

  const submit = (savarinLit = lecture?.etat === 'lecture') => {
    const reading = readDraft(draftRef.current)
    if (reading.kind === 'invalid') {
      setError(reading.message)
      return
    }
    detacher(cle)
    add.mutate(reading.item, {
      onSuccess: (state) => {
        // La file des ecritures du chariot garantit que le dernier article
        // rendu est celui-ci.
        const id = state.session?.items.at(-1)?.id
        if (id !== undefined) rattacher(cle, id)
        onAdded(reading.item.name, savarinLit)
      },
      onError: () => reprendre(cle, appliquerIci),
    })
  }

  /*
   * Envoyer les photos AJOUTE l'article quand il est complet (un nom, une
   * quantite) : on retourne au chariot aussitot, Savarin finira derriere.
   * Sinon (un produit inconnu, sans nom), la feuille reste ouverte et se
   * remplit sous les yeux.
   */
  const envoyer = (photos: readonly Blob[]) => {
    lancerLecture({ cle, photos, avant: draftRef.current, itemId: null, ecouteur: appliquerIci })
    if (readDraft(draftRef.current).kind === 'ready') submit(true)
  }

  const unknownCode = barcode.error instanceof ApiError && barcode.error.status === 404
  const onList = draft.ingredientId !== null && listIngredientIds.has(draft.ingredientId)

  return (
    <Sheet
      open
      onClose={onClose}
      title="Ajouter au chariot"
      dismissible={!add.isPending}
      actions={
        <>
          <BoutonRafale
            onEnvoyer={envoyer}
            occupe={lecture?.etat === 'lecture'}
            disabled={add.isPending}
          />
          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
            disabled={add.isPending}
          >
            Annuler
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => submit()}
            disabled={add.isPending}
          >
            {add.isPending ? 'Ajout…' : 'Ajouter'}
          </button>
        </>
      }
    >
      <LectureSavarin lecture={lecture} />
      {ean !== null && (
        <p className="row__meta session-source">
          <span>Code {ean}</span>
          {known !== undefined && <span className="badge badge--pantry">déjà en bibliothèque</span>}
        </p>
      )}

      {barcode.isFetching && <p className="field__hint">Recherche du produit…</p>}

      {barcode.isError && (
        <p className="field__hint">
          {unknownCode
            ? 'Ce code n’est connu ni de ta bibliothèque ni d’OpenFoodFacts. Donne-lui un nom : sa fiche sera créée quand tu termineras les courses.'
            : barcode.error.message}
        </p>
      )}

      {ean === null && (
        <p className="field__hint">
          Article sans code-barres. Sa fiche sera créée quand tu termineras les courses.
        </p>
      )}

      <SessionItemFields
        draft={draft}
        onChange={change}
        onList={onList}
        observed={observed.data}
        observedPending={observed.isFetching}
        proposition={proposition}
        error={error ?? add.error?.message}
        disabled={add.isPending}
        lusSavarin={lusSavarin}
      />
    </Sheet>
  )
}
