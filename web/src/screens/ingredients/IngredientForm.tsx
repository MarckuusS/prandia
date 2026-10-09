/**
 * Fiche d'ingredient — creation ET modification, portage du panneau droit de
 * IngredientsPage.qml.
 *
 * Le desktop montrait liste et formulaire cote a cote dans un SplitView 42/58.
 * En 375 px c'est un ecran a part, atteint depuis la liste et quitte par le
 * bouton Retour. Consequence directe : il faut une barre d'action COLLANTE (le
 * bouton Enregistrer ne se cherche pas au bas d'un formulaire de vingt champs)
 * et un signalement des modifications non enregistrees, que le desktop n'avait
 * pas et dont l'absence se paye bien plus cher au doigt.
 *
 * Quatre regles metier qui ne se devinent pas en lisant le formulaire :
 *
 *   1. Une macro VIDE vaut « inconnue » (`null`), pas zero. Le desktop allait
 *      plus loin et convertissait AUSSI un 0 saisi en `null`, rendant
 *      impossible d'affirmer « 0 g de sucres ». Ce piege n'est pas porte :
 *      vide = inconnu, 0 = zero mesure.
 *
 *   2. `source` et `sourceRef` ne partent PAS en modification. Le desktop
 *      affichait un champ « Réf. source » editable dont la saisie etait
 *      ensuite ignoree en silence. Ici il passe en lecture seule des que la
 *      fiche existe.
 *
 *   3. Le prix ne se saisit pas : il derive du dernier releve. La cellule est
 *      un BOUTON qui ouvre l'historique, plutot qu'un cadenas qui n'explique
 *      rien.
 *
 *   4. `source` n'est pas un champ : elle se DEDUIT de la provenance du code
 *      porte par « Réf. source ». Un code venu d'OpenFoodFacts — parametre
 *      `?ean=` de la feuille d'import, ou scan fait ici — donne une fiche
 *      `openfoodfacts` ; tout le reste donne `manual`. C'est ce qui garantit
 *      que le lien « ouvrir la fiche d'origine », affiche ensuite en lecture
 *      seule, mene bien quelque part.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { SOURCE_LABELS, formatEuros, formatGrams, type Ingredient, type Source } from '@prandia/shared'

import { BarcodeScanner, isValidEan } from '../../components/BarcodeScanner.js'
import {
  FieldShell,
  NumberField,
  SelectField,
  TextField,
  useFieldIds,
} from '../../components/Field.js'
import { ConfirmDialog } from '../../components/Sheet.js'
import { SourceBadge } from '../../components/States.js'
import { Icon } from '../../icons/index.js'
import { ApiError } from '../../lib/api.js'
import {
  useBarcode,
  useRayons,
  useCreateIngredient,
  useDeleteIngredient,
  useUpdateIngredient,
} from '../../lib/queries.js'
import { PriceHistorySheet } from './PriceHistorySheet.js'
import {
  EMPTY_DRAFT,
  MONTHS,
  draftFromIngredient,
  sourceUrl,
  toWritePayload,
  type IngredientDraft,
} from './model.js'
import '../../styles/ingredients.css'

/** Les 8 champs du tableau nutritionnel, dans l'ordre impose par la reglementation UE. */
const NUTRIENTS = [
  { key: 'kcal', label: 'Énergie', unit: 'kcal/100 g', max: 2000, sub: false },
  { key: 'fats', label: 'Lipides', unit: 'g/100 g', max: 100, sub: false },
  { key: 'saturatedFats', label: 'dont acides gras saturés', unit: 'g/100 g', max: 100, sub: true },
  { key: 'carbs', label: 'Glucides', unit: 'g/100 g', max: 100, sub: false },
  { key: 'sugars', label: 'dont sucres', unit: 'g/100 g', max: 100, sub: true },
  { key: 'fiber', label: 'Fibres', unit: 'g/100 g', max: 100, sub: false },
  { key: 'proteins', label: 'Protéines', unit: 'g/100 g', max: 100, sub: false },
  { key: 'salt', label: 'Sel', unit: 'g/100 g', max: 100, sub: false },
] as const

type NutrientKey = (typeof NUTRIENTS)[number]['key']

/**
 * Aide du champ « Réf. source ».
 *
 * Sortie du JSX parce que le champ n'est plus un `TextField` : il faut la
 * passer a `FieldShell` et la reutiliser pour `useFieldIds`.
 */
const SOURCE_REF_HINT =
  'Modifiable uniquement à la création : c’est cette référence qui relie ensuite la fiche à son catalogue d’origine.'

/**
 * Code-barres transmis par l'URL, `null` quand il n'y a rien d'exploitable.
 *
 * La cle de controle est verifiee avant tout pre-remplissage. Le seul emetteur
 * legitime de ce parametre — la feuille d'import, quand un scan ne trouve rien
 * chez OpenFoodFacts — ne produit que des codes deja valides ; une reference
 * bidon tapee dans la barre d'adresse voyagerait sinon jusqu'au lien « ouvrir
 * la fiche d'origine » de la fiche enregistree, qui pointerait vers une page
 * inexistante.
 */
function readEanParam(params: URLSearchParams): string | null {
  const raw = params.get('ean')
  if (raw === null) return null
  const digits = raw.replace(/\D/g, '')
  return isValidEan(digits) ? digits : null
}

export interface IngredientFormProps {
  /** `null` en creation. Le parent monte le formulaire avec `key={id}`. */
  readonly ingredient: Ingredient | null
}

export function IngredientForm({ ingredient }: IngredientFormProps) {
  const navigate = useNavigate()
  const create = useCreateIngredient()
  const update = useUpdateIngredient()
  const rayons = useRayons()
  const [searchParams] = useSearchParams()

  // `?ean=` n'est lu qu'a la CREATION : en modification « Réf. source » est en
  // lecture seule, et l'API reecrit de toute facon la reference depuis la ligne
  // existante. Honorer le parametre y afficherait une valeur que rien
  // n'enregistrerait — exactement le piege silencieux que la fiche evite.
  const prefillEan = ingredient === null ? readEanParam(searchParams) : null

  /*
   * `?remplir=1` demande d'interroger OpenFoodFacts d'entree.
   *
   * DEUX ARRIVEES, deux intentions. Depuis la feuille d'import, on n'atterrit
   * ici qu'apres avoir lu « produit inconnu » : relancer la requete reposerait
   * une question deja tranchee et afficherait un echec en travers d'un
   * formulaire vide. Depuis le point d'entree de scan, au contraire, le
   * produit vient d'etre RESOLU et affiche — arriver sur une fiche vide
   * obligerait a rescanner le meme code. Le parametre distingue les deux.
   */
  const remplirDepuisOff = prefillEan !== null && searchParams.get('remplir') === '1'

  const initial = useMemo(
    // Le code pre-rempli fait partie de l'etat INITIAL et non d'une
    // modification : sinon la fiche s'ouvrirait en annoncant « Modifications
    // non enregistrées » avant que l'utilisateur ait touche quoi que ce soit.
    () =>
      ingredient ? draftFromIngredient(ingredient) : { ...EMPTY_DRAFT, sourceRef: prefillEan ?? '' },
    [ingredient, prefillEan],
  )
  const [draft, setDraft] = useState<IngredientDraft>(initial)
  const [nameError, setNameError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)
  const [priceOpen, setPriceOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  /** Code qui rattache la fiche a OpenFoodFacts : celui de l'URL, puis celui du dernier scan. */
  const [offEan, setOffEan] = useState<string | null>(prefillEan)

  const patch = (changes: Partial<IngredientDraft>) =>
    setDraft((current) => ({ ...current, ...changes }))

  // Source deduite plutot que choisie (regle 4 de l'en-tete). Tant que « Réf.
  // source » porte EXACTEMENT le code venu d'OpenFoodFacts, la fiche vient de
  // la ; des que l'utilisateur le retouche, elle redevient manuelle. Un menu
  // « Source » de plus aurait laisse annoncer « openfoodfacts » sur un code
  // invente, donc un lien d'origine mort.
  const source: Source =
    offEan !== null && draft.sourceRef.trim() === offEan ? 'openfoodfacts' : 'manual'

  const id = ingredient?.id ?? null
  const isPending = create.isPending || update.isPending
  const error = id === null ? create.error : update.error
  // Le doublon de nom n'est pas une panne : il se lit au niveau du champ Nom,
  // la ou l'utilisateur peut le corriger, et pas dans la barre d'action.
  const duplicateMessage =
    error instanceof ApiError && error.code === 'duplicate_name' ? error.message : null
  /**
   * La fiche que le serveur designe comme deja existante.
   *
   * Le 409 portait `existingId` depuis le debut, et personne ne le lisait :
   * l'utilisateur voyait "ce nom existe deja" sans le moindre moyen d'aller
   * voir. Il devait quitter le formulaire, perdre sa saisie, et chercher a la
   * main ce qu'il venait de recreer.
   */
  const duplicateId =
    error instanceof ApiError && error.code === 'duplicate_name'
      ? typeof error.extra['existingId'] === 'number'
        ? error.extra['existingId']
        : null
      : null

  // Le formulaire est « sale » des qu'il s'ecarte de ce qui a ete charge. La
  // comparaison passe par JSON : le brouillon est un objet plat de valeurs
  // primitives, une comparaison champ a champ n'apprendrait rien de plus.
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)

  // « ✓ Enregistré » pendant 1,5 s, comme le desktop : sur telephone, rien
  // d'autre ne signale qu'un formulaire est parti — ni titre de fenetre, ni
  // barre d'etat.
  useEffect(() => {
    if (savedAt === 0) return
    const timer = setTimeout(() => setSavedAt(0), 1500)
    return () => clearTimeout(timer)
  }, [savedAt])

  // Un rafraichissement ou une fermeture d'onglet avec un formulaire en cours
  // perd tout sans rien demander. C'est le seul garde-fou que le navigateur
  // laisse poser ; la navigation interne, elle, est signalee par la mention
  // « Modifications non enregistrées » de la barre d'action.
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const name = draft.name.trim()
    if (name === '') {
      setNameError("Le nom de l'ingrédient est obligatoire.")
      return
    }
    setNameError(null)

    const payload = toWritePayload(draft)

    if (id === null) {
      create.mutate(
        // `sourceRef` n'est accepte qu'ici : ensuite il identifie la fiche
        // d'origine et n'a plus aucune raison de bouger.
        { ...payload, source, sourceRef: draft.sourceRef.trim() || null },
        // `replace` : le bouton Retour ne doit pas ramener sur un formulaire
        // vide qui recreerait un doublon au prochain envoi.
        { onSuccess: (created) => void navigate(`/ingredients/${created.id}`, { replace: true }) },
      )
      return
    }

    // `id` APRES l'etalement : `Partial<Ingredient>` porte un `id` optionnel
    // qui, place en premier, ecraserait celui du chemin par `undefined`.
    update.mutate({ ...payload, id }, { onSuccess: () => setSavedAt(Date.now()) })
  }

  return (
    <>
      <form className="form ing-form" onSubmit={submit}>
        <Identity
          ingredient={ingredient}
          draft={draft}
          nameError={nameError ?? duplicateMessage}
          onPatch={patch}
          autoLookup={remplirDepuisOff ? prefillEan : null}
          onScan={(code) => {
            setOffEan(code)
            patch({ sourceRef: code })
          }}
        />

        {duplicateId !== null && (
          <p className="note" role="alert">
            Cette fiche existe déjà dans ta bibliothèque.{' '}
            <Link to={`/ingredients/${duplicateId}`}>Ouvrir la fiche existante</Link>. Ta saisie
            sera perdue.
          </p>
        )}

        <fieldset className="ing-form__section">
          <legend className="ing-form__legend">Valeurs nutritionnelles pour 100 g</legend>
          <p className="field__hint">
            Laisse un champ vide quand la valeur est inconnue : « — » et « 0 » ne disent pas la même
            chose, et un zéro inventé fausserait tous les totaux de la semaine.
          </p>
          {NUTRIENTS.map((nutrient) => (
            <div key={nutrient.key} className={nutrient.sub ? 'ing-form__sub' : undefined}>
              <NumberField
                label={nutrient.label}
                value={draft[nutrient.key]}
                onChange={(value) => patch(nutrientChange(nutrient.key, value))}
                suffix={nutrient.unit}
                min={0}
                max={nutrient.max}
                decimals={2}
              />
            </div>
          ))}
        </fieldset>

        <fieldset className="ing-form__section">
          <legend className="ing-form__legend">Quantités</legend>
          <NumberField
            label="Poids unitaire"
            value={draft.pieceWeightG}
            onChange={(value) => patch({ pieceWeightG: value })}
            suffix="g / pièce"
            min={0}
            max={10000}
            decimals={1}
            hint="1 œuf ≈ 60 g, 1 oignon ≈ 150 g, 1 gousse d’ail ≈ 5 g. Renseigné, il fait apparaître l’unité « pièce » partout où l’on saisit une quantité. Vide pour l’huile, le lait, le riz, le sel."
          />
          <NumberField
            label="Poids cuit"
            value={draft.cookedWeightPer100gRaw}
            onChange={(value) => patch({ cookedWeightPer100gRaw: value })}
            suffix="g / 100 g cru"
            min={0}
            max={1000}
            decimals={1}
            hint="Ex : 300 pour du riz (100 g cru → 300 g cuit). Optionnel — sert à estimer le poids d’une portion servie. Les valeurs nutritionnelles restent par 100 g cru."
          />
        </fieldset>

        <fieldset className="ing-form__section">
          <legend className="ing-form__legend">Rayon</legend>
          {/* Liste FERMEE, alimentee par le gestionnaire de rayons.
              La saisie libre qui existait ici fabriquait des sections
              fantomes : « Epicerie » et « Épicerie » sont deux rayons pour la
              liste de courses, qui regroupe sur le texte exact. Creer un rayon
              se fait donc en un seul endroit, ou on le voit deja exister. */}
          <SelectField
            label="Rayon"
            value={draft.categoryL1}
            onChange={(value) => patch({ categoryL1: value })}
            placeholder="Aucun rayon"
            options={rayonOptions(rayons.data?.items ?? [], draft.categoryL1)}
            hint="Regroupe l’ingrédient dans la liste de courses et dans le frigo."
          />
          <p className="field__hint">
            Il manque un rayon ? <Link to="/parametres/rayons">Gérer les rayons</Link>.
          </p>
        </fieldset>

        <SeasonPicker months={draft.months} onChange={(months) => patch({ months })} />

        {ingredient && <PriceSummary ingredient={ingredient} onOpenHistory={() => setPriceOpen(true)} />}

        <div className="ing-form__danger">
          {id === null ? (
            <button type="button" className="button button--secondary" onClick={() => void navigate(-1)}>
              Annuler
            </button>
          ) : (
            <button type="button" className="button button--danger" onClick={() => setDeleteOpen(true)}>
              {ingredient?.source === 'manual' ? 'Supprimer cet ingrédient' : 'Retirer de ma bibliothèque'}
            </button>
          )}
        </div>

        <div className="ing-actions">
          <p className="ing-actions__state" aria-live="polite">
            {error !== null && duplicateMessage === null ? (
              <span className="text-error" role="alert">
                {error.message}
              </span>
            ) : dirty ? (
              'Modifications non enregistrées'
            ) : (
              ''
            )}
          </p>
          <button
            type="submit"
            className={`button ${savedAt > 0 ? 'button--saved' : 'button--primary'}`}
            disabled={isPending}
          >
            {savedAt > 0 ? (
              <>
                <Icon name="ui-check" size={16} className="icon--inline" /> Enregistré
              </>
            ) : isPending ? (
              'Enregistrement…'
            ) : (
              'Enregistrer'
            )}
          </button>
        </div>
      </form>

      {ingredient && (
        <PriceHistorySheet open={priceOpen} onClose={() => setPriceOpen(false)} ingredient={ingredient} />
      )}

      {ingredient && id !== null && (
        <DeleteDialog open={deleteOpen} ingredient={ingredient} onClose={() => setDeleteOpen(false)} />
      )}
    </>
  )
}

/**
 * Traduit « ce nutriment vaut X » en modification partielle du brouillon.
 *
 * Passe par un `switch` plutot que par une cle calculee : sous
 * `exactOptionalPropertyTypes`, `{ [key]: value }` avec une cle d'union se
 * degrade en signature d'index et perd tout controle de type.
 */
function nutrientChange(key: NutrientKey, value: number | null): Partial<IngredientDraft> {
  switch (key) {
    case 'kcal':
      return { kcal: value }
    case 'fats':
      return { fats: value }
    case 'saturatedFats':
      return { saturatedFats: value }
    case 'carbs':
      return { carbs: value }
    case 'sugars':
      return { sugars: value }
    case 'fiber':
      return { fiber: value }
    case 'proteins':
      return { proteins: value }
    case 'salt':
      return { salt: value }
  }
}

/** Rayons connus, plus celui de la fiche s'il n'est plus utilise par personne d'autre. */
/**
 * Options du menu Rayon.
 *
 * Le rayon COURANT est ajoute d'office s'il ne figure pas dans la liste. Sans
 * cette precaution, un ingredient dont le rayon vient d'etre supprime par
 * l'autre cuisinier verrait son champ se vider tout seul a l'ouverture de la
 * fiche, et un simple « Enregistrer » effacerait l'information sans que
 * personne ne l'ait demande.
 */
function rayonOptions(
  known: ReadonlyArray<{ name: string; ingredientCount: number }>,
  current: string,
): Array<{ value: string; label: string }> {
  const options = known.map((r) => ({ value: r.name, label: `${r.name} (${r.ingredientCount})` }))
  if (current !== '' && !known.some((r) => r.name === current)) {
    options.unshift({ value: current, label: `${current} (rayon supprimé)` })
  }
  return options
}

// ---------------------------------------------------------------------------
// Identite
// ---------------------------------------------------------------------------

function Identity({
  ingredient,
  draft,
  nameError,
  onPatch,
  onScan,
  autoLookup,
}: {
  ingredient: Ingredient | null
  draft: IngredientDraft
  nameError: string | null
  onPatch: (changes: Partial<IngredientDraft>) => void
  /** Code lu par la camera. Remonte pour fixer la source de la fiche. */
  onScan: (code: string) => void
  /** Code a interroger des l'ouverture, quand l'appelant sait le produit connu. */
  autoLookup: string | null
}) {
  const link = ingredient ? sourceUrl(ingredient) : null
  const [scanning, setScanning] = useState(false)

  /**
   * Code dont on attend la fiche OpenFoodFacts.
   *
   * Il n'est amorce que si l'appelant l'a DEMANDE (`?remplir=1`, pose par le
   * point d'entree de scan, qui vient de resoudre le produit). Depuis la
   * feuille d'import on arrive apres un « produit inconnu » : relancer la
   * requete reposerait une question deja tranchee et afficherait un panneau
   * d'echec en travers d'un formulaire vide.
   */
  const [lookup, setLookup] = useState<string | null>(autoLookup)

  const refIds = useFieldIds(undefined, { hint: SOURCE_REF_HINT })

  return (
    <fieldset className="ing-form__section">
      <legend className="ing-form__legend">Identité</legend>

      <TextField
        label="Nom"
        value={draft.name}
        onChange={(value) => onPatch({ name: value })}
        placeholder="Ex : Tomate grappe"
        error={nameError}
        required
        autoFocus={ingredient === null}
        enterKeyHint="next"
      />

      <TextField
        label="Marque"
        value={draft.brand}
        onChange={(value) => onPatch({ brand: value })}
        placeholder="Ex : Pâturages, Carrefour Bio… (optionnel)"
      />

      {ingredient === null ? (
        <>
          {/* `FieldShell` + `useFieldIds` au lieu de `TextField` : c'est le seul
              moyen de glisser un bouton ENTRE le libelle et l'aide. Un bouton
              pose a cote du `TextField` entier se serait aligne sous la ligne
              d'aide, a dix pixels du bord bas de la carte. Les deux helpers
              sont exportes pour ce cas — QuantityField fait pareil. */}
          <FieldShell ids={refIds} label="Réf. source" hint={SOURCE_REF_HINT}>
            <div className="ing-scan">
              <input
                id={refIds.controlId}
                className="field__input"
                type="text"
                value={draft.sourceRef}
                onChange={(event) => onPatch({ sourceRef: event.target.value })}
                placeholder="Code CIQUAL ou code-barres EAN (optionnel)"
                inputMode="numeric"
                aria-describedby={refIds.describedBy}
              />
              {/* Treize chiffres recopies a la main devant un rayon, c'est une
                  erreur de saisie sur deux. Le meme geste qu'a l'import. */}
              <button
                type="button"
                className="button button--secondary ing-scan__button"
                onClick={() => setScanning(true)}
              >
                Scanner
              </button>
            </div>
          </FieldShell>

          <BarcodeScanner
            open={scanning}
            onClose={() => setScanning(false)}
            title="Scanner un code-barres"
            hint="Le code remplira « Réf. source »."
            onDetect={(code) => {
              setScanning(false)
              setLookup(code)
              onScan(code)
            }}
          />

          {/* `key` sur le code : un second scan doit repartir d'un panneau
              neuf, pas garder le « ✓ repris » du produit precedent. */}
          {lookup !== null && (
            <ScannedFill
              key={lookup}
              ean={lookup}
              draft={draft}
              onPatch={onPatch}
              onDismiss={() => setLookup(null)}
            />
          )}
        </>
      ) : (
        <div className="ing-readonly">
          <span className="field__label">Source</span>
          <span className="ing-readonly__value">
            <SourceBadge source={ingredient.source} />
            {link ? (
              // rel="noopener" : la page ouverte ne doit pas pouvoir manipuler
              // celle-ci par `window.opener`. En PWA iOS le lien quitte
              // l'application, d'ou le libelle explicite.
              <a href={link} target="_blank" rel="noopener noreferrer" className="ing-readonly__link">
                {ingredient.sourceRef} - ouvrir la fiche d’origine{' '}
                <Icon name="ui-external-link" size={14} className="icon--inline" />
              </a>
            ) : (
              <span>{SOURCE_LABELS[ingredient.source]}</span>
            )}
          </span>
        </div>
      )}
    </fieldset>
  )
}

// ---------------------------------------------------------------------------
// Reprise d'une fiche OpenFoodFacts
// ---------------------------------------------------------------------------

/**
 * Fusionne un produit OpenFoodFacts dans le brouillon.
 *
 * Toutes les cles sont TOUJOURS rendues, meme quand la valeur ne bouge pas.
 * L'alternative — n'emettre que les cles concernees par des spreads
 * conditionnels — se type mal sous `exactOptionalPropertyTypes`, et la variante
 * naive (`{ name: undefined }` pour « ne touche pas ») VIDERAIT le champ au
 * lieu de le preserver. Reecrire une valeur identique ne coute rien.
 *
 * `replace = false` ne remplit que le vide : c'est l'action par defaut, celle
 * qui ne peut pas faire perdre une saisie.
 */
function merged(
  draft: IngredientDraft,
  product: Ingredient,
  replace: boolean,
): Partial<IngredientDraft> {
  const text = (current: string, incoming: string | null): string =>
    incoming === null || incoming.trim() === '' || (!replace && current.trim() !== '')
      ? current
      : incoming.trim()

  // `current !== null` et non « falsy » : 0 est une valeur mesuree, pas un vide.
  const macro = (current: number | null, incoming: number | null): number | null =>
    incoming === null || (!replace && current !== null) ? current : incoming

  return {
    name: text(draft.name, product.name),
    brand: text(draft.brand, product.brand),
    kcal: macro(draft.kcal, product.kcal),
    fats: macro(draft.fats, product.fats),
    saturatedFats: macro(draft.saturatedFats, product.saturatedFats),
    carbs: macro(draft.carbs, product.carbs),
    sugars: macro(draft.sugars, product.sugars),
    fiber: macro(draft.fiber, product.fiber),
    proteins: macro(draft.proteins, product.proteins),
    salt: macro(draft.salt, product.salt),
  }
}

/** Champs deja remplis que la fiche OpenFoodFacts recouvrirait, nommes pour l'utilisateur. */
function overwritten(draft: IngredientDraft, product: Ingredient): string[] {
  const names: string[] = []
  if (draft.name.trim() !== '' && product.name.trim() !== '') names.push('Nom')
  if (draft.brand.trim() !== '' && (product.brand ?? '').trim() !== '') names.push('Marque')

  // Huit libelles enumeres feraient une phrase illisible sur 375 px : au-dela
  // d'un seul conflit, on compte.
  const macros = NUTRIENTS.filter((n) => draft[n.key] !== null && product[n.key] !== null).map(
    (n) => n.label,
  )
  if (macros.length === 1) names.push(...macros)
  else if (macros.length > 1) names.push(`${macros.length} valeurs nutritionnelles`)

  return names
}

/**
 * Ce qu'OpenFoodFacts sait du code lu — propose, jamais impose.
 *
 * Quatre issues, qui n'appellent pas la meme action : la fiche est deja dans la
 * bibliotheque (l'ouvrir, plutot que de finir sur un 409 « existe déjà » au
 * moment d'enregistrer), le produit est connu (le reprendre), le code est
 * inconnu (cas NORMAL : marque de distributeur, produit local, vrac), ou le
 * reseau a lache.
 */
function ScannedFill({
  ean,
  draft,
  onPatch,
  onDismiss,
}: {
  ean: string
  draft: IngredientDraft
  onPatch: (changes: Partial<IngredientDraft>) => void
  onDismiss: () => void
}) {
  const query = useBarcode(ean)
  const [applied, setApplied] = useState(false)

  if (query.isPending) {
    return (
      <p className="ing-scan-fill__wait" aria-live="polite">
        Recherche du produit sur OpenFoodFacts…
      </p>
    )
  }

  if (query.isError) {
    const unknown = query.error instanceof ApiError && query.error.status === 404
    return (
      <div className="ing-scan-fill">
        <p className="card__lead">
          {unknown
            ? `Le code ${ean} est inconnu d’OpenFoodFacts. Il reste dans « Réf. source » ; le reste est à saisir.`
            : query.error.message}
        </p>
        <div className="ing-scan-fill__actions">
          <button type="button" className="button button--ghost" onClick={onDismiss}>
            Fermer
          </button>
        </div>
      </div>
    )
  }

  const product = query.data

  if (product.id !== null && (product.alreadyKnown === true || product.inLibrary)) {
    return (
      <div className="ing-scan-fill">
        <p className="status status--ok">« {product.name} » est déjà dans ta bibliothèque.</p>
        <div className="ing-scan-fill__actions">
          <Link to={`/ingredients/${product.id}`} className="button button--primary lien-surface">
            Ouvrir sa fiche
          </Link>
          <button type="button" className="button button--ghost" onClick={onDismiss}>
            Continuer cette création
          </button>
        </div>
      </div>
    )
  }

  if (applied) {
    return (
      <div className="ing-scan-fill">
        <p className="status status--ok">
          <Icon name="ui-check" size={16} className="icon--inline" /> Informations reprises depuis
          OpenFoodFacts.
        </p>
        {/* Rien n'est parti au serveur : le dire evite le classique « je croyais
            que c'était enregistré » sur un formulaire quitte au bouton Retour. */}
        <p className="card__lead">Relis les valeurs, puis « Enregistrer ».</p>
        <div className="ing-scan-fill__actions">
          <button type="button" className="button button--ghost" onClick={onDismiss}>
            Fermer
          </button>
        </div>
      </div>
    )
  }

  const conflicts = overwritten(draft, product)

  const apply = (replace: boolean) => {
    onPatch(merged(draft, product, replace))
    setApplied(true)
  }

  const macros = [
    product.kcal !== null ? `${Math.round(product.kcal)} kcal` : null,
    product.proteins !== null ? `P ${formatGrams(product.proteins)}` : null,
    product.carbs !== null ? `G ${formatGrams(product.carbs)}` : null,
    product.fats !== null ? `L ${formatGrams(product.fats)}` : null,
  ].filter((part): part is string => part !== null)

  return (
    <div className="ing-scan-fill">
      <p className="ing-scan-fill__title">{product.name}</p>
      {/* Un produit OpenFoodFacts sans marque NI macro existe : ne pas laisser
          une ligne vide ouvrir un ecart de plus dans une carte deja dense. */}
      {(product.brand || macros.length > 0) && (
        <p className="ing-scan-fill__meta">
          {product.brand && <span>{product.brand}</span>}
          {macros.length > 0 && <span>{macros.join(' · ')}</span>}
        </p>
      )}

      <p className="card__lead">
        {conflicts.length === 0
          ? 'OpenFoodFacts connaît ce produit : reprends sa fiche plutôt que de tout saisir.'
          : `Tu as déjà rempli : ${conflicts.join(', ')}. Ta saisie est gardée, sauf si tu demandes le remplacement.`}
      </p>

      {/* Le bouton par defaut ne detruit jamais rien. « Tout remplacer » n'existe
          que lorsqu'il y a effectivement quelque chose a ecraser, et il le dit. */}
      <div className="ing-scan-fill__actions">
        <button type="button" className="button button--primary" onClick={() => apply(false)}>
          {conflicts.length === 0 ? 'Reprendre ces informations' : 'Compléter les champs vides'}
        </button>
        {conflicts.length > 0 && (
          <button type="button" className="button button--secondary" onClick={() => apply(true)}>
            Tout remplacer
          </button>
        )}
        <button type="button" className="button button--ghost" onClick={onDismiss}>
          Ignorer
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Saisonnalite
// ---------------------------------------------------------------------------

function SeasonPicker({
  months,
  onChange,
}: {
  months: readonly number[]
  onChange: (months: readonly number[]) => void
}) {
  const selected = new Set(months)

  const toggle = (month: number) => {
    const next = new Set(selected)
    if (next.has(month)) next.delete(month)
    else next.add(month)
    onChange([...next].sort((a, b) => a - b))
  }

  return (
    <fieldset className="ing-form__section">
      <legend className="ing-form__legend">Saisonnalité</legend>
      <p className="field__hint">
        Coche les mois où l’ingrédient est de saison. Vide = pas de badge « de saison ».
      </p>

      {/* Deux rangees de six et non une de douze : douze cibles alignees sur
          375 px feraient 28 px de large, sous le minimum tactile. */}
      <div className="ing-months" role="group" aria-label="Mois de saison">
        {MONTHS.map((month) => (
          <button
            key={month.number}
            type="button"
            className={`ing-month${selected.has(month.number) ? ' ing-month--on' : ''}`}
            aria-pressed={selected.has(month.number)}
            aria-label={month.name}
            onClick={() => toggle(month.number)}
          >
            <span aria-hidden="true">{month.initial}</span>
          </button>
        ))}
      </div>

      <div className="ing-months__shortcuts">
        <button
          type="button"
          className="button button--ghost"
          onClick={() => onChange(MONTHS.map((month) => month.number))}
        >
          Toute l’année
        </button>
        <button type="button" className="button button--ghost" onClick={() => onChange([])}>
          Aucun mois
        </button>
      </div>
    </fieldset>
  )
}

// ---------------------------------------------------------------------------
// Prix
// ---------------------------------------------------------------------------

function PriceSummary({
  ingredient,
  onOpenHistory,
}: {
  ingredient: Ingredient
  onOpenHistory: () => void
}) {
  return (
    <fieldset className="ing-form__section">
      <legend className="ing-form__legend">Prix de référence</legend>

      {/* Cellule cliquable plutot que cadenassee : un champ grise n'explique
          pas POURQUOI il l'est, alors qu'un bouton qui ouvre l'historique
          repond a la question en un tap. */}
      <button type="button" className="ing-price" onClick={onOpenHistory}>
        <span className="ing-price__amount">{formatEuros(ingredient.priceEur)}</span>
        <span className="ing-price__for">
          {ingredient.priceQuantityG ? `pour ${formatGrams(ingredient.priceQuantityG)}` : 'aucun relevé'}
        </span>
        <span className="ing-price__cta" aria-hidden="true">
          <Icon name="ui-chart" size={16} className="icon--inline" /> Historique{' '}
          <Icon name="ui-chevron-right" size={14} className="icon--inline" />
        </span>
      </button>

      <p className="field__hint">
        Calculé automatiquement depuis le dernier relevé de l’historique. Il ne se saisit pas
        directement : note ce que tu vois en rayon, le prix suit.
      </p>
    </fieldset>
  )
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

/**
 * Deux suppressions sous un seul bouton.
 *
 * Une fiche CIQUAL ou OpenFoodFacts n'est jamais detruite : elle SORT de la
 * bibliotheque et reste retrouvable dans l'import. Une fiche saisie a la main
 * disparait pour de bon. La confirmation dit lequel des deux va se produire,
 * parce que rien dans l'ecran ne permet de le deviner.
 */
function DeleteDialog({
  open,
  ingredient,
  onClose,
}: {
  open: boolean
  ingredient: Ingredient
  onClose: () => void
}) {
  const navigate = useNavigate()
  const remove = useDeleteIngredient()
  const permanent = ingredient.source === 'manual'

  return (
    <ConfirmDialog
      open={open}
      title={permanent ? `Supprimer « ${ingredient.name} » ?` : `Retirer « ${ingredient.name} » ?`}
      message={
        permanent
          ? 'Cette fiche a été créée à la main : elle sera définitivement supprimée. Si une recette l’utilise, la suppression sera refusée.'
          : `Cette fiche vient de ${SOURCE_LABELS[ingredient.source]} : elle sort de ta bibliothèque mais reste dans le catalogue. Tu pourras la réimporter à tout moment.`
      }
      confirmLabel={permanent ? 'Supprimer' : 'Retirer'}
      danger
      busy={remove.isPending}
      error={remove.error?.message}
      onClose={onClose}
      onConfirm={() => {
        if (ingredient.id === null) return
        remove.mutate(ingredient.id, {
          onSuccess: (result) => {
            onClose()
            // L'instantane voyage dans l'etat de navigation : c'est ce qui
            // permet a la liste d'offrir « Annuler » sans etat serveur, y
            // compris apres une suppression definitive — la fiche est alors
            // RECREEE, avec un nouvel identifiant, comme sur le desktop.
            void navigate('/ingredients', {
              replace: true,
              state: { deleted: { removed: result.removed, ingredient } },
            })
          },
        })
      }}
    />
  )
}
