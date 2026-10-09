/**
 * Limites et precautions.
 *
 * CHAQUE PHRASE A ETE VERIFIEE CONTRE LE CODE, et c'est la seule regle qui
 * compte ici : un texte de precaution qui promet un garde-fou inexistant est
 * pire que pas de texte du tout, parce qu'il fait baisser la garde de qui le
 * lit.
 *
 * Le mockup dont vient cet ecran annoncait quatre choses fausses, toutes
 * reecrites :
 *
 *   - "l'app REFUSERA toute cible sous ton metabolisme de base". Faux deux
 *     fois. Le plancher est un nombre FIXE (`MIN_SAFE_KCAL`), pas le
 *     metabolisme de base, qui varie d'une personne a l'autre ; et une cible
 *     peut parfaitement tomber sous le metabolisme de base sans qu'aucun
 *     drapeau ne se leve. Homme de 40 ans, 178 cm, 95 kg, sedentaire, objectif
 *     « seche » : metabolisme 1 868, cible 1 794, et pas un mot.
 *   - "tout rythme au-dela de 1 kg par semaine". Le curseur s'arrete a 1, donc
 *     rien au-dela ne peut meme etre demande : il n'y a pas de refus, il y a
 *     une borne. Et le vrai plafond qui mord n'est pas en kg mais en part de
 *     la depense (`MAX_ADJUST`), souvent plus bas que l'allure demandee.
 *   - le verbe lui-meme. Cette application ne REFUSE rien : elle corrige, elle
 *     avertit, et elle enregistre.
 *   - "recalage hebdomadaire", "recalculees chaque dimanche". Il n'y a aucune
 *     tache periodique. Ce qui est vrai, et mieux, c'est qu'aucune cible n'est
 *     stockee : elle se recalcule du profil a chaque affichage.
 *
 * Le lien "En savoir plus" a ete retire plutot que de pointer vers une page
 * qui n'existe pas. Les sources sont nommees en toutes lettres.
 */

import { MAX_ADJUST, MIN_SAFE_KCAL, PACE_BOUNDS } from '@prandia/shared'

import { Icon } from '../../icons/index.js'

const kcalFr = (v: number) => v.toLocaleString('fr-FR')

/** L'allure la plus rapide qu'on puisse choisir. Lue, jamais recopiee. */
const ALLURE_MAX = PACE_BOUNDS.max

/** Borne minimale de la cible saisie a la main, telle que le schema l'accepte. */
const CIBLE_MANUELLE_MIN = 800

export function Limites({ id }: { readonly id?: string | undefined }) {
  return (
    <div className="card limites" id={id}>
      <h2 className="card__title limites__titre">
        <Icon name="ui-alert" size={18} className="icon--inline" />
        Limites et précautions
      </h2>

      <ul className="limites__liste">
        <li>
          <strong>L’estimation est statistique.</strong> Mifflin-St Jeor ignore la composition
          corporelle, les traitements, la grossesse et l’allaitement. Un écart de 10 à 15 % avec ta
          dépense réelle est normal.
        </li>

        <li>
          <strong>Deux corrections s’appliquent d’office.</strong> La cible calculée ne descend
          jamais sous {kcalFr(MIN_SAFE_KCAL.f)} kcal chez la femme, {kcalFr(MIN_SAFE_KCAL.m)} chez
          l’homme, et un écart de plus de {Math.round(MAX_ADJUST * 100)} % de ta dépense est ramené
          à cette limite. Chacune est annoncée à l’endroit où elle se produit, jamais appliquée en
          silence.
        </li>

        <li>
          <strong>Le reste n’est pas bloqué.</strong> Une cible sous ton métabolisme de base reste
          possible, et une cible saisie à la main l’emporte sur le calcul dès{' '}
          {kcalFr(CIBLE_MANUELLE_MIN)} kcal : ce champ existe pour le chiffre qu’un professionnel
          t’a donné. L’écran te le signale, il ne t’en empêche pas.
        </li>

        <li>
          <strong>Le curseur d’allure ne va pas au-delà de{' '}
          {ALLURE_MAX.toLocaleString('fr-FR')} kg par semaine.</strong> Ce n’est pas un oubli.
          Selon ta dépense, le plafond de {Math.round(MAX_ADJUST * 100)} % peut même ramener
          l’écart plus bas que l’allure demandée ; l’écran le dit alors.
        </li>

        <li>
          <strong>Rien n’est figé.</strong> Aucune cible n’est enregistrée : elle se recalcule de
          ton profil à chaque affichage. Change ton poids ou ton objectif, elle suit aussitôt.
        </li>

        <li>
          <strong>Rien ici ne remplace un avis médical.</strong> Grossesse, allaitement, moins de
          18 ans, pathologie ou antécédents de trouble du comportement alimentaire : parles-en à un
          professionnel de santé avant de suivre ces cibles.
        </li>
      </ul>

      <p className="limites__source">
        Ordres de grandeur pour un adulte en bonne santé, tirés des bornes usuelles des agences
        (AMDR, EFSA, ANSES).
      </p>
    </div>
  )
}
