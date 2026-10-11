/**
 * Importer une recette depuis un lien : coller, relire, creer.
 *
 * TROIS TEMPS, et le deuxieme est la raison d'etre de l'ecran. Le serveur lit
 * la page et propose une fiche pour chaque ligne (worker/src/routes/
 * importRecette.ts) ; RIEN n'est cree avant que la personne ait relu. Une ligne
 * mal reconnue ("beurre" pris pour du beurre de cacahuete) fausserait les
 * macros de la recette sans que rien ne le signale ensuite.
 *
 * Chaque ligne arrive dans l'un de trois etats, et l'ecran les distingue :
 *   - reconnue : une fiche sure, rien a faire ;
 *   - a verifier : une fiche plausible mais pas certaine, ou une quantite
 *     supposee (une piece sans poids connu, un "sel, poivre" sans quantite) ;
 *   - a choisir : rien d'assez proche. Il faut choisir ou ignorer la ligne
 *     avant de creer, sans quoi la recette mentirait sur ce qu'elle contient.
 *
 * SUR iPHONE, PAS DE "PARTAGER VERS PRANDIA" : iOS ne laisse pas une app
 * installee depuis Safari apparaitre dans le menu Partager (WebKit, bogue
 * 194593). Le geste est donc "copier le lien, toucher Coller", et la lecture
 * part d'elle-meme si le presse-papiers contient un lien.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { formatGrams, importAmount, lienRecette, parseSteps, type Ingredient } from '@prandia/shared'

import { NumberField, SwitchField, TextField } from '../../components/Field.js'
import { QuantityField } from '../../components/QuantityField.js'
import { Sheet } from '../../components/Sheet.js'
import { LoadingRows } from '../../components/States.js'
import { useToast } from '../../components/Toast.js'
import { Icon, RayonIcon } from '../../icons/index.js'
import { reduirePhoto } from '../../lib/photo.js'
import {
  fetchImportPhoto,
  useAddToLibrary,
  useCatalog,
  useReadRecipeLink,
  useSaveRecipe,
  useUploadRecipePhoto,
  type ImportLine,
  type ImportProposal,
} from '../../lib/queries.js'
import { lienDuPressePapiers } from '../../lib/pressePapiers.js'
import { useRayonStyle } from '../../lib/useRayonStyle.js'
import { EtapesRecette } from './EtapesRecette.js'
import '../../styles/import-recette.css'

export function ImportRecette() {
  const [params] = useSearchParams()
  const lecture = useReadRecipeLink()
  const [saisie, setSaisie] = useState(params.get('url') ?? '')
  const [proposition, setProposition] = useState<ImportProposal | null>(null)

  const lancer = (texte: string) => {
    const lien = lienRecette(texte)
    if (lien === null) return
    setSaisie(lien)
    lecture.mutate(lien, { onSuccess: setProposition })
  }

  // Un lien dans l'adresse (venu de "Nouvelle recette", qui a deja lu le
  // presse-papiers) : la lecture part tout de suite, une seule fois.
  const lancee = useRef(false)
  useEffect(() => {
    if (lancee.current) return
    lancee.current = true
    const depart = params.get('url')
    if (depart !== null) lancer(depart)
  }, [])

  if (proposition !== null) {
    return (
      <Revue
        proposition={proposition}
        onRecommencer={() => {
          setProposition(null)
          lecture.reset()
        }}
      />
    )
  }

  const coller = async () => {
    const lien = await lienDuPressePapiers()
    if (lien !== null) lancer(lien)
  }
  const valide = lienRecette(saisie) !== null

  return (
    <section className="screen import">
      <div className="card">
        <h2 className="card__title">Depuis un site de recettes</h2>
        <p className="card__lead">
          Colle le lien d’une recette. Prandia lit ce que le site publie, ingrédients, étapes,
          portions et photo, et te les fait relire avant de créer la recette.
        </p>
        <div className="form">
          <TextField
            label="Lien de la recette"
            type="url"
            inputMode="url"
            enterKeyHint="go"
            value={saisie}
            onChange={setSaisie}
            placeholder="https://www.marmiton.org/recettes/…"
          />
          {saisie.trim() !== '' && !valide && (
            <p className="field__hint">Ce texte ne contient pas de lien vers un site.</p>
          )}
          <div className="import__actions">
            <button type="button" className="button button--secondary" onClick={() => void coller()} disabled={lecture.isPending}>
              <Icon name="ui-copy" size={16} className="icon--inline" /> Coller le lien
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => lancer(saisie)}
              disabled={!valide || lecture.isPending}
            >
              {lecture.isPending ? 'Lecture…' : 'Lire la recette'}
            </button>
          </div>
          {lecture.isError && (
            <p className="text-error" role="alert">
              {lecture.error.message}
            </p>
          )}
        </div>
      </div>
      {lecture.isPending && <LoadingRows rows={4} />}
    </section>
  )
}

// ---------------------------------------------------------------------------
// La revue
// ---------------------------------------------------------------------------

/** Ce que la personne a decide pour une ligne. */
interface Choix {
  readonly ingredient: Ingredient | null
  readonly grams: number | null
  readonly unit: string | null
  /** La quantite est supposee, pas lue : on le dit. */
  readonly estimated: boolean
  /** La fiche est sure : choisie a la main, ou nettement la meilleure. */
  readonly sure: boolean
  readonly ignored: boolean
}

function pour(line: ImportLine, ingredient: Ingredient | null, sure: boolean): Choix {
  if (ingredient === null) return { ingredient: null, grams: null, unit: null, estimated: false, sure: false, ignored: false }
  const quantite = importAmount(line, ingredient)
  return { ingredient, grams: quantite.grams, unit: quantite.unit, estimated: quantite.estimated, sure, ignored: false }
}

const choixInitial = (line: ImportLine): Choix =>
  pour(line, line.candidates.find((c) => c.id === line.choiceId) ?? null, line.sure)

/**
 * Deux lignes pour le meme ingredient ("sel" et "sel fin") n'en font qu'une :
 * l'editeur de recette refuse les doublons. Les masses s'additionnent ; deux
 * unites differentes se relisent en grammes.
 */
function fusionner(retenues: readonly Choix[]) {
  const parId = new Map<number, { ingredientId: number; quantityG: number; unit: string | null; notes: null }>()
  for (const c of retenues) {
    const id = c.ingredient?.id
    if (id === null || id === undefined || c.grams === null || c.grams <= 0) continue
    const deja = parId.get(id)
    if (deja) {
      deja.quantityG += c.grams
      if (deja.unit !== c.unit) deja.unit = 'g'
    } else {
      parId.set(id, { ingredientId: id, quantityG: c.grams, unit: c.unit, notes: null })
    }
  }
  return [...parId.values()]
}

/** Assez grande pour la largeur d'un telephone : on s'arrete a la premiere. */
const PHOTO_LARGEUR_MIN = 600

/**
 * La photo du site, relayee par le serveur, en apercu. Les adresses sont
 * essayees dans l'ordre : la premiere d'au moins `PHOTO_LARGEUR_MIN` pixels
 * l'emporte, a defaut la plus grande. Le bloc recette de certains sites ne
 * donne qu'une vignette de 290 pixels.
 */
function usePhotoImportee(urls: readonly string[]) {
  const cle = urls.join(' ')
  const [etat, setEtat] = useState<{ blob: Blob | null; apercu: string | null; enCours: boolean }>({
    blob: null,
    apercu: null,
    enCours: urls.length > 0,
  })
  useEffect(() => {
    if (cle === '') return
    let annule = false
    let apercu: string | null = null
    void (async () => {
      let meilleure: { blob: Blob; largeur: number } | null = null
      for (const url of cle.split(' ')) {
        try {
          const blob = await fetchImportPhoto(url)
          const image = await createImageBitmap(blob)
          const largeur = image.width
          image.close()
          if (meilleure === null || largeur > meilleure.largeur) meilleure = { blob, largeur }
          if (largeur >= PHOTO_LARGEUR_MIN) break
        } catch {
          // Une adresse morte ou une image illisible : on essaie la suivante.
        }
      }
      if (annule) return
      if (meilleure === null) {
        setEtat({ blob: null, apercu: null, enCours: false })
        return
      }
      apercu = URL.createObjectURL(meilleure.blob)
      setEtat({ blob: meilleure.blob, apercu, enCours: false })
    })()
    return () => {
      annule = true
      if (apercu !== null) URL.revokeObjectURL(apercu)
    }
  }, [cle])
  return etat
}

function Revue({ proposition, onRecommencer }: { readonly proposition: ImportProposal; readonly onRecommencer: () => void }) {
  const { recipe, lines } = proposition
  const navigate = useNavigate()
  const toast = useToast()
  const save = useSaveRecipe()
  const ajouter = useAddToLibrary()
  const deposer = useUploadRecipePhoto()

  const [nom, setNom] = useState(recipe.name)
  const [portions, setPortions] = useState<number | null>(recipe.portions)
  const [temps, setTemps] = useState<number | null>(recipe.prepTimeMin)
  const [choix, setChoix] = useState<Choix[]>(() => lines.map(choixInitial))
  const [enChoix, setEnChoix] = useState<number | null>(null)
  const [garderPhoto, setGarderPhoto] = useState(true)
  const [enCours, setEnCours] = useState(false)
  const [erreur, setErreur] = useState<string | null>(null)
  const photo = usePhotoImportee(recipe.imageUrls)
  // Le texte qui sera enregistre, et ses etapes lues comme la fiche les lira :
  // la revue montre ce que la recette affichera une fois creee.
  const instructions = recipe.steps.join('\n')
  const etapes = useMemo(() => parseSteps(instructions), [instructions])

  const modifier = (index: number, suite: Choix) => setChoix((avant) => avant.map((c, i) => (i === index ? suite : c)))

  const actives = choix.filter((c) => !c.ignored)
  const aChoisir = actives.filter((c) => c.ingredient === null).length
  const aVerifier = actives.filter((c) => c.ingredient !== null && (!c.sure || c.estimated)).length
  const ignorees = choix.length - actives.length
  const site = new URL(recipe.sourceUrl).hostname.replace(/^www\./, '')

  const creer = async () => {
    setEnCours(true)
    setErreur(null)
    try {
      const retenues = actives.filter((c) => c.ingredient !== null)
      // Les fiches du catalogue retenues entrent dans la bibliotheque : c'est
      // la qu'on les retrouve ensuite, dans les recettes comme au planning.
      const aAjouter = new Map<number, Ingredient>()
      for (const c of retenues) {
        if (c.ingredient && !c.ingredient.inLibrary && c.ingredient.id !== null) aAjouter.set(c.ingredient.id, c.ingredient)
      }
      for (const id of aAjouter.keys()) await ajouter.mutateAsync(id)

      const recette = await save.mutateAsync({
        id: null,
        name: nom.trim(),
        instructions,
        defaultPortions: Math.max(1, Math.round(portions ?? 1)),
        sourceUrl: recipe.sourceUrl,
        prepTimeMin: temps !== null && temps > 0 ? Math.round(temps) : null,
        lines: fusionner(retenues),
        tagIds: [],
      })
      if (recette.id === null) throw new Error('La recette n’a pas pu être créée.')

      // La photo AU MIEUX : la recette existe deja, une photo manquee ne doit
      // pas la faire passer pour un echec.
      if (garderPhoto && photo.blob !== null) {
        try {
          const reduite = await reduirePhoto(photo.blob, 'import')
          await deposer.mutateAsync({ recipeId: recette.id, cover: reduite.cover, thumb: reduite.thumb })
        } catch {
          toast.show({ message: 'Recette créée, mais sa photo n’a pas pu être importée.' })
        }
      }
      void navigate(`/recettes/${recette.id}`, { replace: true })
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'La recette n’a pas pu être créée.')
      setEnCours(false)
    }
  }

  const ligneEnChoix = enChoix === null ? undefined : lines[enChoix]

  return (
    <section className="screen import">
      <div className="card import-entete">
        {(photo.enCours || photo.apercu !== null) && (
          <div className={`import-entete__photo${garderPhoto ? '' : ' import-entete__photo--retiree'}`}>
            {photo.apercu !== null ? <img src={photo.apercu} alt="" /> : <span className="skeleton import-entete__attente" />}
          </div>
        )}
        <p className="import-entete__source">
          Lue sur <strong>{site}</strong>
        </p>
        <div className="form">
          <TextField label="Nom" value={nom} onChange={setNom} required />
          <div className="form__row">
            <NumberField label="Portions" value={portions} onChange={setPortions} min={1} max={50} decimals={0} />
            <NumberField label="Temps" value={temps} onChange={setTemps} min={0} max={1440} decimals={0} suffix="min" />
          </div>
          {photo.apercu !== null && (
            <SwitchField
              label="Garder la photo du site"
              hint="Compressée, pour prendre peu de place."
              checked={garderPhoto}
              onChange={setGarderPhoto}
            />
          )}
        </div>
      </div>

      <h2 className="section-header">Ingrédients · {lines.length}</h2>
      <p className="import-bilan">
        {[
          `${actives.length - aChoisir - aVerifier} reconnu${actives.length - aChoisir - aVerifier > 1 ? 's' : ''}`,
          aVerifier > 0 ? `${aVerifier} à vérifier` : null,
          aChoisir > 0 ? `${aChoisir} à choisir` : null,
          ignorees > 0 ? `${ignorees} ignoré${ignorees > 1 ? 's' : ''}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <ul className="import-lignes">
        {lines.map((line, index) => {
          const c = choix[index]
          if (c === undefined) return null
          return (
            <LigneImport
              key={index}
              line={line}
              choix={c}
              onChange={(suite) => modifier(index, suite)}
              onChoisir={() => setEnChoix(index)}
            />
          )
        })}
      </ul>

      {etapes.length > 0 && (
        <div className="card">
          <h3 className="card__title">Étapes · {etapes.filter((e) => !e.heading).length}</h3>
          <EtapesRecette etapes={etapes} />
          <p className="field__hint">Elles se modifient ensuite dans l’éditeur, comme celles d’une recette tapée.</p>
        </div>
      )}

      <div className="card import-fin">
        <button
          type="button"
          className="button button--primary button--block"
          onClick={() => void creer()}
          disabled={aChoisir > 0 || nom.trim() === '' || enCours}
        >
          {enCours ? 'Création…' : 'Créer la recette'}
        </button>
        {aChoisir > 0 && (
          <p className="field__hint">
            {aChoisir === 1
              ? 'Un ingrédient reste à choisir, ou à ignorer, avant de créer la recette.'
              : `${aChoisir} ingrédients restent à choisir, ou à ignorer, avant de créer la recette.`}
          </p>
        )}
        {erreur !== null && (
          <p className="text-error" role="alert">
            {erreur}
          </p>
        )}
        <button type="button" className="button button--ghost button--block" onClick={onRecommencer} disabled={enCours}>
          Changer de lien
        </button>
      </div>

      {ligneEnChoix !== undefined && enChoix !== null && (
        <ChoixIngredient
          line={ligneEnChoix}
          onClose={() => setEnChoix(null)}
          onChoisir={(ingredient) => {
            modifier(enChoix, pour(ligneEnChoix, ingredient, true))
            setEnChoix(null)
          }}
        />
      )}
    </section>
  )
}

function Pastille({ ingredient }: { readonly ingredient: Ingredient }) {
  const style = useRayonStyle()(ingredient.categoryL1)
  return (
    <span className="icon-chip icon-chip--sm" {...style.tint} aria-hidden="true">
      <RayonIcon glyph={style.glyph} size={16} strokeWidth={1.8} />
    </span>
  )
}

function LigneImport({
  line,
  choix,
  onChange,
  onChoisir,
}: {
  readonly line: ImportLine
  readonly choix: Choix
  readonly onChange: (suite: Choix) => void
  readonly onChoisir: () => void
}) {
  const { ingredient } = choix
  if (choix.ignored) {
    return (
      <li className="card import-ligne import-ligne--ignoree">
        <p className="import-ligne__brut">{line.raw}</p>
        <div className="import-ligne__reprendre">
          <span>Ignorée : elle ne sera pas dans la recette.</span>
          <button type="button" className="button button--ghost" onClick={() => onChange({ ...choix, ignored: false })}>
            Reprendre
          </button>
        </div>
      </li>
    )
  }

  const aVerifier = ingredient !== null && (!choix.sure || choix.estimated)
  return (
    <li className="card import-ligne">
      <p className="import-ligne__brut">{line.raw}</p>
      <button
        type="button"
        className={`lien-fiche lien-fiche--bouton lien-surface import-ligne__fiche${ingredient === null ? ' import-ligne__fiche--vide' : ''}`}
        onClick={onChoisir}
      >
        {ingredient !== null ? (
          <Pastille ingredient={ingredient} />
        ) : (
          <span className="icon-chip icon-chip--sm" aria-hidden="true">
            <Icon name="ui-search" size={16} />
          </span>
        )}
        <span className="lien-fiche__libelle">{ingredient?.name ?? 'Choisir l’ingrédient'}</span>
        {aVerifier && <span className="import-ligne__badge">À vérifier</span>}
        <Icon name="ui-chevron-right" size={18} className="lien-fiche__chevron" />
      </button>

      {ingredient !== null && (
        <QuantityField
          label="Quantité"
          value={choix.grams}
          onChange={(grams) => onChange({ ...choix, grams, estimated: false })}
          pieceWeightG={ingredient.pieceWeightG}
          cookedWeightPer100gRaw={ingredient.cookedWeightPer100gRaw}
          unit={choix.unit}
          onUnitChange={(unit) => onChange({ ...choix, unit })}
        />
      )}
      {ingredient !== null && choix.estimated && (
        <p className="field__hint">Quantité supposée : le site ne la donne pas en poids. Vérifie-la.</p>
      )}

      <button type="button" className="button button--ghost import-ligne__ignorer" onClick={() => onChange({ ...choix, ignored: true })}>
        Ignorer cette ligne
      </button>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Choisir une fiche
// ---------------------------------------------------------------------------

function ChoixIngredient({
  line,
  onChoisir,
  onClose,
}: {
  readonly line: ImportLine
  readonly onChoisir: (ingredient: Ingredient) => void
  readonly onClose: () => void
}) {
  const [texte, setTexte] = useState(line.name)
  const [requete, setRequete] = useState(line.name.trim())
  useEffect(() => {
    const minuterie = setTimeout(() => setRequete(texte.trim()), 250)
    return () => clearTimeout(minuterie)
  }, [texte])
  const catalogue = useCatalog(requete, { pageSize: 20 })
  const dejaProposees = new Set(line.candidates.map((c) => c.id))
  const resultats = (catalogue.data?.pages.flatMap((p) => p.items) ?? []).filter((i) => !dejaProposees.has(i.id))

  const rangee = (ingredient: Ingredient) => (
    <li key={ingredient.id}>
      <button type="button" className="import-choix__ligne" onClick={() => onChoisir(ingredient)}>
        <Pastille ingredient={ingredient} />
        <span className="import-choix__corps">
          <span className="import-choix__nom">{ingredient.name}</span>
          <span className="import-choix__meta">
            {[
              ingredient.kcal !== null ? `${Math.round(ingredient.kcal)} kcal / 100 g` : null,
              ingredient.pieceWeightG !== null ? `1 pièce = ${formatGrams(ingredient.pieceWeightG)}` : null,
              ingredient.inLibrary ? 'Ma bibliothèque' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
      </button>
    </li>
  )

  return (
    <Sheet open onClose={onClose} title="Choisir l’ingrédient" variant="plein">
      <p className="import-choix__brut">
        Sur le site : <span>{line.raw}</span>
      </p>
      {line.candidates.length > 0 && (
        <>
          <h3 className="section-header">Propositions</h3>
          <ul className="import-choix">{line.candidates.map(rangee)}</ul>
        </>
      )}
      <TextField label="Chercher dans la bibliothèque et CIQUAL" type="search" value={texte} onChange={setTexte} />
      {catalogue.isFetching && resultats.length === 0 && <LoadingRows rows={3} />}
      {resultats.length > 0 && <ul className="import-choix">{resultats.map(rangee)}</ul>}
      {requete !== '' && !catalogue.isFetching && resultats.length === 0 && (
        <p className="field__hint">Rien d’autre ne correspond. Tu peux ignorer cette ligne et l’ajouter ensuite.</p>
      )}
    </Sheet>
  )
}
