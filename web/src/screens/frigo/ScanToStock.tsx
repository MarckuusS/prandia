/**
 * Scanner un produit pour le mettre au frigo.
 *
 * C'est le geste du retour de courses : on vide les sacs d'une main, on vise
 * les codes-barres de l'autre. Taper « crème légère UHT 18 % MG » au pouce
 * pendant ce temps-la n'a jamais ete realiste, et c'est bien ce que
 * l'utilisateur signale : il n'avait aucun moyen de partir d'un produit.
 *
 * Un code lu a TROIS issues, et elles n'appellent pas la meme suite :
 *
 *   1. le produit est deja dans la bibliotheque personnelle — de loin le cas le
 *      plus frequent, puisqu'on rachete toujours les memes choses. Il est
 *      resolu SANS RESEAU sur l'index deja en cache : le formulaire se remplit
 *      dans l'instant, il ne reste qu'a valider ;
 *   2. OpenFoodFacts le connait, la bibliotheque non : un seul bouton l'ajoute
 *      a la bibliotheque ET le choisit. Deux ecritures cote code, un geste cote
 *      utilisateur ;
 *   3. personne ne le connait — un 404 est un cas NORMAL ici, les produits
 *      frais et les marques de distributeur manquent souvent. On le dit, et on
 *      propose les deux chemins manuels plutot qu'une impasse.
 *
 * La camera, les autorisations, le HTTPS, la cle de controle du code : tout
 * cela vit dans BarcodeScanner. Ici on ne recoit qu'un code deja valide.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { Ingredient } from '@prandia/shared'

import { BarcodeScanner } from '../../components/BarcodeScanner.js'
import { SourceBadge } from '../../components/States.js'
import { ApiError } from '../../lib/api.js'
import {
  useAddToLibrary,
  useBarcode,
  useCreateIngredient,
  useIngredients,
} from '../../lib/queries.js'
import { offCreatePayload } from '../../lib/offPayload.js'

export interface ScanToStockProps {
  /** Appele avec l'ingredient resolu — la feuille le traite comme un choix du picker. */
  readonly onPick: (ingredient: Ingredient) => void
  readonly disabled?: boolean | undefined
  /**
   * Code venu du point d'entree de scan global, injecte au montage.
   *
   * Il passe par `detect`, la meme et unique porte que la camera : resolution
   * locale d'abord, OpenFoodFacts ensuite, revendication de la fiche si elle
   * existe deja au catalogue. Rien de ce chemin n'est duplique.
   */
  readonly initialCode?: string | undefined
}

export function ScanToStock({ onPick, disabled, initialCode }: ScanToStockProps) {
  const [scanning, setScanning] = useState(false)
  /** Code lu qui n'a PAS ete reconnu localement : il attend OpenFoodFacts. */
  const [pending, setPending] = useState<string | null>(null)

  const library = useLibraryByBarcode()

  const detect = (code: string) => {
    setScanning(false)
    const known = library.byRef.get(code)
    if (known) {
      // Chemin instantane : aucune requete, aucune carte intermediaire a
      // valider. La feuille bascule sur « ingrédient choisi », ce qui est le
      // retour visuel — en ajouter un second ferait un tap de plus pour rien.
      setPending(null)
      onPick(known)
      return
    }
    setPending(code)
  }

  /*
   * Injection du code venu de l'URL.
   *
   * DANS UN EFFET et non pendant le rendu : `detect` appelle `onPick`, qui
   * ecrit l'etat du PARENT — React interdit de mettre a jour un composant
   * pendant le rendu d'un autre.
   *
   * ON ATTEND L'INDEX DE LA BIBLIOTHEQUE. Sur ce chemin la feuille vient de
   * monter, donc la requete est encore en vol : sans cette garde, un produit
   * pourtant deja en bibliotheque serait declare inconnu et partirait chez
   * OpenFoodFacts, imposant un tap de plus. On teste `!isPending` et non le
   * succes : une bibliotheque en erreur ne doit pas retenir le code.
   *
   * La ref garantit UNE SEULE injection : `detect` est aussi la porte de la
   * camera, et rejouer l'effet ecraserait un choix fait a la main.
   */
  const injecte = useRef<string | null>(null)
  useEffect(() => {
    if (initialCode === undefined || library.pending) return
    if (injecte.current === initialCode) return
    injecte.current = initialCode
    detect(initialCode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode, library.pending])

  return (
    <div className="scan">
      <button
        type="button"
        className="button button--secondary scan__button"
        onClick={() => setScanning(true)}
        disabled={disabled}
      >
        Scanner un code-barres
      </button>

      <BarcodeScanner
        open={scanning}
        onClose={() => setScanning(false)}
        onDetect={detect}
        title="Scanner un produit"
        hint="Le produit lu remplit directement le formulaire d’ajout."
      />

      {pending !== null && (
        // `key` sur le code : rescanner remonte un composant neuf, donc sans
        // l'erreur d'ajout du produit precedent restee affichee.
        <ScannedProduct
          key={pending}
          ean={pending}
          onPick={onPick}
          onDismiss={() => setPending(null)}
          onRescan={() => {
            setPending(null)
            setScanning(true)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ce que la bibliotheque connait deja
// ---------------------------------------------------------------------------

/**
 * La bibliotheque personnelle indexee par code-barres.
 *
 * Meme cle de cache que le picker de la feuille (`useIngredients('')`) : ce
 * hook ne declenche aucune requete supplementaire, il relit ce qui est deja
 * charge. C'est ce qui rend le cas frequent instantane.
 *
 * L'index porte sur la seule `sourceRef`, sans prefixer par la source comme le
 * fait la feuille d'import : ici la cle est un EAN de 8 a 14 chiffres, un code
 * CIQUAL en compte 5, la collision n'existe pas. Et une fiche creee par un
 * import de ticket porte le meme code sous une autre source — la retrouver
 * quand meme est exactement ce qu'on veut.
 */
/**
 * L'index local des codes-barres, ET son etat de chargement.
 *
 * L'etat compte : un index vide parce que la requete est en vol ne dit PAS la
 * meme chose qu'un index vide parce que le code est inconnu. Sans cette
 * distinction, un code injecte au montage partirait systematiquement chez
 * OpenFoodFacts. Aucune requete supplementaire : meme cle de cache que le
 * picker.
 */
function useLibraryByBarcode(): { byRef: ReadonlyMap<string, Ingredient>; pending: boolean } {
  const library = useIngredients('')
  const items = library.data?.items

  const byRef = useMemo(() => {
    const index = new Map<string, Ingredient>()
    for (const item of items ?? []) {
      if (item.id === null || item.sourceRef === null) continue
      // Premiere arrivee gagnante : deux fiches pour un meme code sont une
      // anomalie, en choisir une au hasard a chaque rendu en serait une autre.
      if (!index.has(item.sourceRef)) index.set(item.sourceRef, item)
    }
    return index
  }, [items])

  return { byRef, pending: library.isPending }
}

// ---------------------------------------------------------------------------
// Le produit lu
// ---------------------------------------------------------------------------

function ScannedProduct({
  ean,
  onPick,
  onDismiss,
  onRescan,
}: {
  ean: string
  onPick: (ingredient: Ingredient) => void
  onDismiss: () => void
  onRescan: () => void
}) {
  const query = useBarcode(ean)
  const addToLibrary = useAddToLibrary()
  const create = useCreateIngredient()

  const busy = addToLibrary.isPending || create.isPending
  const failure = addToLibrary.error ?? create.error

  if (query.isPending) {
    return (
      <div className="card scan__result">
        <p className="card__lead">Recherche du code {ean}…</p>
      </div>
    )
  }

  if (query.isError) {
    // 404 = code inconnu d'OpenFoodFacts. Ce n'est pas une panne : c'est une
    // information, et elle appelle une suite differente d'un serveur muet.
    const unknown = query.error instanceof ApiError && query.error.status === 404
    return (
      <div className="card scan__result">
        <h3 className="card__title">{unknown ? 'Produit inconnu' : 'Lecture impossible'}</h3>
        <p className="card__lead">
          {unknown
            ? `Le code ${ean} n’est répertorié ni dans ta bibliothèque ni sur OpenFoodFacts. Note-le si tu veux créer sa fiche.`
            : query.error.message}
        </p>
        <div className="scan__actions">
          {unknown && (
            // Quitter la feuille perd le lot en cours de saisie — a ce
            // stade il n'y a rien d'autre a perdre qu'un code, et creer la
            // fiche est la seule facon de ranger vraiment ce produit.
            <Link to={`/ingredients/nouveau?ean=${ean}`} className="button button--primary lien-surface">
              Créer sa fiche
            </Link>
          )}
          <button type="button" className="button button--secondary" onClick={onDismiss}>
            Chercher par nom
          </button>
          <button type="button" className="button button--ghost" onClick={onRescan}>
            Scanner autre chose
          </button>
        </div>
      </div>
    )
  }

  const product = query.data
  // `alreadyKnown` signale une fiche deja en base ; `inLibrary` dit si elle est
  // dans la bibliotheque de travail ou seulement dans le catalogue. Le premier
  // cas n'arrive ici que si l'index local n'etait pas encore charge au moment
  // du scan — un tap de plus, jamais une impasse.
  const known = product.alreadyKnown === true && product.inLibrary

  const adopt = () => {
    const done = (saved: Ingredient) => {
      onPick(saved)
      onDismiss()
    }
    if (known) {
      done(product)
      return
    }
    // Une fiche qui existe deja (ligne de catalogue) se REVENDIQUE, elle ne se
    // recree pas : la creer buterait sur l'unicite du nom.
    if (product.id !== null) addToLibrary.mutate(product.id, { onSuccess: done })
    else create.mutate(offCreatePayload(product), { onSuccess: done })
  }

  return (
    <div className="card scan__result">
      <p className="scan__name">{product.name}</p>
      <p className="scan__meta">
        <SourceBadge source={product.source} />
        {product.brand && <span>{product.brand}</span>}
        <span>Code {ean}</span>
      </p>

      {known && <p className="status status--ok">Déjà dans ta bibliothèque.</p>}

      <div className="scan__actions">
        <button type="button" className="button button--primary" onClick={adopt} disabled={busy}>
          {busy ? 'Ajout…' : known ? 'Choisir cet ingrédient' : 'Ajouter et le mettre au frigo'}
        </button>
        <button type="button" className="button button--ghost" onClick={onRescan} disabled={busy}>
          Scanner autre chose
        </button>
      </div>

      {failure && (
        <p className="field__error" role="alert">
          {failure.message}
        </p>
      )}
    </div>
  )
}
