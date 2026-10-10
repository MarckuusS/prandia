/**
 * Mes objectifs : un tableau de bord, pas un formulaire.
 *
 * L'ecran etait huit cartes de champs. C'etait l'ecran de REGLAGE, et il
 * reste : il a demenage sous `/objectifs/reglages`, avec son bouton retour.
 * Ce qui s'affiche ici REPOND, au lieu de demander.
 *
 * SIX BLOCS, du plus strategique au plus operationnel. L'ordre n'est pas
 * decoratif : on ouvre cet ecran pour savoir si l'on y arrive, pas pour lire
 * son tour de taille.
 *
 * Tout ce qui se calcule ici vient de `shared/src/weight.ts`, module pur et
 * teste comme une specification : la moyenne mobile, le rythme par regression,
 * la date d'arrivee et la marge. Aucun de ces chiffres n'est stocke.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import {
  SAFE_PACE,
  addDays,
  bmi,
  bmiZone,
  currentIsoWeek,
  movingAverage,
  dayOnTarget,
  readCap,
  type Cap,
  type NutritionTotal,
  type TrendPoint,
} from '@prandia/shared'

import { NumberField } from '../components/Field.js'
import { ErrorState, LoadingRows } from '../components/States.js'
import { Sheet } from '../components/Sheet.js'
import { useToast } from '../components/Toast.js'
import { Icon } from '../icons/index.js'
import { todayIso, useCalendar, useSaveWeighIn, useWeightLog } from '../lib/queries.js'
import { useDailyTargets, type DailyTargets } from '../lib/useDailyTargets.js'
import { CourbePoids } from './objectifs/CourbePoids.js'
import { Reperes } from './objectifs/Reperes.js'
import { entriesOfDay, sumNutrition } from './semaine/totals.js'
import '../styles/objectifs.css'

/** Les quatre plages du selecteur. `null` = tout l'historique. */
const PLAGES = [
  { cle: '4s', label: '4 sem.', jours: 28 },
  { cle: '8s', label: '8 sem.', jours: 56 },
  { cle: '6m', label: '6 mois', jours: 182 },
  { cle: 'tout', label: 'Tout', jours: null },
] as const

const kg = (v: number) =>
  v.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const kcal = (v: number) => Math.round(v).toLocaleString('fr-FR')
const jourCourt = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })

export function ObjectifsScreen() {
  const cible = useDailyTargets()
  const pesees = useWeightLog()
  const [plage, setPlage] = useState<(typeof PLAGES)[number]['cle']>('8s')
  const [pesee, setPesee] = useState(false)

  const today = todayIso()

  const points = useMemo(() => movingAverage(pesees.data?.weighIns ?? [], 7), [pesees.data])

  const visibles = useMemo(() => {
    const jours = PLAGES.find((p) => p.cle === plage)?.jours ?? null
    if (jours === null) return points
    const debut = addDays(today, -jours)
    return points.filter((p) => p.day >= debut)
  }, [points, plage, today])

  /*
   * Le cap se lit sur TOUT l'historique, jamais sur la plage affichee : le
   * point de depart du chemin parcouru est la premiere pesee, et le selecteur
   * ne sert qu'a cadrer le dessin. Sans cela, passer sur "4 sem." aurait fait
   * bondir la barre de progression a 100 %.
   */
  const cap = useMemo(
    () => readCap(points, today, cible.mesures.targetWeightKg, cible.targets?.targetDate ?? null),
    [points, today, cible],
  )

  if (cible.etat === 'chargement' || pesees.isPending) {
    return (
      <section className="screen">
        <LoadingRows rows={5} />
      </section>
    )
  }

  if (pesees.isError) {
    return (
      <section className="screen">
        <ErrorState error={pesees.error} onRetry={() => void pesees.refetch()} />
      </section>
    )
  }

  return (
    <section className="screen screen--objectifs">
      <Bloc1Cap cap={cap} onPeser={() => setPesee(true)} />

      <Bloc2Poids
        points={visibles}
        cap={cap}
        today={today}
        plage={plage}
        onPlage={setPlage}
        onPeser={() => setPesee(true)}
      />

      <Bloc3Energie cible={cible} cap={cap} />
      <Bloc4Cibles cible={cible} />
      {/* Les reperes de sel, sucres, satures et fibres viennent JUSTE APRES la
          cible en calories : ce sont des cibles du jour, au meme titre, et
          les separer les ferait lire comme un a-cote. */}
      <Reperes kcalTarget={cible.kcalTarget} />
      <Bloc5Regularite cible={cible} />
      <Bloc6Mesures cible={cible} cap={cap} />

      {pesee && <FeuillePesee today={today} onClose={() => setPesee(false)} />}
    </section>
  )
}

// ---------------------------------------------------------------------------
// 1. Le cap
// ---------------------------------------------------------------------------

/**
 * La reponse a la seule question qui compte : est-ce que j'y arrive ?
 *
 * Elle est en HAUT parce qu'elle est strategique. Tout le reste de l'ecran
 * l'explique ou la nuance ; rien ne la remplace.
 */
function Bloc1Cap({ cap, onPeser }: { cap: Cap | null; onPeser: () => void }) {
  if (cap === null) {
    return (
      <div className="card">
        <h2 className="card__title">Le cap</h2>
        <p className="card__lead">
          Aucune pesée enregistrée. La courbe, le rythme et la date d’arrivée se calculent tous
          depuis l’historique : il en faut au moins deux, à une semaine d’écart.
        </p>
        <button type="button" className="button button--primary" onClick={onPeser}>
          Me peser
        </button>
      </div>
    )
  }

  return (
    <div className="card cap">
      <h2 className="card__title">Le cap</h2>

      <div className="cap__haut">
        <span className="chiffre cap__cible">{kg(cap.targetKg)} kg</span>
        {cap.etaDay !== null && <span className="cap__vers">vers le {jourCourt(cap.etaDay)}</span>}
      </div>

      <div
        className="cap__piste"
        role="img"
        aria-label={`Progression : ${Math.round(cap.progress * 100)} pour cent du chemin`}
      >
        <span className="cap__part" style={{ width: `${cap.progress * 100}%` }} />
      </div>

      <div className="cap__reperes">
        <span>Départ {kg(cap.startKg)} kg</span>
        <span className="cap__actuel">{kg(cap.currentKg)} kg aujourd’hui</span>
        <span>Reste {kg(cap.remainingKg)} kg</span>
      </div>

      <div className="cap__mesures">
        <span className="mesurette">
          <b className="chiffre">
            {cap.paceKgPerWeek === null ? '—' : `${kg(cap.paceKgPerWeek)} kg`}
          </b>
          <small>Rythme par semaine</small>
        </span>
        <span className="mesurette">
          <b className="chiffre">{cap.etaDay === null ? '—' : jourCourt(cap.etaDay)}</b>
          <small>Arrivée estimée</small>
        </span>
        <span className="mesurette">
          {/* Le verdict n'est affiche QUE si les deux dates existent : sans date
              visee, "dans les temps" ne compare rien. */}
          <b
            className={
              cap.onTrack === null ? '' : cap.onTrack ? 'verdict verdict--tenu' : 'verdict verdict--rate'
            }
          >
            {cap.onTrack === null ? '—' : cap.onTrack ? 'Dans les temps' : 'En retard'}
          </b>
          <small>
            {cap.marginDays === null
              ? 'Pas de date visée'
              : `Marge : ${Math.abs(cap.marginDays)} jour${Math.abs(cap.marginDays) > 1 ? 's' : ''}`}
          </small>
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2. Poids
// ---------------------------------------------------------------------------

function Bloc2Poids({
  points,
  cap,
  today,
  plage,
  onPlage,
  onPeser,
}: {
  points: readonly TrendPoint[]
  cap: Cap | null
  today: string
  plage: (typeof PLAGES)[number]['cle']
  onPlage: (cle: (typeof PLAGES)[number]['cle']) => void
  onPeser: () => void
}) {
  const premier = points[0]
  if (cap === null || premier === undefined) return null

  /*
   * L'ecart de la semaine se lit sur la MOYENNE et non sur deux pesees : d'un
   * matin a l'autre, ce chiffre serait du bruit affiche avec une decimale.
   */
  const ilYAUneSemaine = points.find((p) => p.day >= addDays(today, -7))?.smoothed ?? null
  const delta = ilYAUneSemaine === null ? null : cap.currentKg - ilYAUneSemaine

  return (
    <div className="card">
      <div className="card-entete">
        <h2 className="card__title card-entete__titre">Poids</h2>
        <button type="button" className="button button--ghost" onClick={onPeser}>
          Me peser
        </button>
      </div>

      <div className="poids__haut">
        <span>
          <span className="chiffre poids__valeur">{kg(cap.currentKg)}</span>{' '}
          <span className="poids__unite">kg</span>
        </span>
        {delta !== null && (
          <span className={`delta${delta > 0 ? ' delta--hausse' : ''}`}>
            {delta > 0 ? '+' : ''}
            {kg(delta)} kg cette semaine
          </span>
        )}
      </div>

      <CourbePoids points={points} targetKg={cap.targetKg} etaDay={cap.etaDay} today={today} />

      <div className="courbe__bornes">
        <span>{jourCourt(premier.day)}</span>
        <span>aujourd’hui</span>
        <span>{cap.etaDay === null ? '' : jourCourt(cap.etaDay)}</span>
      </div>

      <div className="series">
        <span className="series__item">
          <span className="series__marque series__marque--points" aria-hidden="true" /> Pesées
        </span>
        <span className="series__item">
          <span className="series__marque series__marque--trait" aria-hidden="true" /> Moyenne 7 j
        </span>
        <span className="series__item">
          <span className="series__marque series__marque--pointille" aria-hidden="true" /> Projection
        </span>
      </div>

      <div className="plages" role="group" aria-label="Période affichée">
        {PLAGES.map((p) => (
          <button
            key={p.cle}
            type="button"
            className={`plage${plage === p.cle ? ' plage--actif' : ''}`}
            aria-pressed={plage === p.cle}
            onClick={() => onPlage(p.cle)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 3. Bilan energetique
// ---------------------------------------------------------------------------

/**
 * La depense en face de la cible, et le verdict sur le rythme.
 *
 * Le conseil FERME LA BOUCLE : quand le rythme observe tombe dans la zone
 * sure, il dit de ne rien changer. Un tableau de bord qui ne conclut jamais
 * laisse l'utilisateur decider seul de ce qu'il doit lire.
 */
function Bloc3Energie({ cible, cap }: { cible: DailyTargets; cap: Cap | null }) {
  const t = cible.targets
  if (t === null || cible.kcalTarget === null) return null

  const rythme = cap?.paceKgPerWeek ?? null
  const absRythme = rythme === null ? null : Math.abs(rythme)
  const dansLaZone = absRythme !== null && absRythme >= SAFE_PACE.min && absRythme <= SAFE_PACE.max

  // Les deux barres partagent la meme echelle : la plus grande des deux fait
  // 100 %. Sans cela, une cible superieure a la depense sortirait du cadre.
  const echelle = Math.max(t.tdee, cible.kcalTarget)

  return (
    <div className="card">
      <h2 className="card__title">Bilan énergétique</h2>

      <div className="energie">
        <div className="energie__ligne">
          <span className="energie__haut">
            <span>Dépense estimée</span>
            <span className="energie__valeur">{kcal(t.tdee)} kcal / j</span>
          </span>
          <span className="energie__piste">
            <span
              className="energie__part energie__part--depense"
              style={{ width: `${(t.tdee / echelle) * 100}%` }}
            />
          </span>
        </div>

        <div className="energie__ligne">
          <span className="energie__haut">
            <span>Cible d’apport</span>
            <span className="energie__valeur">{kcal(cible.kcalTarget)} kcal / j</span>
          </span>
          <span className="energie__piste">
            <span
              className="energie__part energie__part--cible"
              style={{ width: `${(cible.kcalTarget / echelle) * 100}%` }}
            />
          </span>
        </div>
      </div>

      <p className={`conseil${dansLaZone ? '' : ' conseil--attention'}`}>
        <Icon
          name={dansLaZone ? 'ui-check-circle' : 'ui-info'}
          size={16}
          className="icon--inline"
        />{' '}
        {absRythme === null ? (
          <>
            Écart théorique de <b>{kcal(Math.abs(t.tdee - cible.kcalTarget))} kcal / j</b>. Note tes
            pesées pendant deux semaines et ce chiffre se comparera au rythme réellement observé.
          </>
        ) : dansLaZone ? (
          <>
            Rythme observé : <b>{kg(absRythme)} kg par semaine</b>, dans la zone recommandée (de{' '}
            {kg(SAFE_PACE.min)} à {kg(SAFE_PACE.max)}). Garde cette cible.
          </>
        ) : (
          <>
            Rythme observé : <b>{kg(absRythme)} kg par semaine</b>, hors de la zone recommandée (de{' '}
            {kg(SAFE_PACE.min)} à {kg(SAFE_PACE.max)}).{' '}
            {absRythme < SAFE_PACE.min
              ? 'Trop lent pour se voir sur la balance : creuse l’écart, ou accorde-toi plus de temps.'
              : 'Trop rapide : à ce rythme, une part de ce qui part est du muscle.'}
          </>
        )}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 4. Cibles quotidiennes
// ---------------------------------------------------------------------------

const MACROS = [
  { cle: 'proteins', label: 'Protéines' },
  { cle: 'carbs', label: 'Glucides' },
  { cle: 'fats', label: 'Lipides' },
] as const

function Bloc4Cibles({ cible }: { cible: DailyTargets }) {
  const t = cible.targets
  if (t === null || cible.kcalTarget === null) {
    return (
      <div className="card">
        <h2 className="card__title">Cibles quotidiennes</h2>
        <p className="card__lead">
          Il manque une mesure pour calculer une cible.{' '}
          <Link to="/objectifs/reglages">Compléter mon profil</Link>
        </p>
      </div>
    )
  }

  const poids = cible.mesures.weightKg
  const lignes = MACROS.map((m) => ({
    ...m,
    macro: t[m.cle],
    // Proteines et lipides se jugent au poids de corps ; les glucides, non :
    // ils sont le reste, ce qui ferait un ratio sans signification.
    parKg: m.cle === 'carbs' || poids === null ? null : t[m.cle].grams / poids,
  }))

  return (
    <div className="card">
      <div className="card-entete">
        <h2 className="card__title card-entete__titre">Cibles quotidiennes</h2>
        <Link className="lien-discret" to="/objectifs/reglages">
          Modifier
        </Link>
      </div>

      <div className="cible__kcal">
        <span className="chiffre cible__valeur">{kcal(cible.kcalTarget)}</span>{' '}
        <span className="cible__unite">kcal par jour</span>
      </div>

      {/* La tri-barre montre la repartition CALORIQUE et non les grammes : 80 g
          de lipides pesent plus dans la journee que 150 g de proteines. C'est
          la meme barre que partout ailleurs, alimentee ici par la CIBLE au lieu
          du consomme. */}
      <span
        className="macro-bar cible__barre"
        role="img"
        aria-label={`Répartition : ${lignes.map((l) => `${l.label} ${l.macro.percent} %`).join(', ')}`}
      >
        {lignes.map((l) => (
          <span
            key={l.cle}
            className={`macro-bar__part macro-bar__part--${l.cle}`}
            style={{ flexGrow: l.macro.percent }}
          />
        ))}
      </span>

      <ul className="cibles">
        {lignes.map((l) => (
          <li key={l.cle} className="cibles__ligne">
            <span className={`cibles__puce cibles__puce--${l.cle}`} aria-hidden="true" />
            <span className="cibles__label">{l.label}</span>
            <span className="cibles__part">{l.macro.percent} %</span>
            <span className="cibles__grammes">
              {l.macro.grams} g
              {l.parKg === null ? null : <small> · {kg(l.parKg)} g/kg</small>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 5. Regularite
// ---------------------------------------------------------------------------

const INITIALES = ['L', 'M', 'M', 'J', 'V', 'S', 'D'] as const

/**
 * La semaine en sept points, et ce qu'elle vaut.
 *
 * SUR LA SEMAINE EN COURS et non sur trente jours, contrairement au mockup.
 * Une journee est "tenue" quand son apport tombe a moins de 10 % de la cible,
 * ce qui demande le calendrier complet de chaque jour. Or le calendrier se
 * charge par SEMAINE : couvrir trente jours coûterait cinq requetes, dont
 * quatre ne serviraient qu'a cette statistique. Le libelle dit donc sur quoi
 * porte le pourcentage, plutot que d'annoncer une fenetre qu'il n'a pas.
 */
function Bloc5Regularite({ cible }: { cible: DailyTargets }) {
  const isoWeek = currentIsoWeek()
  const semaine = useCalendar(isoWeek)
  const data = semaine.data
  const kcalTarget = cible.kcalTarget
  const eaters = cible.eaters

  const jours = useMemo(() => {
    if (data === undefined || kcalTarget === null) return null
    // Lundi = 0, comme partout ailleurs dans le calendrier.
    const aujourdhui = (new Date().getDay() + 6) % 7
    return INITIALES.map((initiale, index) => {
      if (index > aujourdhui) return { initiale, etat: 'avenir' as const }
      if (index === aujourdhui) return { initiale, etat: 'encours' as const }
      const duJour = entriesOfDay(data, index)
      const total: NutritionTotal = sumNutrition(duJour, data)
      const tenu = dayOnTarget(total.kcal, duJour.length, kcalTarget, eaters)
      return { initiale, etat: tenu ? ('tenu' as const) : ('rate' as const) }
    })
  }, [data, kcalTarget, eaters])

  if (jours === null) return null

  const passes = jours.filter((j) => j.etat === 'tenu' || j.etat === 'rate')
  const tenus = passes.filter((j) => j.etat === 'tenu').length
  const adherence = passes.length === 0 ? null : Math.round((tenus / passes.length) * 100)

  // Serie en cours : jours tenus consecutifs, en remontant depuis hier.
  let serie = 0
  for (let i = passes.length - 1; i >= 0; i -= 1) {
    if (passes[i]?.etat !== 'tenu') break
    serie += 1
  }

  return (
    <div className="card">
      <h2 className="card__title">Régularité</h2>

      <ol className="semaine-points">
        {jours.map((j, i) => (
          <li key={i} className="semaine-points__jour">
            <span className={`pastille pastille--${j.etat}`}>
              {j.etat === 'tenu' ? <Icon name="ui-check" size={14} /> : null}
            </span>
            <span aria-hidden="true">{j.initiale}</span>
          </li>
        ))}
      </ol>

      <div className="regularite">
        <span className="regularite__stat">
          <b className="chiffre">{serie} j</b>
          <small>d’affilée dans la cible</small>
        </span>
        <span className="regularite__stat">
          <b className="chiffre">{adherence === null ? '—' : `${adherence} %`}</b>
          <small>des jours écoulés cette semaine</small>
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 6. Mesures
// ---------------------------------------------------------------------------

function Bloc6Mesures({ cible, cap }: { cible: DailyTargets; cap: Cap | null }) {
  const { waistCm, heightCm } = cible.mesures
  // Le poids lisse l'emporte sur celui du profil : c'est le meme chiffre a une
  // pesee pres, mais celui-la ne saute pas d'un matin a l'autre.
  const poids = cap?.currentKg ?? cible.mesures.weightKg
  const imc = bmi(poids, heightCm)

  if (waistCm === null && imc === null) return null

  return (
    <div className="mesures">
      {waistCm !== null && (
        <div className="card mesure">
          <span className="mesure__label">Tour de taille</span>
          <span>
            <span className="chiffre mesure__valeur">{kg(waistCm)}</span>{' '}
            <span className="mesure__unite">cm</span>
          </span>
        </div>
      )}
      {imc !== null && (
        <div className="card mesure">
          <span className="mesure__label">IMC</span>
          <span className="chiffre mesure__valeur">
            {imc.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
          </span>
          <span className="mesure__zone">{bmiZone(imc)}</span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// La pesee du jour
// ---------------------------------------------------------------------------

function FeuillePesee({ today, onClose }: { today: string; onClose: () => void }) {
  const enregistrer = useSaveWeighIn()
  const toast = useToast()
  const [poids, setPoids] = useState<number | null>(null)

  const valide = poids !== null && poids >= 20 && poids <= 400

  return (
    <Sheet
      open
      onClose={onClose}
      title="Ma pesée du jour"
      dismissible={!enregistrer.isPending}
      variant="dialog"
      actions={
        <>
          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
            disabled={enregistrer.isPending}
          >
            Annuler
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={!valide || enregistrer.isPending}
            onClick={() => {
              if (!valide) return
              enregistrer.mutate(
                { day: today, weightKg: poids },
                {
                  onSuccess: () => {
                    toast.show({ message: 'Pesée enregistrée.' })
                    onClose()
                  },
                },
              )
            }}
          >
            {enregistrer.isPending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </>
      }
    >
      <NumberField
        label="Poids"
        value={poids}
        onChange={setPoids}
        min={20}
        max={400}
        decimals={1}
        suffix="kg"
        autoFocus
        required
        hint="Le matin, à jeun, dans les mêmes conditions : c’est la régularité de la mesure qui rend la tendance lisible, pas sa précision."
      />
      {enregistrer.isError && (
        <p className="status status--error" role="alert">
          {enregistrer.error.message}
        </p>
      )}
    </Sheet>
  )
}
