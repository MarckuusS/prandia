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
import {
  QUANTITES_MAX,
  formatGrams,
  importAmount,
  lienRecette,
  parseSteps,
  type Ingredient,
} from '@prandia/shared'

import { NumberField, SwitchField, TextField } from '../../components/Field.js'
import { QuantityField } from '../../components/QuantityField.js'
import { Sheet } from '../../components/Sheet.js'
import { LoadingRows } from '../../components/States.js'
import { useToast } from '../../components/Toast.js'
import { Icon, RayonIcon } from '../../icons/index.js'
import { reduirePhoto } from '../../lib/photo.js'
import {
  estimerQuantites,
  fetchImportPhoto,
  lookupBarcode,
  useAddToLibrary,
  useCatalog,
  useCompletionEtat,
  useCreateIngredient,
  useIngredients,
  useOffSearch,
  useReadRecipeLink,
  useSaveRecipe,
  useUploadRecipePhoto,
  type ImportLine,
  type ImportProposal,
} from '../../lib/queries.js'
import { offCreatePayload } from '../../lib/offPayload.js'
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
  /** La quantite vient de l'IA, d'apres la recette : encadree jusqu'a une retouche. */
  readonly ia: boolean
}

function pour(line: ImportLine, ingredient: Ingredient | null, sure: boolean): Choix {
  if (ingredient === null) {
    return { ingredient: null, grams: null, unit: null, estimated: false, sure: false, ignored: false, ia: false }
  }
  const quantite = importAmount(line, ingredient)
  return {
    ingredient,
    grams: quantite.grams,
    unit: quantite.unit,
    estimated: quantite.estimated,
    sure,
    ignored: false,
    ia: false,
  }
}

/**
 * Pose l'estimation de l'IA sur une ligne encore SUPPOSEE ; une quantite lue
 * ou corrigee par la personne ne bouge pas. En grammes : c'est ce que l'IA
 * estime, et l'unite se change ensuite comme ailleurs.
 */
function avecIA(estimations: ReadonlyMap<number, number>, index: number, c: Choix): Choix {
  const grammes = estimations.get(index)
  if (grammes === undefined || c.ingredient === null || !c.estimated) return c
  return { ...c, grams: grammes, unit: 'g', ia: true }
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
  const creerFiche = useCreateIngredient()
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

  /*
   * LES QUANTITES QUI NE SONT PAS EN POIDS ("1/2 sachet", "1/4 de pot",
   * "1 piece", "sel, poivre") : les regles de `importAmount` en donnent un
   * ordre de grandeur sans rien savoir de la recette ; l'IA, qui la recoit en
   * entier, juge a la coherence (shared/src/quantitesIA.ts). Une question, a
   * l'ouverture, pour toutes les lignes incertaines. La reponse ne touche que
   * les lignes encore supposees : une quantite corrigee pendant la question
   * reste celle de la personne.
   */
  const iaDisponible = useCompletionEtat().data?.disponible === true
  const [iaGrammes, setIaGrammes] = useState<ReadonlyMap<number, number>>(new Map())
  const [iaEtat, setIaEtat] = useState<'attente' | 'fait' | 'erreur' | null>(null)
  const iaLancee = useRef(false)
  useEffect(() => {
    if (!iaDisponible || iaLancee.current) return
    iaLancee.current = true
    const aEstimer = lines
      .flatMap((line, index) => {
        const c = choix[index]
        if (c === undefined) return []
        // Sans fiche, on ne sait que ce que la ligne dit : sans unite, sa
        // quantite sera supposee quand on la choisira.
        const incertaine = c.ingredient === null ? line.unit === null : c.estimated
        return incertaine
          ? [{ index, fiche: c.ingredient?.name ?? null, contenanceG: c.ingredient?.pieceWeightG ?? null }]
          : []
      })
      .slice(0, QUANTITES_MAX)
    if (aEstimer.length === 0) return
    setIaEtat('attente')
    estimerQuantites({
      titre: recipe.name,
      portions: recipe.portions > 0 ? Math.round(recipe.portions) : null,
      site,
      lignes: lines.map((line) => line.raw),
      aEstimer,
    })
      .then(({ estimations }) => {
        const parIndex = new Map(estimations.map((e) => [e.index, e.grammes]))
        setIaGrammes(parIndex)
        setChoix((avant) => avant.map((c, i) => avecIA(parIndex, i, c)))
        setIaEtat('fait')
      })
      .catch(() => setIaEtat('erreur'))
    // Une seule question par revue : `iaLancee` la garde, les lignes ne
    // changent pas pendant la revue.
  }, [iaDisponible])
  const estimeesParIA = choix.filter((c) => !c.ignored && c.ia).length

  const actives = choix.filter((c) => !c.ignored)
  const aChoisir = actives.filter((c) => c.ingredient === null).length
  const aVerifier = actives.filter((c) => c.ingredient !== null && (!c.sure || c.estimated)).length
  const ignorees = choix.length - actives.length
  const site = new URL(recipe.sourceUrl).hostname.replace(/^www\./, '')

  const creer = async () => {
    setEnCours(true)
    setErreur(null)
    try {
      /*
       * Un produit du commerce (OpenFoodFacts) n'existe pas encore en base :
       * il est CREE ici, a la creation de la recette et pas au choix, pour
       * qu'une revue abandonnee ne laisse rien dans la bibliotheque. Deux
       * lignes qui ont choisi le meme produit ne le creent qu'une fois.
       */
      const crees = new Map<string, Ingredient>()
      const retenues: Choix[] = []
      for (const c of actives) {
        const choisi = c.ingredient
        if (choisi === null) continue
        if (choisi.id !== null) {
          retenues.push(c)
          continue
        }
        const cle = choisi.sourceRef ?? choisi.name
        let fiche = crees.get(cle)
        if (fiche === undefined) {
          fiche = await creerFiche.mutateAsync(offCreatePayload(choisi))
          crees.set(cle, fiche)
        }
        retenues.push({ ...c, ingredient: fiche })
      }
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
      {iaEtat !== null && (
        <p className={`import-ia${iaEtat === 'erreur' ? ' import-ia--erreur' : ''}`} role="status">
          <Icon name="ui-ia" size={16} className="icon--inline" />{' '}
          {iaEtat === 'attente'
            ? 'L’IA estime les quantités qui ne sont pas données en poids…'
            : iaEtat === 'erreur'
              ? 'L’IA n’a pas pu estimer les quantités : elles restent supposées.'
              : estimeesParIA > 0
                ? `L’IA a estimé ${estimeesParIA} quantité${estimeesParIA > 1 ? 's' : ''} d’après la recette, encadrée${estimeesParIA > 1 ? 's' : ''} en jaune. Vérifie-les.`
                : 'L’IA n’a pas trouvé d’estimation sûre : les quantités restent supposées.'}
        </p>
      )}
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
            // L'estimation de l'IA vaut pour la LIGNE, quelle que soit la
            // fiche : elle suit un changement de fiche.
            modifier(enChoix, avecIA(iaGrammes, enChoix, pour(ligneEnChoix, ingredient, true)))
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
        <span className="lien-fiche__libelle">
          {ingredient?.name ?? 'Choisir l’ingrédient'}
          {ingredient !== null && ingredient.brand !== null && ingredient.brand !== '' && (
            <span className="import-choix__marque">{ingredient.brand}</span>
          )}
        </span>
        {aVerifier && <span className="import-ligne__badge">À vérifier</span>}
        <Icon name="ui-chevron-right" size={18} className="lien-fiche__chevron" />
      </button>

      {ingredient !== null && (
        // Estimee par l'IA : le meme cadre que dans la fiche d'un ingredient,
        // jusqu'a ce que la personne retouche la quantite.
        <div className={choix.ia ? 'champ-ia champ-ia--rempli' : undefined}>
          <QuantityField
            label="Quantité"
            value={choix.grams}
            onChange={(grams) => onChange({ ...choix, grams, estimated: false, ia: false })}
            pieceWeightG={ingredient.pieceWeightG}
            cookedWeightPer100gRaw={ingredient.cookedWeightPer100gRaw}
            spoonWeightG={ingredient.spoonWeightG}
            unit={choix.unit}
            onUnitChange={(unit) => onChange({ ...choix, unit })}
          />
          {choix.ia && (
            <span className="champ-ia__demander champ-ia__demander--rempli" aria-hidden="true">
              <Icon name="ui-ia" size={16} />
            </span>
          )}
        </div>
      )}
      {ingredient !== null && choix.ia && (
        <p className="field__hint">Estimée par l’IA d’après la recette : le site ne la donne pas en poids. Vérifie-la.</p>
      )}
      {ingredient !== null && choix.estimated && !choix.ia && (
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
  const [source, setSource] = useState<'catalogue' | 'commerce'>('catalogue')
  const catalogue = useCatalog(requete, { pageSize: 20, enabled: source === 'catalogue' })
  const dejaProposees = new Set(line.candidates.map((c) => c.id))
  const resultats = (catalogue.data?.pages.flatMap((p) => p.items) ?? []).filter((i) => !dejaProposees.has(i.id))

  /*
   * LES PRODUITS DU COMMERCE, avec leur marque et leur contenance
   * (OpenFoodFacts). La recherche ne part que sur un geste (l'onglet, Entree,
   * le bouton) : OpenFoodFacts bride les clients anonymes, et une requete par
   * lettre tapee le ferait vite. Un produit deja dans la bibliotheque (meme
   * code-barres) est rendu par SA fiche : le recreer buterait sur l'unicite.
   */
  const [requeteCommerce, setRequeteCommerce] = useState('')
  const commerce = useOffSearch(requeteCommerce, source === 'commerce' && requeteCommerce.length >= 2)
  const produits = commerce.data?.pages.flatMap((p) => p.items) ?? []
  const bibliotheque = useIngredients('')
  const parCode = useMemo(() => {
    const index = new Map<string, Ingredient>()
    for (const i of bibliotheque.data?.items ?? []) if (i.sourceRef !== null) index.set(i.sourceRef, i)
    return index
  }, [bibliotheque.data])
  const chercherEnLigne = () => {
    if (texte.trim().length >= 2) setRequeteCommerce(texte.trim())
  }

  /*
   * La recherche d'OpenFoodFacts ne rend PAS la contenance du paquet, quels
   * que soient les champs demandes : seule la fiche du produit, lue par son
   * code-barres, la donne. On la lit au choix, une requete par produit
   * retenu, et "1 sachet de salade" se dose alors au sachet reel. Une fiche
   * illisible laisse le resultat de recherche tel quel.
   */
  const [completant, setCompletant] = useState<string | null>(null)
  const choisir = async (ingredient: Ingredient) => {
    if (ingredient.id !== null || ingredient.sourceRef === null || ingredient.pieceWeightG !== null) {
      onChoisir(ingredient)
      return
    }
    setCompletant(ingredient.sourceRef)
    let complet: Ingredient = ingredient
    try {
      complet = await lookupBarcode(ingredient.sourceRef)
    } catch {
      // Code inconnu de la fiche produit, ou reseau : le resultat suffit.
    }
    setCompletant(null)
    onChoisir(complet)
  }

  const rangee = (ingredient: Ingredient) => {
    const connu = ingredient.id === null && ingredient.sourceRef !== null ? parCode.get(ingredient.sourceRef) : undefined
    const choisi = connu ?? ingredient
    const paquet = choisi.source === 'openfoodfacts'
    const enLecture = completant !== null && completant === choisi.sourceRef
    return (
      <li key={choisi.id ?? `off-${choisi.sourceRef ?? choisi.name}`}>
        <button
          type="button"
          className="import-choix__ligne"
          onClick={() => void choisir(choisi)}
          disabled={completant !== null}
          aria-busy={enLecture || undefined}
        >
          <Pastille ingredient={choisi} />
          <span className="import-choix__corps">
            <span className="import-choix__nom">{choisi.name}</span>
            {choisi.brand !== null && choisi.brand !== '' && (
              <span className="import-choix__marque">{choisi.brand}</span>
            )}
            <span className="import-choix__meta">
              {[
                enLecture ? 'Lecture de la fiche…' : null,
                choisi.kcal !== null ? `${Math.round(choisi.kcal)} kcal / 100 g` : null,
                choisi.pieceWeightG !== null
                  ? paquet
                    ? `paquet de ${formatGrams(choisi.pieceWeightG)}`
                    : `1 pièce = ${formatGrams(choisi.pieceWeightG)}`
                  : null,
                choisi.nutriscoreGrade !== null ? `Nutri-Score ${choisi.nutriscoreGrade.toUpperCase()}` : null,
                choisi.inLibrary ? 'Ma bibliothèque' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
        </button>
      </li>
    )
  }

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

      <div className="segmented" role="group" aria-label="Où chercher">
        <button
          type="button"
          className={`segmented__tab${source === 'catalogue' ? ' segmented__tab--active' : ''}`}
          aria-pressed={source === 'catalogue'}
          onClick={() => setSource('catalogue')}
        >
          Aliments
        </button>
        <button
          type="button"
          className={`segmented__tab${source === 'commerce' ? ' segmented__tab--active' : ''}`}
          aria-pressed={source === 'commerce'}
          onClick={() => {
            setSource('commerce')
            chercherEnLigne()
          }}
        >
          Marques
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (source === 'commerce') chercherEnLigne()
        }}
      >
        <TextField
          label={
            source === 'catalogue'
              ? 'Chercher dans ta bibliothèque et CIQUAL'
              : 'Chercher un produit du commerce (OpenFoodFacts)'
          }
          type="search"
          value={texte}
          onChange={setTexte}
          enterKeyHint="search"
        />
      </form>

      {source === 'catalogue' && (
        <>
          {catalogue.isFetching && resultats.length === 0 && <LoadingRows rows={3} />}
          {resultats.length > 0 && <ul className="import-choix">{resultats.map(rangee)}</ul>}
          {requete !== '' && !catalogue.isFetching && resultats.length === 0 && (
            <p className="field__hint">
              Rien d’autre ne correspond. Essaie l’onglet Marques, ou ignore cette ligne et
              ajoute-la ensuite.
            </p>
          )}
        </>
      )}

      {source === 'commerce' && (
        <>
          {texte.trim() !== requeteCommerce && (
            <button
              type="button"
              className="button button--secondary button--block"
              onClick={chercherEnLigne}
              disabled={texte.trim().length < 2}
            >
              Chercher “{texte.trim()}” sur OpenFoodFacts
            </button>
          )}
          {commerce.isFetching && produits.length === 0 && <LoadingRows rows={3} />}
          {commerce.isError && <p className="text-error">{commerce.error.message}</p>}
          {produits.length > 0 && <ul className="import-choix">{produits.map(rangee)}</ul>}
          {commerce.hasNextPage && (
            <button
              type="button"
              className="button button--ghost button--block"
              onClick={() => void commerce.fetchNextPage()}
              disabled={commerce.isFetchingNextPage}
            >
              {commerce.isFetchingNextPage ? 'Chargement…' : 'Voir plus de produits'}
            </button>
          )}
          {requeteCommerce !== '' && commerce.isSuccess && produits.length === 0 && (
            <p className="field__hint">OpenFoodFacts ne connaît aucun produit à ce nom.</p>
          )}
          <p className="field__hint">
            Le produit choisi entrera dans ta bibliothèque à la création de la recette, avec sa
            marque, ses valeurs et la contenance de son paquet.
          </p>
        </>
      )}
    </Sheet>
  )
}
