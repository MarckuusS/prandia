/**
 * La date de peremption, saisie de TROIS facons, de la plus rapide a la plus
 * longue :
 *
 *   1. toucher le jour dans la rangee des trois semaines a venir : on lit
 *      "14/10" sur le pot, on touche "14". Un geste, et c'est le cas courant,
 *      les produits frais ;
 *   2. la faire LIRE par l'iPhone : toucher le champ, puis "Scanner le texte".
 *      C'est la lecture de texte du systeme, offerte dans tout champ de texte ;
 *      elle colle ce qu'elle voit ("A consommer jusqu'au 14/10/26 L5285"), et
 *      `parseExpiryText` en retrouve la date ;
 *   3. la taper : "14/10/26", "141026", "03/2027" pour une date au mois.
 *
 * LE CHAMP EST UN TEXTE, PAS UN `type="date"`, et c'est tout le point : le
 * selecteur natif d'iOS impose trois roues, et la lecture du systeme ne sait
 * remplir qu'un champ de texte. Le clavier reste le clavier texte : rien ne
 * garantit que la lecture soit offerte sur le pave numerique.
 *
 * Ce qui a ete lu se dit en toutes lettres sous le champ ("Lu : mardi 14
 * octobre 2026") : une date mal comprise doit se voir avant d'etre enregistree.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  addDaysIso,
  formatExpiryInput,
  implausibleExpiryYear,
  parseExpiryText,
  todayLocalIsoDate,
} from '@prandia/shared'

import { Icon } from '../icons/index.js'
import '../styles/peremption.css'

/** Trois semaines : la duree de vie d'a peu pres tout ce qui a une DLC. */
const JOURS_PROPOSES = 21

const JOUR_SEMAINE = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', timeZone: 'UTC' })
const MOIS_COURT = new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone: 'UTC' })
const EN_TOUTES_LETTRES = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})
const MOIS_EN_LETTRES = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' })

/** Midi UTC : aucun fuseau ne fait changer de jour une date ainsi construite. */
const enDate = (iso: string) => new Date(`${iso}T12:00:00Z`)

interface Jour {
  readonly iso: string
  readonly haut: string
  readonly numero: string
  /** Le mois, pose devant le premier jour d'un nouveau mois. */
  readonly nouveauMois: string | null
}

function joursAVenir(aujourdhui: string): Jour[] {
  return Array.from({ length: JOURS_PROPOSES }, (_, i) => {
    const iso = addDaysIso(aujourdhui, i)
    const d = enDate(iso)
    return {
      iso,
      haut: i === 0 ? 'auj.' : i === 1 ? 'dem.' : JOUR_SEMAINE.format(d),
      numero: String(d.getUTCDate()),
      nouveauMois: i > 0 && d.getUTCDate() === 1 ? MOIS_COURT.format(d) : null,
    }
  })
}

export interface DatePeremptionProps {
  readonly value: string | null
  readonly onChange: (value: string | null) => void
  readonly label?: string | undefined
  /** Phrase d'aide propre a l'ecran, avant celle qui explique la lecture. */
  readonly hint?: string | undefined
  readonly disabled?: boolean | undefined
}

export function DatePeremption({
  value,
  onChange,
  label = 'Périmé le',
  hint,
  disabled,
}: DatePeremptionProps) {
  const id = useId()
  const aujourdhui = todayLocalIsoDate()
  const jours = useMemo(() => joursAVenir(aujourdhui), [aujourdhui])

  const [texte, setTexte] = useState(value === null ? '' : formatExpiryInput(value))
  const [precision, setPrecision] = useState<'jour' | 'mois'>('jour')
  /*
   * La derniere valeur que CE champ a emise. Une valeur differente venue du
   * parent (un autre produit choisi, une remise a zero) reecrit le texte ; la
   * sienne, non : sinon "14/1" deviendrait "14/01/27" sous les doigts pendant
   * qu'on tape "14/10".
   */
  const emise = useRef(value)
  useEffect(() => {
    if (value === emise.current) return
    emise.current = value
    setTexte(value === null ? '' : formatExpiryInput(value))
    setPrecision('jour')
  }, [value])

  const emettre = (suivante: string | null) => {
    emise.current = suivante
    onChange(suivante)
  }

  const saisir = (brut: string) => {
    setTexte(brut)
    const lu = parseExpiryText(brut, aujourdhui)
    setPrecision(lu?.precision ?? 'jour')
    emettre(lu?.date ?? null)
  }

  const toucher = (iso: string) => {
    setTexte(formatExpiryInput(iso))
    setPrecision('jour')
    emettre(iso)
  }

  const nonLu = texte.trim() !== '' && value === null
  const anneeDouteuse = nonLu ? implausibleExpiryYear(texte, aujourdhui) : null
  const lecture =
    value === null
      ? null
      : precision === 'mois'
        ? `Lu : jusqu’à fin ${MOIS_EN_LETTRES.format(enDate(value))}`
        : `Lu : ${EN_TOUTES_LETTRES.format(enDate(value))}`

  return (
    <div className={`field peremption${nonLu ? ' field--invalid' : ''}`}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>

      <div className="peremption__saisie">
        <input
          id={id}
          className="field__input peremption__texte"
          type="text"
          value={texte}
          onChange={(e) => saisir(e.target.value)}
          // Un format, pas un exemple : une vraie date en gris passait pour
          // une date deja saisie.
          placeholder="JJ/MM/AA"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="done"
          disabled={disabled}
          aria-invalid={nonLu ? true : undefined}
          aria-describedby={`${id}-lecture`}
        />
        {texte !== '' && (
          <button
            type="button"
            className="button button--ghost peremption__effacer"
            onClick={() => {
              setTexte('')
              emettre(null)
            }}
            disabled={disabled}
            aria-label="Effacer la date"
          >
            <Icon name="ui-close" size={18} />
          </button>
        )}
      </div>

      <p
        id={`${id}-lecture`}
        className={nonLu ? 'field__error' : 'field__hint'}
        aria-live="polite"
      >
        {nonLu
          ? anneeDouteuse !== null
            ? `L’année ${anneeDouteuse} paraît mal lue : corrige-la dans le champ.`
            : 'Date non reconnue. Écris-la comme sur l’emballage, par exemple 14/10/26.'
          : (lecture ?? `${hint === undefined ? '' : `${hint} `}Touche le jour, ou tape la date.`)}
      </p>

      {/* LE CHEMIN EXACT, parce qu'iOS le cache. Depuis iOS 17, "Scanner le
          texte" n'est plus dans le menu du champ mais dans son sous-menu
          "Remplissage automatique", et rien ne l'annonce : "touche le champ,
          puis Scanner le texte" ouvrait le clavier, et l'on s'arretait la
          (constate sur iPhone le 2026-10-11). Replie : on le lit une fois. */}
      <details className="peremption__aide">
        <summary>Faire lire la date par l’iPhone</summary>
        <ol>
          <li>Touche le champ, puis touche-le une seconde fois : un petit menu apparaît.</li>
          <li>
            Choisis <strong>Remplissage automatique</strong>, puis <strong>Scanner le texte</strong>.
          </li>
          <li>Vise la date sur l’emballage, puis touche Insérer.</li>
        </ol>
        <p>
          Si l’option manque : Réglages, Général, Langue et région, active Texte en direct.
        </p>
      </details>

      <div className="peremption__jours" role="group" aria-label="Les trois semaines à venir">
        {jours.map((j) => (
          <span key={j.iso} className="peremption__case">
            {j.nouveauMois !== null && (
              <span className="peremption__mois" aria-hidden="true">
                {j.nouveauMois}
              </span>
            )}
            <button
              type="button"
              className={`peremption__jour${j.iso === value ? ' peremption__jour--on' : ''}`}
              onClick={() => toucher(j.iso)}
              disabled={disabled}
              aria-pressed={j.iso === value}
              aria-label={EN_TOUTES_LETTRES.format(enDate(j.iso))}
            >
              <span className="peremption__jour-haut">{j.haut}</span>
              <span className="peremption__jour-numero chiffre">{j.numero}</span>
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}
