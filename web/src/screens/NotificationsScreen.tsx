/**
 * Parametres, Notifications : ce que je recois, a quelle heure, et sur quel
 * appareil.
 *
 * Deux reglages differents, et l'ecran les separe (voir lib/notifications.ts) :
 * l'appareil s'abonne en haut, les types se reglent en dessous et valent pour
 * tous les appareils de la personne.
 *
 * ENREGISTREMENT AU FIL DES GESTES, sans bouton : chaque interrupteur et chaque heure
 * part tout de suite. Ce sont de petites ecritures independantes, et un ecran de
 * reglages qu'on quitte sans enregistrer perd ce qu'on croyait avoir regle.
 *
 * UN TYPE PAS ENCORE BRANCHE LE DIT ("Bientôt"). Il se regle deja, et partira
 * quand la planification saura le composer : laisser croire qu'il marche ferait
 * attendre une notification qui ne viendra pas.
 *
 * UNE HEURE PAR LIGNE, libelle a gauche, champ a droite, de largeur fixe : les
 * heures s'alignent en une seule colonne d'une carte a l'autre. Elles
 * s'enroulaient a la suite du libelle, la premiere a cote de lui et les
 * suivantes en dessous, sans ordre lisible.
 */

import { useEffect, useId, useState } from 'react'
import { NOTIFICATION_DEFS, type NotificationDef } from '@prandia/shared'

import { SwitchField } from '../components/Field.js'
import { ErrorState, LoadingRows } from '../components/States.js'
import { useToast } from '../components/Toast.js'
import {
  activerAppareil,
  desactiverAppareil,
  etatAppareil,
  useNotificationSettings,
  useSetNotificationPref,
  useTestNotification,
  type EtatAppareil,
  type NotificationPref,
} from '../lib/notifications.js'
import '../styles/settings.css'

const FAMILLES = [
  { cle: 'cuisine', titre: 'Cuisine et stocks' },
  { cle: 'sante', titre: 'Santé et objectifs' },
] as const

const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']

/** Plusieurs heures dans la journee : on les nomme par leur rang. */
const RANGS = ['Premier rappel', 'Deuxième rappel', 'Troisième rappel']

function libelleHeure(def: NotificationDef, total: number, index: number): string {
  if (total > 1) return RANGS[index] ?? `Rappel ${index + 1}`
  return def.weekday === null ? 'Chaque jour à' : `Le ${JOURS[def.weekday] ?? 'dimanche'} à`
}

export function NotificationsScreen() {
  const reglages = useNotificationSettings()
  const setPref = useSetNotificationPref()

  if (reglages.isPending) {
    return (
      <section className="screen">
        <LoadingRows rows={6} />
      </section>
    )
  }
  if (reglages.isError) {
    return (
      <section className="screen">
        <ErrorState error={reglages.error} onRetry={() => void reglages.refetch()} />
      </section>
    )
  }

  const { publicKey, prefs } = reglages.data
  const prefDe = (def: NotificationDef): NotificationPref =>
    prefs.find((p) => p.kind === def.kind) ?? { kind: def.kind, enabled: false, times: [...def.defaultTimes] }

  return (
    <section className="screen">
      <Appareil publicKey={publicKey} />

      {FAMILLES.map((famille) => (
        <div key={famille.cle}>
          <h2 className="section-header settings-group">{famille.titre}</h2>
          <ul className="notif-liste">
            {NOTIFICATION_DEFS.filter((def) => def.famille === famille.cle).map((def) => (
              <TypeNotification
                key={def.kind}
                def={def}
                pref={prefDe(def)}
                onChange={(pref) => setPref.mutate(pref)}
              />
            ))}
          </ul>
        </div>
      ))}

      {setPref.isError && (
        <p className="text-error" role="alert">
          {setPref.error.message}
        </p>
      )}
    </section>
  )
}

function TypeNotification({
  def,
  pref,
  onChange,
}: {
  readonly def: NotificationDef
  readonly pref: NotificationPref
  readonly onChange: (pref: NotificationPref) => void
}) {
  const prefixe = useId()

  return (
    <li className="card notif">
      <SwitchField
        label={def.label}
        badge={def.disponible ? undefined : 'Bientôt'}
        hint={def.description}
        checked={pref.enabled}
        onChange={(enabled) => onChange({ ...pref, enabled })}
      />
      {pref.enabled && (
        <ul className="notif__heures">
          {pref.times.map((time, index) => {
            const id = `${prefixe}-heure-${index}`
            return (
              <li key={index} className="notif__ligne">
                <label className="notif__quand" htmlFor={id}>
                  {libelleHeure(def, pref.times.length, index)}
                </label>
                <input
                  id={id}
                  type="time"
                  className="field__input notif__heure"
                  value={time}
                  step={300}
                  onChange={(event) => {
                    const valeur = event.target.value
                    if (!/^\d{2}:\d{2}$/.test(valeur)) return
                    onChange({ ...pref, times: pref.times.map((t, i) => (i === index ? valeur : t)) })
                  }}
                />
              </li>
            )
          })}
        </ul>
      )}
      {!def.disponible && pref.enabled && (
        <p className="field__hint">Réglé dès maintenant, envoyé dès que ce rappel sera prêt.</p>
      )}
    </li>
  )
}

function Appareil({ publicKey }: { readonly publicKey: string | null }) {
  const toast = useToast()
  const test = useTestNotification()
  const [etat, setEtat] = useState<EtatAppareil | null>(null)
  const [occupe, setOccupe] = useState(false)
  const [erreur, setErreur] = useState<string | null>(null)

  useEffect(() => {
    void etatAppareil().then(setEtat, () => setEtat('indisponible'))
  }, [])

  const agir = async (action: () => Promise<EtatAppareil>) => {
    setOccupe(true)
    setErreur(null)
    try {
      setEtat(await action())
    } catch (error) {
      setErreur(error instanceof Error ? error.message : 'L’opération n’a pas abouti.')
    } finally {
      setOccupe(false)
    }
  }

  return (
    <div className="card">
      <h2 className="card__title">Cet appareil</h2>

      {etat === null && <p className="card__lead">Vérification…</p>}
      {etat === 'indisponible' && <p className="card__lead">Ce navigateur ne sait pas recevoir de notifications.</p>}
      {etat === 'onglet-iphone' && (
        <p className="card__lead">
          Sur iPhone, les notifications n’arrivent que dans l’application installée. Dans Safari, touche
          Partager puis "Sur l’écran d’accueil", et ouvre Prandia depuis son icône.
        </p>
      )}
      {etat === 'refuse' && (
        <p className="card__lead">
          Les notifications sont refusées pour Prandia. Réactive-les dans les Réglages du téléphone,
          Notifications, Prandia : l’application ne peut pas redemander elle-même.
        </p>
      )}

      {etat === 'a-activer' && (
        <>
          <p className="card__lead">
            Cet appareil ne reçoit pas encore de notifications. Le téléphone va demander ton accord.
          </p>
          <button
            type="button"
            className="button button--primary button--block"
            disabled={occupe || publicKey === null}
            onClick={() => publicKey !== null && void agir(() => activerAppareil(publicKey))}
          >
            {occupe ? 'Activation…' : 'Activer les notifications'}
          </button>
          {publicKey === null && (
            <p className="field__hint">Le serveur n’est pas encore prêt à envoyer des notifications.</p>
          )}
        </>
      )}

      {etat === 'actif' && (
        <>
          <p className="card__lead">Cet appareil reçoit les notifications activées ci-dessous.</p>
          <div className="notif__actions">
            <button
              type="button"
              className="button button--secondary"
              disabled={test.isPending}
              onClick={() =>
                test.mutate(undefined, {
                  onSuccess: (bilan) =>
                    toast.show({
                      message:
                        bilan.envoye > 0
                          ? 'Notification de test envoyée.'
                          : 'La notification de test n’est pas partie.',
                    }),
                })
              }
            >
              {test.isPending ? 'Envoi…' : 'Envoyer un test'}
            </button>
            <button
              type="button"
              className="button button--ghost"
              disabled={occupe}
              onClick={() => void agir(desactiverAppareil)}
            >
              Désactiver ici
            </button>
          </div>
          {test.isError && (
            <p className="text-error" role="alert">
              {test.error.message}
            </p>
          )}
        </>
      )}

      {erreur !== null && (
        <p className="text-error" role="alert">
          {erreur}
        </p>
      )}
    </div>
  )
}
