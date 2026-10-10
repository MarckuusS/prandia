/**
 * Aujourd'hui.
 *
 * L'ecran d'arrivee de l'application. Il repond dans l'ordre a trois
 * questions : ou j'en suis de ma journee, ce que j'ai mange, et ou je vais
 * maintenant.
 *
 * IL NE FAIT AUCUNE REQUETE QUI LUI SOIT PROPRE. Les repas viennent de
 * `useCalendar(currentIsoWeek())` — la meme cle de cache que le Planning, qui
 * lit la semaine entiere puisqu'il n'existe pas de route par jour. Ouvrir
 * l'Accueil puis le Planning ne coute donc qu'un seul aller-retour, et un repas
 * ajoute ici apparait la sans rien reclamer.
 *
 * LES QUATRE ACCES DU BAS NE SONT PAS UNE DECORATION. En passant de cinq
 * onglets a quatre plus un bouton de scan, Bibliotheque, Recettes, Courses et
 * Frigo ont quitte la barre. Ils sont ici, et c'est le seul endroit ou ils le
 * sont : les retirer rendrait quatre ecrans inatteignables.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { currentIsoWeek, datesOfIsoWeek } from '@prandia/shared'

import { EmptyState, ErrorState, LoadingRows } from '../components/States.js'
import { useToast } from '../components/Toast.js'
import { Icon, type IconName } from '../icons/index.js'
import { useAddEntry, useCalendar, useDeleteEntry, type EntryDraft } from '../lib/queries.js'
import { BilanDuJour } from './accueil/BilanDuJour.js'
import { Hydratation } from './accueil/Hydratation.js'
import { EntrySheet } from './semaine/EntrySheet.js'
import { MealRow } from './semaine/MealRow.js'
import { entriesOfDay, sumNutrition, type SavedEntry } from './semaine/totals.js'
import '../styles/accueil.css'

/**
 * Les quatre ecrans qui ont quitte la barre d'onglets.
 *
 * L'ordre suit la journee plutot que l'alphabet : on cuisine avec ce qu'on a
 * (Frigo), depuis un repertoire (Recettes), en s'appuyant sur des fiches
 * (Bibliotheque), et on complete ce qui manque (Courses).
 */
const ACCES: ReadonlyArray<{ to: string; icon: IconName; label: string; detail: string }> = [
  { to: '/frigo', icon: 'ui-fridge', label: 'Frigo', detail: 'Ce que j’ai déjà' },
  { to: '/recettes', icon: 'ui-utensils', label: 'Recettes', detail: 'Mon répertoire' },
  { to: '/ingredients', icon: 'ui-basket', label: 'Bibliothèque', detail: 'Mes ingrédients' },
  { to: '/courses', icon: 'ui-cart', label: 'Courses', detail: 'Ce qu’il me faut' },
]

/** 0 = lundi, 6 = dimanche. `getDay()` rend 0 pour dimanche, d'ou le decalage. */
const indiceDuJour = (now: Date = new Date()) => (now.getDay() + 6) % 7

export function AccueilScreen() {
  const isoWeek = currentIsoWeek()
  const query = useCalendar(isoWeek)
  const supprimer = useDeleteEntry(isoWeek)
  const rajouter = useAddEntry(isoWeek)
  const toast = useToast()
  const [ouverte, setOuverte] = useState<SavedEntry | null>(null)

  const jour = indiceDuJour()
  const data = query.data

  const repas = useMemo(() => (data === undefined ? [] : entriesOfDay(data, jour)), [data, jour])
  const total = useMemo(
    () => (data === undefined ? null : sumNutrition(repas, data)),
    [repas, data],
  )

  /*
   * LES ACCES SONT RENDUS DANS LES TROIS ETATS, y compris pendant le
   * chargement et en cas d'echec — et ce n'est pas un detail de presentation.
   *
   * Ils sont le SEUL chemin vers Bibliotheque, Recettes, Courses et Frigo.
   * Places apres les retours anticipes, ils disparaissaient des que le
   * calendrier ne repondait pas : en magasin, reseau faible, lancement a froid
   * (le cache n'est pas persiste), l'ecran Courses — celui pour lequel on a
   * sorti le telephone — devenait inatteignable. Ils ne dependent d'aucune
   * donnee : rien ne justifie qu'ils attendent une requete.
   */
  if (query.isPending) {
    return (
      <section className="screen">
        <LoadingRows rows={4} />
        <Acces />
      </section>
    )
  }

  if (query.isError || data === undefined) {
    return (
      <section className="screen">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        <Acces />
      </section>
    )
  }

  const kcal = Math.round(total?.kcal ?? 0)

  return (
    <section className="screen">
      <BilanDuJour dayTotal={total ?? sumNutrition([], data)} hasEntries={repas.length > 0} />

      <Hydratation />

      <div className="card">
        <div className="card-entete">
          <h2 className="card__title card-entete__titre">Repas du jour</h2>
          {repas.length > 0 && (
            <span className="card-entete__valeur">{kcal.toLocaleString('fr-FR')} kcal</span>
          )}
        </div>

        {repas.length === 0 ? (
          <EmptyState title="Rien de prévu aujourd’hui">
            Le planning de la semaine est l’endroit ou l’on compose une journée.
          </EmptyState>
        ) : (
          <ul className="row-list">
            {repas.map((entry) => (
              <MealRow key={entry.id} entry={entry} data={data} onEdit={setOuverte} />
            ))}
          </ul>
        )}

        <Link className="button button--secondary accueil__vers-planning lien-surface" to="/planning">
          <Icon name="ui-calendar" size={18} className="icon--inline" />
          {repas.length === 0 ? 'Planifier la journée' : 'Ouvrir le planning'}
        </Link>
      </div>

      <Acces />

      {ouverte !== null && (
        <EntrySheet
          isoWeek={isoWeek}
          entry={ouverte}
          data={data}
          onClose={() => setOuverte(null)}
          // MEME geste que sur le Planning, annulation comprise : un repas
          // retire depuis l'Accueil doit pouvoir se remettre, sans quoi la
          // meme action n'a pas les memes consequences selon l'ecran par
          // lequel on y arrive.
          onDelete={(entry, label) => {
            const brouillon: EntryDraft = {
              dayOfWeek: entry.dayOfWeek,
              slot: entry.slot,
              recipeId: entry.recipeId,
              ingredientId: entry.ingredientId,
              quantityG: entry.quantityG,
              portions: entry.portions,
              // Sans l'unite, un repas remis apres annulation se relirait en
              // grammes crus ou en grammes la ou l'on avait saisi des pieces.
              unit: entry.unit,
            }
            setOuverte(null)
            supprimer.mutate(entry.id, {
              onSuccess: () => toast.showUndo(`${label} retiré`, () => rajouter.mutate(brouillon)),
            })
          }}
        />
      )}
    </section>
  )
}

/** Les quatre cartes vers les ecrans sortis de la barre d'onglets. */
function Acces() {
  return (
    <nav className="acces" aria-label="Les autres écrans">
      {ACCES.map((a) => (
        <Link key={a.to} to={a.to} className="acces__carte lien-surface">
          <span className="acces__icone" aria-hidden="true">
            <Icon name={a.icon} size={22} strokeWidth={1.7} />
          </span>
          <span className="acces__label">{a.label}</span>
          <span className="acces__detail">{a.detail}</span>
        </Link>
      ))}
    </nav>
  )
}

/** Les dates de la semaine courante, pour dater le surtitre de l'Accueil. */
export function libelleDuJour(now: Date = new Date()): string {
  const dates = datesOfIsoWeek(currentIsoWeek(now))
  const date = dates[indiceDuJour(now)]
  if (date === undefined) return ''
  // `timeZone: 'UTC'` obligatoire : `datesOfIsoWeek` rend des dates a midi UTC,
  // et les lire en heure locale decale d'un jour selon le fuseau.
  const texte = date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })
  return texte.charAt(0).toUpperCase() + texte.slice(1)
}
