/**
 * Regler mes objectifs — `/objectifs/reglages`, vue empilee.
 *
 * L'ecran repond a une question : « combien pour MOI, aujourd'hui ». Il ne
 * donne pas d'avis medical, et il le dit — en bas, dans un bloc qu'on ne peut
 * pas ne pas voir, et dont chaque phrase a ete verifiee contre le code.
 *
 * CINQ PARTIS PRIS D'INTERFACE :
 *
 *   1. Les cibles se recalculent PENDANT la saisie, avant tout enregistrement.
 *      Changer d'objectif et voir la ligne bouger explique le calcul mieux
 *      qu'une phrase, et evite d'enregistrer pour decouvrir le resultat.
 *
 *   2. Le detail du calcul est montre, pas cache : metabolisme de base, puis
 *      facteur d'activite, puis ajustement d'objectif. Quelqu'un qui ne sait
 *      pas lire un tableau nutritionnel a d'autant plus besoin de voir d'ou
 *      sort le chiffre qu'on lui propose.
 *
 *   3. L'energie et la repartition sont DEUX cartes distinctes, parce que ce
 *      sont deux decisions distinctes. Choisir « seche » propose une
 *      repartition ; la remplacer ne change pas l'objectif de poids.
 *
 *   4. Rien n'est obligatoire SAUF la reconnaissance des limites, et seulement
 *      la premiere fois, et seulement s'il y a une cible. Un profil se remplit
 *      par etapes ; l'ecran s'enregistre a tout moment et dit ce qui manque
 *      encore pour que la cible apparaisse.
 *
 *   5. L'AGE se saisit en annees, pas en annee de naissance. C'est ce que les
 *      gens connaissent d'eux-memes. Ce qui est STOCKE reste l'annee de
 *      naissance, et la conversion est exacte dans les deux sens :
 *      `ageFrom` du module partage n'est qu'une soustraction d'annees.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ACTIVITY_LEVELS,
  ageFrom,
  estimateTargets,
  type ActivityCode,
  type GoalCode,
  type MacroSplit,
  type SplitCode,
} from '@prandia/shared'

import { NumberField, RadioGroupField } from '../components/Field.js'
import { ErrorState, LoadingRows } from '../components/States.js'
import { useToast } from '../components/Toast.js'
import { useProfile, useSaveProfile, useWeightLog, type ProfilePayload } from '../lib/queries.js'
import { Limites } from './reglages/Limites.js'
import { Objectif } from './reglages/Objectif.js'
import { PiedEnregistrer } from './reglages/PiedEnregistrer.js'
import { EffetsCard, TargetsCard } from './reglages/Conservees.js'
import { EMPTY, type Draft } from './reglages/draft.js'
import '../styles/profile.css'
import '../styles/reglages.css'

export function ProfileScreen() {
  const query = useProfile()
  const pesees = useWeightLog()
  const save = useSaveProfile()
  const toast = useToast()

  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [enregistre, setEnregistre] = useState(false)
  /** Copie de ce que le serveur a rendu, pour savoir si quelque chose a bouge. */
  const initial = useRef<Draft>(EMPTY)

  // Le serveur fait foi au PREMIER chargement seulement : reecraser le tampon
  // a chaque reponse effacerait la saisie en cours si une requete de fond
  // aboutissait entre-temps.
  useEffect(() => {
    if (loaded || query.data === undefined) return
    const { profile, eaters } = query.data
    const charge: Draft = {
      sex: profile.sex,
      birthYear: profile.birthYear,
      heightCm: profile.heightCm,
      weightKg: profile.weightKg,
      waistCm: profile.waistCm,
      activity: profile.activity as ActivityCode | null,
      goal: profile.goal as GoalCode | null,
      split: profile.split as SplitCode | null,
      splitProteins: profile.splitProteins,
      splitCarbs: profile.splitCarbs,
      splitFats: profile.splitFats,
      targetWeightKg: profile.targetWeightKg,
      paceKgPerWeek: profile.paceKgPerWeek,
      kcalTarget: profile.kcalTarget,
      eaters,
    }
    setDraft(charge)
    initial.current = charge
    setLoaded(true)
  }, [query.data, loaded])

  const patch = (changes: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...changes }))
    setEnregistre(false)
  }

  const customSplit: MacroSplit | null =
    draft.splitProteins === null && draft.splitCarbs === null && draft.splitFats === null
      ? null
      : {
          proteins: draft.splitProteins ?? 0,
          carbs: draft.splitCarbs ?? 0,
          fats: draft.splitFats ?? 0,
        }

  const estimated = useMemo(
    () => estimateTargets({ ...draft, customSplit }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft],
  )

  /** La cible saisie a la main l'emporte sur l'estimation, si elle existe. */
  const kcal = draft.kcalTarget ?? estimated?.kcal ?? null

  const missingText = useMemo(() => {
    const labels: Record<string, string> = {
      sex: 'le sexe', birthYear: 'l’âge', heightCm: 'la taille',
      weightKg: 'le poids', activity: 'le niveau d’activité', goal: 'l’objectif',
    }
    const missing = Object.entries(labels)
      .filter(([key]) => draft[key as keyof Draft] === null)
      .map(([, label]) => label)
    // « a, b et c » : une enumeration lue par un humain, pas un tableau imprime.
    if (missing.length <= 1) return missing.join('')
    return `${missing.slice(0, -1).join(', ')} et ${missing[missing.length - 1]}`
  }, [draft])

  const modifie = useMemo(
    () => (Object.keys(EMPTY) as (keyof Draft)[]).some((k) => draft[k] !== initial.current[k]),
    [draft, loaded],
  )

  if (query.isPending) return <section className="screen"><LoadingRows rows={5} /></section>
  /*
   * L'ecran d'erreur ne remplace le formulaire que s'il n'y a RIEN a montrer.
   *
   * `refetchOnWindowFocus` est actif : revenir sur l'onglet apres trente
   * secondes relance la requete, et un echec passe `isError` a vrai alors que
   * `data` tient toujours. Sans cette condition, un formulaire a moitie rempli
   * disparaissait derriere un ecran d'erreur, avec le pied et la case.
   */
  if (query.isError && query.data === undefined) {
    return (
      <section className="screen">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </section>
    )
  }

  const submit = () => {
    // L'instantane de CE qui part, garde en type `Draft` : `ProfilePayload`
    // elargit les codes en `string`, et il servira de repere de comparaison.
    const envoye: Draft = { ...draft }
    void save
      .mutateAsync(envoye satisfies ProfilePayload)
      .then(() => {
        /*
         * LE REPERE EST PRIS SUR CE QUI EST REELLEMENT PARTI, pas sur l'etat
         * courant.
         *
         * Le `.then` se referme sur le brouillon du moment du clic. Sur un
         * reseau lent, quelqu'un corrige son poids pendant que la requete
         * vole : declarer l'etat courant enregistre ferait afficher
         * « Enregistre » sur une saisie qui n'est jamais partie. En prenant
         * `envoye` comme repere, `modifie` redevient vrai tout seul.
         *
         * Et surtout, on ne repose RIEN dans le brouillon : le serveur ne
         * renvoie aucun champ qu'il aurait modifie de son cote.
         */
        initial.current = envoye
        setEnregistre(true)
        toast.show({ message: 'Objectifs enregistrés.' })
      })
      // L'erreur est deja rendue par le pied, via `save.isError` ; sans ce
      // rattrapage, chaque echec laisse une promesse rejetee non traitee.
      .catch(() => undefined)
  }

  const anneeCourante = new Date().getFullYear()
  const age = draft.birthYear === null ? null : ageFrom(draft.birthYear, new Date())
  /** Une pesee existe : le poids du profil suit alors la derniere en date. */
  const auto = (pesees.data?.weighIns.length ?? 0) > 0

  return (
    <section className="screen screen--reglages">
      {/* ---------- 1. Mon profil ---------- */}
      <div className="card">
        <h2 className="card__title">Mon profil</h2>

        <div className="segmented" role="group" aria-label="Sexe">
          {([['m', 'Homme'], ['f', 'Femme']] as const).map(([code, label]) => (
            <button
              key={code}
              type="button"
              className={`segmented__tab${draft.sex === code ? ' segmented__tab--active' : ''}`}
              aria-pressed={draft.sex === code}
              onClick={() => patch({ sex: code })}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="field__hint">
          Sert uniquement à estimer ta dépense : la formule de référence n’a que ces deux
          constantes. Ces informations sont <strong>personnelles</strong>, l’autre personne du
          foyer ne les voit pas.
        </p>

        <div className="lignes">
          <NumberField
            label="Âge"
            className="field--ligne"
            value={age}
            /* `decimals` n'arrondit que l'AFFICHAGE. « 30,5 » donnerait une annee
               de naissance fractionnaire, que `z.number().int()` refuse : un 400
               qui perdrait TOUS les reglages de la page, pas seulement l'age. */
            onChange={(v) => patch({ birthYear: v === null ? null : anneeCourante - Math.round(v) })}
            min={10}
            max={120}
            suffix="ans"
            hint="L’année suffit au calcul : une erreur de douze mois déplace la cible de 5 kcal."
          />
          <NumberField
            label="Taille"
            className="field--ligne"
            value={draft.heightCm}
            onChange={(v) => patch({ heightCm: v })}
            min={80}
            max={250}
            suffix="cm"
          />
          <NumberField
            label="Poids actuel"
            className="field--ligne"
            value={draft.weightKg}
            onChange={(v) => patch({ weightKg: v })}
            min={20}
            max={400}
            suffix="kg"
            decimals={1}
            hint={
              auto
                ? 'Mis à jour tout seul à chaque pesée enregistrée. Le modifier ici reste possible : la prochaine pesée reprendra la main.'
                : undefined
            }
          />
          <NumberField
            label="Tour de taille"
            className="field--ligne"
            value={draft.waistCm}
            onChange={(v) => patch({ waistCm: v })}
            min={30}
            max={250}
            suffix="cm"
            decimals={1}
            hint="Facultatif, et il n’entre dans aucun calcul de cible. Il se lit à côté de l’IMC, parce que la balance seule ne dit pas où sont partis les kilos."
          />
        </div>
      </div>

      {/* ---------- 2. Activite habituelle ---------- */}
      <div className="card">
        <h2 className="card__title">Activité habituelle</h2>
        <RadioGroupField
          legend="Niveau d’activité"
          legendHidden
          value={draft.activity}
          onChange={(v) => patch({ activity: v as ActivityCode })}
          options={ACTIVITY_LEVELS.map((l) => ({ value: l.code, label: l.label, hint: l.hint }))}
          hint="Décris ta semaine ENTIÈRE, sport compris. L’erreur la plus fréquente est d’ajouter mentalement le sport à un niveau qui le compte déjà. C’est un point de départ : l’écran Objectifs compare ensuite cette estimation au rythme réellement observé sur tes pesées, et le dit si les deux divergent."
        />
      </div>

      {/* ---------- 3. Mon objectif ---------- */}
      <Objectif
        goal={draft.goal}
        targetWeightKg={draft.targetWeightKg}
        weightKg={draft.weightKg}
        paceKgPerWeek={draft.paceKgPerWeek}
        onPatch={patch}
      />

      {/* ---------- 4. Tes cibles calculees ---------- */}
      <TargetsCard estimated={estimated} draft={draft} missing={missingText} onPatch={patch} kcal={kcal} />

      <EffetsCard cibles={estimated} />

      {/* ---------- 5. Limites et precautions ---------- */}
      <Limites />

      <PiedEnregistrer
        onSubmit={submit}
        enCours={save.isPending}
        erreur={save.isError ? save.error.message : null}
        modifie={modifie}
        enregistre={enregistre && !modifie}
      />
    </section>
  )
}
