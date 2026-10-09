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
import type { Ingredient } from '@prandia/shared'

import { BarcodeScanner } from '../../components/BarcodeScanner.js'
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
} from '../../lib/queries.js'
import { SessionItemFields } from './SessionItemFields.js'
import {
  draftFromProduct,
  emptyDraft,
  mergeProduct,
  readDraft,
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
}

/** Un code en attente de confirmation. Le compteur force une feuille NEUVE. */
interface Pending {
  readonly ean: string | null
  readonly nonce: number
}

export function ScanToCart({ listIngredientIds, scan, onScanTraite }: ScanToCartProps) {
  const [scanning, setScanning] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [lastAdded, setLastAdded] = useState<string | null>(null)
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
          onClick={() => setScanning(true)}
        >
          <Icon name="ui-camera" size={18} className="icon--inline" /> Scanner un produit
        </button>
        {/* Le vrac, la boucherie et le marche n'ont pas de code-barres, et ils
            pesent lourd dans un chariot. Sans cette porte, la session ne
            couvrirait que les produits emballes. */}
        <button
          type="button"
          className="button button--secondary session-scan__manual"
          onClick={() => openDraft(null)}
          aria-label="Ajouter un article sans code-barres"
        >
          Sans code
        </button>
      </div>

      <BarcodeScanner
        open={scanning}
        onClose={() => setScanning(false)}
        onDetect={(code) => {
          setScanning(false)
          openDraft(code)
        }}
        title="Scanner un produit"
        hint={lastAdded === null ? undefined : `Dernier ajouté : ${lastAdded}`}
      />

      {pending !== null && (
        <ScannedItemSheet
          key={`${pending.ean ?? 'sans-code'}-${pending.nonce}`}
          ean={pending.ean}
          listIngredientIds={listIngredientIds}
          onClose={() => setPending(null)}
          onAdded={(name) => {
            setPending(null)
            setLastAdded(name)
            toast.show({ message: `✓ ${name} dans le chariot.` })
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
function useLibraryByBarcode(): ReadonlyMap<string, Ingredient> {
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
  onAdded: (name: string) => void
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
  const [priceApplied, setPriceApplied] = useState(false)
  /** Vrai des que l'utilisateur touche au montant : la suggestion se tait alors. */
  const [priceTouched, setPriceTouched] = useState(false)

  /*
   * Pre-remplissage PENDANT le rendu, et non dans un effet.
   *
   * Un effet afficherait d'abord une image avec les champs vides, puis les
   * remplirait — visible a l'oeil, et suffisant pour qu'on commence a taper
   * par-dessus. Les sentinelles garantissent une seule application.
   */
  const product = barcode.data
  if (product !== undefined && !productApplied) {
    setProductApplied(true)
    setDraft((previous) => mergeProduct(previous, product))
  }

  const suggestion = observed.data
  if (suggestion?.found === true && !priceApplied) {
    setPriceApplied(true)
    setDraft((previous) => ({
      ...previous,
      priceEur:
        previous.priceEur ??
        (suggestion.priceEur === undefined ? null : Number(suggestion.priceEur)),
      // La contenance d'Open Prices sert de repli quand OpenFoodFacts n'en a
      // pas — le cas du Nutella, vide chez OFF et connu a 400 g ici.
      quantityG: previous.quantityG ?? suggestion.quantityG ?? null,
      pieceWeightG: previous.pieceWeightG ?? suggestion.quantityG ?? null,
    }))
  }

  const change = (next: ItemDraft) => {
    if (next.priceEur !== draft.priceEur) setPriceTouched(true)
    if (error !== null) setError(null)
    setDraft(next)
  }

  const submit = () => {
    const reading = readDraft(draft)
    if (reading.kind === 'invalid') {
      setError(reading.message)
      return
    }
    add.mutate(reading.item, { onSuccess: () => onAdded(reading.item.name) })
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
            onClick={submit}
            disabled={add.isPending}
          >
            {add.isPending ? 'Ajout…' : 'Ajouter au chariot'}
          </button>
        </>
      }
    >
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
        priceIsSuggested={priceApplied && !priceTouched && draft.priceEur !== null}
        error={error ?? add.error?.message}
        disabled={add.isPending}
      />
    </Sheet>
  )
}
