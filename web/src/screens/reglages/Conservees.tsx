/**
 * Les trois cartes que la refonte ne touche pas.
 *
 * Repartition, Effets et Cible sont recopiees ICI SANS UNE RETOUCHE depuis
 * l'ancien ecran. Elles portent des avertissements, des seuils et des
 * explications qu'il serait facile de perdre en les reecrivant de memoire :
 * les cinq drapeaux de `estimateTargets`, les trois horizons de temps, la
 * redistribution des curseurs, le detail du calcul.
 *
 * Elles prennent `Draft` en parametre, defini dans l'ecran : c'est le meme
 * tampon d'edition, avec les memes noms de champs.
 */

import { useMemo } from 'react'
import {
  ENERGY_GOALS,
  MACRO_SPLITS,
  MIN_FAT_PERCENT,
  MIN_PROTEINS_PER_KG,
  ajusterSplit,
  effetsSecondaires,
  splitOf,
  type MacroCle,
  type SplitCode,
  type Targets,
} from '@prandia/shared'

import { NumberField, SelectField } from '../../components/Field.js'
import { NutrientLabel } from '../../components/NutrientLabel.js'
import { Icon } from '../../icons/index.js'
import type { Draft } from './draft.js'

/** Comme partout ailleurs : « 2 759 » et non « 2759 ». */
const kcalFr = (value: number) => value.toLocaleString('fr-FR')

const dateFr = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric',
  })

// ---------------------------------------------------------------------------
// Repartition
// ---------------------------------------------------------------------------

export function SplitCard({
  draft,
  estimated,
  onPatch,
}: {
  readonly draft: Draft
  readonly estimated: Targets | null
  readonly onPatch: (changes: Partial<Draft>) => void
}) {
  const proposee = ENERGY_GOALS.find((g) => g.code === draft.goal)?.defaultSplit
  const perso = draft.split === 'perso'

  /**
   * Bouger une macro redistribue le reste sur les deux autres.
   *
   * Tout le calcul est dans `ajusterSplit`, cote module partage, ou il est
   * teste : l'ecran ne fait que lui passer la main et ranger le resultat.
   */
  const bouger = (macro: MacroCle, valeur: number) => {
    const actuel = {
      proteins: draft.splitProteins ?? 0,
      carbs: draft.splitCarbs ?? 0,
      fats: draft.splitFats ?? 0,
    }
    const suivant = ajusterSplit(actuel, macro, valeur)
    onPatch({
      splitProteins: suivant.proteins,
      splitCarbs: suivant.carbs,
      splitFats: suivant.fats,
    })
  }

  /**
   * Passer en « personnalisée » recopie la repartition en cours dans les trois
   * champs. Les laisser vides obligerait a tout ressaisir pour deplacer cinq
   * points, et personne ne connait par coeur celle qu'il vient de quitter.
   */
  const choisir = (code: string) => {
    if (code !== 'perso') {
      onPatch({ split: code === '' ? null : (code as SplitCode) })
      return
    }
    const depart =
      draft.splitProteins !== null
        ? null
        : (estimated?.split ?? splitOf(draft.split ?? proposee ?? 'equilibre'))
    onPatch({
      split: 'perso',
      ...(depart
        ? { splitProteins: depart.proteins, splitCarbs: depart.carbs, splitFats: depart.fats }
        : {}),
    })
  }

  return (
    <div className="card">
      <h2 className="card__title">Répartition</h2>
      <SelectField
        label="Répartition des macros"
        value={draft.split ?? ''}
        onChange={choisir}
        placeholder={
          proposee
            ? `Celle de l’objectif — ${MACRO_SPLITS.find((s) => s.code === proposee)?.label}`
            : 'Celle de l’objectif'
        }
        options={MACRO_SPLITS.map((s) => ({
          value: s.code,
          label: s.split
            ? `${s.label} — ${s.split.proteins}/${s.split.carbs}/${s.split.fats}`
            : s.label,
        }))}
        hint="Protéines / glucides / lipides, en part de l’énergie. Changer de répartition ne change pas la cible en kcal."
      />

      {perso && (
        <>
          <div className="split-curseurs">
            {([
              ['proteins', 'Protéines', draft.splitProteins],
              ['carbs', 'Glucides', draft.splitCarbs],
              ['fats', 'Lipides', draft.splitFats],
            ] as const).map(([cle, label, valeur]) => (
              <label key={cle} className="split-curseur">
                <span className="split-curseur__tete">
                  <span className="split-curseur__nom">{label}</span>
                  <span className="split-curseur__part">{valeur ?? 0} %</span>
                </span>
                <input
                  type="range"
                  className={`split-curseur__piste split-curseur__piste--${cle}`}
                  min={0}
                  max={100}
                  step={1}
                  value={valeur ?? 0}
                  onChange={(e) => bouger(cle, Number(e.target.value))}
                />
                <span className="split-curseur__grammes">
                  {estimated ? `${estimated[cle].grams} g` : '—'}
                </span>
              </label>
            ))}
          </div>

          <p className="field__hint">
            Bouger un curseur redistribue le reste sur les deux autres : le total fait toujours
            100 %. Les grammes suivent la cible en kcal, qui ne bouge pas.
          </p>

        </>
      )}
    </div>
  )
}

/**
 * Ce qu'un reglage extreme coute, par horizon.
 *
 * Elle n'apparait QUE lorsqu'il y a quelque chose a dire : une carte
 * permanente qui repete « tout va bien » rendrait sourd au jour ou elle
 * signale un vrai probleme.
 *
 * Les trois horizons sont separes parce qu'ils ne sont pas comparables. Un
 * deficit creuse se paie en fatigue la premiere semaine, en masse musculaire
 * au bout de deux mois, en densite osseuse au bout de deux ans. Les fondre en
 * une phrase ferait lire la consequence la plus grave comme imminente — donc
 * paniquante, donc ignoree.
 */
export function EffetsCard({ cibles }: { readonly cibles: Targets | null }) {
  const avis = useMemo(() => (cibles === null ? [] : effetsSecondaires(cibles)), [cibles])
  if (avis.length === 0) return null

  const serieux = avis.filter((a) => a.gravite === 'serieux').length

  return (
    <div className="card effets">
      <h2 className="card__title">
        <Icon name="ui-alert" size={18} className="icon--inline" /> Ce que ce réglage implique
      </h2>
      <p className="card__lead">
        {serieux > 0
          ? 'Ton réglage sort des bornes habituelles. Rien ne t’empêche de le garder — mais voilà ce qu’en dit la littérature.'
          : 'Ton réglage s’écarte des bornes habituelles. Rien de grave, mais autant le savoir.'}
      </p>

      <ul className="effets__liste">
        {avis.map((a) => (
          <li key={a.code} className={`effet effet--${a.gravite}`}>
            <p className="effet__constat">{a.constat}</p>
            <dl className="effet__horizons">
              {([
                ['court', 'Jours à semaines', a.court],
                ['moyen', 'Semaines à mois', a.moyen],
                ['long', 'Mois à années', a.long],
              ] as const)
                .filter(([, , texte]) => texte !== null)
                .map(([cle, quand, texte]) => (
                  <div key={cle} className="effet__horizon">
                    <dt>{quand}</dt>
                    <dd>{texte}</dd>
                  </div>
                ))}
            </dl>
          </li>
        ))}
      </ul>

      <p className="field__hint">
        Ordres de grandeur pour un adulte en bonne santé, tirés des bornes usuelles des agences
        (AMDR, EFSA, ANSES) — pas un diagnostic. Un régime durablement hors de ces bornes se
        discute avec un médecin ou un diététicien, surtout en cas de traitement, de grossesse ou
        d’atteinte rénale.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ce que ca donne
// ---------------------------------------------------------------------------

export function TargetsCard({
  estimated,
  draft,
  missing,
  kcal,
  onPatch,
}: {
  readonly estimated: Targets | null
  readonly draft: Draft
  readonly missing: string
  readonly kcal: number | null
  readonly onPatch: (changes: Partial<Draft>) => void
}) {
  const manual = draft.kcalTarget !== null

  return (
    <div className="card">
      <h2 className="card__title">Ma cible</h2>

      {estimated === null && !manual && (
        <p className="card__lead">
          Il manque encore {missing} pour estimer un objectif. Tu peux aussi entrer directement une
          cible plus bas.
        </p>
      )}

      {estimated !== null && (
        <>
          {/* Le detail du calcul, pas seulement son resultat. */}
          <dl className="kv profile-steps">
            <dt>Métabolisme de base</dt>
            <dd>{kcalFr(estimated.bmr)} kcal</dd>
            <dt>Dépense estimée</dt>
            <dd>{kcalFr(estimated.tdee)} kcal</dd>
            <dt>Après objectif</dt>
            <dd>{kcalFr(estimated.kcal)} kcal</dd>
          </dl>

          {estimated.weeksToTarget !== null && estimated.targetDate !== null && (
            <p className="profile-eta">
              <Icon name="ui-calendar" size={16} className="icon--inline" />{' '}
              {estimated.kgToTarget?.toLocaleString('fr-FR')} kg en {estimated.weeksToTarget}{' '}
              semaines, soit vers le {dateFr(estimated.targetDate)}.
            </p>
          )}

          {estimated.capped && (
            <p className="status status--warn">
              <Icon name="ui-alert" size={16} className="icon--inline" /> L’allure demandée creusait
              un écart de plus de 25 % de ta dépense. Elle a été ramenée à cette limite.
            </p>
          )}

          {estimated.floored && (
            <p className="status status--warn">
              <Icon name="ui-alert" size={16} className="icon--inline" /> Le calcul descendait sous
              le seuil d’un régime non supervisé : la cible a été relevée à{' '}
              {kcalFr(estimated.kcal)} kcal.
            </p>
          )}

          {estimated.kgToTarget !== null &&
            estimated.kgToTarget > 0 &&
            estimated.weeksToTarget === null && (
              <p className="status status--warn">
                <Icon name="ui-alert" size={16} className="icon--inline" /> À ce réglage, la cible ne
                se rapproche pas : l’apport retenu ne va pas dans la direction du poids visé.
              </p>
            )}


          {/* Memes pictogrammes que le calendrier et la fiche ingredient : trois
              dessins differents pour la meme chose obligeraient a réapprendre
              le code couleur a chaque ecran. */}
          <ul className="profile-macros">
            {([
              ['proteins', 'Protéines', estimated.proteins],
              ['carbs', 'Glucides', estimated.carbs],
              ['fats', 'Lipides', estimated.fats],
            ] as const).map(([key, label, macro]) => (
              <li key={key}>
                <NutrientLabel nutrient={key} label={label} />
                <span className="profile-macros__value">
                  {kcalFr(macro.grams)} g · {macro.percent} %
                  {key === 'proteins' && (
                    // Les proteines se jugent au poids du corps, pas en part de
                    // l'energie : 25 % ne veut rien dire sans savoir de quoi.
                    <span className="profile-macros__per-kg">
                      {estimated.proteinsPerKg.toLocaleString('fr-FR', {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      })}{' '}
                      g/kg
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>

          {estimated.lowProteins && (
            <p className="status status--warn">
              <Icon name="ui-alert" size={16} className="icon--inline" /> Moins de{' '}
              {MIN_PROTEINS_PER_KG.toLocaleString('fr-FR')} g de protéines par kilo, en déficit :
              c’est la masse musculaire qui paie en premier.
            </p>
          )}

          {estimated.lowFats && (
            <p className="status status--warn">
              <Icon name="ui-alert" size={16} className="icon--inline" /> Moins de{' '}
              {MIN_FAT_PERCENT} % de lipides : en dessous, l’apport ne couvre plus les besoins
              hormonaux et l’absorption des vitamines A, D, E et K.
            </p>
          )}
        </>
      )}

      <NumberField
        label="Cible personnalisée"
        value={draft.kcalTarget}
        onChange={(v) => onPatch({ kcalTarget: v })}
        min={800}
        max={8000}
        suffix="kcal"
        hint={
          manual
            ? 'Cette valeur remplace l’estimation. Vide-la pour revenir au calcul.'
            : 'Facultatif. Si un professionnel t’a donné un chiffre, entre-le : il l’emportera sur l’estimation.'
        }
      />

      {kcal !== null && (
        <p className="profile-final">
          Objectif retenu : <strong>{kcalFr(kcal)} kcal par jour</strong>
          {manual && ' (saisi à la main)'}
        </p>
      )}

      <p className="field__hint">
        Estimation statistique (Mifflin-St Jeor), pas un avis médical. Elle ignore la composition
        corporelle, les traitements, la grossesse et l’allaitement ; un écart de 10 à 15 % avec la
        dépense réelle est normal.
      </p>
    </div>
  )
}
