/**
 * Ajout d'un lot au frigo — portage d'AddPantryStockDialog.qml.
 *
 * Le desktop ouvrait une vraie fenetre systeme, non modale, deplacable hors de
 * l'application. Rien de tout cela n'a de sens au doigt : c'est une feuille qui
 * monte du bas, avec un seul bouton d'action en pied.
 *
 * Trois defauts du dialogue d'origine sont corriges ici, tous signales par
 * l'inventaire de parite :
 *
 *   1. Il se fermait AVANT de savoir si l'enregistrement avait reussi. Sur le
 *      web la requete peut echouer, et l'utilisateur perdrait sa saisie : la
 *      feuille ne se ferme qu'au succes.
 *   2. Le bouton restait grise sans dire pourquoi. Il reste actif et explique
 *      au tap ce qui manque — un bouton mort au doigt n'apprend rien.
 *   3. Une date mal formee etait silencieusement ignoree et l'article
 *      enregistre sans peremption. `<input type="date">` rend la saisie
 *      invalide impossible.
 *
 * Deux chemins que le desktop n'avait pas du tout :
 *
 *   - le SCAN, qui remplace la recherche par le nom quand on a le produit en
 *     main (voir ScanToStock) ;
 *   - le PRIX PAYE, facultatif, enregistre dans la foulee. Il ne va pas sur le
 *     lot mais dans l'historique de prix de l'ingredient (voir PricePaid) :
 *     c'est ce qui fait remonter le cout dans la liste de courses.
 *
 * Aucune deduplication, comme sur le desktop : ajouter deux fois le meme
 * ingredient cree deux lots, c'est toute la raison d'etre de l'ecran.
 */

import { useState } from 'react'
import type { Ingredient } from '@prandia/shared'

import { DateField, TextField } from '../../components/Field.js'
import { IngredientPicker } from '../../components/IngredientPicker.js'
import { QuantityField } from '../../components/QuantityField.js'
import { Sheet } from '../../components/Sheet.js'
import { useToast } from '../../components/Toast.js'
import { useAddPrice, useAddStock } from '../../lib/queries.js'
import { EMPTY_PRICE_DRAFT, PricePaidFields, readPrice, type PriceDraft } from './PricePaid.js'
import { ScanToStock } from './ScanToStock.js'

/**
 * Quantite proposee des qu'un ingredient est choisi : une piece si
 * l'ingredient en a une, 100 g sinon. Regle metier du desktop, a tenir quel que
 * soit le geste d'ajout.
 */
const DEFAULT_QUANTITY_G = 100

/** Longueur de la colonne `notes` en base. Le desktop ne la faisait pas respecter. */
const NOTES_MAX_LENGTH = 500

export interface AddStockSheetProps {
  readonly onClose: () => void
  /** Code venu du point d'entree de scan : la feuille s'ouvre deja remplie. */
  readonly initialScan?: string | undefined
}

export function AddStockSheet({ onClose, initialScan }: AddStockSheetProps) {
  const add = useAddStock()
  const toast = useToast()

  const [ingredient, setIngredient] = useState<Ingredient | null>(null)
  const [quantityG, setQuantityG] = useState<number | null>(null)
  const [expiryDate, setExpiryDate] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [price, setPrice] = useState<PriceDraft>(EMPTY_PRICE_DRAFT)
  const [priceOpen, setPriceOpen] = useState(false)
  // Les erreurs n'apparaissent qu'apres une tentative : signaler « ingredient
  // manquant » sur un formulaire vierge accuse l'utilisateur avant qu'il ait
  // fait quoi que ce soit.
  const [attempted, setAttempted] = useState(false)

  /*
   * L'identifiant de l'ingredient n'est connu qu'apres selection, alors qu'un
   * hook se declare inconditionnellement. Le 0 de repli n'atteint jamais le
   * reseau : `submit` refuse de partir sans ingredient choisi, et le formulaire
   * de prix n'est meme pas rendu avant.
   */
  const addPrice = useAddPrice(ingredient?.id ?? 0)

  /**
   * Code injecte, efface des qu'un ingredient est choisi.
   *
   * L'EFFACEMENT EST LE POINT DELICAT. `ScanToStock` n'est rendu que tant
   * qu'aucun ingredient n'est choisi ; le bouton « Changer » le remonte, et un
   * code toujours present re-choisirait aussitot le meme produit — « Changer »
   * deviendrait inoperant.
   */
  const [scanInjecte, setScanInjecte] = useState(initialScan)

  const pick = (picked: Ingredient) => {
    setIngredient(picked)
    setQuantityG(picked.pieceWeightG ?? DEFAULT_QUANTITY_G)
    setScanInjecte(undefined)
  }

  const missingIngredient = ingredient === null || ingredient.id === null
  const missingQuantity = quantityG === null || quantityG <= 0

  const priceReading = readPrice(price, quantityG)
  const priceError = attempted && priceReading.kind === 'invalid' ? priceReading.message : null

  const busy = add.isPending || addPrice.isPending

  const submit = async () => {
    setAttempted(true)
    // Les memes conditions que ci-dessus, re-testees sur les valeurs elles-memes
    // pour que TypeScript sache ici que l'identifiant et la quantite existent.
    if (ingredient === null || ingredient.id === null) return
    if (quantityG === null || quantityG <= 0) return
    // Un prix a moitie saisi se corrige avant d'ecrire quoi que ce soit. Un
    // prix ABSENT, lui, ne bloque jamais : c'est un complement, pas une
    // condition.
    if (priceReading.kind === 'invalid') return

    const name = ingredient.name

    try {
      await add.mutateAsync({
        ingredientId: ingredient.id,
        quantityG,
        expiryDate,
        // Chaine vide -> null : le desktop stockait tantot l'un tantot l'autre
        // selon le chemin de code, et « pas de note » devenait deux choses.
        storage: null,
      unit: null,
      notes: notes.trim() === '' ? null : notes.trim(),
      })
    } catch {
      // L'erreur reste exposee par `add.error`, affichee en bas de la feuille,
      // qui reste ouverte avec la saisie intacte.
      return
    }

    if (priceReading.kind === 'ready') {
      try {
        await addPrice.mutateAsync(priceReading.entry)
        toast.show({ message: `${name} ajouté au frigo, prix relevé.` })
      } catch {
        /*
         * Le lot EST enregistre : rouvrir la feuille pour reessayer le prix
         * creerait un second lot. On ferme donc, en disant exactement ce qui
         * est passe et ou reprendre — la fiche du lot sait relever un prix.
         */
        toast.show({
          message: `${name} ajouté au frigo, mais le prix n’a pas pu être enregistré. Rouvre le lot pour réessayer.`,
        })
      }
    } else {
      toast.show({ message: `${name} ajouté au frigo.` })
    }

    onClose()
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Ajouter au stock"
      // Pendant l'enregistrement, fermer ferait croire a une annulation alors
      // que la requete est deja partie.
      dismissible={!busy}
      actions={
        <>
          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
            disabled={busy}
          >
            Annuler
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </>
      }
    >
      {ingredient === null ? (
        <>
          <IngredientPicker
            onPick={pick}
            label="Ingrédient"
            placeholder="Cherche dans ta bibliothèque…"
            hint="Seule ta bibliothèque personnelle est proposée."
            required
            error={attempted && missingIngredient ? 'Choisis un ingrédient.' : null}
          />
          {/* Sous le champ et non a cote : la liste de suggestions s'ouvre DANS
              le flux, juste dessous, et un bouton place sur la meme ligne
              sauterait a chaque frappe en plus de retrecir le champ sur 375 px. */}
          <ScanToStock onPick={pick} initialCode={scanInjecte} />
        </>
      ) : (
        <div className="picked">
          <span className="picked__label">Ingrédient</span>
          <span className="picked__name">{ingredient.name}</span>
          <button
            type="button"
            className="button button--ghost picked__change"
            onClick={() => {
              setIngredient(null)
              // Le prix appartient au produit : le garder d'un ingredient a
              // l'autre releverait le montant du premier sur la fiche du
              // second, sans que rien ne le signale.
              setPrice(EMPTY_PRICE_DRAFT)
              setPriceOpen(false)
            }}
          >
            Changer
          </button>
        </div>
      )}

      <QuantityField
        label="Quantité"
        value={quantityG}
        onChange={setQuantityG}
        pieceWeightG={ingredient?.pieceWeightG ?? null}
        required
        error={attempted && missingQuantity ? 'Indique une quantité supérieure à zéro.' : null}
      />

      <DateField
        label="Périmé le"
        value={expiryDate}
        onChange={setExpiryDate}
        hint="Facultatif — laisse vide pour le sel, les épices, les conserves."
      />

      {/* Le prix n'a de destination qu'une fois l'ingredient connu : c'est sur
          SA fiche qu'il est releve. Replie par defaut — on ne note pas un prix
          a chaque fois qu'on range quelque chose. */}
      {ingredient !== null &&
        (priceOpen ? (
          <section className="price-paid">
            <h3 className="price-paid__title">Prix payé</h3>
            <p className="price-paid__lead">
              Facultatif. Il n’est pas attaché au lot : il rejoint l’historique de prix de
              l’ingrédient, et met à jour le coût de ta liste de courses.
            </p>
            <PricePaidFields
              draft={price}
              onChange={setPrice}
              fallbackQuantityG={quantityG}
              pieceWeightG={ingredient.pieceWeightG}
              error={priceError}
              disabled={busy}
            />
          </section>
        ) : (
          <button
            type="button"
            className="button button--secondary button--block"
            onClick={() => setPriceOpen(true)}
          >
            Saisir le prix payé
          </button>
        ))}

      <TextField
        label="Note"
        value={notes}
        onChange={setNotes}
        placeholder="Ex : promo Lidl, ouvert hier…"
        maxLength={NOTES_MAX_LENGTH}
      />

      {add.isError && (
        <p className="text-error" role="alert">
          {add.error.message}
        </p>
      )}
    </Sheet>
  )
}
