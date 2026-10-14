/**
 * La fiche d'une recette, EN LECTURE.
 *
 * L'ecran n'existait pas : `/recettes/:id` ouvrait l'editeur. On cuisinait donc
 * devant un formulaire, ou la quantite d'un ingredient ne se lisait que dans un
 * champ de saisie, et ou effleurer un champ armait « modifications non
 * enregistrees » sur une recette qu'on n'avait pas voulu toucher.
 *
 * DEUX ECRANS, ET CE N'EST PAS POUR RETIRER DES BOUTONS. La mise a l'echelle et
 * la saisie ne cohabitent plus, ce qui supprime une regle entiere : l'editeur
 * devait expliquer, dans un bandeau, qu'une quantite tapee pendant qu'on
 * affichait six portions serait enregistree ramenee a deux. En lecture rien ne
 * se tape, en edition le ratio vaut toujours un. On ne retire pas le bandeau,
 * on retire ce qu'il fallait expliquer.
 *
 * `/recettes/:id` reste la LECTURE, et l'editeur passe sous `/modifier` : tous
 * les liens du projet pointent deja vers l'adresse courte, et les inverser
 * ferait ouvrir un formulaire depuis le planning, l'accueil et la liste.
 *
 * TROIS ECARTS AU MOCKUP, tous pour la meme raison :
 *
 *   - le mockup affiche « Fer 6,1 mg ». Aucun micronutriment n'est modelise :
 *     la base connait huit nutriments, et le fer n'en fait pas partie. La ligne
 *     porte donc les quatre qui ont un repere journalier source dans
 *     `limits.ts`, ce qui vaut mieux qu'un nombre nu ;
 *   - le mockup pose une duree a cote de chaque etape. Le nombre serait souvent
 *     extractible, sa NATURE serait inventee. Voir `shared/src/steps.ts` ;
 *   - le mockup a deux boutons en pied, « Ajouter aux courses » et
 *     « Planifier ». La liste de courses ne stocke rien : elle se recalcule du
 *     planning a chaque appel. Le premier bouton n'a donc pas de destination
 *     qui ne soit pas le second. Ils sont fusionnes, et la phrase des
 *     manquants reste informative.
 */

import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  COOKED_UNIT_CODE,
  SEASONING_MAX_G,
  cookedWeightG,
  currentIsoWeek,
  feasibility,
  formatEuros,
  formatGrams,
  lienRecette,
  pantryTotals,
  parseSteps,
  photoPath,
  type NutritionTotal,
  type Recipe,
} from '@prandia/shared'

import { MacrosRing } from '../../components/MacrosDonut.js'
import { TableauNutriments } from '../../components/TableauNutriments.js'
import { ErrorState, LoadingRows } from '../../components/States.js'
import { useToast } from '../../components/Toast.js'
import { Icon } from '../../icons/index.js'
import { RayonIcon } from '../../icons/RayonIcon.js'
import { useRayonStyle } from '../../lib/useRayonStyle.js'
import {
  useCalendar,
  useCookingLog,
  usePantry,
  useRecipe,
} from '../../lib/queries.js'
import { CuisinerSheet, messageCuisson } from '../cuisine/CuisinerSheet.js'
import { toDraft } from './draft.js'
import { EtapesRecette } from './EtapesRecette.js'
import { useDerived } from './RecipeDerived.js'
import '../../styles/recette.css'

/**
 * Les trois echelles de lecture de la nutrition.
 *
 * `label` titre l'onglet, `legende` accompagne le chiffre. Les deux different :
 * l'onglet s'ecrit en tete de phrase, la legende se lit a la suite de « kcal »,
 * ou une majuscule au milieu se remarque.
 */
const PORTEES = [
  { cle: 'portion', label: 'Par portion', legende: 'par portion' },
  { cle: 'recette', label: 'Recette entière', legende: 'pour la recette' },
  { cle: 'cent', label: 'Aux 100 g crus', legende: 'pour 100 g crus' },
] as const

type Portee = (typeof PORTEES)[number]['cle']

/**
 * La quantite d'une ligne, telle qu'on l'a saisie. Une ligne saisie EN CUIT se
 * relit en cuit, le cru a cote : "200 g cuits · 67 g crus". La base ne garde
 * que le cru (apports, prix et courses le lisent) ; l'ecrire seul ferait
 * chercher a la fiche un poids que personne n'a tape.
 */
function quantiteLue(
  ingredient: Recipe['lines'][number]['ingredient'],
  unit: string | null,
  crusG: number,
): string {
  if (unit === COOKED_UNIT_CODE && ingredient.cookedWeightPer100gRaw !== null) {
    return `${formatGrams(cookedWeightG(ingredient, crusG))} cuits · ${formatGrams(crusG)} crus`
  }
  return formatGrams(crusG)
}

export function RecipeView() {
  const params = useParams()
  const raw = params['id']
  const id = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null
  const query = useRecipe(id)

  if (id === null) {
    return (
      <section className="screen">
        <ErrorState error={new Error('Cette adresse ne correspond à aucune recette.')} />
      </section>
    )
  }
  if (query.isPending) {
    return (
      <section className="screen">
        <LoadingRows rows={6} />
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

  return <Fiche key={query.data.id ?? 0} recipe={query.data} />
}

function Fiche({ recipe }: { readonly recipe: Recipe }) {
  const navigate = useNavigate()
  const styleOf = useRayonStyle()

  /*
   * Le nombre de portions AFFICHE, jamais enregistre. C'est toute la
   * difference avec l'editeur : le stepper recalcule les quantites, les
   * macros, le cout et les manquants, et ne touche a rien en base.
   */
  const [portions, setPortions] = useState(recipe.defaultPortions)
  const [portee, setPortee] = useState<Portee>('portion')
  const [echecPhoto, setEchecPhoto] = useState(false)
  const [detail, setDetail] = useState(false)

  const draft = useMemo(() => toDraft(recipe), [recipe])
  const derived = useDerived(draft, portions)

  const journal = useCookingLog(recipe.id)
  const cuissons = journal.data?.items.length ?? 0
  const [cuisine, setCuisine] = useState(false)
  const toast = useToast()

  // Le frigo et la semaine partagent leur cache avec le Frigo et le Planning :
  // venant de l'un de ces ecrans, ces deux lectures ne coutent rien.
  const frigo = usePantry()
  const semaine = useCalendar(currentIsoWeek())

  const manque = useMemo(() => {
    if (frigo.data === undefined) return null
    return feasibility(recipe, pantryTotals(frigo.data.items), portions)
  }, [recipe, frigo.data, portions])

  const auPlanning = useMemo(() => {
    if (semaine.data === undefined || recipe.id === null) return null
    const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']
    const trouvee = semaine.data.entries.find((e) => e.recipeId === recipe.id)
    return trouvee === undefined ? null : (JOURS[trouvee.dayOfWeek] ?? null)
  }, [semaine.data, recipe.id])

  const total: NutritionTotal =
    portee === 'portion' ? derived.perPortion : portee === 'recette' ? derived.total : derived.per100g

  // `find` ne peut pas echouer, `portee` vient de PORTEES ; le repli garde le
  // type honnete sans imposer un `!` a la lecture.
  const echelle = PORTEES.find((p) => p.cle === portee) ?? PORTEES[0]

  /*
   * Le repli sur erreur ramene le bandeau vert, INDISCERNABLE d'une recette
   * sans photo : une cle peut designer un objet absent, et une session expiree
   * rend un 401. Le carre casse du navigateur ferait croire a une perte.
   */
  const photo =
    recipe.id !== null && recipe.imageKey !== null && !echecPhoto
      ? photoPath(recipe.id, recipe.imageKey)
      : null

  const etapes = useMemo(() => parseSteps(recipe.instructions), [recipe.instructions])
  const ratio = portions / Math.max(recipe.defaultPortions, 1)

  /*
   * LE SITE D'ORIGINE, a re-toucher depuis la fiche : on y revient pour une
   * photo d'etape, une astuce, les avis. Repasse par `lienRecette`, qui ne
   * laisse sortir que du http(s) vers un hote public : la colonne est du texte
   * libre, et un "javascript:" pose dans un `href` s'executerait au toucher.
   */
  const source = useMemo(() => {
    const lien = recipe.sourceUrl === null ? null : lienRecette(recipe.sourceUrl)
    return lien === null ? null : { href: lien, site: new URL(lien).hostname.replace(/^www\./, '') }
  }, [recipe.sourceUrl])

  return (
    <section className="screen screen--recette">
      {/* ---------- Le bandeau ---------- */}
      {/* SANS PHOTO, RIEN NE CHANGE : degrade vert fixe, filigrane, 132 px de
          haut. C'est une etiquette. AVEC photo il devient le contenu, d'ou les
          200 px et le voile bas, qui n'est pas une finition : le degrade fixe
          garantissait le contraste du texte blanc pose dessus, une photo
          detruit cette garantie et il faut la reconstruire dans le pire cas,
          une photo entierement blanche. */}
      <div className={`fiche-hero${photo === null ? '' : ' fiche-hero--photo'}`}>
        {photo !== null && (
          <img className="fiche-hero__image" src={photo} alt="" onError={() => setEchecPhoto(true)} />
        )}
        {/* Un seul bouton retour : la barre empilee en pose deja un, et le
            mockup en dessinait un second a douze pixels du premier. */}
        <Link
          to={`/recettes/${recipe.id}/modifier`}
          className="fiche-hero__action lien-surface"
          aria-label="Modifier la recette"
        >
          <Icon name="ui-edit" size={18} />
        </Link>
        {/* Le filigrane EST le suppleant de la photo : les deux ensemble
            feraient des couverts geants par-dessus le plat. */}
        {photo === null && (
          <Icon name="ui-utensils" size={72} className="fiche-hero__filigrane" />
        )}
        <span className="fiche-hero__origine">
          {recipe.sourceUrl === null ? 'Ma recette' : source === null ? 'Importée' : `Importée de ${source.site}`}
          {recipe.updatedAt !== null && ` · modifiée le ${jourCourt(recipe.updatedAt)}`}
        </span>
      </div>

      <div className="fiche-titre">
        <h2>{recipe.name}</h2>
        <p className="fiche-titre__meta">
          {recipe.prepTimeMin !== null && <span>{recipe.prepTimeMin} min</span>}
          <span>
            {cuissons === 0
              ? 'Jamais cuisinée'
              : `Cuisinée ${cuissons} fois`}
          </span>
          {auPlanning !== null && <span className="fiche-titre__plan">Au planning {auPlanning}</span>}
        </p>
        {/* Une ligne de navigation, comme pour aller voir une fiche, mais qui
            SORT de l'application : la fleche de sortie remplace le chevron. */}
        {source !== null && (
          <a
            href={source.href}
            target="_blank"
            rel="noreferrer noopener"
            className="lien-fiche lien-surface fiche-source"
          >
            <span className="lien-fiche__libelle">
              Voir la recette sur <strong>{source.site}</strong>
            </span>
            <Icon name="ui-external-link" size={18} className="lien-fiche__chevron" />
          </a>
        )}
      </div>

      {/* ---------- Portions ---------- */}
      <div className="card fiche-portions">
        <span className="fiche-portions__label">
          Portions
          <small>Ingrédients et macros recalculés</small>
        </span>
        <div className="stepper">
          <button
            type="button"
            className="stepper__bouton"
            onClick={() => setPortions((p) => Math.max(1, p - 1))}
            disabled={portions <= 1}
            aria-label="Une portion de moins"
          >
            <Icon name="ui-minus" size={16} />
          </button>
          <span className="chiffre stepper__valeur" aria-live="polite">
            {portions}
          </span>
          <button
            type="button"
            className="stepper__bouton"
            onClick={() => setPortions((p) => Math.min(50, p + 1))}
            disabled={portions >= 50}
            aria-label="Une portion de plus"
          >
            <Icon name="ui-plus" size={16} />
          </button>
        </div>
      </div>

      {/* ---------- Valeurs nutritionnelles ---------- */}
      <div className="card">
        <h3 className="card__title">Valeurs nutritionnelles</h3>

        <div className="segmented" role="group" aria-label="Échelle des valeurs">
          {PORTEES.map((p) => (
            <button
              key={p.cle}
              type="button"
              className={`segmented__tab${portee === p.cle ? ' segmented__tab--active' : ''}`}
              aria-pressed={portee === p.cle}
              onClick={() => setPortee(p.cle)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* L'ANNEAU PUIS LE TABLEAU, ET RIEN ENTRE LES DEUX.
            Les arcs disent la proportion de chaque famille en grammes, la
            colonne « Part » du tableau redonne la meme proportion en chiffres,
            sur la meme base. Une legende posee entre les deux rediraient une
            troisieme fois les memes quatre lignes, sans qu'on sache laquelle
            fait foi. Le selecteur d'echelle juste au-dessus commande les deux,
            d'ou leur presence dans une seule carte. */}
        <MacrosRing total={total} centerCaption={`kcal ${echelle.legende}`} />

        <TableauNutriments total={total} vide={recipe.lines.length === 0} />

        {/* Le mockup renvoie vers un « Détail complet » qui n'aurait rien de
            plus a montrer : les huit nutriments sont deja la. Le lien deplie
            donc ce qui manque vraiment, le detail du calcul. */}
        <button
          type="button"
          className="button button--ghost fiche-plus"
          aria-expanded={detail}
          onClick={() => setDetail((d) => !d)}
        >
          {detail ? 'Masquer le détail' : 'Détail du calcul'}
        </button>

        {detail && (
          <dl className="kv fiche-detail">
            <dt>Masse crue</dt>
            <dd>{formatGrams(derived.totalWeightG)}</dd>
            {derived.hasCookingRatio && (
              <>
                <dt>Masse après cuisson</dt>
                <dd>{formatGrams(derived.cookedWeightTotalG)}</dd>
              </>
            )}
            <dt>Coût par portion</dt>
            <dd>{formatEuros(derived.cost.perPortion)}</dd>
            {derived.unknownMacroLines > 0 && (
              <>
                <dt>Lignes sans macros</dt>
                <dd>{derived.unknownMacroLines}</dd>
              </>
            )}
          </dl>
        )}

        <p className="field__hint">
          « Aux 100 g » se lit sur la masse <strong>crue</strong> : une recette perd de l’eau à la
          cuisson, et 100 g de plat servi ne sont pas 100 g d’ingrédients pesés.
        </p>
      </div>

      {/* ---------- Ingrédients ---------- */}
      <div className="card">
        <h3 className="card__title">
          Ingrédients · pour {portions} {portions > 1 ? 'portions' : 'portion'}
        </h3>

        <ul className="fiche-ingredients">
          {recipe.lines.map((line, i) => {
            const style = styleOf(line.ingredient.categoryL1)
            const quantite = line.quantityG * ratio
            const absent = manque?.missing.some((m) => m.ingredientId === line.ingredient.id) === true
            return (
              <li key={line.ingredient.id ?? i} className="fiche-ingredient">
                <span className="icon-chip icon-chip--sm" {...style.tint}>
                  <RayonIcon glyph={style.glyph} size={18} strokeWidth={1.8} />
                </span>
                <span className="fiche-ingredient__corps">
                  <span className="fiche-ingredient__nom">
                    {line.ingredient.name}
                    {absent && <span className="badge-manque">Manquant</span>}
                  </span>
                  <span className="fiche-ingredient__quantite">
                    {quantiteLue(line.ingredient, line.unit, quantite)}
                    {line.notes !== null && line.notes !== '' && ` · ${line.notes}`}
                  </span>
                </span>
                <span className="fiche-ingredient__kcal chiffre">
                  {Math.round((line.ingredient.kcal ?? 0) * (quantite / 100))} kcal
                </span>
              </li>
            )
          })}
        </ul>
      </div>

      {/* ---------- Instructions ---------- */}
      {etapes.length > 0 && (
        <div className="card">
          <h3 className="card__title">Instructions</h3>
          <EtapesRecette etapes={etapes} />
        </div>
      )}

      {/* ---------- Le pied ---------- */}
      <div className="pied-recette">
        <p className="pied-recette__etat" aria-live="polite">
          {manque === null
            ? ''
            : manque.feasible
              ? `Faisable avec ton frigo. Les lignes de moins de ${SEASONING_MAX_G} g sont supposées présentes.`
              : `${manque.missing.length} ${manque.missing.length > 1 ? 'ingrédients manquants' : 'ingrédient manquant'} d’après ton frigo`}
        </p>
        <div className="pied-recette__actions">
          {/* "J'ai cuisine ca" notait seulement la date. "Je la cuisine" ouvre la
              cuisson : ce qu'on a vraiment mis, le plat au frigo, ce qui en
              sort ; la date part au journal de la meme facon. */}
          <button
            type="button"
            className="button button--secondary"
            disabled={recipe.id === null}
            onClick={() => setCuisine(true)}
          >
            <Icon name="ui-utensils" size={16} className="icon--inline" /> Je la cuisine
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void navigate(`/planning?recette=${recipe.id}&portions=${portions}`)}
          >
            Planifier
          </button>
        </div>
      </div>

      {cuisine && recipe.id !== null && (
        <CuisinerSheet
          recipeId={recipe.id}
          onClose={() => setCuisine(false)}
          onCuisine={(plat, nom) => {
            setCuisine(false)
            toast.show({ message: messageCuisson(nom, plat.sorties.length) })
          }}
        />
      )}
    </section>
  )
}

const jourCourt = (iso: string) =>
  new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })
