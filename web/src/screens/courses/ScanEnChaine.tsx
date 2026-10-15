/**
 * Ranger ses courses : le SCAN EN CHAINE (decision du 2026-10-15).
 *
 * En magasin, on coche sa liste et rien d'autre. A la maison, avant de ranger,
 * chaque produit passe par le meme ecran, sans le quitter : le code-barres,
 * puis la rafale (la face avant, le poids, la date), puis le produit suivant.
 * La camera ne se ferme pas entre deux produits, aucune feuille ne s'ouvre,
 * aucun champ n'est a toucher : Savarin lit les photos en arriere-plan
 * (lecturesArticle.ts) pendant qu'on prend le produit suivant. Les prix
 * viendront du ticket, a la fin.
 *
 * Le produit est cherche des la lecture du code (la bibliotheque d'abord, sans
 * reseau ; OpenFoodFacts sinon), PENDANT qu'on prend les photos : Savarin
 * recoit ainsi le nom a verifier sur la face avant. Un code inconnu, ou un
 * produit sans code-barres (le vrac), entre sans nom : la face avant le donne.
 */

import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Ingredient } from '@prandia/shared'

import { BarcodeScanner } from '../../components/BarcodeScanner.js'
import { ViseurRafale } from '../../components/ScanEtiquette.js'
import { Sheet } from '../../components/Sheet.js'
import { lookupBarcode, useAddSessionItem } from '../../lib/queries.js'
import { detacher, lancerLecture, oublierLecture, rattacher } from './lecturesArticle.js'
import { useLibraryByBarcode } from './ScanToCart.js'
import { brouillonEnArticle, draftFromProduct, emptyDraft } from './sessionDraft.js'
import '../../styles/scan-etiquette.css'

/** Le temps qu'on accorde a OpenFoodFacts apres les photos : au-dela, la face avant nommera le produit. */
const ATTENTE_PRODUIT_MS = 2000

type Recherche = { readonly etat: 'recherche' } | { readonly etat: 'trouve'; readonly produit: Ingredient } | { readonly etat: 'inconnu' }

export interface ScanEnChaineProps {
  /** Ouvert directement sur les photos : un produit sans code-barres. */
  readonly sansCode?: boolean | undefined
  readonly onClose: () => void
}

export function ScanEnChaine({ sansCode = false, onClose }: ScanEnChaineProps) {
  const bibliotheque = useLibraryByBarcode()
  const client = useQueryClient()
  const add = useAddSessionItem()

  /** Le produit en cours : `undefined` entre deux produits, le viseur cherche un code. */
  const [courant, setCourant] = useState<{ readonly ean: string | null; readonly numero: number } | undefined>(
    sansCode ? { ean: null, numero: 0 } : undefined,
  )
  const [recherche, setRecherche] = useState<Recherche>({ etat: 'inconnu' })
  const promesse = useRef<Promise<Ingredient | null>>(Promise.resolve(null))
  const numero = useRef(0)
  /** Ce qui est entre au chariot depuis l'ouverture, le plus recent d'abord. */
  const [ajoutes, setAjoutes] = useState<readonly string[]>([])
  const [erreur, setErreur] = useState<string | null>(null)

  const commencer = (ean: string | null) => {
    numero.current += 1
    const ce = numero.current
    setErreur(null)
    setCourant({ ean, numero: ce })
    if (ean === null) {
      setRecherche({ etat: 'inconnu' })
      promesse.current = Promise.resolve(null)
      return
    }
    const connu = bibliotheque.get(ean)
    if (connu !== undefined) {
      setRecherche({ etat: 'trouve', produit: connu })
      promesse.current = Promise.resolve(connu)
      return
    }
    setRecherche({ etat: 'recherche' })
    const p = client
      .fetchQuery({
        queryKey: ['barcode', ean],
        queryFn: () => lookupBarcode(ean),
        staleTime: 30 * 60 * 1000,
        retry: false,
      })
      .then((r): Ingredient | null => r)
      .catch(() => null)
    promesse.current = p
    void p.then((r) => {
      // Un produit suivant a pu commencer entre-temps : sa recherche a lui fait foi.
      if (numero.current === ce) setRecherche(r === null ? { etat: 'inconnu' } : { etat: 'trouve', produit: r })
    })
  }

  const ajouter = async (photos: readonly Blob[]) => {
    const ce = courant
    if (ce === undefined) return
    // Retour au code-barres TOUT DE SUITE : on prend le produit suivant
    // pendant que celui-ci entre au chariot et que Savarin le lit.
    setCourant(undefined)
    const produit = await Promise.race([
      promesse.current,
      new Promise<null>((r) => window.setTimeout(() => r(null), ATTENTE_PRODUIT_MS)),
    ])
    const draft = produit === null ? emptyDraft(ce.ean) : draftFromProduct(ce.ean, produit)
    const cle = `chaine-${Date.now().toString(36)}-${ce.numero}`
    if (photos.length > 0) {
      lancerLecture({ cle, photos, avant: draft, itemId: null, ecouteur: null })
      detacher(cle)
    }
    setAjoutes((avant) => [draft.name.trim() === '' ? 'Produit à lire' : draft.name, ...avant])
    add.mutate(brouillonEnArticle(draft), {
      onSuccess: (state) => {
        // La file des ecritures du chariot garantit que le dernier article
        // rendu est celui-ci.
        const id = state.session?.items.at(-1)?.id
        if (id !== undefined) rattacher(cle, id)
      },
      onError: (e) => {
        oublierLecture(cle)
        setErreur(`Un produit n’a pas pu entrer au chariot : ${e.message}`)
      },
    })
  }

  const produitConnu = recherche.etat === 'trouve' ? recherche.produit : null
  // Sans photo, seulement quand le produit dit deja ce qu'il est et combien il pese.
  const sansPhoto =
    produitConnu !== null && produitConnu.pieceWeightG !== null
      ? { libelle: 'Ajouter sans photo', onClick: () => void ajouter([]) }
      : undefined

  return (
    <Sheet
      open
      onClose={onClose}
      title="Ranger mes courses"
      variant="plein"
      actions={
        courant === undefined ? (
          <>
            <button type="button" className="button button--secondary" onClick={() => commencer(null)}>
              Sans code-barres
            </button>
            <button type="button" className="button button--primary" onClick={onClose}>
              Terminé
            </button>
          </>
        ) : (
          <button type="button" className="button button--secondary" onClick={() => setCourant(undefined)}>
            Retour au code-barres
          </button>
        )
      }
    >
      <div className="chaine">
        <p className="chaine__etat" aria-live="polite">
          {courant === undefined
            ? ajoutes.length === 0
              ? 'Scanne le code-barres du premier produit.'
              : `${ajoutes.length} produit${ajoutes.length > 1 ? 's' : ''} au chariot. Dernier : ${ajoutes[0]}.`
            : recherche.etat === 'recherche'
              ? 'Recherche du produit…'
              : recherche.etat === 'trouve'
                ? [recherche.produit.name, recherche.produit.brand].filter(Boolean).join(' · ')
                : courant.ean === null
                  ? 'Sans code-barres : la face avant donnera le nom.'
                  : 'Code inconnu : Savarin lira le nom sur la face avant.'}
        </p>

        {erreur !== null && (
          <p className="field__error" role="alert">
            {erreur}
          </p>
        )}

        {courant === undefined ? (
          <BarcodeScanner
            open
            inline
            onClose={onClose}
            onDetect={commencer}
            hint="Vise le code-barres du produit"
          />
        ) : (
          <ViseurRafale
            key={courant.numero}
            onEnvoyer={(photos) => void ajouter(photos)}
            onClose={() => undefined}
            autreAction={sansPhoto}
          />
        )}
      </div>
    </Sheet>
  )
}
