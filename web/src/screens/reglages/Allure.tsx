/**
 * La jauge de rythme : un curseur qui glisse.
 *
 * Elle a d'abord offert TROIS ARRETS, parce que le modele ne connaissait que
 * trois codes d'allure. La colonne est devenue un nombre (migration 0014) et
 * le curseur est maintenant continu, de 0,10 a 1 kg par semaine par pas de
 * 0,05. Les trois anciennes valeurs restent atteignables ; elles ne sont
 * simplement plus les seules.
 *
 * DEUX COUCHES QUI NE SE CONFONDENT PAS : une PISTE, pur decor (`aria-hidden`),
 * qui porte l'axe physique de 0 a 1,2 et ses trois zones ; et un CONTROLE pose
 * dessus. La piste va PLUS LOIN que le curseur, et c'est le point : la bande
 * de droite montre ce qu'on ne peut pas demander. Le garde-fou se voit au lieu
 * de s'affirmer.
 *
 * LE POUCE EST DESSINE A PART. Un `input[type=range]` place le sien a
 * « demi-pouce + valeur x (largeur - pouce) » : sur une piste dont les
 * frontieres de zone sont a des pourcentages exacts, il derive de plusieurs
 * pixels a chaque extremite. On reduit donc le pouce natif a 1 px, invisible,
 * et l'on pose le rond visible a la position exacte de la valeur. L'input
 * garde tout le reste : le glissement au doigt, les fleches du clavier, et
 * l'annonce par un lecteur d'ecran.
 *
 * `null` VEUT DIRE QUELQUE CHOSE : « aucune allure choisie, c'est l'objectif
 * qui decide ». Un curseur a toujours une valeur, donc cet etat se rend a
 * part : le rond est cache et la lecture dit d'ou vient l'ecart. La premiere
 * manipulation choisit une allure ; le bouton du bas revient a `null`.
 */

import { PACE_BOUNDS, SAFE_PACE, paceLabel } from '@prandia/shared'

/** Haut de l'echelle DESSINEE, au-dela de ce que le curseur peut atteindre. */
const ECHELLE_MAX = 1.2

const pct = (kg: number) => (kg / ECHELLE_MAX) * 100

const kgFr = (v: number) =>
  v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** La zone d'une allure, CALCULEE : un litteral mentirait si les bornes bougeaient. */
const zoneDe = (kgPerWeek: number): string => {
  if (kgPerWeek < SAFE_PACE.min) return 'Sous le seuil visible'
  if (kgPerWeek > SAFE_PACE.max) return 'Au-delà du recommandé'
  return 'Zone recommandée'
}

/** Position du curseur quand rien n'est choisi. Le rond y est cache. */
const AU_REPOS = 0.5

export function Allure({
  value,
  onChange,
  onClear,
  perte,
}: {
  readonly value: number | null
  readonly onChange: (kgPerWeek: number) => void
  readonly onClear: () => void
  /** Vrai si l'ecart va vers le BAS. Decide du sens dit et du signe affiche. */
  readonly perte: boolean
}) {
  const pose = value ?? AU_REPOS
  const sens = perte ? 'de moins' : 'de plus'

  return (
    <div className="allure">
      <p className="allure__lecture">
        {value === null ? (
          <span className="allure__vide">Celle de l’objectif</span>
        ) : (
          <>
            <span className="chiffre allure__valeur">
              {perte ? '−' : '+'}
              {kgFr(value)}
            </span>{' '}
            <span className="allure__unite">kg par semaine</span>
            <span className="allure__zone">{zoneDe(value)}</span>
          </>
        )}
      </p>

      <div className="allure__jauge">
        <span className="allure__piste" aria-hidden="true">
          <span
            className="allure__bande allure__bande--lente"
            style={{ width: `${pct(SAFE_PACE.min)}%` }}
          />
          <span
            className="allure__bande allure__bande--sure"
            style={{ width: `${pct(SAFE_PACE.max - SAFE_PACE.min)}%` }}
          />
          <span className="allure__bande allure__bande--exclue" />
        </span>

        {/* Le rond visible, pose a la position EXACTE de la valeur. */}
        {value !== null && (
          <span className="allure__curseur" style={{ left: `${pct(value)}%` }} aria-hidden="true" />
        )}

        {/* Le controle : transparent, il couvre exactement la portion de piste
            que le curseur peut parcourir, de 0,10 a 1 kg par semaine. */}
        <input
          className="allure__champ"
          type="range"
          min={PACE_BOUNDS.min}
          max={PACE_BOUNDS.max}
          step={PACE_BOUNDS.step}
          value={pose}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{
            left: `${pct(PACE_BOUNDS.min)}%`,
            width: `${pct(PACE_BOUNDS.max) - pct(PACE_BOUNDS.min)}%`,
          }}
          aria-label="Allure visée"
          /* « 0,5 » seul ne dit ni de quoi ni dans quel sens. Et tant que rien
             n'est choisi, il ne faut surtout pas annoncer la position de
             repos comme si elle etait un reglage. */
          aria-valuetext={
            value === null
              ? 'Non définie, celle de l’objectif'
              : `${kgFr(value)} kg ${sens} par semaine. ${zoneDe(value)}, ${paceLabel(value).toLowerCase()}.`
          }
        />
      </div>

      <p className="allure__bornes" aria-hidden="true">
        <span style={{ left: `${pct(SAFE_PACE.min)}%` }}>{kgFr(SAFE_PACE.min)}</span>
        <span style={{ left: `${pct(SAFE_PACE.max)}%` }}>
          {SAFE_PACE.max.toLocaleString('fr-FR')}
        </span>
      </p>

      <p className="allure__legende">
        {value !== null && <strong>{paceLabel(value)}. </strong>}
        Sous {kgFr(SAFE_PACE.min)} kg par semaine, la balance ne montrerait rien de net. Au-delà de{' '}
        {SAFE_PACE.max.toLocaleString('fr-FR')}, le curseur ne va pas, et ce n’est pas un oubli. La
        date d’arrivée découle du rythme, jamais l’inverse.
      </p>

      {value !== null && (
        <button type="button" className="button button--ghost allure__annuler" onClick={onClear}>
          Revenir à l’allure de l’objectif
        </button>
      )}
    </div>
  )
}
