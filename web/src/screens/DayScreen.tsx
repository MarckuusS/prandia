/**
 * Une journee du planning.
 *
 * Elle vivait DANS l'ecran de la semaine, depliee sous la carte du jour. Deux
 * niveaux de cartes blanches imbriquees se lisaient comme un seul : on ne
 * savait plus si "MATIN" appartenait a mercredi ou a jeudi. La journee est
 * donc un ecran a part, atteint par un tap et quitte par le bouton retour.
 *
 * Elle porte TOUT ce qui concerne un jour : les cinq creneaux, le tableau des
 * apports, la comparaison a l'objectif, l'anneau, le cout, et les outils dont
 * "vider ce jour" — qui n'ont de sens qu'ici, une fois le jour choisi.
 */

import { useMemo, useState } from "react";
import { useParams } from "react-router";
import {
  DAY_LABELS,
  MEAL_SLOTS,
  MEAL_SLOT_LABELS,
  addNutrition,
  datesOfIsoWeek,
  divideNutrition,
  formatEuros,
  formatGrams,
  perEater,
  type MealSlot,
  type NutritionTotal,
} from "@prandia/shared";

import { EmptyState, ErrorState, LoadingRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { Icon } from "../icons/index.js";
import {
  useAddEntry,
  useCalendar,
  useDeleteEntry,
  type CalendarResponse,
  type EntryDraft,
} from "../lib/queries.js";
import { useIsoWeekParam } from "../lib/useIsoWeekParam.js";
import { AddEntrySheet } from "./semaine/AddEntrySheet.js";
import { EntrySheet } from "./semaine/EntrySheet.js";
import { CarteCout, TableauApports } from "./semaine/Apports.js";
import { GoalCard } from "./semaine/GoalCard.js";
import { MealRow } from "./semaine/MealRow.js";
import { WeekTools, type WeekTool } from "./semaine/WeekTools.js";
import {
  entriesCost,
  entriesOfDay,
  entriesOfSlot,
  sumNutrition,
  type SavedEntry,
} from "./semaine/totals.js";
import "../styles/week.css";

/** Indice de jour lu dans l'adresse. Hors bornes, on retombe sur lundi. */
function lireJour(brut: string | undefined): number {
  const n = Number(brut);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 0;
}

export function DayScreen() {
  const week = useIsoWeekParam();
  const { jour } = useParams();
  const dayIndex = lireJour(jour);

  const query = useCalendar(week.isoWeek);
  const data = query.data;

  const [addTarget, setAddTarget] = useState<MealSlot | null>(null);
  const [editing, setEditing] = useState<SavedEntry | null>(null);
  const [tool, setTool] = useState<WeekTool | null>(null);

  const toast = useToast();
  const remove = useDeleteEntry(week.isoWeek);
  const add = useAddEntry(week.isoWeek);

  /**
   * Suppression immediate, rattrapable pendant six secondes.
   *
   * L'annulation recree une entree, donc un nouvel identifiant. Le tampon est
   * cote client : l'application s'ouvre sur plusieurs appareils, un tampon
   * partage y annulerait la suppression d'un autre.
   */
  const deleteEntry = (entry: SavedEntry, label: string) => {
    const draft: EntryDraft = {
      dayOfWeek: entry.dayOfWeek,
      slot: entry.slot,
      recipeId: entry.recipeId,
      ingredientId: entry.ingredientId,
      quantityG: entry.quantityG,
      portions: entry.portions,
      unit: entry.unit,
    };
    setEditing(null);
    remove.mutate(entry.id, {
      onSuccess: () =>
        toast.showUndo(`${label} retiré`, () => add.mutate(draft)),
    });
  };

  const dates = useMemo(() => datesOfIsoWeek(week.isoWeek), [week.isoWeek]);
  const weekEntries = useMemo(() => data?.entries ?? [], [data]);
  const dayEntries = useMemo(
    () => (data ? entriesOfDay(data, dayIndex) : []),
    [data, dayIndex],
  );

  const total = useMemo(
    () => (data ? sumNutrition(dayEntries, data) : null),
    [dayEntries, data],
  );

  return (
    <section className="screen screen--jour">
      <div className="jour-entete">
        <h2 className="jour-entete__titre">
          {longDayLabel(dates[dayIndex], dayIndex)}
        </h2>
        {total !== null && total.kcal > 0 && (
          <span className="jour-entete__kcal chiffre">
            {Math.round(total.kcal).toLocaleString("fr-FR")}
          </span>
        )}
      </div>

      {query.isPending && <LoadingRows />}
      {query.isError && (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      )}

      {query.isSuccess && data && (
        <>
          {MEAL_SLOTS.map((slot) => (
            <SlotCard
              key={slot}
              slot={slot}
              dayIndex={dayIndex}
              entries={entriesOfSlot(dayEntries, slot)}
              data={data}
              onAdd={() => setAddTarget(slot)}
              onEdit={setEditing}
            />
          ))}

          {dayEntries.length === 0 && (
            <EmptyState title="Journée vide">
              Ajoute un repas à un créneau ci-dessus, ou reprends une semaine
              passée depuis « Outils de la semaine ».
            </EmptyState>
          )}

          <DayTotals data={data} dayEntries={dayEntries} />
        </>
      )}

      <div className="week-tools">
        <button
          type="button"
          className="button button--secondary week-tools__trigger"
          onClick={() => setTool("menu")}
        >
          <span aria-hidden="true">⋯</span> Outils de la semaine
        </button>
      </div>

      {addTarget !== null && (
        <AddEntrySheet
          isoWeek={week.isoWeek}
          dayOfWeek={dayIndex}
          slot={addTarget}
          onClose={() => setAddTarget(null)}
        />
      )}

      {editing !== null && data && (
        <EntrySheet
          isoWeek={week.isoWeek}
          entry={editing}
          data={data}
          onClose={() => setEditing(null)}
          onDelete={deleteEntry}
        />
      )}

      <WeekTools
        isoWeek={week.isoWeek}
        dayOfWeek={dayIndex}
        weekEntryCount={weekEntries.length}
        dayEntryCount={dayEntries.length}
        tool={tool}
        onTool={setTool}
      />
    </section>
  );
}

/** « Lundi 28 avril ». Les dates de la semaine sont a midi UTC (voir isoweek.ts). */
function longDayLabel(date: Date | undefined, index: number): string {
  if (!date) return DAY_LABELS[index] ?? "";
  const formatted = date.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function SlotCard({
  slot,
  dayIndex,
  entries,
  data,
  onAdd,
  onEdit,
}: {
  slot: MealSlot;
  dayIndex: number;
  entries: readonly SavedEntry[];
  data: CalendarResponse;
  onAdd: () => void;
  onEdit: (entry: SavedEntry) => void;
}) {
  const kcal = sumNutrition(entries, data).kcal;
  const slotLabel = MEAL_SLOT_LABELS[slot];
  const dayLabel = DAY_LABELS[dayIndex] ?? "";

  return (
    <section className="slot">
      <header className="slot__header">
        {/* Les cinq creneaux restent affiches meme vides : c'est ce qui rend
            l'ajout a un en-cas atteignable en un seul geste. */}
        <h3 className="slot__title">{slotLabel}</h3>
        {kcal > 0 && (
          <span className="slot__kcal">
            {Math.round(kcal).toLocaleString("fr-FR")} kcal
          </span>
        )}
      </header>

      {entries.length > 0 && (
        <ul className="slot__list">
          {entries.map((entry) => (
            <MealRow key={entry.id} entry={entry} data={data} onEdit={onEdit} />
          ))}
        </ul>
      )}

      <button
        type="button"
        className="slot__add"
        onClick={onAdd}
        aria-label={`Ajouter un repas — ${dayLabel} ${slotLabel.toLowerCase()}`}
      >
        <span aria-hidden="true">＋</span> Ajouter
      </button>
    </section>
  );
}

/**
 * Ce qu'une journee apporte, et ce qu'elle coute.
 *
 * Le tableau ne porte PLUS de colonne "Semaine". Elle obligeait a ouvrir un
 * jour pour lire un total de semaine, et mettait deux portees dans un meme
 * tableau : on comparait sans le vouloir une journee a sept. La semaine a
 * desormais les siens, sur son propre ecran.
 */
function DayTotals({
  data,
  dayEntries,
}: {
  data: CalendarResponse;
  dayEntries: readonly SavedEntry[];
}) {
  const dayTotal = useMemo(
    () => sumNutrition(dayEntries, data),
    [dayEntries, data],
  );
  const dayCost = useMemo(
    () => entriesCost(dayEntries, data),
    [dayEntries, data],
  );

  return (
    <>
      {/* L'anneau est DANS cette carte, au-dessus de son tableau. Il vivait
          dans une carte separee, POSEE APRES, et la carte d'objectif passait
          entre les deux : la figure arrivait apres les chiffres qu'elle
          illustre, et la colonne "Part" du tableau n'avait rien a cote d'elle
          a expliquer. */}
      <TableauApports
        titre="Apports du jour"
        total={dayTotal}
        entryCount={dayEntries.length}
        anneau="kcal ce jour"
      />

      {/* Apres les nombres bruts : c'est la lecture personnelle de la journee,
          et elle n'a de sens qu'une fois les totaux vus. */}
      <GoalCard dayTotal={dayTotal} hasEntries={dayEntries.length > 0} />

      <CarteCout titre="Coût du jour" cout={dayCost} portee="de ce jour" />
    </>
  );
}

/**
 * Une valeur nutritionnelle.
 *
 * « — » quand il n'y a rien a totaliser : afficher « 0 kcal » pour une journee
 * vide laisserait croire a une donnee mesuree. Une macro inconnue, elle,
 * compte pour 0 dans l'agregat — regle du domaine, reprise du desktop.
 */
